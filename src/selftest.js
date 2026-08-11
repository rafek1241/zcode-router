import http from 'node:http';
import crypto from 'node:crypto';
import { createRouter } from './server.js';

// In-process mock upstream: proves the whole pipeline (auth, routing,
// streaming, tool calls, vision bridge) without touching a real provider
// or spending a cent. Bound to 127.0.0.1 on an ephemeral port.
function createMockUpstream(state) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    if (!url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.requests.push(body);
    const imagePart = body.messages
      ?.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => p.type === 'image_url');
    if (imagePart) state.visionCalls += 1;

    const reply = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: imagePart
              ? `MOCK-VISION-READ(${body.model}):${crypto.createHash('sha256').update(imagePart.image_url.url).digest('hex').slice(0, 12)}`
              : `MOCK-REPLY[${body.model}]: ${lastUserText(body)}`,
            ...(body.tools && /call the tool/i.test(lastUserText(body))
              ? { tool_calls: [{ id: 'call_mock', type: 'function', function: { name: 'mock_tool', arguments: '{"ok":true}' } }] }
              : {}),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const text = reply.choices[0].message.content || '';
      res.write(chunk({ role: 'assistant', content: text.slice(0, 8) }));
      res.write(chunk({ content: text.slice(8) }, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
}

function lastUserText(body) {
  const msgs = [...(body.messages || [])].reverse();
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
    }
  }
  return '';
}

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// Distinct payload so the bridge cache (keyed by image hash) does not dedupe
// the Anthropic check against the earlier OpenAI check.
const PNG_1PX_ALT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

