// Anthropic Messages API <-> OpenAI Chat Completions translation.
// ZCode's default protocol for custom providers is Anthropic; the upstream
// subscription providers speak OpenAI chat completions. Translating the
// request first also gives the vision bridge one canonical shape to work on.

export function anthropicToOpenai(body) {
  const messages = [];
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system : body.system.map((b) => b.text || '').join('\n');
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    if (m.role === 'assistant') {
      const contentParts = [];
      const toolCalls = [];
      for (const b of m.content) {
        if (b.type === 'text') contentParts.push({ type: 'text', text: b.text || '' });
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') contentParts.push(thinkingPart(b));
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        }
      }
      const msg = { role: 'assistant', content: assistantContent(contentParts) };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    // user role: tool_result blocks become separate tool messages, the rest
    // stays as content parts in order
    const parts = [];
    const flush = () => {
      if (parts.length) messages.push({ role: 'user', content: parts.splice(0, parts.length) });
    };
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        flush();
        messages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n'),
        });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text || '' });
      } else if (b.type === 'image') {
        if (b.source?.type === 'base64') {
          parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        } else if (b.source?.type === 'url') {
          parts.push({ type: 'image_url', image_url: { url: b.source.url } });
        }
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        parts.push(thinkingPart(b));
      }
    }
    flush();
  }

  const out = { model: body.model, messages, stream: Boolean(body.stream) };
  out.max_tokens = body.max_tokens ?? 8192;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences != null) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object' } },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    out.tool_choice =
      tc.type === 'any' ? 'required'
      : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } }
      : tc.type === 'none' ? 'none'
      : 'auto';
  }
  return out;
}

const STOP_REASON = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' };

function thinkingPart(b) {
  const part = { type: b.type };
  if (b.thinking != null) part.thinking = b.thinking;
  if (b.signature != null) part.signature = b.signature;
  if (b.data != null) part.data = b.data;
  return part;
}

function assistantContent(parts) {
  if (parts.some((p) => p.type === 'thinking' || p.type === 'redacted_thinking')) return parts;
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n');
  return text || null;
}

export function mapStopReason(finish) {
  return STOP_REASON[finish] || (finish ? 'end_turn' : null);
}

