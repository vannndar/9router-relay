import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const direct = process.argv.includes('--upstream');
const base = direct ? process.env.PASTE_UPSTREAM_URL : `${process.env.CHECK_BASE_URL || 'http://127.0.0.1:3018'}/api/paste`;
const room = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
const isolatedRoom = randomBytes(16).toString('base64url');
const headers = { 'x-paste-room': room };
if (direct) headers['x-paste-backend-key'] = process.env.PASTE_BACKEND_KEY;
else headers.origin = new URL(base).origin;
const notes = [];
async function call(method, suffix = '', body, extra = {}) {
  return fetch(`${base}${suffix}`, { method, headers: { ...headers, ...extra,
    ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
}
try {
  const missing = await fetch(base);
  assert.equal(missing.status, direct ? 401 : 400);
  const first = await call('POST', '', { text: 'Temporary sync check from device A.', ttlSeconds: 600 });
  assert.equal(first.status, 201, `create returned ${first.status}`);
  const { note } = await first.json(); notes.push(note.id);
  assert(note.expiresAt - note.createdAt === 600_000);
  const fromB = await call('GET');
  assert.equal(fromB.status, 200);
  const read = await fromB.json();
  assert.equal(read.notes[0].text, 'Temporary sync check from device A.');
  const etag = fromB.headers.get('etag');
  assert.equal((await call('GET', '', undefined, { 'if-none-match': etag })).status, 304);
  const isolated = await call('GET', '', undefined, { 'x-paste-room': isolatedRoom });
  assert.equal((await isolated.json()).notes.length, 0);
  assert.equal((await call('DELETE', `/${note.id}`)).status, 204);
  assert.equal((await (await call('GET')).json()).notes.length, 0);
  console.log(JSON.stringify({ target: direct ? 'docker-public-backend' : 'vercel',
    twoDeviceSync: 'passed', requiresLogin: false, roomIsolation: 'passed',
    conditionalRead: 'passed', deletion: 'passed', expiry: '10 minutes', testNotesRemoved: true }));
} finally {
  for (const id of notes) await call('DELETE', `/${id}`).catch(() => {});
}
