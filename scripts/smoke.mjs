import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const base = (args.includes('--url') ? option('--url') : 'http://127.0.0.1:3018').replace(/\/$/, '');
const headers = { authorization: `Bearer ${process.env.RELAY_API_KEY}` };

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200, 'health');
const unauthorized = await fetch(`${base}/v1/models`);
assert.equal(unauthorized.status, 401, 'missing credentials must be rejected');
const forbidden = await fetch(`${base}/api/keys`, { headers });
assert.equal(forbidden.status, 404, 'dashboard endpoints must not be forwarded');
const modelsResponse = await fetch(`${base}/v1/models`, { headers });
assert.equal(modelsResponse.status, 200, `models returned ${modelsResponse.status}`);
const models = await modelsResponse.json();
assert(Array.isArray(models.data), 'models must be an OpenAI-compatible list');
console.log(JSON.stringify({ health: health.status, unauthorized: unauthorized.status,
  adminBlocked: forbidden.status, models: models.data.length }));

if (args.includes('--model')) {
  const model = option('--model');
  const start = Date.now();
  const completion = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with only OK.' }],
      max_tokens: 20, stream: true }),
    signal: AbortSignal.timeout(90_000),
  });
  assert.equal(completion.status, 200, `completion returned ${completion.status}: ${(completion.status !== 200 ? await completion.text() : '').slice(0, 300)}`);
  assert.match(completion.headers.get('content-type') || '', /text\/event-stream/);
  let chunks = 0;
  let firstChunkMs;
  let transcript = '';
  for await (const chunk of completion.body) {
    chunks += 1;
    firstChunkMs ??= Date.now() - start;
    transcript += new TextDecoder().decode(chunk);
  }
  assert.match(transcript, /data:/);
  assert.match(transcript, /"content"\s*:/, 'stream should include generated content');
  // Some 9Router adapters close after a final finish_reason instead of emitting [DONE].
  const finishReason = transcript.match(/"finish_reason"\s*:\s*"([^"]+)"/)?.[1];
  const doneMarker = transcript.includes('[DONE]');
  assert(doneMarker || finishReason, 'stream must include an explicit completion marker');
  console.log(JSON.stringify({ streaming: 'passed', model, chunks, firstChunkMs,
    totalMs: Date.now() - start, doneMarker, finishReason }));

  if (args.includes('--tools')) {
    const messages = [{ role: 'user', content: 'Call relay_probe with message OK. Use the tool before answering.' }];
    const tools = [{ type: 'function', function: { name: 'relay_probe',
      description: 'Return a short message to verify tool transport.',
      parameters: { type: 'object', properties: { message: { type: 'string' } },
        required: ['message'], additionalProperties: false } } }];
    const callModel = async (body) => {
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 256, stream: false, ...body }),
        signal: AbortSignal.timeout(90_000) });
      assert.equal(response.status, 200, `tool request returned ${response.status}`);
      return response.json();
    };
    const first = await callModel({ messages, tools,
      tool_choice: { type: 'function', function: { name: 'relay_probe' } } });
    const assistant = first.choices?.[0]?.message;
    assert(assistant?.tool_calls?.length, 'model must return a tool call');
    const call = assistant.tool_calls[0];
    assert.equal(call.function.name, 'relay_probe');
    const input = JSON.parse(call.function.arguments);
    assert.equal(input.message, 'OK');
    const final = await callModel({ tools, tool_choice: 'none', messages: [
      ...messages, assistant, { role: 'tool', tool_call_id: call.id,
        content: JSON.stringify({ message: input.message, verified: true }) },
    ] });
    assert(final.choices?.[0]?.message?.content, 'model must answer after the tool result');
    console.log(JSON.stringify({ toolRoundTrip: 'passed', tool: call.function.name }));
  }
}
