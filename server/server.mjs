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

// ---- the leaderboard is counted here, not taken on a client's word ----------------------------
// The server sees every position a player reports. From those it measures how far someone has
// really walked (new ground only, reached on foot: standing still, pacing on the spot and teleporting
// are worth nothing) and counts the sectors they were first into itself. What it cannot see (objects, escapes, deaths) is held to
// what that much walking makes possible. A made-up score is simply ignored.
const ENTRY = [14.4, 14.4], V_MAX = 5.5;            // sprint is 4.7 m/s
const WALK_ROW = 30;                                 // metres walked before someone gets a leaderboard row
const NEW_ROWS_PER_IP = 20, DAY = 86400000;        // a school or a family shares one address
const JUMP_HOLD = 8000;                              // after a teleport nothing is counted for this long
// the seed of a sector, exactly as the game works it out (dist/js/util.js hash3, net.js seedFor)
const WORLD_SEED = 0x4c563030;
function hash3(a, b, c) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) * 2246822519;
  return (h ^ (h >>> 15)) >>> 0;
}
const seedOf = (k) => { const [sx, sz] = k.split(',').map(Number); return hash3(sx, sz, WORLD_SEED ^ 0x1234); };           // new leaderboard names per address per day
const capSectors = (w) => Math.floor(w / 16) + 4;    // a sector is 28.8 m across
// sectors that load around a player get their name on them too: a full view is about 50, then roughly
// seven more for every sector walked. One allowance per address (a school shares one), refilled over time,
// with a ceiling per day. Sectors a player walks into do not depend on it (see enter).
const CLAIM_BURST = 300, CLAIM_PER_S = 2, CLAIM_PER_DAY = 8000;
const CELL = 3;                                      // metres: walking is counted in squares of new ground
const capArtifacts = (w) => Math.min(12, Math.floor(w / 40));
const capEscapes = (w) => Math.floor(w / 240);       // no exit is closer to the entry than that
const capDeaths = (w) => Math.floor(w / 10) + 1;
if (!db.salt) { db.salt = crypto.randomBytes(12).toString('base64url'); dirty = true; }
const ipTag = (ip) => crypto.createHash('sha256').update(db.salt + ip).digest('base64url').slice(0, 8); // for the log: comparable, not reversible
const log = (...a) => console.log(new Date().toISOString(), ...a);
// rows from before this check: keep the ones that are possible, drop the ones that are not
{
  const named = new Map(); for (const r of db.sector) named.set(r.username, (named.get(r.username) || 0) + 1);
  const before = db.stat.length;
  db.stat = db.stat.filter((r) => {
    if (typeof r.walk === 'number') return true;
    const ok = (r.sectors || 0) <= (named.get(r.username) || 0) && (r.far || 0) <= 20000 && (r.escapes || 0) <= (r.sectors || 0) + 3;
    if (!ok) { log('leaderboard: dropped impossible row', r.username, 'sectors', r.sectors, 'far', r.far, 'escapes', r.escapes); return false; }
    r.walk = Math.max(r.far || 0, (r.sectors || 0) * 16, (r.escapes || 0) * 240, (r.artifacts || 0) * 40, (r.deaths || 0) * 10);
    return true;
  });
  if (db.stat.length !== before || db.stat.some((r) => r.walk !== undefined)) dirty = true;
}
const statByUid = new Map(db.stat.map((r) => [r.uid, r]));
const claimsByUid = new Map(); for (const r of db.sector) if (r.uid) claimsByUid.set(r.uid, (claimsByUid.get(r.uid) || 0) + 1);
const newRows = new Map(); // address -> times of the leaderboard rows it started
const claimBudget = new Map(); // address -> { n: claims left, t: last refill, day, used: claims today }
function mayClaim(ip) {
  const t = Date.now(), day = Math.floor(t / DAY);
  let b = claimBudget.get(ip);
  if (!b) { b = { n: CLAIM_BURST, t, day, used: 0 }; claimBudget.set(ip, b); }
  if (b.day !== day) { b.day = day; b.used = 0; }
  b.n = Math.min(CLAIM_BURST, b.n + (t - b.t) / 1000 * CLAIM_PER_S); b.t = t;
  if (b.n < 1 || b.used >= CLAIM_PER_DAY) return false;
  b.n--; b.used++;
  return true;
}
function makeSector(c, k) {
  const r = { id: rid(), k, s: seedOf(k), username: c.name, uid: c.uid, created_at: new Date().toISOString() };
  db.sector.push(r); sectorByK.set(k, r); claimsByUid.set(c.uid, (claimsByUid.get(c.uid) || 0) + 1); dirty = true;
  return r;
}
const pubStat = (r) => { const { uid, walk, ...rest } = r; return rest; };
const pubSector = (r) => { const { uid, n, ...rest } = r; return rest; };
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
  if (Array.isArray(s.e)) o.e = s.e.slice(0, 8).map(cleanEnt).filter(Boolean);
  return o;
}
// A creature another client is simulating: [id, type, x, y, z, yaw, state, k, alias, reveal, run, v].
// The first seven are required; the rest depend on the type (see Entities.serialize in the client).
function cleanEnt(e) {
  if (!Array.isArray(e) || e.length < 7 || e.length > 12 || typeof e[0] !== 'string' || e[0].length >= 40 || typeof e[1] !== 'string' || !/^[LHBMKWR]$/.test(e[1])) return null;
  if (!num(e[2], -1e7, 1e7) || !num(e[3], -100, 100) || !num(e[4], -1e7, 1e7) || !num(e[5], -1e4, 1e4) || typeof e[6] !== 'string' || e[6].length > 16) return null;
  const o = e.slice(0, 7);
  if (e.length > 7) o.push(num(e[7], -1e6, 1e6) ? e[7] : 0);
  if (e.length > 8) o.push(typeof e[8] === 'string' ? e[8].replace(/[^\w \-]/g, '').slice(0, 16) : null);
  if (e.length > 9) o.push(e[9] ? 1 : 0);
  if (e.length > 10) o.push(Array.isArray(e[10]) && e[10].length === 4 && e[10].every((v) => Number.isInteger(v) && Math.abs(v) < 2e7) ? e[10] : null);
  if (e.length > 11) o.push(num(e[11], 0, 50) ? e[11] : 0);
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
      if (!c.state || Math.abs(sx * SECTOR_M - c.state.x) > SECTOR_M * 4 || Math.abs(sz * SECTOR_M - c.state.z) > SECTOR_M * 4) return;
      // and only as many as load around someone who is really moving through the place. The seed is the
      // server's own: a client cannot hand in a different one and change what everybody sees there.
      if (Date.now() < (c.holdT || 0)) return; // just teleported: the game asks again in a few seconds
      if (!mayClaim(c.ip)) { flag(c, 'claims'); return; }
      r = makeSector(c, d.k);
      all({ t: 'c', op: 'create', c: name, r: pubSector(r) }, c);
    }
    send(c, { t: 'c', op: 'create', c: name, r: pubSector(r), rid: m.rid });
  } else if (name === 'sign_v1') {
    if (m.op === 'create') {
      if (typeof d.g !== 'string' || d.g.length > 8 || !num(d.x, -1e7, 1e7) || !num(d.y, -100, 100) || !num(d.z, -1e7, 1e7) || !num(d.r, -1e4, 1e4)) return;
      if (!c.state || Math.hypot(d.x - c.state.x, d.z - c.state.z) > 6) return;
      const mine = db.sign.filter((r) => r.uid === c.uid);
      if (mine.length >= 30) { const old = mine[0]; db.sign.splice(db.sign.indexOf(old), 1); all({ t: 'c', op: 'delete', c: name, id: old.id }); }
      const r = { id: rid(), g: d.g, x: d.x, y: d.y, z: d.z, r: d.r, username: c.name, uid: c.uid, created_at: new Date().toISOString() };
      db.sign.push(r); dirty = true;
      const pub = { ...r }; delete pub.uid;
      all({ t: 'c', op: 'create', c: name, r: pub }, c); send(c, { t: 'c', op: 'create', c: name, r: pub, rid: m.rid });
    } else if (m.op === 'delete') {
      const i = db.sign.findIndex((r) => r.id === m.id && r.uid === c.uid);
      if (i >= 0) { db.sign.splice(i, 1); dirty = true; all({ t: 'c', op: 'delete', c: name, id: m.id }); }
    }
  } else if (name === 'stat_v1' && (m.op === 'create' || m.op === 'update')) {
    const r = statRow(c); if (!r) return; // has not walked anywhere yet, or too many new names from one address
    const v = (x) => (num(x, 0, 1e7) ? Math.floor(x) : 0);
    // sectors and distance are counted by the server (see track). The rest is the client's word,
    // never going down, and never past what the walking it has done allows.
    const w = r.walk, next = { artifacts: [v(d.artifacts), capArtifacts(w)], escapes: [v(d.escapes), capEscapes(w)], deaths: [v(d.deaths), capDeaths(w)] };
    let changed = r.username !== c.name; r.username = c.name;
    for (const k in next) { const [want, cap] = next[k], now = Math.max(r[k] || 0, Math.min(want, cap)); if (want > cap && want > (r[k] || 0)) flag(c, k); if (now !== r[k]) { r[k] = now; changed = true; } }
    // a browser's own count can honestly be ahead (it kept counting from before this was measured here)
    if (v(d.sectors) > r.sectors + 2000 || v(d.far) > r.far + 50000) flag(c, 'score');
    if (changed) { dirty = true; all({ t: 'c', op: 'update', c: name, r: pubStat(r) }, c); }
    send(c, { t: 'c', op: 'update', c: name, r: pubStat(r), rid: m.rid });
  }
}

