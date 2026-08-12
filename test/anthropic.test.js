import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRig, PNG_1PX } from './helpers.js';
import { anthropicToOpenai, openaiToAnthropic, estimateTokens } from '../src/anthropic.js';

const B64 = PNG_1PX.split(',')[1];

function msg(base, config, body, { xApiKey = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (xApiKey) headers['x-api-key'] = config.localKey;
  else headers.authorization = `Bearer ${config.localKey}`;
  return fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('unit: anthropicToOpenai maps system, images, tools, tool history', () => {
  const out = anthropicToOpenai({
    model: 'p/m',
    max_tokens: 123,
    system: 'be brief',
    temperature: 0.5,
    stop_sequences: ['END'],
    tools: [{ name: 'run', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'run' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'toolu_1', name: 'run', input: { a: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }, { type: 'text', text: 'and?' }] },
    ],
  });
  assert.equal(out.messages[0].role, 'system');
  const userParts = out.messages[1].content;
  assert.equal(userParts[0].type, 'text');
  assert.equal(userParts[1].type, 'image_url');
  assert.ok(userParts[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(out.messages[2].tool_calls[0].function.name, 'run');
  assert.equal(JSON.parse(out.messages[2].tool_calls[0].function.arguments).a, 'x');
  assert.deepEqual(out.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'done' });
  assert.equal(out.max_tokens, 123);
  assert.deepEqual(out.stop, ['END']);
  assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'run' } });
  assert.equal(out.tools[0].function.parameters.properties.a.type, 'string');
});

test('unit: openaiToAnthropic maps text, tool calls, usage, stop reasons', () => {
  const out = openaiToAnthropic(
    {
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    'p/m'
  );
  assert.equal(out.type, 'message');
  assert.equal(out.model, 'p/m');
  assert.equal(out.content[0].text, 'hi');
  assert.deepEqual(out.content[1], { type: 'tool_use', id: 'call_1', name: 'run', input: { a: 1 } });
  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5 });
});

test('messages: accepts x-api-key and bearer, rejects wrong key', async (t) => {
  const { base, config } = await makeRig(t);
  const body = { model: 'mock/mock-text', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] };
  assert.equal((await msg(base, config, body)).status, 200);
  assert.equal((await msg(base, config, body, { xApiKey: false })).status, 200);
  const bad = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
    body: JSON.stringify(body),
  });
  assert.equal(bad.status, 401);
  const shape = await bad.json();
  assert.equal(shape.type, 'error');
  assert.equal(shape.error.type, 'authentication_error');
});

test('messages: non-streaming text reply in Anthropic shape', async (t) => {
  const { base, config, state } = await makeRig(t);
  const res = await msg(base, config, { model: 'mock/mock-text', max_tokens: 64, messages: [{ role: 'user', content: 'hello anthropic' }] });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.type, 'message');
  assert.equal(json.role, 'assistant');
  assert.equal(json.model, 'mock/mock-text');
  assert.match(json.content[0].text, /hello anthropic/);
  assert.equal(json.stop_reason, 'end_turn');
  assert.equal(state.requests[0].model, 'mock-text', 'model id rewritten upstream');
});

test('messages: streaming emits the Anthropic event sequence', async (t) => {
  const { base, config } = await makeRig(t);
  const res = await msg(base, config, { model: 'mock/mock-text', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'stream please' }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const body = await res.text();
  const events = [...body.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.match(body, /stream please/);
  assert.match(body, /"stop_reason":"end_turn"/);
});

test('messages: tool calls stream as tool_use blocks with input_json_delta', async (t) => {
  const { base, config } = await makeRig(t, {
    upstreamHandler: async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run', arguments: '' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, 'tool_calls'));
      res.write('data: [DONE]\n\n');
      res.end();
    },
  });
  const res = await msg(base, config, {
    model: 'mock/mock-text',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'call the tool' }],
    tools: [{ name: 'run', description: 'd', input_schema: { type: 'object' } }],
  });
  const body = await res.text();
  assert.match(body, /content_block_start.*tool_use/s);
  assert.match(body, /input_json_delta/);
  assert.match(body, /"stop_reason":"tool_use"/);
  // the two partial_json deltas reassemble to the full arguments
  const partials = [...body.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  assert.equal(partials.join(''), '{"cmd":"ls"}');
});

