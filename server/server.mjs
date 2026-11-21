// LEVEL 0 multiplayer server. One process, one JSON file, no database.
// Relays presence and events between players and stores the shared world:
// sector seeds (first writer wins, forever), chalk signs and the leaderboard.
// Built to idle at a few MB on a weak machine.
//   PORT=8791 DATA=./data/level0.json node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

// a limit that is misspelt in the environment falls back to its default: it never becomes "no limit"
const int = (name, def, lo, hi) => { const v = Number(process.env[name]); return Number.isInteger(v) && v >= lo && v <= hi ? v : def; };
const PORT = int('PORT', 8791, 1, 65535);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'level0.json');
const MAX_CLIENTS = int('MAX_CLIENTS', 200, 1, 5000);
const MAX_PER_IP = int('MAX_PER_IP', 8, 1, 1000);
// Shared with the Worker in front (deploy/worker.js). Only a request that carries it may say which
// address the player has; anybody else's X-Level0-IP is ignored.
const KEY = process.env.LEVEL0_KEY || '';
const KEY_HASH = crypto.createHash('sha256').update(KEY).digest();
const VOICE = process.env.LEVEL0_VOICE === '1'; // the voice hand-shake is not passed on while voice is off in the game
const BOOK_MAX = 20000;     // addresses each per-address book remembers at once
const MSG_PER_S = 60;       // a game sends about 20 a second; far past that the connection is dropped
const MAX_FRAME = VOICE ? 6000 : 3000; // bytes in one message (a full state is under 2000)
const MAX_SECTORS = 100000; // rows the world file may hold; past that sectors are still playable, only not signed
const NEAR_SECTORS = 10;    // a player is told about the sectors this many around them, not about the whole world
const SECTOR_M = 28.8, AOI = 130;
const BAD = /n[i1]gg|f[a4]gg|h[i1]tler|k[i1]ke|r[a4]pe|c[u\*]nt|naz[i1]/i;

