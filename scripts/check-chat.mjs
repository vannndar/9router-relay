import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { readSseData } from '../web/stream.mjs';

const base = process.env.CHECK_BASE_URL || 'http://127.0.0.1:3018';
const assets = await Promise.all(['/chat', '/chat.mjs', '/stream.mjs', '/chat.css'].map(async (path) => {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.text();
}));
assert.equal(assets[1], readFileSync(new URL('../web/chat.mjs', import.meta.url), 'utf8'));
assert.equal(assets[2], readFileSync(new URL('../web/stream.mjs', import.meta.url), 'utf8'));
const dom = new JSDOM(assets[0], { url: `${base}/chat`, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const get = (id) => window.document.getElementById(id);
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.AbortController = AbortController;
window.AbortSignal = AbortSignal;
window.testHelpers = { readSseData };
const origins = new Set();
window.fetch = (url, init) => {
  const target = new URL(url, base);
  origins.add(target.origin);
  assert.equal(target.origin, base, 'browser requests must stay on the Vercel origin');
  return fetch(target, init);
};
window.Storage.prototype.setItem = () => assert.fail('unexpected browser storage write');
Object.defineProperty(window.document, 'cookie', { get: () => '', set: () => assert.fail('unexpected cookie write') });
window.eval(assets[1].replace("import { readSseData } from './stream.mjs';", 'const { readSseData } = window.testHelpers;'));
window.document.dispatchEvent(new window.CustomEvent('relay:show-chat'));
const submit = (id) => get(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
async function until(condition) {
  const start = Date.now();
  while (!condition()) {
    assert(Date.now() - start < 60_000, 'live DOM check timed out');
    if (!get('connectionError').hidden) throw new Error(get('connectionError').textContent);
    if (!get('notice').hidden) throw new Error(get('notice').textContent);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
try {
  get('tokenInput').value = process.env.RELAY_API_KEY;
  submit('connectionForm');
  await until(() => !get('connectionDialog').open);
  assert.equal(get('tokenInput').value, '');
  const modelCount = get('modelSelect').options.length;
  get('promptInput').value = 'Uji chat sementara relay-session-20261104. Jawab hanya OK.';
  submit('chatForm');
  await until(() => window.document.querySelector('.message-actions button'));
  assert.match(window.document.querySelector('.assistant .message-body').textContent, /OK/i);
  assert.equal(window.localStorage.length, 0);
  assert.equal(window.sessionStorage.length, 0);
  get('newChatButton').click();
  assert.equal(get('messages').children.length, 0);
  window.dispatchEvent(new window.Event('pagehide'));
  assert.equal(get('promptInput').disabled, true);
  assert.equal(get('tokenInput').value, '');
  console.log(JSON.stringify({ chat: 'passed', modelCount, requestsStayOnVercel: origins.size === 1,
    browserStorageWrites: 0, newChatClearsHistory: true, navigationClearsToken: true,
    visualBrowserQA: 'not run by this DOM check' }));
} finally {
  dom.window.close();
}
