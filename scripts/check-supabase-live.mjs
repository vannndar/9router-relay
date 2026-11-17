import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createPasteGateway } from '../lib/paste.mjs';

const env = parseEnv(readFileSync(new URL('../.env.supabase.local', import.meta.url), 'utf8'));
const gateway = createPasteGateway({ env });
const production = process.argv.includes('--production');
if (production && !process.env.CHECK_BASE_URL) throw new Error('CHECK_BASE_URL is required for --production');
const base = production ? process.env.CHECK_BASE_URL : 'https://local-check.example';
const room = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
const otherRoom = randomBytes(16).toString('base64url');
let noteId;
const call = (method, suffix = '', body, roomCode = room, extra = {}) => (production ? fetch : gateway)(new Request(`${base}/api/paste${suffix}`, {
  method, headers: { 'x-paste-room': roomCode, ...extra }, body: body ? JSON.stringify(body) : undefined,
}));
async function stored(id) {
  const headers = { apikey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY };
  if (env.SUPABASE_SERVICE_ROLE_KEY && !env.SUPABASE_SECRET_KEY) headers.authorization = `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/paste_notes?select=id&id=eq.${id}`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()).length === 1;
}
try {
  const created = await call('POST', '', { text: 'Disposable Supabase connection check.', ttlSeconds: 600 });
  assert.equal(created.status, 201, await created.clone().text());
  noteId = (await created.json()).note.id;
  const createdNote = (await (await call('GET')).json()).notes.find(note => note.id === noteId);
  assert.equal(createdNote.subject, 'Memo 1');
  assert(await stored(noteId), 'the note must exist in the new Supabase database');
  const read = await call('GET');
  assert.equal(read.status, 200);
  assert((await read.json()).notes.some(note => note.id === noteId));
  assert.equal((await call('GET', '', undefined, room, { 'if-none-match': read.headers.get('etag') })).status, 304);
  assert.equal((await call('GET', '', undefined, otherRoom)).status, 200);
  assert(!(await (await call('GET', '', undefined, otherRoom)).json()).notes.some(note => note.id === noteId));
  assert.equal((await call('DELETE', `/${noteId}`, undefined, otherRoom)).status, 204);
  assert((await (await call('GET')).json()).notes.some(note => note.id === noteId));
  assert.equal((await call('DELETE', `/${noteId}`)).status, 204);
  assert(!(await (await call('GET')).json()).notes.some(note => note.id === noteId));
  assert(!(await stored(noteId)), 'deletion must remove the note from Supabase too');
  console.log(JSON.stringify({ backend: production ? 'production-vercel-to-supabase' : 'hosted-supabase', createReadDelete: 'passed',
    roomIsolation: 'passed', etag: 'passed', databaseConfirmed: true, testNoteRemoved: true }));
} finally {
  if (noteId) await call('DELETE', `/${noteId}`);
}
