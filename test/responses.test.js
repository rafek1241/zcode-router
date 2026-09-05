import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiToResponsesRequest, responsesToOpenaiResponse, ResponsesStreamTranslator } from '../src/responses.js';

test('openaiToResponsesRequest maps system, text, images, tools', () => {
  const req = openaiToResponsesRequest({
    model: 'muse-spark-1.3-contributor',
    stream: false,
    max_tokens: 64,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
      { role: 'assistant', content: 'thinking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ],
    tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  });
  assert.equal(req.model, 'muse-spark-1.3-contributor');
  assert.equal(req.instructions, 'you are helpful');
  assert.equal(req.max_output_tokens, 64);
  assert.equal(req.temperature, 0.2);
  const userImg = req.input.find((i) => i.role === 'user' && Array.isArray(i.content));
  assert.ok(userImg.content.some((c) => c.type === 'input_image' && c.image_url === 'data:image/png;base64,AAA'));
  assert.ok(req.input.some((i) => i.type === 'function_call' && i.call_id === 'call_1'));
  assert.ok(req.input.some((i) => i.type === 'function_call_output' && i.call_id === 'call_1'));
  assert.deepEqual(req.tools, [{ type: 'function', name: 't', description: 'd', parameters: { type: 'object' } }]);
});

test('responsesToOpenaiResponse maps text, tools, usage', () => {
  const out = responsesToOpenaiResponse(
    {
      id: 'resp_1',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 't', arguments: '{"a":1}' },
      ],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    },
    'mock/mock-spark'
  );
  assert.equal(out.model, 'mock/mock-spark');
  assert.equal(out.choices[0].message.content, 'hello');
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 't');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test('ResponsesStreamTranslator turns deltas into OpenAI chunks', () => {
  const tr = new ResponsesStreamTranslator('mock/mock-spark');
  const lines = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"hello"}',
    'event: response.completed',
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}`,
  ];
  const chunks = lines.flatMap((l) => tr.push(l));
  const body = chunks.join('');
  assert.match(body, /hello/);
  assert.match(body, /\[DONE\]/);
  assert.match(body, /"finish_reason":"stop"/);
});

test('ResponsesStreamTranslator replays full output when only completed arrives', () => {
  const tr = new ResponsesStreamTranslator('mock/mock-spark');
  const out = tr.push(
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FULL' }] }], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } })}`
  );
  assert.match(out.join(''), /FULL/);
});
