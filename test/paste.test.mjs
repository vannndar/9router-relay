import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { PasteStore } from '../clipboard/store.mjs';
import { createPasteGateway } from '../lib/paste.mjs';

const roomA = '012345';
const roomB = 'ABCDEFGHIJKLMNOPQRSTUV';

test('SQLite paste store isolates rooms, enforces limits, and expires content', () => {
  let now = Date.now();
  const store = new PasteStore(':memory:', { now: () => now, maxPerRoom: 2 });
  try {
    const first = store.add(roomA, 'temporary note', 600);
    store.add(roomB, 'other room', 3600);
    assert.equal(store.list(roomA).length, 1);
    store.remove(roomB, first.id);
    assert.equal(store.list(roomA).length, 1, 'a different room must not delete this note');
    assert.equal(store.list(roomB)[0].text, 'other room');
    store.add(roomA, 'second', 600);
    assert.throws(() => store.add(roomA, 'third'), /Ruang penuh/);
    assert.throws(() => store.add(roomA, 'x'.repeat(1_000_001)), /1 MB/);
    assert.throws(() => store.add(roomA, 'bad ttl', 2), /Masa berlaku/);
    assert.throws(() => store.list('../another-room'), /tidak valid/);
    for (const value of ['12345', '1234567', 'abcdef', '123 456']) {
      assert.throws(() => store.list(value), /tidak valid/);
    }
    now += 600_001;
    assert.equal(store.list(roomA).length, 0);
    assert.equal(store.list(roomB).length, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM notes').get().n, 1);
    assert.notEqual(store.db.prepare('SELECT room_hash FROM notes').get().room_hash, roomB);
  } finally { store.close(); }
});

test('SQLite keeps unexpired content across a backend restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-paste-test-'));
  const path = join(dir, 'paste.sqlite');
  let store = new PasteStore(path);
  try {
    store.add(roomA, 'survives restart');
    store.close();
    store = new PasteStore(path);
    assert.equal(store.list(roomA)[0].text, 'survives restart');
  } finally {
    store.close();
    unlinkSync(path);
    rmdirSync(dir);
  }
});

test('paste gateway needs no model token, pins the backend, and keeps backend credentials private', async () => {
  const env = { PASTE_UPSTREAM_URL: 'https://backend.example/_paste/notes', PASTE_BACKEND_KEY: 'k'.repeat(40) };
  let calls = 0;
  const gateway = createPasteGateway({ env, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url.href, env.PASTE_UPSTREAM_URL);
    assert.equal(init.headers.get('x-paste-room'), roomA);
    assert.equal(init.headers.get('x-paste-backend-key'), env.PASTE_BACKEND_KEY);
    assert.equal(init.headers.has('authorization'), false);
    assert.equal(init.headers.has('cookie'), false);
    assert.equal(init.redirect, 'manual');
    return Response.json({ notes: [] }, { headers: { etag: '"version"', 'set-cookie': 'unexpected=value' } });
  } });
  const response = await gateway(new Request('https://relay.example/api/paste', {
    headers: { 'x-paste-room': roomA, 'x-relay-target': 'https://evil.example', cookie: 'private=1' },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-paste-backend-key'), null);
  assert.equal(calls, 1);
  assert.equal((await gateway(new Request('https://relay.example/api/paste'))).status, 400);
  assert.equal((await gateway(new Request('https://relay.example/api/paste', {
    headers: { 'x-paste-room': roomA, origin: 'https://evil.example' },
  }))).status, 403);
  const unconfigured = createPasteGateway({ env: {}, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal((await unconfigured(new Request('https://relay.example/api/paste', {
    headers: { 'x-paste-room': roomA },
  }))).status, 503);
});

test('paste gateway preserves conditional reads and rejects oversized posts before forwarding', async () => {
  const gateway = createPasteGateway({ env: { PASTE_UPSTREAM_URL: 'https://backend.example/_paste/notes', PASTE_BACKEND_KEY: 'k'.repeat(40) },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.get('if-none-match'), '"version"');
      return new Response(null, { status: 304, headers: { etag: '"version"' } });
    } });
  const headers = { 'x-paste-room': roomA, 'if-none-match': '"version"' };
  const response = await gateway(new Request('https://relay.example/api/paste', { headers }));
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
  assert.equal((await gateway(new Request('https://relay.example/api/paste', { method: 'POST', headers, body: 'x'.repeat(4_000_001) }))).status, 413);
});

async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(setImmediate); }
  assert.fail('Paste UI did not reach the expected state');
}