test('messages: vision bridge works for Anthropic image blocks', async (t) => {
  const { base, config, state } = await makeRig(t);
  const res = await msg(base, config, {
    model: 'mock/mock-text',
    max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } }] }],
  });
  assert.equal(res.status, 200);
  const forwarded = state.requests.find((r) => r.model === 'mock-text');
  const parts = forwarded.messages.find((m) => m.role === 'user').content;
  assert.ok(!parts.some((p) => p.type === 'image_url'), 'no image reaches the text model');
  assert.ok(parts.some((p) => p.type === 'text' && p.text.includes('VISION-READ(mock-vision)')));
  assert.equal(state.visionCalls, 1);
});

test('messages: upstream errors surface in Anthropic error shape', async (t) => {
  const { base, config } = await makeRig(t, {
    upstreamHandler: (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
    },
  });
  const res = await msg(base, config, { model: 'mock/mock-text', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.equal(json.type, 'error');
  assert.equal(json.error.type, 'rate_limit_error');
  assert.match(json.error.message, /quota exhausted/);
});

test('messages: unknown model lists available models in Anthropic shape', async (t) => {
  const { base, config } = await makeRig(t);
  const res = await msg(base, config, { model: 'mock/nope', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error.type, 'not_found_error');
  assert.match(json.error.message, /mock\/mock-text/);
});

test('count_tokens estimates without touching upstream', async (t) => {
  const { base, config, state } = await makeRig(t);
  const res = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.localKey },
    body: JSON.stringify({ model: 'mock/mock-text', messages: [{ role: 'user', content: 'a'.repeat(400) }] }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.input_tokens >= 90 && json.input_tokens <= 130, `~100 expected, got ${json.input_tokens}`);
  assert.equal(state.requests.length, 0);
});

test('unit: estimateTokens scales with content', () => {
  const small = estimateTokens({ messages: [{ role: 'user', content: 'hi' }] });
  const big = estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
  assert.ok(big > small);
});

// --- messages-protocol upstreams (opencode Go MiniMax/Qwen over /messages) ---

test('messages upstream: openai client, non-streaming', async (t) => {
  const { chat, state } = await makeRig(t);
  const res = await chat({ model: 'mock/mock-msg', messages: [{ role: 'user', content: 'hello msg upstream' }] });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.match(json.choices[0].message.content, /hello msg upstream/);
  assert.equal(json.choices[0].finish_reason, 'stop');
  const sent = state.anthropicRequests[0];
  assert.equal(sent.model, 'mock-msg', 'model id rewritten');
  assert.equal(sent.messages.at(-1).content, 'hello msg upstream', 'plain string content');
  assert.ok(sent.max_tokens > 0, 'max_tokens defaulted for Anthropic');
});

test('messages upstream: openai client streaming gets OpenAI chunks', async (t) => {
  const { chat } = await makeRig(t);
  const res = await chat({ model: 'mock/mock-msg', stream: true, messages: [{ role: 'user', content: 'stream msg' }] });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /"object":"chat.completion.chunk"/);
  assert.match(body, /stream msg/);
  assert.match(body, /data: \[DONE\]/);
  assert.doesNotMatch(body, /event: message_start/, 'no Anthropic events leak');
});

test('messages upstream: anthropic client round-trips (double translation)', async (t) => {
  const { base, config } = await makeRig(t);
  const res = await msg(base, config, { model: 'mock/mock-msg', max_tokens: 64, messages: [{ role: 'user', content: 'full circle' }] });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.type, 'message');
  assert.match(json.content[0].text, /full circle/);
  assert.equal(json.stop_reason, 'end_turn');
});

