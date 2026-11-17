import { createHash } from 'node:crypto';
import { supabaseConnection } from './paste-supabase-config.mjs';

export const MAX_FILE_BYTES = 5_000_000;
export const FILE_TYPES = {
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif',
};
const BUCKET = 'paste-files';
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const error = (message, status) => json({ error: { message } }, status);

export async function removeStoredFile(path, { base, headers, fetchImpl = fetch }) {
  const response = await fetchImpl(new URL(`/storage/v1/object/${BUCKET}`, base), {
    method: 'DELETE', headers: new Headers([...headers, ['content-type', 'application/json']]),
    body: JSON.stringify({ prefixes: [path] }), redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Storage deletion failed');
  await response.body?.cancel();
}

export async function supabaseFiles(request, { room, noteId, action, env, fetchImpl }) {
  let connection;
  try { connection = supabaseConnection(env); }
  catch { return error('Penyimpanan file belum dikonfigurasi.', 503); }
  const { base, headers } = connection;
  const roomHash = createHash('sha256').update(room).digest('hex');
  const call = async (path, method = 'GET', body) => {
    const outgoing = new Headers(headers);
    if (body !== undefined) outgoing.set('content-type', 'application/json');
    const response = await fetchImpl(new URL(path, base), { method, headers: outgoing, redirect: 'manual',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('File service request failed'); }
    return response.status === 204 ? null : response.json();
  };
  const rpc = (name, body) => call(`/rest/v1/rpc/${name}`, 'POST', body);
  const scopedNote = async () => {
    const query = new URLSearchParams({ select: 'id,file_name,file_size,file_type,storage_path,file_status,expires_at,upload_deadline',
      id: `eq.${noteId}`, room_hash: `eq.${roomHash}`, expires_at: `gt.${new Date().toISOString()}`, limit: '1' });
    return (await call(`/rest/v1/paste_notes?${query}`))[0];
  };
  const signedUrl = value => {
    const url = new URL(value.startsWith('/object/') ? `/storage/v1${value}` : value, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/storage/v1/object/')) throw new Error('Invalid signed URL');
    return url;
  };
  let reservation;
  try {
    if (!noteId) {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 4_000_000) return error('Teks terlalu panjang. Maksimal 1 MB.', 413);
      let body;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return error('Data file tidak valid.', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error('Data file tidak valid.', 400);
      const name = typeof body.fileName === 'string' ? body.fileName.normalize('NFC').trim() : '';
      if (!name || [...name].length > 180 || /[\x00-\x1f\x7f/\\]/.test(name)) return error('Nama file tidak valid. Maksimal 180 karakter.', 400);
      const type = FILE_TYPES[name.split('.').at(-1).toLowerCase()];
      if (!type) return error('Gunakan Word, Excel, PowerPoint, PDF, gambar, TXT, atau CSV.', 400);
      if (!Number.isSafeInteger(body.fileSize) || body.fileSize < 1 || body.fileSize > MAX_FILE_BYTES) return error('Ukuran file harus antara 1 byte dan 5 MB.', 413);
      const text = body.text ?? '', subject = body.subject ?? '', ttl = body.ttlSeconds ?? 3600;
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1_000_000) return error('Teks terlalu panjang. Maksimal 1 MB.', 413);
      if (typeof subject !== 'string' || [...subject.trim()].length > 120) return error('Subject maksimal 120 karakter.', 400);
      if (![600, 3600, 86400].includes(ttl)) return error('Masa berlaku tidak valid.', 400);
      const result = await rpc('paste_file_begin', { p_room_hash: roomHash, p_name: name, p_size: body.fileSize,
        p_type: type, p_text: text, p_subject: subject.trim(), p_ttl_seconds: ttl });
      if (result.error) return error(result.error.message, result.status);
      reservation = result;
      const signed = await call(`/storage/v1/object/upload/sign/${BUCKET}/${result.storage_path}`, 'POST', { upsert: false });
      return json({ noteId: result.id, uploadUrl: signedUrl(signed.url).href, contentType: type }, 201);
    }

    const note = await scopedNote();
    if (!note?.storage_path) return error('File tidak ditemukan atau sudah kedaluwarsa.', 404);
    if (action === 'complete') {
      if (note.file_status !== 'pending' || Date.parse(note.upload_deadline) <= Date.now()) return error('Unggahan sudah berakhir. Pilih file dan coba lagi.', 409);
      const info = await call(`/storage/v1/object/info/${BUCKET}/${note.storage_path}`);
      const actualSize = Number(info.metadata?.size ?? info.size);
      if (actualSize !== note.file_size || actualSize > MAX_FILE_BYTES) return error('Ukuran file tidak cocok. Unggah ulang file.', 400);
      const result = await rpc('paste_file_complete', { p_room_hash: roomHash, p_note_id: note.id });
      if (result.error) return error(result.error.message, result.status);
      return json({ note: result.note });
    }
    if (note.file_status !== 'ready') return error('File belum selesai diunggah.', 404);
    const expiresIn = Math.min(60, Math.floor((Date.parse(note.expires_at) - Date.now()) / 1000));
    if (expiresIn < 1) return error('File sudah kedaluwarsa.', 404);
    const signed = await call(`/storage/v1/object/sign/${BUCKET}/${note.storage_path}`, 'POST', { expiresIn });
    const url = signedUrl(signed.signedURL ?? signed.signedUrl);
    url.searchParams.set('download', note.file_name);
    return json({ url: url.href, fileName: note.file_name, expiresIn });
  } catch {
    if (reservation) {
      try { await call(`/rest/v1/paste_notes?id=eq.${reservation.id}&room_hash=eq.${roomHash}`, 'DELETE'); } catch { /* Expiry cleanup will retry. */ }
    }
    return error('Layanan file belum terhubung. Coba lagi sebentar.', 502);
  }
}
