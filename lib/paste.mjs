import { randomUUID } from 'node:crypto';
import { supabasePaste } from './paste-supabase.mjs';
import { supabaseFiles } from './paste-files.mjs';

const validRoom = (room) => typeof room === 'string' && /^(?:\d{6}|[A-Za-z0-9_-]{22})$/.test(room);
const errorResponse = (message, status) => Response.json({ error: { message } }, {
  status, headers: { 'cache-control': 'no-store' },
});

/** The browser holds a room capability, while the backend credential stays on Vercel. */
export function createPasteGateway({ env = process.env, fetchImpl = fetch } = {}) {
  return async (request) => {
    const url = new URL(request.url);
    const fileMatch = url.pathname.match(/^\/api\/paste\/files(?:\/([a-f0-9-]{36})\/(complete|download))?$/);
    if (fileMatch) {
      const allowed = fileMatch[2] === 'download' ? 'GET' : 'POST';
      if (request.method !== allowed) return errorResponse('Metode tidak didukung.', 405);
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return errorResponse('Origin tidak diizinkan.', 403);
      const room = request.headers.get('x-paste-room');
      if (!validRoom(room)) return errorResponse('Tautan ruang tidak valid.', 400);
      if (env.PASTE_STORAGE !== 'supabase') return errorResponse('Fitur file memerlukan Supabase.', 503);
      return supabaseFiles(request, { room, noteId: fileMatch[1], action: fileMatch[2], env, fetchImpl });
    }
    const match = url.pathname.match(/^\/api\/paste(?:\/([a-f0-9-]{36}))?$/);
    if (!match) return errorResponse('Endpoint tidak ditemukan.', 404);
    if (!['GET', 'POST', 'DELETE'].includes(request.method) ||
        (match[1] && request.method !== 'DELETE') || (!match[1] && request.method === 'DELETE')) {
      return errorResponse('Metode tidak didukung.', 405);
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return errorResponse('Origin tidak diizinkan.', 403);
    const room = request.headers.get('x-paste-room');
    if (!validRoom(room)) return errorResponse('Tautan ruang tidak valid.', 400);
    if (env.PASTE_STORAGE === 'supabase') return supabasePaste(request, { room, noteId: match[1], env, fetchImpl });
    if (env.PASTE_STORAGE && env.PASTE_STORAGE !== 'docker') return errorResponse('Penyimpanan papan teks belum dikonfigurasi.', 503);
    const backendKey = env.PASTE_BACKEND_KEY;
    let upstream;
    try {
      upstream = new URL(env.PASTE_UPSTREAM_URL);
      if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash ||
          upstream.pathname !== '/_paste/notes' || !backendKey || backendKey.length < 32) throw new Error();
    } catch { return errorResponse('Papan teks sedang disiapkan. Coba lagi sebentar.', 503); }
    if (match[1]) upstream.pathname += `/${match[1]}`;
    const headers = new Headers({ 'x-paste-backend-key': backendKey, 'x-paste-room': room,
      'x-request-id': randomUUID() });
    if (request.headers.has('if-none-match')) headers.set('if-none-match', request.headers.get('if-none-match'));
    const init = { method: request.method, headers, redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) };
    if (request.method === 'POST') {
      headers.set('content-type', 'application/json');
      const body = await request.arrayBuffer();
      // JSON escaping can make a valid 1 MB text considerably larger on the wire.
      if (body.byteLength > 4_000_000) return errorResponse('Teks terlalu panjang. Maksimal 1 MB.', 413);
      init.body = body;
    }
    try {
      const result = await fetchImpl(upstream, init);
      if (result.status >= 300 && result.status < 400 && result.status !== 304) {
        await result.body?.cancel();
        return errorResponse('Backend papan teks belum tersedia.', 502);
      }
      const outgoing = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      for (const name of ['content-type', 'etag', 'retry-after']) if (result.headers.has(name)) outgoing.set(name, result.headers.get(name));
      return new Response([204, 304].includes(result.status) ? null : result.body, { status: result.status, headers: outgoing });
    } catch { return errorResponse('Papan teks belum terhubung. Coba lagi sebentar.', 502); }
  };
}
