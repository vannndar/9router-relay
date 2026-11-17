import { createHash, timingSafeEqual } from 'node:crypto';

const ROUTES = new Map([
  ['/v1/models', ['GET', 'HEAD']],
  ['/v1/chat/completions', ['POST']],
  ['/v1/completions', ['POST']],
  ['/v1/responses', ['POST']],
  ['/v1/messages', ['POST']],
  ['/v1/messages/count_tokens', ['POST']],
  ['/v1/embeddings', ['POST']],
]);

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

function jsonError(message, status, extraHeaders = {}) {
  return Response.json({ error: { message, type: 'relay_error' } }, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function validSecret(actual, expected) {
  if (!actual || !expected) return false;
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}

function readConfiguration(env) {
  if (!env.RELAY_API_KEY || env.RELAY_API_KEY.length < 32 || !env.UPSTREAM_API_KEY) {
    throw new Error('Relay credentials are not configured.');
  }
  if (!env.UPSTREAM_ORIGIN) {
    throw new Error('UPSTREAM_ORIGIN is not configured.');
  }
  const origin = new URL(env.UPSTREAM_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('UPSTREAM_ORIGIN must be an HTTPS origin without a path.');
  }
  return { origin: origin.origin, key: env.UPSTREAM_API_KEY, secret: env.RELAY_API_KEY };
}

function routeMethods(pathname) {
  if (ROUTES.has(pathname)) return ROUTES.get(pathname);
  if (/^\/v1\/responses\/[A-Za-z0-9_-]+$/.test(pathname)) return ['GET', 'DELETE'];
  if (/^\/v1\/responses\/[A-Za-z0-9_-]+\/cancel$/.test(pathname)) return ['POST'];
  return null;
}

function connectionHeaders(headers) {
  return new Set((headers.get('connection') || '').split(',').map((s) => s.trim().toLowerCase()));
}

function upstreamHeaders(incoming, key) {
  const headers = new Headers();
  const connection = connectionHeaders(incoming);
  for (const [name, value] of incoming) {
    if (HOP_HEADERS.has(name) || connection.has(name) ||
        /^(x-forwarded-|x-vercel-|x-relay-|cf-|proxy-)/.test(name) ||
        ['authorization', 'x-api-key', 'cookie', 'host', 'origin', 'referer',
          'accept-encoding', 'forwarded', 'x-real-ip', 'x-9r-real-ip'].includes(name)) continue;
    headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${key}`);
  return headers;
}

function downstreamHeaders(upstream) {
  const headers = new Headers();
  const connection = connectionHeaders(upstream);
  for (const [name, value] of upstream) {
    if (HOP_HEADERS.has(name) || connection.has(name) ||
        ['set-cookie', 'content-encoding', 'location'].includes(name)) continue;
    headers.set(name, value);
  }
  headers.set('cache-control', 'no-store, no-transform');
  headers.set('x-accel-buffering', 'no');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

/** A fixed-origin, authenticated HTTP relay. Request and response bodies stay opaque. */
export function createRelay({ env = process.env, fetchImpl = fetch, timeoutMs = 285_000 } = {}) {
  return async function relay(request) {
    const url = new URL(request.url);
    let config;
    try {
      config = readConfiguration(env);
    } catch {
      return jsonError('Relay is not configured.', 503);
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      if (!['GET', 'HEAD'].includes(request.method)) {
        return jsonError('Method not allowed.', 405, { allow: 'GET, HEAD' });
      }
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({
        status: 'ok', service: '9router-vercel-relay',
      }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }

    const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const apiKey = request.headers.get('x-api-key');
    if (!validSecret(bearer || apiKey, config.secret)) {
      return jsonError('Invalid or missing relay API key.', 401, {
        'www-authenticate': 'Bearer realm="9router-relay"',
      });
    }

    const methods = routeMethods(url.pathname);
    if (!methods) return jsonError('Endpoint not available through this relay.', 404);
    if (!methods.includes(request.method)) {
      return jsonError('Method not allowed.', 405, { allow: methods.join(', ') });
    }

    // The destination always comes from server configuration, never request headers or query params.
    const target = new URL(config.origin);
    target.pathname = url.pathname;
    target.search = url.search;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    const init = {
      method: request.method,
      headers: upstreamHeaders(request.headers, config.key),
      redirect: 'manual',
      signal,
    };
    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      init.body = request.body;
      init.duplex = 'half';
    }

    try {
      const upstream = await fetchImpl(target, init);
      if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
        await upstream.body?.cancel();
        return jsonError('The upstream returned a redirect.', 502);
      }
      return new Response(request.method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: downstreamHeaders(upstream.headers),
      });
    } catch {
      if (request.signal.aborted) return jsonError('Request cancelled.', 499);
      if (timeout.aborted) return jsonError('The upstream request timed out.', 504);
      return jsonError('Unable to reach the upstream service.', 502);
    }
  };
}