let db = { sector: [], sign: [], stat: [] };
// A data file that cannot be read is never written over: it is put aside and the newest daily copy that
// can be read is used instead. Rows that are not what a row should be are left out, so nothing further
// down has to wonder what it is looking at.
{
  const str = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n;
  const fnum = (v) => typeof v === 'number' && Number.isFinite(v);
  const shape = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not a data file');
    const arr = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) : []);
    return {
      ...o,
      sector: arr(o.sector).filter((r) => str(r.k, 16) && /^-?\d{1,6},-?\d{1,6}$/.test(r.k) && fnum(r.s) && str(r.username, 32)),
      sign: arr(o.sign).filter((r) => str(r.g, 8) && fnum(r.x) && fnum(r.y) && fnum(r.z) && fnum(r.r) && str(r.username, 32)),
      stat: arr(o.stat).filter((r) => str(r.uid, 32) && str(r.username, 32)).map((r) => { for (const k of ['sectors', 'artifacts', 'escapes', 'deaths', 'far']) if (!fnum(r[k]) || r[k] < 0) r[k] = 0; if (r.walk !== undefined && !fnum(r.walk)) delete r.walk; return r; }),
      salt: str(o.salt, 64) ? o.salt : undefined,
    };
  };
  const read = (f) => shape(JSON.parse(fs.readFileSync(f, 'utf8')));
  if (fs.existsSync(DATA)) {
    try { db = { ...db, ...read(DATA) }; } catch (e) {
      console.error('data file unreadable (' + (e && e.message) + '): kept aside, loading the newest daily copy');
      try { fs.copyFileSync(DATA, DATA + '.unreadable-' + Date.now()); } catch { /* nothing more to do */ }
      const dir = path.dirname(DATA), base = path.basename(DATA, '.json');
      const copies = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.') && /\.\d{4}-\d\d-\d\d\.json$/.test(f)).sort().reverse();
      for (const f of copies) { try { db = { ...db, ...read(path.join(dir, f)) }; console.error('loaded ' + f); break; } catch { /* try the one before */ } }
    }
  }
}
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
const JUMP_HOLD = 5000;                              // after a teleport nothing is counted for this long
// the seed of a sector, exactly as the game works it out (dist/js/util.js hash3, net.js seedFor)
const WORLD_SEED = 0x4c563030;
function hash3(a, b, c) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) * 2246822519;
  return (h ^ (h >>> 15)) >>> 0;
}
const seedOf = (k) => { const [sx, sz] = k.split(',').map(Number); return hash3(sx, sz, WORLD_SEED ^ 0x1234); };
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
  if (!b) { if (claimBudget.size >= BOOK_MAX) return false; b = { n: CLAIM_BURST, t, day, used: 0 }; claimBudget.set(ip, b); }
  if (b.day !== day) { b.day = day; b.used = 0; }
  b.n = Math.min(CLAIM_BURST, b.n + (t - b.t) / 1000 * CLAIM_PER_S); b.t = t;
  if (b.n < 1 || b.used >= CLAIM_PER_DAY) return false;
  b.n--; b.used++;
  return true;
}
// New rows have a pace for the whole server as well (a crowd of real players makes a few dozen a second)
// and the file has a size it does not grow past.
const made = { n: 2000, t: Date.now() };
function makeSector(c, k) {
  const t = Date.now(); made.n = Math.min(2000, made.n + (t - made.t) / 1000 * 40); made.t = t;
  if (made.n < 1 || db.sector.length >= MAX_SECTORS) return null;
  made.n--;
  const r = { id: rid(), k, s: seedOf(k), username: c.name, uid: c.uid, created_at: new Date().toISOString() };
  db.sector.push(r); sectorByK.set(k, r); claimsByUid.set(c.uid, (claimsByUid.get(c.uid) || 0) + 1); dirty = true;
  return r;
}
// Sector rows go to the players who are near them. The rest hear about them when they get there.
const secOf = (x, z) => [Math.floor(x / SECTOR_M), Math.floor(z / SECTOR_M)];
function tellSector(r, except) {
  const [kx, kz] = r.k.split(',').map(Number), o = JSON.stringify({ t: 'c', op: 'create', c: 'sector_v1', r: pubSector(r) });
  for (const p of clients.values()) {
    if (p === except || !p.pos || !ready(p)) continue;
    const [sx, sz] = secOf(p.pos.x, p.pos.z);
    if (Math.abs(sx - kx) <= NEAR_SECTORS && Math.abs(sz - kz) <= NEAR_SECTORS) { p.ws.send(o); p.sent.add(r.k); }
  }
}
// the rows around a place that this player has not been sent yet
function tellArea(c, x, z) {
  const [sx, sz] = secOf(x, z), k0 = sx + ',' + sz;
  if (k0 === c.areaK) return; c.areaK = k0;
  if (c.sent.size > 6000) c.sent.clear();
  let n = 0;
  for (let dz = -6; dz <= 6 && n < 200; dz++) for (let dx = -6; dx <= 6 && n < 200; dx++) {
    const k = (sx + dx) + ',' + (sz + dz); if (c.sent.has(k)) continue;
    const r = sectorByK.get(k); if (!r) continue;
    c.sent.add(k); n++; send(c, { t: 'c', op: 'create', c: 'sector_v1', r: pubSector(r) });
  }
}
// the address limits are kept per network, not per single address: one IPv6 customer has billions
function addrKey(ip) {
  ip = String(ip || '').trim().toLowerCase().slice(0, 64);
  const v4 = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); if (v4) return v4[1];
  if (!ip.includes(':')) return ip || 'unknown';
  let [head, tail] = ip.split('::'); head = head ? head.split(':') : []; tail = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const parts = tail === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  const h = parts.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16));
  while (h.length < 4) h.push('0');
  h[3] = (parseInt(h[3], 16) & 0xff00).toString(16); // the first 56 bits
  return h.join(':') + '::/56';
}
// ---- what one player can do to the others is checked here too -----------------------------------
// Chalk signs: one of the eight marks, placed where the player really is, a few per address.
const SIGN_IDS = new Set(['fwd', 'back', 'safe', 'danger', 'dead', 'exit', 'eye', 'water']);
const SIGN_WALK = 10, SIGNS_PER_HOUR = 12, SIGNS_PER_DAY = 40, SIGNS_NEAR = 3, SIGNS_MAX = 4000, SIGNS_PER_ADDR = 60;
const signBudget = new Map(); // address -> [times of the signs it placed in the last day]
// Creatures a player's game is simulating are shown to the others only when they behave like creatures:
// near their owner, moving no faster than a creature can, having existed for a few seconds, and not
// appearing next to somebody else. One that jumps starts again from nothing.
const ENT_RANGE = 150, ENT_V = 8, ENT_AGE = 3000, ENT_CLEAR = 12, CELL_M = 0.6, HORDE_V = 4.6; // creatures reach 6 m/s, the horde 0.92 of a sprint
const CONN_PER_MIN = 30;
const connTimes = new Map(); // address -> times of its recent connections
const pubStat = (r) => { const { uid, walk, ...rest } = r; return rest; };
const pubSector = (r) => { const { uid, n, ...rest } = r; return rest; };
let saving = false;
function save() {
  if (!dirty || saving) return; dirty = false; saving = true;
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = DATA + '.tmp';
  // written beside the file and moved over it; if either step fails the data is still due to be saved
  fs.writeFile(tmp, JSON.stringify(db), (e) => { if (e) { saving = false; dirty = true; return; } fs.rename(tmp, DATA, (e2) => { saving = false; if (e2) dirty = true; }); });
}
// One copy of the data a day, the last seven kept: whatever gets scribbled into the world can be taken
// back out again.
let snapDay = '';
function snapshot() {
  const day = new Date().toISOString().slice(0, 10); if (day === snapDay) return;
  snapDay = day;
  const dir = path.dirname(DATA), base = path.basename(DATA, '.json'), file = path.join(dir, base + '.' + day + '.json');
  if (!fs.existsSync(DATA)) return;
  if (!fs.existsSync(file)) fs.copyFileSync(DATA, file);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.') && /\.\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
  for (const f of old.slice(0, -7)) fs.unlinkSync(path.join(dir, f));
}
try { snapshot(); } catch (e) { console.error('snapshot', e && e.message); }
setInterval(() => { try { snapshot(); save(); } catch (e) { oops('save', e); } }, 10000);

