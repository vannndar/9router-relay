import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPasteGateway } from '../lib/paste.mjs';

const env = { PASTE_STORAGE: 'supabase', SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test_only' };
const room = '012345';
const hash = createHash('sha256').update(room).digest('hex');
const noteId = '12345678-1234-1234-1234-123456789abc';
const request = (method = 'GET', body, extraHeaders = {}, suffix = '') => new Request(`https://relay.example/api/paste${suffix}`, {
  method, headers: { 'x-paste-room': room, ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body),
});

test('Supabase reads preserve the browser contract, use room hashes, hide expired notes, and support ETags', async () => {
  const gateway = createPasteGateway({ env, fetchImpl: async (url, init) => {
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(url.pathname, '/rest/v1/paste_notes');
    assert.equal(url.searchParams.get('room_hash'), `eq.${hash}`);
    assert.match(url.searchParams.get('expires_at'), /^gt\.\d{4}-/);
    assert(['id,subject,text,created_at,expires_at,file_name,file_size,file_type', 'id,subject,created_at,expires_at,file_name,file_size,file_type'].includes(url.searchParams.get('select')));
    assert.equal(url.searchParams.get('or'), '(file_status.is.null,file_status.eq.ready)');
    assert.equal(init.headers.get('apikey'), env.SUPABASE_SECRET_KEY);
    assert.equal(init.headers.has('authorization'), false);
    assert.equal(init.headers.has('cookie'), false);
    assert.equal(init.redirect, 'manual');
    return Response.json([{ id: noteId, subject: 'Memo 1', text: 'hello', created_at: '2026-11-12T00:00:00Z', expires_at: '2026-11-12T01:00:00Z' }], {
      headers: { 'set-cookie': 'never=forward' },
    });
  } });
  const response = await gateway(request('GET', undefined, { cookie: 'private=1' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('apikey'), null);
  const { notes } = await response.json();
  assert.deepEqual(notes, [{ id: noteId, subject: 'Memo 1', text: 'hello', createdAt: Date.parse('2026-11-12T00:00:00Z'), expiresAt: Date.parse('2026-11-12T01:00:00Z') }]);
  const cached = await gateway(request('GET', undefined, { 'if-none-match': `W/${response.headers.get('etag')}` }));
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
});

test('Supabase posts validate input, keep server credentials private, and preserve database errors', async () => {
  let calls = 0;
  const gateway = createPasteGateway({ env, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url.pathname, '/rest/v1/rpc/paste_note_add');
    assert.deepEqual(JSON.parse(init.body), { p_room_hash: hash, p_text: 'from A', p_ttl_seconds: 600, p_subject: '' });
    return Response.json(calls === 1 ? { note: { id: noteId } } : { status: 429, error: { message: 'Terlalu banyak kiriman. Tunggu sebentar.' } });
  } });
  assert.equal((await gateway(request('POST', { text: 'from A', ttlSeconds: 600 }))).status, 201);
  const limited = await gateway(request('POST', { text: 'from A', ttlSeconds: 600 }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  for (const [body, status] of [[null, 400], [[], 400], [{ text: ' ' }, 400], [{ text: 'x', ttlSeconds: 1 }, 400], [{ text: 'x', subject: 'a'.repeat(121) }, 400], [{ text: 'x', subject: 123 }, 400], [{ text: '😀'.repeat(250001) }, 413]]) {
    assert.equal((await gateway(request('POST', body))).status, status);
  }
  const invalidJson = new Request('https://relay.example/api/paste', { method: 'POST', headers: { 'x-paste-room': room }, body: '{' });
  assert.equal((await gateway(invalidJson)).status, 400);
  assert.equal(calls, 2, 'invalid posts must not reach Supabase');
});

test('one MB posts survive JSON escaping; oversized UTF-8 text is rejected', async () => {
  let calls = 0;
  const gateway = createPasteGateway({ env, fetchImpl: async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(Buffer.byteLength(body.p_text, 'utf8'), 1_000_000);
    return Response.json({ note: { id: noteId } });
  } });
  for (const text of ['x'.repeat(1_000_000), '😀'.repeat(250_000), 'a\n'.repeat(500_000)]) {
    assert.equal((await gateway(request('POST', { text }))).status, 201);
  }
  assert.equal((await gateway(request('POST', { text: 'x'.repeat(1_000_001) }))).status, 413);
  assert.equal(calls, 3);
});

test('multiple large memos stream intact and conditional polling fetches metadata only', async () => {
  let fullReads = 0, metadataReads = 0;
  const notes = Array.from({ length: 5 }, (_, index) => ({ id: `large-${index}`, subject: `Memo ${index + 1}`, text: 'x'.repeat(1_000_000),
    created_at: '2026-11-13T00:00:00Z', expires_at: '2026-11-14T00:00:00Z' }));
  const gateway = createPasteGateway({ env, fetchImpl: async url => {
    const metadata = !url.searchParams.get('select').split(',').includes('text');
    if (metadata) { metadataReads++; return Response.json(notes.map(({ text, ...note }) => note)); }
    fullReads++; return Response.json(notes);
  } });
  const response = await gateway(request());
  const payload = await response.json();
  assert.equal(payload.notes.length, 5);
  assert(payload.notes.every(note => note.text.length === 1_000_000));
  const unchanged = await gateway(request('GET', undefined, { 'if-none-match': response.headers.get('etag') }));
  assert.equal(unchanged.status, 304);
  assert.equal(fullReads, 1);
  assert.equal(metadataReads, 1);
});

test('Supabase deletes always filter by both room and note and never leak upstream failures', async () => {
  const gateway = createPasteGateway({ env, fetchImpl: async (url, init) => {
    assert(['GET', 'DELETE'].includes(init.method));
    assert.equal(url.searchParams.get('room_hash'), `eq.${hash}`);
    assert.equal(url.searchParams.get('id'), `eq.${noteId}`);
    return init.method === 'GET' ? Response.json([]) : new Response(null, { status: 204 });
  } });
  assert.equal((await gateway(request('DELETE', undefined, {}, `/${noteId}`))).status, 204);
  for (const result of [new Response('database details and credentials', { status: 500 }), new Response(null, { status: 302 })]) {
    const failed = createPasteGateway({ env, fetchImpl: async () => result });
    const response = await failed(request());
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /credentials|sb_secret/);
  }
});

test('Supabase requires a server key, pins its destination, and retains origin and room checks', async () => {
  const neverFetch = () => assert.fail('invalid requests must not fetch');
  for (const config of [{ ...env, SUPABASE_SECRET_KEY: '' }, { ...env, SUPABASE_SECRET_KEY: 'sb_publishable_test' },
    { ...env, SUPABASE_URL: 'https://evil.example' }, { ...env, SUPABASE_URL: `${env.SUPABASE_URL}/other` },
    { ...env, PASTE_STORAGE: 'typo' }]) {
    const gateway = createPasteGateway({ env: config, fetchImpl: neverFetch });
    assert.equal((await gateway(request())).status, 503);
  }
  const gateway = createPasteGateway({ env, fetchImpl: neverFetch });
  assert.equal((await gateway(request('GET', undefined, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await gateway(request('GET', undefined, { 'x-paste-room': '12345' }))).status, 400);
});
