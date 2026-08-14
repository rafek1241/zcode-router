import http from 'node:http';
import crypto from 'node:crypto';
import { createRouter } from '../src/server.js';

// Shared test rig: mock upstream + router, both on loopback ephemeral ports.
export async function makeRig(t, { configOverrides = {}, upstreamHandler } = {}) {
  const state = { requests: [], visionCalls: 0, anthropicRequests: [] };
  const upstream = http.createServer(
    upstreamHandler ||
      (async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (url.pathname.endsWith('/messages')) {
          // Mock for messages-protocol upstreams (e.g. opencode Go MiniMax/Qwen).
          state.anthropicRequests.push(body);
          const hasImage = body.messages?.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));
          if (hasImage) state.visionCalls += 1;
          const text = hasImage ? `VISION-READ(${body.model})` : `REPLY[${body.model}]: ${anthropicLastText(body)}`;
          const toolUse = body.tools && /call the tool/i.test(anthropicLastText(body));
          const blocks = [{ type: 'text', text }];
          if (toolUse) blocks.push({ type: 'tool_use', id: 'toolu_1', name: 'mock_tool', input: { ok: true } });
          if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            res.write(ev('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } }));
            res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
            res.write(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
            res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
            if (toolUse) {
              res.write(ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mock_tool', input: {} } }));
              res.write(ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ok":true}' } }));
              res.write(ev('content_block_stop', { type: 'content_block_stop', index: 1 }));
            }
            res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }));
            res.write(ev('message_stop', { type: 'message_stop' }));
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_mock',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: blocks,
              stop_reason: toolUse ? 'tool_use' : 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 4 },
            })
          );
          return;
        }
        state.requests.push(body);
        const imagePart = body.messages
          ?.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .find((p) => p.type === 'image_url');
        if (imagePart) state.visionCalls += 1;
        const text = imagePart
          ? `VISION-READ(${body.model})`
          : `REPLY[${body.model}]: ${lastText(body)}`;
        const message = { role: 'assistant', content: text };
        if (body.tools && /call the tool/i.test(lastText(body))) {
          message.tool_calls = [{ id: 'call_1', type: 'function', function: { name: 'mock_tool', arguments: '{}' } }];
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (delta, finish = null) =>
            `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          res.write(chunk({ role: 'assistant', content: text.slice(0, 6) }));
          res.write(chunk({ content: text.slice(6) }, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      })
  );
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const config = {
    version: 1,
    localKey: crypto.randomBytes(24).toString('base64url'),
    port: 0,
    providers: {
      mock: {
        enabled: true,
        key: 'mock-key',
        baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
        models: [
          { id: 'mock-text', vision: false },
          { id: 'mock-vision', vision: true },
          { id: 'mock-msg', vision: false, protocol: 'messages' },
          { id: 'mock-msg-vision', vision: true, protocol: 'messages' },
          { id: 'mock-alias', vision: false, upstream: 'real-upstream' },
        ],
      },
    },
    visionBridge: { enabled: true, engine: 'auto', local: null },
    ...configOverrides,
  };

  const server = createRouter({ config, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${config.localKey}`, 'content-type': 'application/json' };

  t.after(async () => {
    server.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
  });

  return { state, config, base, auth, chat: (body) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify(body) }) };
}

function lastText(body) {
  for (const m of [...(body.messages || [])].reverse()) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  }
  return '';
}

function anthropicLastText(body) {
  for (const m of [...(body.messages || [])].reverse()) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  }
  return '';
}

export const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
