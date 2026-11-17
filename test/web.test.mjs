import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createApplication } from '../lib/web.mjs';
import { readSseData } from '../web/stream.mjs';

test('serves solver, tool pages and local assets without caching, credentials, or third-party scripts', async () => {
  let calls = 0;
  const app = createApplication({ relay: async () => { calls++; return new Response('api'); } });
  for (const [path, type] of [['/', 'text/html'], ['/chat', 'text/html'], ['/paste', 'text/html'], ['/chat.css', 'text/css'], ['/chat.mjs', 'text/javascript'], ['/stream.mjs', 'text/javascript']]) {
    const response = await app(new Request(`https://relay.example${path}`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    const source = await response.text();
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/);
    if (path === '/') assert.doesNotMatch(source, /<script[^>]+src="https?:/);
  }
  assert.equal(calls, 0);
  assert.equal((await app(new Request('https://relay.example/health'))).status, 200);
  assert.equal(calls, 1);
  assert.equal((await app(new Request('https://relay.example/', { method: 'POST' }))).status, 405);
});

test('SSE decoding handles split UTF-8, split CRLF, multiline data, and a final event without a separator', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"text":"Halo 🌿"}\r\n\r\ndata: {"n":\r\ndata: 2}\r\n\r\ndata: [DONE]');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const events = [];
  for await (const data of readSseData(stream)) events.push(data);
  assert.deepEqual(events, ['{"text":"Halo 🌿"}', '{"n":\n2}', '[DONE]']);
});

test('leaving the SSE reader cancels the network stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  }, cancel() { cancelled = true; } });
  for await (const _data of readSseData(stream)) break;
  assert.equal(cancelled, true);
});

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../web/chat.mjs', import.meta.url), 'utf8')
  .replace("import { readSseData } from './stream.mjs';", 'const { readSseData } = window.testHelpers;');

function createPage(fetchImpl) {
  const dom = new JSDOM(html, { url: 'https://relay.example/chat', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.AbortController = AbortController;
  window.AbortSignal = AbortSignal;
  window.fetch = fetchImpl;
  window.testHelpers = { readSseData };
  window.Storage.prototype.setItem = () => assert.fail('must not persist browser state');
  Object.defineProperty(window.document, 'cookie', { get: () => '', set: () => assert.fail('must not write cookies') });
  window.eval(source);
  window.document.dispatchEvent(new window.CustomEvent('relay:show-chat'));
  return { dom, window, document: window.document };
}

async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(setImmediate);
  }
  assert.fail('DOM interaction did not reach the expected state');
}

function submit(page, id) {
  page.document.getElementById(id).dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
}

test('chat UI validates a token, streams a safe answer, clears history, and forgets authentication on navigation', async () => {
  const fakeToken = 'test-only-token';
  const requests = [];
  const answer = 'Halo **teman**.\n\n```html\n<img src=x onerror=alert(1)>\n```';
  const page = createPage(async (url, init) => {
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'omit');
    if (url === '/v1/models') {
      if (init.headers.authorization !== `Bearer ${fakeToken}`) return new Response('{}', { status: 401 });
      return Response.json({ data: [{ id: 'other-model' }, { id: 'simple-setting-and-looking' }] });
    }
    assert.equal(url, '/v1/chat/completions');
    requests.push(JSON.parse(init.body));
    const text = `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  });
  const get = (id) => page.document.getElementById(id);
  assert.equal(get('connectionDialog').open, true);
  assert.equal(get('promptInput').disabled, true);
  get('tokenInput').value = 'bad'; submit(page, 'connectionForm');
  await until(() => !get('connectionError').hidden);
  assert.match(get('connectionError').textContent, /Token belum cocok/);
  get('tokenInput').value = fakeToken; submit(page, 'connectionForm');
  await until(() => !get('connectionDialog').open);
  assert.equal(get('tokenInput').value, '');
  assert.equal(get('modelSelect').value, 'simple-setting-and-looking');
  get('promptInput').value = 'Pertanyaan pertama'; submit(page, 'chatForm');
  await until(() => page.document.querySelector('.message-actions button'));
  assert.equal(requests[0].messages.length, 1);
  assert.equal(requests[0].messages[0].content, 'Pertanyaan pertama');
  assert.equal(page.document.querySelector('.message-body strong').textContent, 'teman');
  assert.equal(page.document.querySelector('img'), null, 'model text must not become executable HTML');
  assert.match(page.document.querySelector('.message-body pre').textContent, /<img/);
  assert.equal(page.window.localStorage.length, 0);
  assert.equal(page.window.sessionStorage.length, 0);
  get('newChatButton').click();
  assert.equal(get('messages').children.length, 0);
  assert.equal(get('welcome').hidden, false);
  get('promptInput').value = 'Pertanyaan baru'; submit(page, 'chatForm');
  await until(() => page.document.querySelector('.message-actions button'));
  assert.equal(requests[1].messages.length, 1, 'new chat must not send the previous conversation');
  page.window.dispatchEvent(new page.window.Event('pagehide'));
  assert.equal(get('messages').children.length, 0);
  assert.equal(get('promptInput').disabled, true);
  assert.equal(get('tokenInput').value, '');
  page.dom.window.close();
  const fresh = createPage(async () => assert.fail('fresh page should not authenticate automatically'));
  assert.equal(fresh.document.getElementById('messages').children.length, 0);
  assert.equal(fresh.document.getElementById('connectionDialog').open, true);
  fresh.dom.window.close();
});
