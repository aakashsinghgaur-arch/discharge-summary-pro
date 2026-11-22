#!/usr/bin/env node
// Tiny static server for local development and tests. Applies the same security
// headers as production (from vercel.json) so CSP problems show up locally.
//   node scripts/serve.mjs [dir=dist] [port=5173]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.aff': 'text/plain; charset=utf-8', '.dic': 'text/plain; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };

export function startServer({ dir, port = 0, extraConnectSrc = '', headers = true } = {}) {
  const root = dirname(fileURLToPath(import.meta.url));
  const vercel = JSON.parse(readFileSync(join(root, '..', 'vercel.json'), 'utf8'));
  const base = vercel.headers.find((h) => h.source === '/(.*)').headers;
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(dir, p));
      if (!file.startsWith(normalize(dir))) { res.writeHead(403).end(); return; }
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      const h = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
      if (headers) base.forEach(({ key, value }) => {
        if (key === 'Strict-Transport-Security') return;
        let v = value.replace(' upgrade-insecure-requests', '').replace(/;$/, '');
        if (key === 'Content-Security-Policy' && extraConnectSrc) v = v.replace("connect-src 'self'", `connect-src 'self' ${extraConnectSrc}`);
        h[key] = v;
      });
      res.writeHead(200, h).end(await readFile(file));
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const dir = normalize(join(process.cwd(), process.argv[2] || 'dist'));
  startServer({ dir, port: +(process.argv[3] || 5173) }).then(({ url }) => console.log(`serving ${dir} at ${url}`));
}
