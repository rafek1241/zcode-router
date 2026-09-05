// OpenAI Responses API <-> Chat Completions translation.
// opencode-go serves muse-spark over POST /responses only: /chat/completions
// and /messages both answer 500. The router stays canonical-OpenAI internally
// and converts to Responses on the way out, back to OpenAI on the way in.

/** Chat Completions body -> Responses body (model, input, instructions, tools). */
export function openaiToResponsesRequest(body) {
  const instructionsParts = [];
  const input = [];
  for (const m of body.messages || []) {
    if (m.role === 'system') {
      instructionsParts.push(
        typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n')
      );
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }
    if (m.role === 'assistant') {
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((p) => p.type === 'text' || typeof p.text === 'string').map((p) => p.text || '').join('\n')
            : '';
      if (text) input.push({ role: 'assistant', content: text });
      for (const tc of m.tool_calls || []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments || '{}',
        });
      }
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      input.push({ role: 'user', content: m.content });
      continue;
    }
    const content = [];
    for (const p of m.content || []) {
      if (p.type === 'text' && typeof p.text === 'string') content.push({ type: 'input_text', text: p.text });
      else if (p.type === 'image_url') {
        const url = p.image_url?.url || '';
        if (url) content.push({ type: 'input_image', image_url: url });
      } else if (typeof p.text === 'string') content.push({ type: 'input_text', text: p.text });
    }
    if (content.length === 1 && content[0].type === 'input_text') input.push({ role: 'user', content: content[0].text });
    else input.push({ role: 'user', content: content.length ? content : '' });
  }
  const out = { model: body.model, input, stream: Boolean(body.stream) };
  if (instructionsParts.length) out.instructions = instructionsParts.join('\n');
  const maxOut = body.max_tokens ?? body.max_completion_tokens;
  if (maxOut != null) out.max_output_tokens = maxOut;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      name: t.function?.name,
      description: t.function?.description || '',
      parameters: t.function?.parameters || { type: 'object' },
    }));
  }
  if (body.tool_choice != null) {
    const tc = body.tool_choice;
    out.tool_choice =
      tc === 'auto' || tc === 'required' || tc === 'none'
        ? tc
        : tc?.type === 'function'
          ? { type: 'function', name: tc.function?.name }
          : 'auto';
  }
  return out;
}

/** Responses JSON -> Chat Completions JSON (text + function_call -> tool_calls). */
export function responsesToOpenaiResponse(resp, requestedModel) {
  let text = '';
  const toolCalls = [];
  for (const item of resp.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text' && typeof c.text === 'string') text += (text ? '\n' : '') + c.text;
        else if (c.type === 'refusal' && typeof c.refusal === 'string') text += (text ? '\n' : '') + c.refusal;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  if (!text && typeof resp.output_text === 'string') text = resp.output_text;
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const prompt = resp.usage?.input_tokens ?? 0;
  const completion = resp.usage?.output_tokens ?? 0;
  return {
    id: resp.id || 'resp_zcode_router',
    object: 'chat.completion',
    created: 0,
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: resp.usage?.total_tokens ?? prompt + completion },
  };
}

/** Responses SSE (semantic events) -> OpenAI chat.chunk SSE lines. */
export class ResponsesStreamTranslator {
  constructor(model) {
    this.model = model;
    this.toolIndex = new Map();
    this.nextTool = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.done = false;
    this.sentRole = false;
    this.textEmitted = false;
  }

  push(rawLine) {
    const out = [];
    if (rawLine.startsWith('event:')) {
      this.pendingEvent = rawLine.slice(6).trim();
      return out;
    }
    if (!rawLine.startsWith('data:')) return out;
    const dataStr = rawLine.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') return out;
    let data;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return out;
    }
    const emit = (delta, finish = null, usage = undefined) => {
      const chunk = {
        id: 'chatcmpl_zcode_router',
        object: 'chat.completion.chunk',
        created: 0,
        model: this.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      };
      if (usage) chunk.usage = usage;
      out.push(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const ensureRole = () => {
      if (!this.sentRole) {
        this.sentRole = true;
        emit({ role: 'assistant', content: '' });
      }
    };
    const toolIndexFor = (key) => {
      let oi = this.toolIndex.get(key);
      if (oi == null) {
        oi = this.nextTool++;
        this.toolIndex.set(key, oi);
      }
      return oi;
    };

    switch (data.type) {
      case 'response.created':
      case 'response.in_progress':
        ensureRole();
        break;
      case 'response.output_item.added': {
        const item = data.item || {};
        if (item.type === 'function_call') {
          const key = item.call_id || item.id || `idx:${data.output_index}`;
          const oi = toolIndexFor(key);
          if (data.output_index != null) this.toolIndex.set(`idx:${data.output_index}`, oi);
          if (item.call_id) this.toolIndex.set(item.call_id, oi);
          if (item.id) this.toolIndex.set(item.id, oi);
          ensureRole();
          emit({ tool_calls: [{ index: oi, id: item.call_id || item.id, type: 'function', function: { name: item.name || '', arguments: '' } }] });
        }
        break;
      }
      case 'response.output_text.delta':
        if (data.delta) {
          ensureRole();
          this.textEmitted = true;
          emit({ content: data.delta });
        }
        break;
      case 'response.refusal.delta':
        if (data.delta) {
          ensureRole();
          this.textEmitted = true;
          emit({ content: data.delta });
        }
        break;
      case 'response.function_call_arguments.delta': {
        if (!data.delta) break;
        ensureRole();
        const key = data.item_id || (data.output_index != null ? `idx:${data.output_index}` : 'idx:0');
        emit({ tool_calls: [{ index: toolIndexFor(key), function: { arguments: data.delta } }] });
        break;
      }
      case 'response.completed': {
        const resp = data.response || data;
        const usage = resp.usage || {};
        this.inputTokens = usage.input_tokens ?? this.inputTokens;
        this.outputTokens = usage.output_tokens ?? 0;
        // Sparse gateways may send only completed without deltas — replay full output once.
        if (!this.textEmitted || this.nextTool === 0) {
          const full = responsesToOpenaiResponse(resp, this.model);
          const fullText = full.choices[0].message.content;
          const fullTools = full.choices[0].message.tool_calls || [];
          if (fullText && !this.textEmitted) {
            ensureRole();
            emit({ content: fullText });
            this.textEmitted = true;
          }
          for (const tc of fullTools) {
            const oi = toolIndexFor(tc.id);
            ensureRole();
            emit({ tool_calls: [{ index: oi, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] });
          }
        }
        const hasTools = this.nextTool > 0;
        emit({}, hasTools ? 'tool_calls' : 'stop', {
          prompt_tokens: this.inputTokens,
          completion_tokens: this.outputTokens,
          total_tokens: this.inputTokens + this.outputTokens,
        });
        this.done = true;
        out.push('data: [DONE]\n\n');
        break;
      }
      case 'response.failed':
      case 'error':
        if (!this.done) {
          this.done = true;
          emit({}, 'stop');
          out.push('data: [DONE]\n\n');
        }
        break;
      default:
        break;
    }
    return out;
  }

  finalize() {
    if (this.done) return [];
    this.done = true;
    return ['data: [DONE]\n\n'];
  }
}