// how far this player has really walked: the row's total, or this visit's if they have no row yet
const walked = (c) => { const r = statByUid.get(c.uid); return r ? r.walk : c.walk; };
// one line in the log per kind of impossible claim per visit
function flag(c, what) { if (c.flags[what]) return; c.flags[what] = 1; log('leaderboard: refused', what, 'from', c.name, 'addr', ipTag(c.ip), 'walked', Math.round(walked(c)) + ' m'); }
function statRow(c) {
  let r = statByUid.get(c.uid);
  if (r) return r;
  if (c.walk < WALK_ROW) return null;
  const t = Date.now(), mine = (newRows.get(c.ip) || []).filter((x) => t - x < DAY);
  if (mine.length >= NEW_ROWS_PER_IP) { flag(c, 'new names'); return null; }
  mine.push(t); newRows.set(c.ip, mine);
  r = { id: rid(), uid: c.uid, created_at: new Date().toISOString(), username: c.name, sectors: 0, artifacts: 0, escapes: 0, deaths: 0, far: 0, walk: c.walk };
  db.stat.push(r); statByUid.set(c.uid, r); dirty = true;
  log('leaderboard: new row', c.name, 'addr', ipTag(c.ip));
  all({ t: 'c', op: 'create', c: 'stat_v1', r: pubStat(r) });
  return r;
}
// every position report: measure the walking, the distance from the entry, and first entries
function track(c, s) {
  const t = Date.now(), p = c.pos;
  c.pos = { x: s.x, z: s.z, t };
  if (!p || s.a === 0) return;
  // on foot: no further than the time since the last report allows. A jump is a teleport (dying, a way
  // out, or a cheat): nothing counts for it, nor for a few seconds after it.
  // (an allowance that fills at top speed and holds a second and a half, so reports that arrive late and
  // bunched together on a poor connection are not mistaken for a jump)
  const d = Math.hypot(s.x - p.x, s.z - p.z);
  c.allow = Math.min(V_MAX * 1.5, c.allow + V_MAX * (t - p.t) / 1000);
  if (d > c.allow + 0.6) { c.secK = ''; c.cell = ''; c.allow = 0; c.holdT = t + JUMP_HOLD; return; }
  c.allow = Math.max(0, c.allow - d);
  if (t < (c.holdT || 0)) return;
  // new ground only, one square at a time
  const cell = Math.floor(s.x / CELL) + ',' + Math.floor(s.z / CELL);
  let step = 0;
  if (cell !== c.cell) { c.cell = cell; if (!c.cells.has(cell)) { if (c.cells.size > 40000) c.cells.clear(); c.cells.add(cell); step = CELL; } }
  c.walk += step;
  const k = Math.floor(s.x / SECTOR_M) + ',' + Math.floor(s.z / SECTOR_M);
  if (k !== c.secK) { c.secK = k; if (c.entered.length < 12 && !c.entered.includes(k)) c.entered.push(k); }
  const r = statByUid.get(c.uid) || statRow(c); if (!r) return; // not on the board yet: the entries wait
  r.walk += step;
  let pub = false;
  const far = Math.round(Math.min(Math.hypot(s.x - ENTRY[0], s.z - ENTRY[1]), r.walk + 60));
  if (far > r.far) { r.far = far; pub = far % 10 === 0; }
  while (c.entered.length) if (enter(c, r, c.entered.shift())) pub = true;
  if (pub) { dirty = true; all({ t: 'c', op: 'update', c: 'stat_v1', r: pubStat(r) }); }
  else if (t - (c.saveT || 0) > 60000) { c.saveT = t; dirty = true; }
}
// the player has walked into sector k. If nobody had it yet it becomes theirs here and now; if it is
// theirs and not counted yet, it counts.
function enter(c, r, k) {
  let sec = sectorByK.get(k);
  if (!sec) { sec = makeSector(c, k); all({ t: 'c', op: 'create', c: 'sector_v1', r: pubSector(sec) }); }
  if (sec.uid !== c.uid || sec.n) return false;
  if (r.sectors >= capSectors(r.walk)) { flag(c, 'sectors'); return false; }
  sec.n = 1; r.sectors++;
  // not refused, only written down: faster than anyone finds their way through the maze, for a long time
  c.gain = (c.gain || 0) + 1; c.gainT = c.gainT || Date.now();
  if (c.gain >= 60 && c.gain / ((Date.now() - c.gainT) / 60000 + 0.01) > 4) flag(c, 'pace (' + c.gain + ' sectors this visit, not refused)');
  return true;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/ws/health' || req.url === '/ws') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, online: clients.size, sectors: db.sector.length, signs: db.sign.length })); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 6000, perMessageDeflate: false });
wss.on('connection', (ws, req) => {
  // Cloudflare's own header cannot be forged through Cloudflare, so it wins. Only when it is the
  // Worker's own address (a proxied request from another zone) is the Worker's X-Level0-IP used.
  const h = req.headers, cf = String(h['cf-connecting-ip'] || '');
  const ip = String((cf && cf !== '2a06:98c0:3600::103' ? cf : h['x-level0-ip'] || cf) || h['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const n = (perIp.get(ip) || 0) + 1;
  if (clients.size >= MAX_CLIENTS || n > MAX_PER_IP) { ws.close(1013, 'full'); return; }
  perIp.set(ip, n);
  const c = { ws, ip, id: null, name: '', uid: '', state: null, changed: false, rate: {}, alive: true, pos: null, walk: 0, secK: '', cell: '', cells: new Set(), entered: [], allow: 3, flags: {} };
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
      send(c, { t: 'w', id: c.id, name: c.name, peers, cols: { sector_v1: db.sector.map(pubSector), sign_v1: db.sign.map(strip), stat_v1: db.stat.map(pubStat) } });
      all({ t: 'j', id: c.id, name: c.name }, c);
      return;
    }
    if (m.t === 'p') { if (!okRate(c, 'p', 20)) return; const s = cleanState(m.s); if (s) { c.state = s; c.changed = true; track(c, s); } }
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
