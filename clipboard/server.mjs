import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PasteError, PasteStore, validRoom } from './store.mjs';

const key = process.env.PASTE_BACKEND_KEY;
if (!key || key.length < 32) throw new Error('PASTE_BACKEND_KEY must be configured.');
const store = new PasteStore(process.env.PASTE_DB_PATH || '/data/paste.sqlite');
const hash = (value) => createHash('sha256').update(value).digest();
const writeLimits = new Map();

function reply(res, status, value, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://paste.internal');
    if (url.pathname === '/health' && req.method === 'GET') return reply(res, 200, { status: 'ok' });
    const provided = req.headers['x-paste-backend-key'];
    if (typeof provided !== 'string' || !timingSafeEqual(hash(provided), hash(key))) {
      return reply(res, 401, { error: { message: 'Unauthorized' } });
    }
    const room = req.headers['x-paste-room'];
    if (!validRoom(room)) throw new PasteError('Tautan ruang tidak valid.');
    const match = url.pathname.match(/^\/_paste\/notes(?:\/([a-f0-9-]{36}))?$/);
    if (!match) return reply(res, 404, { error: { message: 'Not found' } });
    if (req.method === 'GET' && !match[1]) {
      const notes = store.list(room);
      const etag = store.etag(notes);
      // Cloudflare may weaken ETags when it compresses the JSON response.
      const previousTags = (req.headers['if-none-match'] || '').split(',').map((tag) => tag.trim().replace(/^W\//, ''));
      if (previousTags.includes(etag)) return reply(res, 304, undefined, { etag });
      return reply(res, 200, { notes, serverTime: Date.now() }, { etag });
    }
    if (req.method === 'POST' && !match[1]) {
      const bucket = writeLimits.get(room);
      if (bucket && Date.now() - bucket.start < 60_000 && bucket.count >= 20) {
        return reply(res, 429, { error: { message: 'Terlalu banyak kiriman. Tunggu sebentar.' } }, { 'retry-after': '60' });
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4_000_000) throw new PasteError('Teks terlalu panjang. Maksimal 1 MB.', 413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new PasteError('Format teks tidak valid.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PasteError('Format teks tidak valid.');
      const note = store.add(room, body.text, body.ttlSeconds ?? 3600, body.subject ?? '');
      if (!bucket || Date.now() - bucket.start >= 60_000) writeLimits.set(room, { start: Date.now(), count: 1 });
      else bucket.count++;
      return reply(res, 201, { note });
    }
    if (req.method === 'DELETE' && match[1]) {
      store.remove(room, match[1]);
      return reply(res, 204);
    }
    return reply(res, 405, { error: { message: 'Method not allowed' } });
  } catch (error) {
    return reply(res, error instanceof PasteError ? error.status : 500, {
      error: { message: error instanceof PasteError ? error.message : 'Papan teks belum bisa diproses.' },
    });
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.maxRequestsPerSocket = 100;
const cleanup = setInterval(() => {
  store.purge();
  for (const [room, bucket] of writeLimits) if (Date.now() - bucket.start >= 60_000) writeLimits.delete(room);
}, 60_000).unref();
server.listen(Number(process.env.PORT || 3020), '0.0.0.0', () => console.log('Relay paste backend ready.'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  clearInterval(cleanup);
  server.close(() => { store.close(); process.exit(0); });
});
