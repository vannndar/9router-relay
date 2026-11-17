import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { readSseData } from '../web/stream.mjs';

const base = process.env.CHECK_BASE_URL || 'http://127.0.0.1:3018';
const room = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
const [html, pasteScript, chatScript] = await Promise.all(['/paste', '/paste.mjs', '/chat.mjs'].map(async (path) => {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.text();
}));
assert.equal(pasteScript, readFileSync(new URL('../web/paste.mjs', import.meta.url), 'utf8'));
const pages = [];
function device(roomCode = room) {
  const dom = new JSDOM(html, { url: `${base}/paste#r=${roomCode}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.AbortController = AbortController;
  window.AbortSignal = AbortSignal;
  window.TextEncoder = TextEncoder;
  window.testHelpers = { readSseData };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.Storage.prototype.setItem = () => assert.fail('unexpected browser storage');
  window.fetch = (url, init) => {
    const target = new URL(url, base);
    assert.equal(target.origin, base);
    assert.equal(init.headers.authorization, undefined, 'paste does not need a login');
    return fetch(target, { ...init, headers: { ...init.headers, origin: base } });
  };
  window.eval(chatScript.replace("import { readSseData } from './stream.mjs';", 'const { readSseData } = window.testHelpers;'));
  window.eval(pasteScript);
  const page = { dom, window, get: (id) => window.document.getElementById(id) };
  pages.push(page); return page;
}
async function until(check) {
  const started = Date.now();
  while (!check()) {
    assert(Date.now() - started < 40_000, 'live clipboard UI timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
try {
  const a = device();
  const b = device(randomBytes(16).toString('base64url'));
  assert.equal(a.get('connectionDialog').open, false);
  assert.equal(a.get('pastePanel').hidden, false);
  await until(() => a.get('pasteSyncStatus').textContent.includes('Tersinkron') && b.get('pasteSyncStatus').textContent.includes('Tersinkron'));
  assert.equal(a.get('roomName').textContent, room);
  b.get('joinRoomInput').value = `${room.slice(0, 3)} ${room.slice(3)}`;
  b.get('joinRoomForm').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => b.get('roomName').textContent === room && b.get('pasteSyncStatus').textContent.includes('Tersinkron'));
  a.get('pasteInput').value = 'Temporary live UI test from device A.';
  a.get('pasteSubject').value = 'Pemeriksaan memo';
  a.get('pasteForm').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => a.get('pasteList').querySelector('.paste-card'));
  b.window.dispatchEvent(new b.window.Event('focus'));
  await until(() => b.get('pasteList').querySelector('.paste-card'));
  assert.match(b.get('pasteList').textContent, /Temporary live UI test from device A/);
  assert.equal(b.get('pasteList').querySelector('h3').textContent, 'Pemeriksaan memo');
  b.get('pasteSearch').value = 'PEMERIKSAAN';
  b.get('pasteSearch').dispatchEvent(new b.window.Event('input'));
  assert(b.get('pasteList').querySelector('.paste-card'));
  b.get('pasteSearch').value = 'no matching memo';
  b.get('pasteSearch').dispatchEvent(new b.window.Event('input'));
  assert.equal(b.get('pasteList').querySelector('.paste-card'), null);
  b.get('clearSearchButton').click();
  assert(b.get('pasteList').querySelector('.paste-card'));
  b.get('pasteList').querySelector('[aria-label="Hapus teks ini dari ruang"]').click();
  await until(() => !b.get('pasteList').querySelector('.paste-card'));
  a.window.dispatchEvent(new a.window.Event('focus'));
  await until(() => !a.get('pasteList').querySelector('.paste-card'));
  assert.equal(b.get('chatTab').getAttribute('href'), '/chat');
  const chatDom = new JSDOM(html, { url: `${base}/chat`, runScripts: 'outside-only', pretendToBeVisual: true });
  chatDom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  chatDom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  chatDom.window.testHelpers = { readSseData };
  chatDom.window.fetch = () => assert.fail('chat page must not start paste polling');
  chatDom.window.eval(chatScript.replace("import { readSseData } from './stream.mjs';", 'const { readSseData } = window.testHelpers;'));
  chatDom.window.eval(pasteScript);
  assert.equal(chatDom.window.document.getElementById('chatPanel').hidden, false);
  assert.equal(chatDom.window.document.getElementById('connectionDialog').open, true, 'chat authentication stays available separately');
  chatDom.window.close();
  assert(pages.every((p) => p.window.localStorage.length === 0 && p.window.sessionStorage.length === 0));
  console.log(JSON.stringify({ livePasteUI: 'passed', twoDevices: 'passed', noPasteLogin: true,
    crossDeviceDelete: 'passed', browserStorageWrites: 0, chatPage: 'passed', visualQA: 'not run by this DOM check' }));
} finally {
  for (const page of pages) { page.window.dispatchEvent(new page.window.Event('pagehide')); page.dom.window.close(); }
  const response = await fetch(`${base}/api/paste`, { headers: { 'x-paste-room': room } });
  if (response.ok) for (const note of (await response.json()).notes) {
    await fetch(`${base}/api/paste/${note.id}`, { method: 'DELETE', headers: { 'x-paste-room': room } });
  }
}
