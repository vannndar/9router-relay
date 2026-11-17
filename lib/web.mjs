import { readFileSync } from 'node:fs';
import { createRelay } from './relay.mjs';
import { createPasteGateway } from './paste.mjs';

const assets = new Map([
  ['/', ['solver.html', 'text/html; charset=utf-8']],
  ['/paste', ['index.html', 'text/html; charset=utf-8']],
  ['/paste/', ['index.html', 'text/html; charset=utf-8']],
  ['/chat', ['index.html', 'text/html; charset=utf-8']],
  ['/chat/', ['index.html', 'text/html; charset=utf-8']],
  ['/solver.css', ['solver.css', 'text/css; charset=utf-8']],
  ['/solver.mjs', ['solver.mjs', 'text/javascript; charset=utf-8']],
  ['/solver-core.mjs', ['solver-core.mjs', 'text/javascript; charset=utf-8']],
  ['/solver-strategy.mjs', ['solver-strategy.mjs', 'text/javascript; charset=utf-8']],
  ['/solver-image.mjs', ['solver-image.mjs', 'text/javascript; charset=utf-8']],
  ['/solver-worker.mjs', ['solver-worker.mjs', 'text/javascript; charset=utf-8']],
  ['/grid-paint.mjs', ['grid-paint.mjs', 'text/javascript; charset=utf-8']],
  ['/chat.css', ['chat.css', 'text/css; charset=utf-8']],
  ['/chat.mjs', ['chat.mjs', 'text/javascript; charset=utf-8']],
  ['/stream.mjs', ['stream.mjs', 'text/javascript; charset=utf-8']],
  ['/paste.mjs', ['paste.mjs', 'text/javascript; charset=utf-8']],
  ['/paste.css', ['paste.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [path, {
  body: readFileSync(new URL(`../web/${file}`, import.meta.url)), type,
}]));

const securityHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

try {
  const storage = new URL(process.env.SUPABASE_URL);
  if (storage.protocol === 'https:' && storage.hostname.endsWith('.supabase.co') && !storage.port && !storage.username && !storage.password && !storage.search && !storage.hash && storage.pathname === '/') {
    securityHeaders['content-security-policy'] = securityHeaders['content-security-policy'].replace("connect-src 'self'", `connect-src 'self' ${storage.origin}`);
  }
} catch { /* Without cloud storage, keep the original self-only policy. */ }

export function createApplication({ relay = createRelay(), paste = createPasteGateway() } = {}) {
  return async (request) => {
    const asset = assets.get(new URL(request.url).pathname);
    if (!asset) {
      if (new URL(request.url).pathname.startsWith('/api/paste')) return paste(request);
      return relay(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response(null, { status: 405, headers: { ...securityHeaders, allow: 'GET, HEAD' } });
    }
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers: { ...securityHeaders, 'content-type': asset.type },
    });
  };
}
