// LEVEL 0 multiplayer server. One process, one JSON file, no database.
// Relays presence and events between players and stores the shared world:
// sector seeds (first writer wins, forever), chalk signs and the leaderboard.
// Built to idle at a few MB on a weak machine.
//   PORT=8791 DATA=./data/level0.json node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DATA || path.join(path.dirname(new URL(import.meta.url).pathname), 'data', 'level0.json');
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS || 200);
const MAX_PER_IP = Number(process.env.MAX_PER_IP || 8);
const SECTOR_M = 28.8, AOI = 130;
const BAD = /n[i1]gg|f[a4]gg|h[i1]tler|k[i1]ke|r[a4]pe|c[u\*]nt|naz[i1]/i;

let db = { sector: [], sign: [], stat: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch { /* first run */ }
const sectorByK = new Map(db.sector.map((r) => [r.k, r]));
let dirty = false;
function save() {
  if (!dirty) return; dirty = false;
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = DATA + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), (e) => { if (!e) fs.rename(tmp, DATA, () => {}); });
}
setInterval(save, 10000);

const clients = new Map();
const perIp = new Map();
const rid = () => crypto.randomBytes(6).toString('base64url');
const cleanName = (n) => { let s = String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 16); if (s.length < 2 || BAD.test(s)) s = 'guest-' + rid().slice(0, 4); return s; };
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi);
const send = (c, o) => { if (c.ws.readyState === 1 && c.ws.bufferedAmount < 262144) c.ws.send(JSON.stringify(o)); };
const all = (o, except) => { const s = JSON.stringify(o); for (const c of clients.values()) if (c !== except && c.ws.readyState === 1) c.ws.send(s); };

function okRate(c, key, perSec) {
  const t = Date.now(), b = c.rate[key] || (c.rate[key] = { n: 0, t });
  if (t - b.t > 1000) { b.t = t; b.n = 0; }
  return ++b.n <= perSec;
}
function cleanState(s) {
  if (!s || typeof s !== 'object' || !num(s.x, -1e7, 1e7) || !num(s.z, -1e7, 1e7) || !num(s.y, -100, 100)) return null;
  const o = { x: s.x, y: s.y, z: s.z, w: num(s.w, -1e4, 1e4) ? s.w : 0, p: num(s.p, -2, 2) ? s.p : 0, f: s.f ? 1 : 0, c: s.c ? 1 : 0, a: s.a === 0 ? 0 : 1, n: num(s.n, 0, 1) ? s.n : 0, v: s.v ? 1 : 0 };
  if (Array.isArray(s.e)) o.e = s.e.slice(0, 4).filter((e) => Array.isArray(e) && e.length === 7 && typeof e[0] === 'string' && e[0].length < 40 && /^[LHB]$/.test(e[1]) && num(e[2], -1e7, 1e7) && num(e[3], -100, 100) && num(e[4], -1e7, 1e7) && num(e[5], -1e4, 1e4) && typeof e[6] === 'string' && e[6].length < 8);
  return o;
}