test('two device sessions share pasted text and deletions without login or browser storage', async () => {
  const store = new PasteStore();
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../web/paste.mjs', import.meta.url), 'utf8');
  const pages = [];
  function page(room) {
    const dom = new JSDOM(html, { url: `https://relay.example/paste${room ? `#r=${room}` : ''}`, runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window;
    window.AbortController = AbortController;
    window.AbortSignal = AbortSignal;
    window.TextEncoder = TextEncoder;
    window.Storage.prototype.setItem = () => assert.fail('must not write browser storage');
    window.fetch = async (url, init) => {
      assert.equal(init.headers.authorization, undefined, 'paste must not require a login token');
      assert.equal(init.credentials, 'omit');
      const requestedRoom = init.headers['x-paste-room'];
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        return Response.json({ note: store.add(requestedRoom, body.text, body.ttlSeconds, body.subject) }, { status: 201 });
      }
      if (init.method === 'DELETE') { store.remove(requestedRoom, url.split('/').at(-1)); return new Response(null, { status: 204 }); }
      const notes = store.list(requestedRoom);
      const etag = store.etag(notes);
      if (init.headers['if-none-match'] === etag) return new Response(null, { status: 304 });
      return Response.json({ notes }, { headers: { etag } });
    };
    window.eval(script);
    const result = { dom, window, get: (id) => window.document.getElementById(id) };
    pages.push(result); return result;
  }
  try {
    const landing = page();
    assert.equal(landing.window.location.hash, '', 'opening the page should not silently create a room');
    assert.equal(landing.get('pasteInput').disabled, true);
    landing.get('newRoomButton').click();
    assert.match(landing.get('roomName').textContent, /^\d{6}$/);
    assert.equal(landing.get('pasteInput').disabled, false);
    landing.get('pasteInput').value = '😀';
    landing.get('pasteInput').dispatchEvent(new landing.window.Event('input'));
    assert.equal(landing.get('pasteSize').textContent, '4 B');
    landing.get('pasteInput').value = 'x'.repeat(1_000_000);
    landing.get('pasteInput').dispatchEvent(new landing.window.Event('input'));
    assert.equal(landing.get('pasteSize').textContent, '1 MB');
    assert.equal(landing.get('publishPasteButton').disabled, false);
    landing.get('pasteInput').value += 'é';
    landing.get('pasteInput').dispatchEvent(new landing.window.Event('input'));
    assert.equal(landing.get('publishPasteButton').disabled, true);
    assert.match(landing.get('pasteInput').validationMessage, /1 MB/);
    landing.get('pasteSubject').value = 'Draft';
    landing.get('pasteInput').value = 'Belum dikirim';
    landing.get('newRoomButton').click();
    assert.equal(landing.get('pasteSubject').value, 'Draft');
    assert.equal(landing.get('pasteInput').value, 'Belum dikirim');
    const a = page(roomA);
    const b = page(roomB);
    const other = page(roomB);
    await until(() => a.get('pasteSyncStatus').textContent.includes('Tersinkron') && b.get('pasteSyncStatus').textContent.includes('Tersinkron'));
    assert.equal(a.get('roomName').textContent, roomA, 'show every digit, including the leading zero');
    assert.equal(b.get('roomName').textContent, roomB, 'old room codes are displayed in full too');
    for (const value of [roomA, '012 345', '012-345', `https://relay.example/paste#r=${roomA}`, `/#r=${roomA}`, `#r=${roomA}`]) {
      b.get('joinRoomInput').value = value;
      b.get('joinRoomForm').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
      assert.equal(b.get('roomName').textContent, roomA, value);
      await until(() => b.get('pasteSyncStatus').textContent.includes('Tersinkron'));
    }
    b.get('joinRoomInput').value = '01234';
    b.get('joinRoomForm').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(b.get('roomName').textContent, roomA, 'an invalid entry must keep the current room');
    assert.match(b.get('pasteNotice').textContent, /6 angka/);
    assert.equal(a.get('connectionDialog').open, false, 'paste page must not display a login dialog');
    a.get('pasteInput').value = '<img src=x onerror=alert(1)> copied from device A';
    a.get('pasteForm').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => a.get('pasteList').querySelector('.paste-card'));
    b.window.dispatchEvent(new b.window.Event('focus'));
    await until(() => b.get('pasteList').querySelector('.paste-card'));
    assert.match(b.get('pasteList').textContent, /copied from device A/);
    assert.equal(b.get('pasteList').querySelector('h3').textContent, 'Memo 1');
    a.get('pasteSubject').value = 'Laporan bulan';
    a.get('pasteInput').value = 'Anggaran Januari';
    a.get('pasteForm').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => a.get('pasteList').querySelectorAll('.paste-card').length === 2);
    for (const search of ['LAPORAN', 'januari']) {
      a.get('pasteSearch').value = search;
      a.get('pasteSearch').dispatchEvent(new a.window.Event('input'));
      assert.equal(a.get('pasteList').querySelectorAll('.paste-card').length, 1);
      assert.equal(a.get('pasteList').querySelector('h3').textContent, 'Laporan bulan');
    }
    a.get('pasteSearch').value = 'no matching memo';
    a.get('pasteSearch').dispatchEvent(new a.window.Event('input'));
    assert.equal(a.get('pasteList').querySelector('.paste-card'), null);
    assert.match(a.get('pasteList').textContent, /Tidak ada memo/);
    a.get('clearSearchButton').click();
    assert.equal(a.get('pasteList').querySelectorAll('.paste-card').length, 2);
    a.get('pasteList').querySelector('[aria-label="Hapus teks ini dari ruang"]').click();
    await until(() => a.get('pasteList').querySelectorAll('.paste-card').length === 1);
    assert.equal(b.window.document.querySelector('img'), null, 'pasted HTML must stay plain text');
    assert.equal(other.get('pasteList').querySelector('.paste-card'), null, 'different room stays isolated');
    b.get('pasteList').querySelector('[aria-label="Hapus teks ini dari ruang"]').click();
    await until(() => !b.get('pasteList').querySelector('.paste-card'));
    a.window.dispatchEvent(new a.window.Event('focus'));
    await until(() => !a.get('pasteList').querySelector('.paste-card'));
    a.get('pasteInput').value = 'x'.repeat(1_000_000);
    a.get('pasteForm').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => a.get('pasteList').querySelector('.paste-expand'));
    assert(a.get('pasteList').querySelector('.paste-text').textContent.length < 20_000);
    a.get('pasteList').querySelector('.paste-expand').click();
    assert.equal(a.get('pasteList').querySelector('.paste-text').textContent.length, 1_000_000);
    a.get('pasteList').querySelector('.paste-expand').click();
    let longCopy = '';
    Object.defineProperty(a.window.navigator, 'clipboard', { value: { writeText: async value => { longCopy = value; } }, configurable: true });
    a.get('pasteList').querySelector('.paste-card-actions button').click();
    await until(() => longCopy.length === 1_000_000);
    a.get('pasteList').querySelector('[aria-label="Hapus teks ini dari ruang"]').click();
    await until(() => !a.get('pasteList').querySelector('.paste-card'));
    a.get('newRoomButton').click();
    assert.match(a.get('roomName').textContent, /^\d{6}$/);
    let copied = '';
    Object.defineProperty(a.window.navigator, 'clipboard', { value: { writeText: async (value) => { copied = value; } }, configurable: true });
    a.get('copyCodeButton').click();
    await until(() => copied === a.get('roomName').textContent);
    a.get('copyRoomButton').click();
    await until(() => copied === `https://relay.example/paste#r=${a.get('roomName').textContent}`);
    Object.defineProperty(a.window.navigator, 'clipboard', { value: undefined, configurable: true });
    a.get('copyCodeButton').click();
    await until(() => !a.get('roomLinkFallback').hidden);
    assert.equal(a.get('roomLinkFallback').value, a.get('roomName').textContent, 'manual copy fallback uses the complete code');
    for (const p of pages) { assert.equal(p.window.localStorage.length, 0); assert.equal(p.window.sessionStorage.length, 0); }
  } finally {
    for (const p of pages) { p.window.dispatchEvent(new p.window.Event('pagehide')); p.dom.window.close(); }
    store.close();
  }
});
