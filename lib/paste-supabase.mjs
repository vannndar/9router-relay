import { createHash } from 'node:crypto';
import { supabaseConnection } from './paste-supabase-config.mjs';
import { removeStoredFile } from './paste-files.mjs';

const errorResponse = (message, status, extra = {}) => Response.json({ error: { message } }, {
  status, headers: { 'cache-control': 'no-store', ...extra },
});

const notesEtag = notes => `"${createHash('sha256').update(JSON.stringify(notes.map(note => [note.id, note.subject || '',
  note.expiresAt ?? Date.parse(note.expires_at), note.file?.name ?? note.file_name ?? null, note.file?.size ?? note.file_size ?? null]))).digest('hex').slice(0, 24)}"`;

function notesResponse(notes, headers) {
  // Stream each memo so a room with several large memos stays within the hosting response contract.
  const encoder = new TextEncoder();
  function* parts() {
    yield '{"notes":[';
    for (let index = 0; index < notes.length; index++) yield `${index ? ',' : ''}${JSON.stringify(notes[index])}`;
    yield `],"serverTime":${Date.now()}}`;
  }
  const iterator = parts();
  return new Response(new ReadableStream({ pull(controller) {
    const part = iterator.next();
    if (part.done) controller.close();
    else controller.enqueue(encoder.encode(part.value));
  }, cancel() { iterator.return(); } }), { headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
}

export async function supabasePaste(request, { room, noteId, env, fetchImpl }) {
  let connection;
  try {
    connection = supabaseConnection(env);
  } catch { return errorResponse('Papan teks sedang disiapkan. Coba lagi sebentar.', 503); }
  const { base, headers } = connection;

  const roomHash = createHash('sha256').update(room).digest('hex');
  const upstream = new URL('/rest/v1/paste_notes', base);
  const init = { method: request.method, headers, redirect: 'manual',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) };

  if (request.method === 'POST') {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 4_000_000) return errorResponse('Teks terlalu panjang. Maksimal 1 MB.', 413);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return errorResponse('Format teks tidak valid.', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('Format teks tidak valid.', 400);
    if (typeof body.text !== 'string' || !body.text.trim()) return errorResponse('Masukkan teks terlebih dahulu.', 400);
    if (Buffer.byteLength(body.text, 'utf8') > 1_000_000) return errorResponse('Teks terlalu panjang. Maksimal 1 MB.', 413);
    const subject = body.subject ?? '';
    if (typeof subject !== 'string' || [...subject.trim()].length > 120) return errorResponse('Subject maksimal 120 karakter.', 400);
    const ttl = body.ttlSeconds ?? 3600;
    if (![600, 3600, 86400].includes(ttl)) return errorResponse('Masa berlaku tidak valid.', 400);
    upstream.pathname = '/rest/v1/rpc/paste_note_add';
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify({ p_room_hash: roomHash, p_text: body.text, p_ttl_seconds: ttl, p_subject: subject.trim() });
  } else {
    upstream.searchParams.set('room_hash', `eq.${roomHash}`);
    if (request.method === 'DELETE') {
      upstream.searchParams.set('id', `eq.${noteId}`);
    } else {
      upstream.searchParams.set('select', 'id,subject,text,created_at,expires_at,file_name,file_size,file_type');
      upstream.searchParams.set('or', '(file_status.is.null,file_status.eq.ready)');
      upstream.searchParams.set('expires_at', `gt.${new Date().toISOString()}`);
      upstream.searchParams.set('order', 'created_at.desc,id.desc');
      upstream.searchParams.set('limit', '25');
    }
  }

  try {
    let storedFile;
    if (request.method === 'DELETE') {
      const lookup = new URL(upstream); lookup.searchParams.set('select', 'storage_path');
      const existing = await fetchImpl(lookup, { ...init, method: 'GET' });
      if (!existing.ok) { await existing.body?.cancel(); return errorResponse('File belum bisa dihapus. Coba lagi.', 502); }
      storedFile = (await existing.json())[0]?.storage_path;
    }
    const previous = (request.headers.get('if-none-match') || '').split(',').map(tag => tag.trim().replace(/^W\//, ''));
    if (request.method === 'GET' && previous.some(Boolean)) {
      const metadataUrl = new URL(upstream);
      metadataUrl.searchParams.set('select', 'id,subject,created_at,expires_at,file_name,file_size,file_type');
      const metadata = await fetchImpl(metadataUrl, init);
      if (!metadata.ok) { await metadata.body?.cancel(); return errorResponse('Papan teks belum terhubung. Coba lagi sebentar.', 502); }
      const etag = notesEtag(await metadata.json());
      if (previous.includes(etag)) return new Response(null, { status: 304, headers: { 'cache-control': 'no-store', etag } });
    }
    const response = await fetchImpl(upstream, init);
    if (!response.ok) {
      await response.body?.cancel();
      return errorResponse('Papan teks belum terhubung. Coba lagi sebentar.', 502);
    }
    if (request.method === 'DELETE') {
      if (storedFile) {
        try { await removeStoredFile(storedFile, { ...connection, fetchImpl }); } catch { /* The durable cleanup queue retries. */ }
      }
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    const payload = await response.json();
    if (request.method === 'POST') {
      if (payload.error) return errorResponse(payload.error.message, payload.status, payload.status === 429 ? { 'retry-after': '60' } : {});
      return Response.json(payload, { status: 201, headers: { 'cache-control': 'no-store' } });
    }
    const notes = payload.map(note => ({ id: note.id, subject: note.subject || '', text: note.text,
      createdAt: Date.parse(note.created_at), expiresAt: Date.parse(note.expires_at),
      ...(note.file_name ? { file: { name: note.file_name, size: note.file_size, type: note.file_type } } : {}) }));
    const etag = notesEtag(notes);
    const outgoing = { 'cache-control': 'no-store', etag };
    if (previous.includes(etag)) return new Response(null, { status: 304, headers: outgoing });
    return notesResponse(notes, outgoing);
  } catch { return errorResponse('Papan teks belum terhubung. Coba lagi sebentar.', 502); }
}