const clients = new Map();
const perIp = new Map();
const rid = () => crypto.randomBytes(6).toString('base64url');
// a name is judged as it reads, not as it is spelt: separators out, digits as the letters they stand for
const plain = (n) => n.toLowerCase().replace(/[\s_\-]+/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
const RESERVED = /^(admin|administrator|mod|moderator|staff|owner|dev|developer|server|system|official|support|level0)$/;
const badName = (s) => BAD.test(s) || BAD.test(plain(s)) || RESERVED.test(plain(s));
const cleanName = (n) => { let s = String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 16); if (s.length < 2 || badName(s)) s = 'guest-' + rid().slice(0, 4); return s; };
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi);
// a connection that does not read what it is sent is skipped, and cut off if it lets a lot pile up
const ready = (c) => { if (c.ws.readyState !== 1) return false; const b = c.ws.bufferedAmount; if (b > 2097152) { c.ws.terminate(); return false; } return b < 262144; };
const send = (c, o) => { if (ready(c)) c.ws.send(JSON.stringify(o)); };
const all = (o, except) => { const s = JSON.stringify(o); for (const c of clients.values()) if (c !== except && ready(c)) c.ws.send(s); };
// A name that is on the leaderboard belongs to whoever put it there. Somebody else asking for it, or for
// the name of a player who is online right now, gets a few characters added.
// (look-alikes count as the same name: 0 and o, 1 and l and i, rn and m, vv and w)
const nameKey = (n) => plain(n).replace(/[il]/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w');
function freeName(name, uid) {
  const k = nameKey(name);
  // on the board the name is held by the row with the most sectors (the oldest, if they are level),
  // whether or not that row has a sector yet
  let best = null;
  for (const r of db.stat) if (nameKey(r.username) === k && (!best || r.sectors > best.sectors || (r.sectors === best.sectors && String(r.created_at) < String(best.created_at)))) best = r;
  let taken = !!best && best.uid !== uid;
  if (!taken && !best) for (const p of clients.values()) if (p.uid !== uid && nameKey(p.name) === k) { taken = true; break; }
  return taken ? name.slice(0, 11) + '-' + uid.slice(0, 4).replace(/[^A-Za-z0-9]/g, 'x') : name;
}

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
  if (e.length > 8) { const al = typeof e[8] === 'string' ? e[8].replace(/[^\w \-]/g, '').slice(0, 16) : null; o.push(al && !badName(al) ? al : null); }
  if (e.length > 9) o.push(e[9] ? 1 : 0);
  if (e.length > 10) o.push(Array.isArray(e[10]) && e[10].length === 4 && e[10].every((v) => Number.isInteger(v) && Math.abs(v) < 2e7) ? e[10] : null);
  if (e.length > 11) o.push(num(e[11], 0, 50) ? e[11] : 0);
  return o;
}