test('messages upstream: anthropic client streaming gets the event sequence', async (t) => {
  const { base, config } = await makeRig(t);
  const res = await msg(base, config, { model: 'mock/mock-msg', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'stream circle' }] });
  assert.equal(res.status, 200);
  const body = await res.text();
  const events = [...body.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
  assert.equal(events[0], 'message_start');
  assert.equal(events.at(-1), 'message_stop');
  assert.match(body, /stream circle/);
});

test('messages upstream: tool calls round-trip to anthropic client', async (t) => {
  const { base, config, state } = await makeRig(t);
  const res = await msg(base, config, {
    model: 'mock/mock-msg',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'call the tool' }],
    tools: [{ name: 'mock_tool', description: 'd', input_schema: { type: 'object' } }],
  });
  const json = await res.json();
  const toolUse = json.content.find((b) => b.type === 'tool_use');
  assert.equal(toolUse.name, 'mock_tool');
  assert.deepEqual(toolUse.input, { ok: true });
  assert.equal(json.stop_reason, 'tool_use');
  const sent = state.anthropicRequests[0];
  assert.equal(sent.tools[0].name, 'mock_tool');
  assert.deepEqual(sent.tools[0].input_schema, { type: 'object' });
});

test('messages upstream: streaming tool call reaches openai client', async (t) => {
  const { chat } = await makeRig(t);
  const res = await chat({
    model: 'mock/mock-msg',
    stream: true,
    messages: [{ role: 'user', content: 'call the tool' }],
    tools: [{ type: 'function', function: { name: 'mock_tool', description: 'd', parameters: { type: 'object' } } }],
  });
  const body = await res.text();
  assert.match(body, /"tool_calls"/);
  assert.match(body, /mock_tool/);
  assert.match(body, /\{\\"ok\\":true\}/, 'arguments stream as JSON-escaped partial');
  assert.match(body, /"finish_reason":"tool_calls"/);
});

test('vision bridge works when the engine is a messages-protocol model', async (t) => {
  const { chat, state, config } = await makeRig(t);
  config.visionBridge.engine = 'mock/mock-msg-vision';
  const res = await chat({
    model: 'mock/mock-text',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG_1PX } }] }],
  });
  assert.equal(res.status, 200);
  await res.json();
  assert.equal(state.visionCalls, 1, 'engine called once');
  const engineReq = state.anthropicRequests.find((r) => r.model === 'mock-msg-vision');
  assert.ok(engineReq, 'engine received an Anthropic-shaped request');
  assert.ok(engineReq.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image' && b.source?.type === 'base64')));
  const forwarded = state.requests.find((r) => r.model === 'mock-text');
  const parts = forwarded.messages[0].content;
  assert.ok(parts.some((p) => p.type === 'text' && p.text.includes('VISION-READ(mock-msg-vision)')));
});

test('unit: openaiToAnthropicRequest merges consecutive tool messages', async () => {
  const { openaiToAnthropicRequest, anthropicToOpenaiResponse } = await import('../src/anthropic.js');
  const out = openaiToAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      { role: 'user', content: 'next' },
    ],
  });
  assert.equal(out.system, 'sys');
  assert.equal(out.messages[1].role, 'assistant');
  assert.equal(out.messages[1].content[0].type, 'tool_use');
  assert.equal(out.messages[2].role, 'user');
  assert.deepEqual(out.messages[2].content.map((b) => b.content), ['r1', 'r2'], 'merged tool_results');
  assert.equal(out.messages[3].content, 'next');

  const back = anthropicToOpenaiResponse(
    { id: 'msg_1', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't1', name: 'f', input: { x: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 2, output_tokens: 3 } },
    'm'
  );
  assert.equal(back.choices[0].message.content, 'a');
  assert.equal(back.choices[0].message.tool_calls[0].function.arguments, '{"x":1}');
  assert.equal(back.choices[0].finish_reason, 'tool_calls');
  assert.equal(back.usage.total_tokens, 5);
});
