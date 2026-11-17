import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../lib/relay.mjs';

const env = {
  UPSTREAM_ORIGIN: 'https://backend.example',
  UPSTREAM_API_KEY: 'private-upstream-key',
  RELAY_API_KEY: 'relay-key-'.repeat(6),
};
const auth = { authorization: `Bearer ${env.RELAY_API_KEY}` };
const request = (path, init = {}) => new Request(`https://relay.example${path}`, {
  ...init, headers: { ...auth, ...init.headers },
});

test('fails closed when credentials or upstream configuration are invalid', async () => {
  for (const override of [{ RELAY_API_KEY: 'short' }, { UPSTREAM_API_KEY: '' },
    { UPSTREAM_ORIGIN: 'http://localhost:1234' }, { UPSTREAM_ORIGIN: 'https://host.test/admin' }]) {
    const relay = createRelay({ env: { ...env, ...override }, fetchImpl: () => assert.fail('must not fetch') });
    assert.equal((await relay(request('/v1/models'))).status, 503);
  }
});

test('accepts health checks but rejects missing or wrong credentials before contacting upstream', async () => {
  const relay = createRelay({ env, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal((await relay(new Request('https://relay.example/health'))).status, 200);
  for (const headers of [{}, { authorization: 'Bearer invalid' }, { 'x-api-key': 'invalid' }]) {
    assert.equal((await relay(new Request('https://relay.example/v1/models', { headers }))).status, 401);
  }
});

test('blocks dashboard endpoints, traversal, and unsupported methods', async () => {
  const relay = createRelay({ env, fetchImpl: () => assert.fail('must not fetch') });
  for (const path of ['/api/keys', '/api/settings', '/v1/../api/keys', '/v1/%2e%2e/api/keys',
    '/v1/%252e%252e/api/keys', '/v1/models/../../api/keys', '//evil.example/v1/models']) {
    assert.equal((await relay(request(path))).status, 404, path);
  }
  const response = await relay(request('/v1/models', { method: 'DELETE' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('pins destination, swaps credentials, strips infrastructure headers and preserves tool-call JSON', async () => {
  const body = JSON.stringify({ model: 'combo', messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }], stream: true });
  let calls = 0;
  const relay = createRelay({ env, fetchImpl: async (target, init) => {
    calls++;
    assert.equal(target.href, 'https://backend.example/v1/chat/completions?beta=true');
    assert.equal(init.headers.get('authorization'), `Bearer ${env.UPSTREAM_API_KEY}`);
    assert.equal(init.headers.get('anthropic-beta'), 'tools-test');
    for (const name of ['cookie', 'x-api-key', 'x-relay-target', 'host', 'x-forwarded-for', 'x-vercel-id', 'x-hide']) {
      assert.equal(init.headers.has(name), false, name);
    }
    assert.equal(init.redirect, 'manual');
    assert.equal(await new Response(init.body).text(), body);
    return Response.json({ choices: [{ message: { tool_calls: [{ id: 'call_2' }] } }] });
  } });
  const response = await relay(request('/v1/chat/completions?beta=true', { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'anthropic-beta': 'tools-test',
      'x-api-key': env.RELAY_API_KEY, 'x-relay-target': 'https://evil.example', cookie: 'session=secret',
      host: 'evil.example', 'x-forwarded-for': '10.0.0.1', 'x-vercel-id': 'internal',
      connection: 'x-hide', 'x-hide': 'private' } }));
  assert.equal(calls, 1);
  assert.equal((await response.json()).choices[0].message.tool_calls[0].id, 'call_2');
});

test('supports Anthropic x-api-key authentication without leaking the relay token', async () => {
  const relay = createRelay({ env, fetchImpl: async (_target, init) => {
    assert.equal(init.headers.get('authorization'), `Bearer ${env.UPSTREAM_API_KEY}`);
    assert.equal(init.headers.has('x-api-key'), false);
    return Response.json({ type: 'message', content: [] });
  } });
  const response = await relay(new Request('https://relay.example/v1/messages', {
    method: 'POST', headers: { 'x-api-key': env.RELAY_API_KEY }, body: '{}',
  }));
  assert.equal(response.status, 200);
});

test('passes provider errors through while removing cookies and invalid compression metadata', async () => {
  const relay = createRelay({ env, fetchImpl: async () => new Response('{"error":"quota"}', {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30',
      'set-cookie': 'secret=1', 'content-encoding': 'gzip', 'content-length': '999' },
  }) });
  const response = await relay(request('/v1/models'));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(await response.text(), '{"error":"quota"}');
});

test('returns the first SSE chunk before the upstream finishes and preserves stream bytes', async () => {
  const encoder = new TextEncoder();
  let upstreamController;
  const stream = new ReadableStream({ start(controller) {
    upstreamController = controller;
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));
  } });
  const relay = createRelay({ env, fetchImpl: async () => new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  }) });
  const response = await relay(request('/v1/chat/completions', { method: 'POST', body: '{}' }));
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /OK/);
  upstreamController.enqueue(encoder.encode('data: [DONE]\n\n'));
  upstreamController.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: [DONE]\n\n');
  assert.equal((await reader.read()).done, true);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
});

test('cancelling the downstream stream cancels the upstream stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const relay = createRelay({ env, fetchImpl: async () => new Response(stream) });
  const response = await relay(request('/v1/models'));
  await response.body.cancel();
  assert.equal(cancelled, true);
});

test('does not follow upstream redirects or disclose fetch errors', async () => {
  const redirectRelay = createRelay({ env, fetchImpl: async () => new Response(null, {
    status: 302, headers: { location: 'https://another.example/private' },
  }) });
  const response = await redirectRelay(request('/v1/models'));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('location'), null);
  const failingRelay = createRelay({ env, fetchImpl: async () => { throw new Error('secret token'); } });
  assert.doesNotMatch(await (await failingRelay(request('/v1/models'))).text(), /secret token/);
});

test('aborts an upstream that does not respond within the request timeout', async () => {
  const relay = createRelay({ env, timeoutMs: 10, fetchImpl: async (_target, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('timeout test failed')), 500);
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
  }) });
  assert.equal((await relay(request('/v1/models'))).status, 504);
});