// Where a creature really is. The horde's danger is not where it is drawn but how far along its
// corridor it has come, so that is the point that gets checked.
function entPoint(e) {
  if (e[1] === 'R') {
    const r = e[10]; if (!r || !num(e[7], -50, 5000)) return null;
    const ax = (r[0] + 0.5) * CELL_M, az = (r[1] + 0.5) * CELL_M, bx = (r[2] + 0.5) * CELL_M, bz = (r[3] + 0.5) * CELL_M, L = Math.hypot(bx - ax, bz - az) || 1;
    if (L > 400) return null;
    return [ax + (bx - ax) / L * e[7], az + (bz - az) / L * e[7], r.join(',')];
  }
  return [e[2], e[4], ''];
}
function entities(c, list) {
  const t = Date.now(), out = [], seen = new Set(), held = t < (c.holdT || 0);
  for (const e of list) {
    // an id is its owner's: nobody can speak for a creature in somebody else's game
    if (!e[0].startsWith(c.id + '.')) e[0] = c.id + '.' + e[0].replace(/[^\w.\-]/g, '').slice(0, 24);
    const id = e[0]; if (seen.has(id)) continue; seen.add(id);
    const p = entPoint(e); if (!p) continue;
    e[6] = e[6].replace(/[^\w\-]/g, '');
    if (e[1] === 'R' && Math.hypot(e[2] - p[0], e[4] - p[1]) > 6) { e[2] = p[0]; e[4] = p[1]; } // the horde is drawn where its front is
    if (Math.hypot(p[0] - c.state.x, p[1] - c.state.z) > ENT_RANGE) { c.ents.delete(id); continue; }
    let k = c.ents.get(id);
    const vmax = e[1] === 'R' ? HORDE_V : ENT_V;
    if (k && k.type === e[1] && k.run === p[2]) {
      k.allow = Math.min(vmax * 0.75, k.allow + vmax * (t - k.t) / 1000); // it cannot save up for a lunge
      const d = Math.hypot(p[0] - k.x, p[1] - k.z);
      if (d > k.allow + 0.25) k = null; else k.allow = Math.max(0, k.allow - d); // the allowance pays for every metre: no free slack per report
    } else k = null;
    if (!k || held) { k = { type: e[1], run: p[2], born: t, out: false, allow: 1 }; c.ents.set(id, k); }
    k.x = p[0]; k.z = p[1]; k.t = t;
    if (!k.out && t - k.born >= ENT_AGE) {
      // first shown to the others: not on top of one of them
      let clear = true;
      for (const o of clients.values()) if (o !== c && o.state && Math.hypot(o.state.x - k.x, o.state.z - k.z) < ENT_CLEAR) { clear = false; break; }
      if (clear) k.out = true;
    }
    if (k.out) out.push(e);
  }
  for (const id of c.ents.keys()) if (!seen.has(id)) c.ents.delete(id);
  return out;
}
// Events between players: only the two the game has, rebuilt from what the server knows.
function event(c, m) {
  const d = m.d; if (!d || typeof d !== 'object' || !c.state) return;
  if (d.k === 'scream') {
    // a death cry, from where the player is, to the players who could hear it
    const t = Date.now(), at = c.pos; if (!at || c.passive || t < (c.holdT || 0) || t - (c.screamT || 0) < 4000) return; c.screamT = t;
    const o = { t: 'e', from: c.id, d: { k: 'scream', x: at.x, y: c.state.y + 1.5, z: at.z } };
    for (const p of clients.values()) if (p !== c && p.state && Math.hypot(p.state.x - at.x, p.state.z - at.z) < 80) send(p, o);
  } else if (d.k === 'rtc' && VOICE) {
    // voice chat hand-shake: one player to one nearby player, nothing but the hand-shake itself
    if (!okRate(c, 'rtc', 30) || typeof m.to !== 'string') return;
    // both ends where they last stood alive, and not straight after a jump: a place that was only reported does not count
    const p = clients.get(m.to), t = Date.now();
    if (!p || p === c || !p.pos || !c.pos || c.passive || t < (c.holdT || 0) || c.state.a === 0 || Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z) > 70) return;
    const str = (v, n) => typeof v === 'string' && v.length <= n;
    let o = null;
    if (d.bye) o = { k: 'rtc', bye: 1 };
    else if (d.sdp && typeof d.sdp === 'object' && (d.sdp.type === 'offer' || d.sdp.type === 'answer') && str(d.sdp.sdp, 5000)) o = { k: 'rtc', sdp: { type: d.sdp.type, sdp: d.sdp.sdp } };
    else if (d.ice && typeof d.ice === 'object' && str(d.ice.candidate, 600)) o = { k: 'rtc', ice: { candidate: d.ice.candidate, sdpMid: str(d.ice.sdpMid, 16) ? d.ice.sdpMid : null, sdpMLineIndex: Number.isInteger(d.ice.sdpMLineIndex) && d.ice.sdpMLineIndex >= 0 && d.ice.sdpMLineIndex < 16 ? d.ice.sdpMLineIndex : null, usernameFragment: str(d.ice.usernameFragment, 64) ? d.ice.usernameFragment : null } };
    if (o) send(p, { t: 'e', from: c.id, d: o });
  }
}