function collection(c, m) {
  if (!okRate(c, 'col', 12)) return;
  const name = m.c, d = m.d || {};
  if (name === 'sector_v1' && m.op === 'create') {
    if (typeof d.k !== 'string' || !/^-?\d{1,6},-?\d{1,6}$/.test(d.k) || !num(d.s, 0, 4294967295)) return;
    let r = sectorByK.get(d.k);
    if (!r) {
      // only somewhere you actually are
      const [sx, sz] = d.k.split(',').map(Number);
      if (!c.state || Math.abs(sx * SECTOR_M - c.state.x) > SECTOR_M * 6 || Math.abs(sz * SECTOR_M - c.state.z) > SECTOR_M * 6) return;
      r = { id: rid(), k: d.k, s: Math.floor(d.s), username: c.name, created_at: new Date().toISOString() };
      db.sector.push(r); sectorByK.set(r.k, r); dirty = true;
      all({ t: 'c', op: 'create', c: name, r }, c);
    }
    send(c, { t: 'c', op: 'create', c: name, r, rid: m.rid });
  } else if (name === 'sign_v1') {
    if (m.op === 'create') {
      if (typeof d.g !== 'string' || d.g.length > 8 || !num(d.x, -1e7, 1e7) || !num(d.y, -100, 100) || !num(d.z, -1e7, 1e7) || !num(d.r, -1e4, 1e4)) return;
      if (!c.state || Math.hypot(d.x - c.state.x, d.z - c.state.z) > 6) return;
      const mine = db.sign.filter((r) => r.uid === c.uid);
      if (mine.length >= 30) { const old = mine[0]; db.sign.splice(db.sign.indexOf(old), 1); all({ t: 'c', op: 'delete', c: name, id: old.id }); }
      const r = { id: rid(), g: d.g, x: d.x, y: d.y, z: d.z, r: d.r, username: c.name, uid: c.uid, created_at: new Date().toISOString() };
      db.sign.push(r); dirty = true;
      all({ t: 'c', op: 'create', c: name, r }, c); send(c, { t: 'c', op: 'create', c: name, r, rid: m.rid });
    } else if (m.op === 'delete') {
      const i = db.sign.findIndex((r) => r.id === m.id && r.uid === c.uid);
      if (i >= 0) { db.sign.splice(i, 1); dirty = true; all({ t: 'c', op: 'delete', c: name, id: m.id }); }
    }
  } else if (name === 'stat_v1' && (m.op === 'create' || m.op === 'update')) {
    const v = (x) => (num(x, 0, 1e7) ? Math.floor(x) : 0);
    let r = db.stat.find((x) => x.uid === c.uid);
    const fresh = !r;
    if (!r) { r = { id: rid(), uid: c.uid, created_at: new Date().toISOString() }; db.stat.push(r); }
    Object.assign(r, { username: c.name, sectors: v(d.sectors), artifacts: Math.min(v(d.artifacts), 12), escapes: v(d.escapes), deaths: v(d.deaths), far: v(d.far) });
    dirty = true;
    all({ t: 'c', op: fresh ? 'create' : 'update', c: name, r }, c); send(c, { t: 'c', op: fresh ? 'create' : 'update', c: name, r, rid: m.rid });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/ws/health' || req.url === '/ws') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, online: clients.size, sectors: db.sector.length, signs: db.sign.length })); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 6000, perMessageDeflate: false });
wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-level0-ip'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const n = (perIp.get(ip) || 0) + 1;
  if (clients.size >= MAX_CLIENTS || n > MAX_PER_IP) { ws.close(1013, 'full'); return; }
  perIp.set(ip, n);
  const c = { ws, ip, id: null, name: '', uid: '', state: null, changed: false, rate: {}, alive: true };
  const hello = setTimeout(() => { if (!c.id) ws.close(); }, 8000);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!c.id) {
      if (m.t !== 'hello' || typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 64) return ws.close();
      clearTimeout(hello);
      c.id = rid(); c.name = cleanName(m.name); c.uid = crypto.createHash('sha256').update(m.token).digest('base64url').slice(0, 14);
      const peers = []; for (const p of clients.values()) peers.push([p.id, p.name, p.state]);
      clients.set(c.id, c);
      const strip = (r) => { const { uid, ...rest } = r; return rest; };
      send(c, { t: 'w', id: c.id, name: c.name, peers, cols: { sector_v1: db.sector, sign_v1: db.sign.map(strip), stat_v1: db.stat.map(strip) } });
      all({ t: 'j', id: c.id, name: c.name }, c);
      return;
    }
    if (m.t === 'p') { if (!okRate(c, 'p', 20)) return; const s = cleanState(m.s); if (s) { c.state = s; c.changed = true; } }
    else if (m.t === 'e') {
      if (!okRate(c, 'e', 40) || !m.d || typeof m.d !== 'object') return;
      const o = { t: 'e', from: c.id, d: m.d };
      if (typeof m.to === 'string') { const p = clients.get(m.to); if (p) send(p, o); } else all(o, c);
    } else if (m.t === 'c') collection(c, m);
  });
  ws.on('close', () => {
    clearTimeout(hello);
    perIp.set(ip, (perIp.get(ip) || 1) - 1); if (perIp.get(ip) <= 0) perIp.delete(ip);
    if (c.id) { clients.delete(c.id); all({ t: 'l', id: c.id }); }
  });
  ws.on('error', () => {});
});

// presence fan-out: nearby players 10 times a second, everybody every 2 seconds
let tick = 0;
setInterval(() => {
  tick++;
  const full = tick % 20 === 0;
  const moved = []; for (const c of clients.values()) if (c.state && (c.changed || full)) moved.push(c);
  if (!moved.length) return;
  for (const c of clients.values()) {
    const u = [];
    for (const m of moved) {
      if (m === c) continue;
      if (full || !c.state || (Math.abs(m.state.x - c.state.x) < AOI && Math.abs(m.state.z - c.state.z) < AOI)) u.push([m.id, m.state]);
    }
    if (u.length) send(c, { t: 'P', u });
  }
  for (const m of moved) m.changed = false;
}, 100);
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch { /* gone */ } } }, 30000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dirty && fs.writeFileSync(DATA, JSON.stringify(db)); process.exit(0); });
server.listen(PORT, HOST, () => console.log(`level0 server on ${HOST}:${PORT}, ${db.sector.length} sectors stored`));
