import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import handler from '../api/index.mjs';

const port = Number(process.env.PORT || 3018);
http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const init = { method: req.method, headers: req.headers, signal: controller.signal };
    if (!['GET', 'HEAD'].includes(req.method)) {
      init.body = Readable.toWeb(req);
      init.duplex = 'half';
    }
    const response = await handler.fetch(new Request(`http://${req.headers.host || `localhost:${port}`}${req.url}`, init));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.destroyed) res.end('{"error":{"message":"Request failed."}}');
  }
}).listen(port, '127.0.0.1', () => console.log(`Relay listening at http://127.0.0.1:${port}`));