function collection(c, m) {
  if (!okRate(c, 'col', 12)) return;
  const name = m.c, d = m.d || {};
  if (name === 'sector_v1' && m.op === 'create') {
    if (typeof d.k !== 'string' || !/^-?\d{1,6},-?\d{1,6}$/.test(d.k) || !num(d.s, 0, 4294967295) || !c.state) return;
    const [sx, sz] = d.k.split(',').map(Number);
    if (sx + ',' + sz !== d.k) return; // one spelling per place: no "007,5", no "-0,5"
    // Only somewhere you actually are, whether the row exists or not: who was where is told to the
    // players who walk there, not to anybody who asks from the entry.
    const at = c.pos; // where the player last stood, alive (not a place reported while down)
    if (!at || c.passive || c.state.a === 0 || Math.abs(sx * SECTOR_M - at.x) > SECTOR_M * 4 || Math.abs(sz * SECTOR_M - at.z) > SECTOR_M * 4) return;
    if (Date.now() < (c.holdT || 0)) return; // just teleported: the game asks again in a few seconds
    let r = sectorByK.get(d.k);
    if (!r) {
      // and only as many as load around someone who is really moving through the place. The seed is the
      // server's own: a client cannot hand in a different one and change what everybody sees there.
      if (!mayClaim(c.ip)) { flag(c, 'claims'); return; }
      r = makeSector(c, d.k); if (!r) return;
      tellSector(r, c);
    }
    c.sent.add(r.k);
    send(c, { t: 'c', op: 'create', c: name, r: pubSector(r), rid: m.rid });
  } else if (name === 'sign_v1') {
    if (m.op === 'create') {
      if (!SIGN_IDS.has(d.g) || !num(d.x, -1e7, 1e7) || !num(d.y, -100, 100) || !num(d.z, -1e7, 1e7) || !num(d.r, -1e4, 1e4)) return;
      if (!c.state || c.passive || c.state.a === 0 || !c.pos || Math.hypot(d.x - c.pos.x, d.z - c.pos.z) > 6) return;
      // by someone who is walking around in there (not a script that just connected or just teleported),
      // not on top of other signs, and only so many from one address
      const t = Date.now();
      if (walked(c) < SIGN_WALK || t < (c.holdT || 0) || t - (c.signT || 0) < 2000) { flag(c, 'sign'); return; }
      if (db.sign.filter((r) => Math.hypot(r.x - d.x, r.z - d.z) < 3).length >= SIGNS_NEAR) { flag(c, 'sign (too many in one spot)'); return; }
      const times = (signBudget.get(c.ip) || []).filter((x) => t - x < DAY);
      if (times.length >= SIGNS_PER_DAY || times.filter((x) => t - x < 3600000).length >= SIGNS_PER_HOUR || (!signBudget.has(c.ip) && signBudget.size >= BOOK_MAX)) { flag(c, 'sign (too many from one address)'); return; }
      times.push(t); signBudget.set(c.ip, times); c.signT = t;
      const mine = db.sign.filter((r) => r.uid === c.uid);
      if (mine.length >= 30) { const old = mine[0]; db.sign.splice(db.sign.indexOf(old), 1); all({ t: 'c', op: 'delete', c: name, id: old.id }); }
      const tag = ipTag(c.ip);
      if (db.sign.length >= SIGNS_MAX || db.sign.filter((r) => r.a === tag).length >= SIGNS_PER_ADDR) { flag(c, 'sign (no room)'); return; }
      const r = { id: rid(), g: d.g, x: d.x, y: d.y, z: d.z, r: d.r, username: c.name, uid: c.uid, a: tag, created_at: new Date().toISOString() };
      db.sign.push(r); dirty = true;
      const pub = { ...r }; delete pub.uid; delete pub.a;
      all({ t: 'c', op: 'create', c: name, r: pub }, c); send(c, { t: 'c', op: 'create', c: name, r: pub, rid: m.rid });
    } else if (m.op === 'delete') {
      const i = db.sign.findIndex((r) => r.id === m.id && r.uid === c.uid);
      if (i >= 0) { db.sign.splice(i, 1); dirty = true; all({ t: 'c', op: 'delete', c: name, id: m.id }); }
    }
  } else if (name === 'stat_v1' && (m.op === 'create' || m.op === 'update')) {
    if (c.passive) return;
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
  if (mine.length >= NEW_ROWS_PER_IP || (!newRows.has(c.ip) && newRows.size >= BOOK_MAX)) { flag(c, 'new names'); return null; }
  mine.push(t); newRows.set(c.ip, mine);
  r = { id: rid(), uid: c.uid, created_at: new Date().toISOString(), username: c.name, sectors: 0, artifacts: 0, escapes: 0, deaths: 0, far: 0, walk: c.walk };
  db.stat.push(r); statByUid.set(c.uid, r); dirty = true;
  log('leaderboard: new row', c.name, 'addr', ipTag(c.ip));
  all({ t: 'c', op: 'create', c: 'stat_v1', r: pubStat(r) });
  return r;
}
// every position report: measure the walking, the distance from the entry, and first entries
function track(c, s) {
  // While a player is down (dead, in a menu, loading) the place they report is not where they stand.
  // The last place they stood stays the reference, so coming back somewhere else is a jump like any other.
  if (s.a === 0 || c.passive) return;
  const t = Date.now(), p = c.pos;
  c.pos = { x: s.x, z: s.z, t };
  // the first place of a visit is free to be anywhere, and nothing counts for a few seconds after it
  if (!p) { c.holdT = t + JUMP_HOLD; return; }
  // on foot: no further than the time since the last report allows. A jump is a teleport (dying, a way
  // out, or a cheat): nothing counts for it, nor for a few seconds after it.
  // (an allowance that fills at top speed and holds a second and a half, so reports that arrive late and
  // bunched together on a poor connection are not mistaken for a jump)
  const d = Math.hypot(s.x - p.x, s.z - p.z);
  c.allow = Math.min(V_MAX * 1.5, c.allow + V_MAX * (t - p.t) / 1000);
  if (d > c.allow + 0.6) { c.secK = ''; c.cell = -1; c.allow = 0; c.holdT = t + JUMP_HOLD; return; }
  c.allow -= d; // may dip 0.6 m under zero: that slack is paid back before any more is given, not handed out with every report
  if (t < (c.holdT || 0)) return;
  // new ground only, one square at a time (squares kept as one number each; the oldest are let go)
  const cell = (Math.floor(s.x / CELL) + 4e6) * 8e6 + (Math.floor(s.z / CELL) + 4e6);
  let step = 0;
  if (cell !== c.cell) {
    c.cell = cell;
    if (!c.cells.has(cell)) { if (c.cells.size >= 12000) { let n = 6000; for (const old of c.cells) { c.cells.delete(old); if (--n <= 0) break; } } c.cells.add(cell); step = CELL; }
  }
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
// theirs and not counted yet, it counts. Never more of them than the walking allows.
function enter(c, r, k) {
  let sec = sectorByK.get(k);
  if (sec && (sec.uid !== c.uid || sec.n)) return false;
  if (r.sectors >= capSectors(r.walk)) { flag(c, 'sectors'); return false; }
  if (!sec) { sec = makeSector(c, k); if (!sec) return false; tellSector(sec); }
  sec.n = 1; r.sectors++;
  // not refused, only written down: faster than anyone finds their way through the maze, for a long time
  c.gain = (c.gain || 0) + 1; c.gainT = c.gainT || Date.now();
  if (c.gain >= 60 && c.gain / ((Date.now() - c.gainT) / 60000 + 0.01) > 4) flag(c, 'pace (fast for a long time, not refused)');
  return true;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/ws/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, online: clients.size })); return; }
  if (req.url === '/' || req.url === '/ws') { res.writeHead(426, { upgrade: 'websocket', 'content-type': 'text/plain' }); res.end('this is a WebSocket'); return; }
  res.writeHead(404); res.end();
});
// compared as two digests: always the same length, whatever bytes somebody puts in the header
const keyed = (h) => { const key = String(h['x-level0-key'] || ''); return KEY.length >= 16 && key.length > 0 && key.length < 200 && crypto.timingSafeEqual(crypto.createHash('sha256').update(key).digest(), KEY_HASH); };
// LEVEL0_STRICT=1: only the Worker may open a connection (it carries the key), so nobody talks to this
// server past the front door. Left off for local development, where there is no Worker.
const STRICT = process.env.LEVEL0_STRICT === '1' && KEY.length >= 16;
const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME, perMessageDeflate: false,
  verifyClient: (info, cb) => { let ok = false; try { ok = !STRICT || keyed(info.req.headers); } catch { ok = false; } cb(ok, 403, 'Forbidden'); } });