export async function runSelftest(log = console.log) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };

  const mockState = { requests: [], visionCalls: 0 };
  const upstream = createMockUpstream(mockState);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const config = {
    version: 1,
    localKey: crypto.randomBytes(24).toString('base64url'),
    port: 0,
    providers: {
      mock: {
        enabled: true,
        key: 'mock-key-not-a-real-secret',
        baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
        label: 'Mock (selftest)',
        models: [
          { id: 'mock-text', vision: false },
          { id: 'mock-vision', vision: true },
        ],
      },
    },
    visionBridge: { enabled: true, engine: 'auto', local: null },
  };

  const server = createRouter({ config, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${config.localKey}`, 'content-type': 'application/json' };

  const close = async () => {
    server.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
  };

  try {
    const health = await fetch(`${base}/health`);
    check('health endpoint answers', health.status === 200);

    const noAuth = await fetch(`${base}/v1/models`);
    check('models endpoint rejects missing key', noAuth.status === 401);

    const badAuth = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer wrong' } });
    check('models endpoint rejects wrong key', badAuth.status === 401);

    const models = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
    const ids = models.data.map((m) => m.id);
    check('catalog lists routed models', ids.includes('mock/mock-text') && ids.includes('mock/mock-vision'), ids.join(', '));

    const once = await chat(base, auth, { model: 'mock/mock-text', messages: [{ role: 'user', content: 'hello router' }] });
    check('non-streaming chat completion', once.status === 200 && (await once.json()).choices[0].message.content.includes('hello router'));

    const stream = await chat(base, auth, { model: 'mock/mock-text', stream: true, messages: [{ role: 'user', content: 'stream me' }] });
    const sse = await stream.text();
    check('streaming chat completion (SSE)', stream.status === 200 && sse.includes('data:') && sse.includes('[DONE]') && sse.includes('stream me'));

    const tool = await chat(base, auth, {
      model: 'mock/mock-text',
      messages: [{ role: 'user', content: 'please call the tool now' }],
      tools: [{ type: 'function', function: { name: 'mock_tool', description: 'test', parameters: { type: 'object' } } }],
    });
    const toolJson = await tool.json();
    check('tool calls pass through', toolJson.choices[0].message.tool_calls?.[0]?.function?.name === 'mock_tool');

    const unknown = await chat(base, auth, { model: 'mock/nope', messages: [{ role: 'user', content: 'x' }] });
    check('unknown model rejected', unknown.status === 404);

    mockState.requests.length = 0;
    mockState.visionCalls = 0;
    const bridged = await chat(base, auth, {
      model: 'mock/mock-text',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: PNG_1PX } }] }],
    });
    await bridged.json();
    const forwarded = mockState.requests.find((r) => r.model === 'mock-text');
    const forwardedParts = forwarded?.messages?.[0]?.content || [];
    const sawImage = forwardedParts.some((p) => p.type === 'image_url');
    const sawEvidence = forwardedParts.some((p) => p.type === 'text' && p.text.includes('MOCK-VISION-READ(mock-vision)'));
    check('vision bridge replaces image with evidence text', !sawImage && sawEvidence && mockState.visionCalls === 1);

    await (
      await chat(base, auth, {
        model: 'mock/mock-text',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'and again?' }, { type: 'image_url', image_url: { url: PNG_1PX } }] }],
      })
    ).json();
    check('vision bridge caches by image hash', mockState.visionCalls === 1, `vision calls: ${mockState.visionCalls}`);

    mockState.requests.length = 0;
    const direct = await chat(base, auth, {
      model: 'mock/mock-vision',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG_1PX } }] }],
    });
    await direct.json();
    const directParts = mockState.requests.find((r) => r.model === 'mock-vision')?.messages?.[0]?.content || [];
    check('vision-capable model receives the image untouched', directParts.some((p) => p.type === 'image_url'));

    const fenced = forwardedParts.find((p) => p.type === 'text' && p.text.includes('MOCK-VISION-READ'));
    const fenceMatch = fenced?.text.match(/BEGIN-IMAGE-DATA-([0-9a-f]{16})/);
    check(
      'evidence is fenced as untrusted data',
      Boolean(fenceMatch && fenced.text.includes('untrusted data') && fenced.text.includes(`END-IMAGE-DATA-${fenceMatch[1]}`))
    );

    // --- Anthropic Messages protocol (zCode's default) ---
    const xkey = { 'x-api-key': config.localKey, 'content-type': 'application/json' };
    const aRes = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: xkey,
      body: JSON.stringify({ model: 'mock/mock-text', max_tokens: 64, messages: [{ role: 'user', content: 'hello messages' }] }),
    });
    const aJson = await aRes.json();
    check(
      'messages: non-streaming Anthropic shape via x-api-key',
      aRes.status === 200 && aJson.type === 'message' && aJson.role === 'assistant' && aJson.content?.[0]?.text?.includes('hello messages') && aJson.stop_reason === 'end_turn'
    );

    const aStream = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: xkey,
      body: JSON.stringify({ model: 'mock/mock-text', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'stream it' }] }),
    });
    const aBody = await aStream.text();
    const events = [...aBody.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    check(
      'messages: streaming Anthropic event sequence',
      aStream.status === 200 && events[0] === 'message_start' && events.includes('content_block_delta') && events.at(-1) === 'message_stop'
    );

    mockState.requests.length = 0;
    mockState.visionCalls = 0;
    const aImg = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: xkey,
      body: JSON.stringify({
        model: 'mock/mock-text',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX_ALT } },
            ],
          },
        ],
      }),
    });
    await aImg.json();
    const aForwarded = mockState.requests.find((r) => r.model === 'mock-text');
    const aParts = aForwarded?.messages?.find((m) => m.role === 'user')?.content || [];
    check(
      'messages: vision bridge handles Anthropic image blocks',
      aRes.ok && mockState.visionCalls === 1 && !aParts.some((p) => p.type === 'image_url') && aParts.some((p) => p.text?.includes('MOCK-VISION-READ(mock-vision)'))
    );
  } finally {
    await close();
  }

  const failed = results.filter((r) => !r).length;
  log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ''}`);
  return failed === 0;
}

function chat(base, auth, body) {
  return fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
}
