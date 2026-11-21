// Serves ./dist for local testing with the same response headers the live site sends (dist/_headers),
// and never from cache, so an edited module is always the one the browser runs.
//   node tools/dev-server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const port = Number(process.argv[2] || 8796);
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', woff2: 'font/woff2', glb: 'model/gltf-binary', bin: 'application/octet-stream', ico: 'image/x-icon' };
// the block under "/*" in dist/_headers
function siteHeaders() {
  const out = {}; let on = false;
  for (const line of fs.readFileSync(path.join(root, '_headers'), 'utf8').split('\n')) {
    if (!/^\s/.test(line)) { on = line.trim() === '/*'; continue; }
    const i = line.indexOf(':'); if (on && i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  // the local game server is on another port
  if (out['Content-Security-Policy']) out['Content-Security-Policy'] = out['Content-Security-Policy'].replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://127.0.0.1:*");
  return out;
}
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { ...siteHeaders(), 'content-type': TYPES[path.extname(file).slice(1)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log('dist on http://127.0.0.1:' + port));