// Nothing a visitor sends may take the server down: every entry point is wrapped, and whatever still
// slips through is written to the log instead of ending the process.
let oopsN = 0;
const oops = (where, e) => { if (++oopsN <= 200) console.error(new Date().toISOString(), 'error in', where + ':', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); };
process.on('uncaughtException', (e) => oops('process', e));
process.on('unhandledRejection', (e) => oops('promise', e));
// (not being able to listen at all is the one error that should end the process: the service manager starts it again)
wss.on('error', (e) => { if (!server.listening) { console.error('cannot listen:', e && e.message); process.exit(1); } oops('wss', e); });
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch { /* gone */ } });
wss.on('connection', (ws, req) => { try { onConnection(ws, req); } catch (e) { oops('connection', e); try { ws.terminate(); } catch { /* gone */ } } });
function onConnection(ws, req) {
  // Cloudflare's own header cannot be forged through Cloudflare, so it wins. Only when it is the
  // Worker's own address (a proxied request from another zone) is the Worker's X-Level0-IP used.
  const h = req.headers, cf = String(h['cf-connecting-ip'] || ''), ours = keyed(h);
  const ip = addrKey(String((ours && h['x-level0-ip']) || cf || req.socket.remoteAddress || '').split(',')[0]);
  const n = (perIp.get(ip) || 0) + 1;
  // one network may hold a share of the places, and only a few of them once the server is nearly full
  const share = clients.size >= MAX_CLIENTS * 0.8 ? 4 : Math.min(MAX_PER_IP, Math.ceil(MAX_CLIENTS * 0.12));
  const now = Date.now(), recent = (connTimes.get(ip) || []).filter((x) => now - x < 60000);
  // (sockets that have not said hello yet count too; and when it is full, whoever has been silent
  // longest, for a minute or more, gives their place to the newcomer)
  if (clients.size >= MAX_CLIENTS && n <= share) { let old = null; for (const p of clients.values()) if (now - (p.lastT || p.t0) > 60000 && (!old || (p.lastT || p.t0) < (old.lastT || old.t0))) old = p; if (old) { clients.delete(old.id); all({ t: 'l', id: old.id }); old.id = null; old.ws.terminate(); } }
  if (clients.size >= MAX_CLIENTS || wss.clients.size > MAX_CLIENTS + 40 || n > share || recent.length >= CONN_PER_MIN || connTimes.size > 20000) { ws.terminate(); return; }
  recent.push(now); connTimes.set(ip, recent);
  perIp.set(ip, n);
  const c = { ws, ip, id: null, name: '', uid: '', state: null, changed: false, rate: {}, alive: true, pos: null, walk: 0, secK: '', cell: -1, cells: new Set(), entered: [], allow: 3, ents: new Map(), over: 0, sent: new Set(), areaK: '', flags: {}, t0: now, lastT: 0 };
  const hello = setTimeout(() => { if (!c.id) ws.terminate(); }, 8000);
  ws.on('pong', () => { c.alive = true; });
  ws.on('ping', () => { if (!okRate(c, 'ping', 3)) ws.terminate(); }); // browsers never send these
  ws.on('message', (buf) => { try { onMessage(buf); } catch (e) { oops('message', e); try { ws.terminate(); } catch { /* gone */ } } });
  const onMessage = (buf) => {
    if (!okRate(c, 'all', MSG_PER_S)) { if (++c.over > 120) ws.terminate(); return; }
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!c.id) {
      if (c.gone || m.t !== 'hello' || typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 64) return ws.terminate();
      clearTimeout(hello);
      c.id = rid(); c.uid = crypto.createHash('sha256').update(m.token).digest('base64url').slice(0, 14); c.name = freeName(cleanName(m.name), c.uid);
      // One visit per player counts: when the same identity comes in again (a second tab, or a script
      // running many at once), the visits it already had stay connected but stop earning anything.
      for (const p of clients.values()) if (p.uid === c.uid) p.passive = true;
      const peers = []; for (const p of clients.values()) peers.push([p.id, p.name, p.state ? rough(p.state) : null]);
      clients.set(c.id, c);
      const strip = (r) => { const { uid, a, ...rest } = r; return rest; };
      // the sectors around the entry now; the ones around wherever the player really is follow with their first position
      const near = [];
      for (let dz = -NEAR_SECTORS; dz <= NEAR_SECTORS; dz++) for (let dx = -NEAR_SECTORS; dx <= NEAR_SECTORS; dx++) { const r = sectorByK.get(dx + ',' + dz); if (r) { near.push(pubSector(r)); c.sent.add(r.k); } }
      const top = db.stat.slice().sort((x, y) => y.sectors - x.sectors).slice(0, 200), own = statByUid.get(c.uid);
      if (own && !top.includes(own)) top.push(own);
      send(c, { t: 'w', id: c.id, name: c.name, peers, cols: { sector_v1: near, sign_v1: db.sign.map(strip), stat_v1: top.map(pubStat) } });
      all({ t: 'j', id: c.id, name: c.name }, c);
      return;
    }
    if (m.t === 'p') {
      if (!okRate(c, 'p', 20)) return; const s = cleanState(m.s); if (!s) return;
      track(c, s);
      // A player who is down (dead, in a menu) stays where they last stood, and brings no creatures:
      // the place in such a report is not a place anybody walked to.
      if (s.a === 0) { const at = c.pos; s.x = at ? at.x : ENTRY[0]; s.z = at ? at.z : ENTRY[1]; delete s.e; }
      c.state = s; c.changed = true; c.json = null; c.lastT = Date.now();
      if (s.e) s.e = c.passive ? [] : entities(c, s.e);
      if (c.pos && s.a !== 0 && !c.passive && Date.now() >= (c.holdT || 0)) tellArea(c, c.pos.x, c.pos.z);
    }
    else if (m.t === 'e') { if (okRate(c, 'e', 40)) event(c, m); }
    else if (m.t === 'c') collection(c, m);
  };
  ws.on('close', () => {
    clearTimeout(hello);
    perIp.set(ip, (perIp.get(ip) || 1) - 1); if (perIp.get(ip) <= 0) perIp.delete(ip);
    c.gone = true;
    if (c.id) { clients.delete(c.id); all({ t: 'l', id: c.id }); }
  });
  ws.on('error', () => {});
}

