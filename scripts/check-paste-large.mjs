import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createPasteGateway } from '../lib/paste.mjs';

const production = process.argv.includes('--production');
const config = parseEnv(readFileSync(new URL('../.env.supabase.local', import.meta.url), 'utf8'));
const route = production ? fetch : createPasteGateway({ env: config });
if (production && !process.env.CHECK_BASE_URL) throw new Error('CHECK_BASE_URL is required for --production');
const base = production ? process.env.CHECK_BASE_URL : 'https://local-check.example';
const room = randomBytes(16).toString('base64url');
const ids = [];
const expected = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');
const call = (method, suffix = '', body, extra = {}) => route(new Request(`${base}/api/paste${suffix}`, {
  method, headers: { 'x-paste-room': room, ...extra }, body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(30_000),
}));
try {
  assert.equal((await call('POST', '', { text: 'x'.repeat(1_000_001) })).status, 413);
  const paragraph = 'Paragraf pengujian kapasitas memo. Ini teks buatan untuk menguji batas aplikasi.\n';
  const content = paragraph.repeat(Math.ceil(1_000_000 / paragraph.length)).slice(0, 1_000_000);
  for (let index = 0; index < 5; index++) {
    const text = `${index}${content.slice(1)}`;
    const response = await call('POST', '', { subject: `Uji kapasitas ${index + 1}`, text, ttlSeconds: 600 });
    assert.equal(response.status, 201);
    const { note } = await response.json();
    ids.push(note.id);
    assert.equal(hash(note.text), hash(text));
    expected.set(note.id, hash(text));
  }
  const response = await call('GET');
  assert.equal(response.status, 200);
  const { notes } = await response.json();
  assert.equal(notes.length, 5);
  for (const note of notes) {
    assert.equal(Buffer.byteLength(note.text, 'utf8'), 1_000_000);
    assert.equal(hash(note.text), expected.get(note.id));
  }
  assert.equal((await call('GET', '', undefined, { 'if-none-match': response.headers.get('etag') })).status, 304);
} finally {
  for (const id of ids) assert.equal((await call('DELETE', `/${id}`)).status, 204);
}
console.log(JSON.stringify({ target: production ? 'production-vercel' : 'hosted-supabase', perMemoBytes: 1_000_000,
  exactLimit: 'passed', overLimit: 'rejected', multiMemoReadBytes: 5_000_000, contentHashes: 'matched', conditionalRead: 'passed', testNotesRemoved: true }));