export function openaiToAnthropic(resp, requestedModel) {
  const choice = resp.choices?.[0] || {};
  const content = [];
  const raw = choice.message?.content;
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (p?.type === 'thinking' || p?.type === 'redacted_thinking') content.push(thinkingPart(p));
      else if (p?.type === 'text' || typeof p?.text === 'string') content.push({ type: 'text', text: p.text || '' });
    }
  } else if (raw) {
    content.push({ type: 'text', text: raw });
  }
  for (const tc of choice.message?.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || '{}');
    } catch { /* malformed upstream arguments degrade to empty input */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  return {
    id: resp.id || 'msg_zcode_router',
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

export function anthropicErrorShape(status, message, type = 'invalid_request_error') {
  return { status, body: { type: 'error', error: { type, message } } };
}

// Translates an upstream OpenAI SSE byte stream into Anthropic Messages SSE
// events. One content block is open at a time; upstream sends text first and
// tool calls sequentially, so a single open-block cursor is enough.
export class AnthropicStreamTranslator {
  constructor(requestedModel, messageId) {
    this.model = requestedModel;
    this.messageId = messageId;
    this.started = false;
    this.open = null; // { kind: 'text' | 'tool', index: number }
    this.nextIndex = 0;
    this.toolByOpenaiIndex = new Map();
    this.finished = false;
  }

  push(rawLine) {
    const events = [];
    if (!rawLine.startsWith('data:')) return events;
    const data = rawLine.slice(5).trim();
    if (!data) return events;
    if (data === '[DONE]') {
      this.finalize(events, null);
      return events;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return events;
    }
    if (!this.started) {
      this.started = true;
      events.push(evt('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: chunk.usage?.prompt_tokens ?? 0, output_tokens: 0 },
        },
      }));
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      if (this.open?.kind !== 'text') {
        this.closeOpen(events);
        this.open = { kind: 'text', index: this.nextIndex++ };
        events.push(evt('content_block_start', { type: 'content_block_start', index: this.open.index, content_block: { type: 'text', text: '' } }));
      }
      events.push(evt('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'text_delta', text: delta.content } }));
    }
    for (const tc of delta.tool_calls || []) {
      const oi = tc.index ?? 0;
      let block = this.toolByOpenaiIndex.get(oi);
      if (!block) {
        this.closeOpen(events);
        block = { index: this.nextIndex++ };
        this.toolByOpenaiIndex.set(oi, block);
        this.open = { kind: 'tool', index: block.index };
        events.push(evt('content_block_start', {
          type: 'content_block_start',
          index: block.index,
          content_block: { type: 'tool_use', id: tc.id || `toolu_${this.messageId}_${oi}`, name: tc.function?.name || '', input: {} },
        }));
      } else if (this.open !== block && this.open?.index !== block.index) {
        this.closeOpen(events);
        this.open = { kind: 'tool', index: block.index };
      }
      if (tc.function?.arguments) {
        events.push(evt('content_block_delta', { type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }));
      }
    }
    if (choice?.finish_reason) {
      this.finalize(events, choice.finish_reason, chunk.usage);
    }
    return events;
  }

  closeOpen(events) {
    if (this.open) {
      events.push(evt('content_block_stop', { type: 'content_block_stop', index: this.open.index }));
      this.open = null;
    }
  }

  finalize(events, finishReason, usage) {
    if (this.finished) return;
    this.finished = true;
    if (!this.started) {
      this.started = true;
      events.push(evt('message_start', {
        type: 'message_start',
        message: { id: this.messageId, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: 0 } },
      }));
    }
    this.closeOpen(events);
    events.push(evt('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(finishReason) || 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage?.completion_tokens ?? 0 },
    }));
    events.push(evt('message_stop', { type: 'message_stop' }));
  }
}

function evt(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Rough estimator for /v1/messages/count_tokens — avoids a 404 in clients
// that pre-flight token counts. ~4 chars/token is the standard approximation.
export function estimateTokens(body) {
  let chars = 0;
  const walk = (v) => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(body.system);
  walk(body.messages);
  walk(body.tools);
  return Math.max(1, Math.ceil(chars / 4));
}

// ---------------------------------------------------------------------------
// Upstream direction: our canonical OpenAI body -> Anthropic Messages upstream
// (opencode Go serves MiniMax/Qwen models only over /messages).
// ---------------------------------------------------------------------------

export function openaiToAnthropicRequest(body) {
  const systemParts = [];
  const messages = [];
  let pendingToolResults = null;
  const flushToolResults = () => {
    if (pendingToolResults) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = null;
    }
  };

  for (const m of body.messages || []) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n'));
      continue;
    }
    if (m.role === 'tool') {
      // consecutive tool messages merge into one user message of tool_result blocks
      (pendingToolResults ||= []).push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }
    flushToolResults();
    if (m.role === 'assistant') {
      const content = [];
      if (typeof m.content === 'string') {
        if (m.content) content.push({ type: 'text', text: m.content });
      } else {
        for (const p of m.content || []) {
          if (p.type === 'thinking' || p.type === 'redacted_thinking') content.push(thinkingPart(p));
          else if (p.type === 'text' || typeof p.text === 'string') content.push({ type: 'text', text: p.text || '' });
        }
      }
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || '{}');
        } catch { /* degrade to empty input */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      messages.push({ role: 'user', content: m.content });
      continue;
    }
    const content = [];
    for (const p of m.content || []) {
      if (p.type === 'text') content.push({ type: 'text', text: p.text || '' });
      else if (p.type === 'thinking' || p.type === 'redacted_thinking') content.push(thinkingPart(p));
      else if (p.type === 'image_url') {
        const url = p.image_url?.url || '';
        const dataMatch = url.match(/^data:([^;]+);base64,(.*)$/s);
        if (dataMatch) content.push({ type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } });
        else content.push({ type: 'image', source: { type: 'url', url } });
      }
    }
    messages.push({ role: 'user', content: content.length ? content : '' });
  }
  flushToolResults();

  const out = {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8192,
    messages,
    stream: Boolean(body.stream),
  };
  if (systemParts.length) out.system = systemParts.join('\n');
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      name: t.function?.name,
      description: t.function?.description || '',
      input_schema: t.function?.parameters || { type: 'object' },
    }));
  }
  if (body.tool_choice != null) {
    const tc = body.tool_choice;
    out.tool_choice =
      tc === 'required' ? { type: 'any' }
      : tc === 'none' ? { type: 'none' }
      : tc === 'auto' ? { type: 'auto' }
      : tc?.type === 'function' ? { type: 'tool', name: tc.function?.name }
      : { type: 'auto' };
  }
  return out;
}