// presence fan-out: nearby players 10 times a second, everybody every 2 seconds. Each mover's state is
// turned into text once a tick, not once per receiver, and its creatures go only to players near it.
// Far away, a player is only "somewhere in that sector": enough for the map, not enough to follow them.
const rough = (s) => ({ x: (Math.floor(s.x / SECTOR_M) + 0.5) * SECTOR_M, y: 0, z: (Math.floor(s.z / SECTOR_M) + 0.5) * SECTOR_M, w: 0, p: 0, f: 0, c: 0, a: s.a, n: 0, v: 0 });
let tick = 0;
setInterval(() => { try {
  tick++;
  const full = tick % 20 === 0;
  const moved = []; for (const c of clients.values()) if (c.state && (c.changed || full)) moved.push(c);
  if (!moved.length) return;
  for (const m of moved) if (!m.json) m.json = ['[' + JSON.stringify(m.id) + ',' + JSON.stringify(m.state) + ']', '[' + JSON.stringify(m.id) + ',' + JSON.stringify(rough(m.state)) + ']'];
  for (const c of clients.values()) {
    if (!ready(c)) continue;
    const u = [];
    for (const m of moved) {
      if (m === c) continue;
      const near = c.state && Math.abs(m.state.x - c.state.x) < AOI && Math.abs(m.state.z - c.state.z) < AOI;
      if (near) u.push(m.json[0]); else if (full) u.push(m.json[1]);
    }
    if (u.length) c.ws.send('{"t":"P","u":[' + u.join(',') + ']}');
  }
  for (const m of moved) m.changed = false;
} catch (e) { oops('tick', e); } }, 100);
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch { /* gone */ } } }, 30000);
// forget addresses that have been quiet for a day
setInterval(() => {
  const t = Date.now();
  for (const [ip, a] of signBudget) if (!a.length || t - a[a.length - 1] > DAY) signBudget.delete(ip);
  for (const [ip, a] of newRows) if (!a.length || t - a[a.length - 1] > DAY) newRows.delete(ip);
  for (const [ip, b] of claimBudget) if (t - b.t > DAY) claimBudget.delete(ip);
}, 3600000);
setInterval(() => { const t = Date.now(); for (const [ip, a] of connTimes) if (!a.length || t - a[a.length - 1] > 60000) connTimes.delete(ip); }, 60000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  // beside the file first, then moved over it: a write that is cut short never leaves half a world
  try { if (dirty) { fs.writeFileSync(DATA + '.tmp2', JSON.stringify(db)); fs.renameSync(DATA + '.tmp2', DATA); } } catch (e) { console.error('last save failed', e && e.message); }
  process.exit(0);
});
server.listen(PORT, HOST, () => console.log(`level0 server on ${HOST}:${PORT}, ${db.sector.length} sectors stored`));