const FROM_ANTHROPIC_STOP = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop', refusal: 'content_filter' };

export function anthropicToOpenaiResponse(resp, requestedModel) {
  const contentParts = [];
  const toolCalls = [];
  for (const b of resp.content || []) {
    if (b.type === 'thinking' || b.type === 'redacted_thinking') contentParts.push(thinkingPart(b));
    else if (b.type === 'text') contentParts.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    }
  }
  const message = { role: 'assistant', content: assistantContent(contentParts) };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: resp.id || 'chatcmpl_zcode_router',
    object: 'chat.completion',
    created: 0,
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: FROM_ANTHROPIC_STOP[resp.stop_reason] || 'stop' }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}

// Translates an Anthropic Messages SSE stream into OpenAI chat.completion.chunk
// SSE lines, so the rest of the pipeline only ever handles one wire format.
export class OpenAIStreamTranslator {
  constructor(model) {
    this.model = model;
    this.toolIndexByBlock = new Map();
    this.inputTokens = 0;
    this.done = false;
  }

  push(rawLine) {
    const out = [];
    if (rawLine.startsWith('event:')) {
      this.pendingEvent = rawLine.slice(6).trim();
      return out;
    }
    if (!rawLine.startsWith('data:')) return out;
    let data;
    try {
      data = JSON.parse(rawLine.slice(5).trim());
    } catch {
      return out;
    }
    const emit = (delta, finish = null, usage = undefined) => {
      const chunk = { id: 'chatcmpl_zcode_router', object: 'chat.completion.chunk', created: 0, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] };
      if (usage) chunk.usage = usage;
      out.push(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    switch (data.type) {
      case 'message_start':
        this.inputTokens = data.message?.usage?.input_tokens ?? 0;
        emit({ role: 'assistant', content: '' });
        break;
      case 'content_block_start':
        if (data.content_block?.type === 'tool_use') {
          const oi = this.toolIndexByBlock.size;
          this.toolIndexByBlock.set(data.index, oi);
          emit({ tool_calls: [{ index: oi, id: data.content_block.id, type: 'function', function: { name: data.content_block.name || '', arguments: '' } }] });
        }
        break;
      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') emit({ content: data.delta.text });
        else if (data.delta?.type === 'input_json_delta') {
          const oi = this.toolIndexByBlock.get(data.index) ?? 0;
          emit({ tool_calls: [{ index: oi, function: { arguments: data.delta.partial_json } }] });
        }
        break;
      case 'message_delta': {
        const finish = FROM_ANTHROPIC_STOP[data.delta?.stop_reason] || 'stop';
        const output = data.usage?.output_tokens ?? 0;
        emit({}, finish, { prompt_tokens: this.inputTokens, completion_tokens: output, total_tokens: this.inputTokens + output });
        break;
      }
      case 'message_stop':
        if (!this.done) {
          this.done = true;
          out.push('data: [DONE]\n\n');
        }
        break;
      default:
        break; // ping, content_block_stop, error — nothing to forward
    }
    return out;
  }

  finalize() {
    if (this.done) return [];
    this.done = true;
    return ['data: [DONE]\n\n'];
  }
}
