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
// Shared with the Worker in front (deploy/worker.js). Only a request that carries it may say which
// address the player has; anybody else's X-Level0-IP is ignored.
const KEY = process.env.LEVEL0_KEY || '';
const KEY_HASH = crypto.createHash('sha256').update(KEY).digest();
const MSG_PER_S = 150;      // a game sends about 20 a second; far past that the connection is dropped
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
// ---- what one player can do to the others is checked here too -----------------------------------
// Chalk signs: one of the eight marks, placed where the player really is, a few per address.
const SIGN_IDS = new Set(['fwd', 'back', 'safe', 'danger', 'dead', 'exit', 'eye', 'water']);
const SIGN_WALK = 10, SIGNS_PER_HOUR = 12, SIGNS_PER_DAY = 40, SIGNS_NEAR = 3, SIGNS_MAX = 4000;
const signBudget = new Map(); // address -> [times of the signs it placed in the last day]
// Creatures a player's game is simulating are shown to the others only when they behave like creatures:
// near their owner, moving no faster than a creature can, having existed for a few seconds, and not
// appearing next to somebody else. One that jumps starts again from nothing.
const ENT_RANGE = 150, ENT_V = 8, ENT_AGE = 3000, ENT_CLEAR = 12, CELL_M = 0.6, HORDE_V = 4.6; // creatures reach 6 m/s, the horde 0.92 of a sprint
const CONN_PER_MIN = 30;
const connTimes = new Map(); // address -> times of its recent connections
const pubStat = (r) => { const { uid, walk, ...rest } = r; return rest; };
const pubSector = (r) => { const { uid, n, ...rest } = r; return rest; };
function save() {
  if (!dirty) return; dirty = false;
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = DATA + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), (e) => { if (!e) fs.rename(tmp, DATA, () => {}); });
}
setInterval(() => { try { save(); } catch (e) { oops('save', e); } }, 10000);

const clients = new Map();
const perIp = new Map();
const rid = () => crypto.randomBytes(6).toString('base64url');
const cleanName = (n) => { let s = String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 16); if (s.length < 2 || BAD.test(s)) s = 'guest-' + rid().slice(0, 4); return s; };
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi);
// a connection that does not read what it is sent is skipped, and cut off if it lets a lot pile up
const ready = (c) => { if (c.ws.readyState !== 1) return false; const b = c.ws.bufferedAmount; if (b > 2097152) { c.ws.terminate(); return false; } return b < 262144; };
const send = (c, o) => { if (ready(c)) c.ws.send(JSON.stringify(o)); };
const all = (o, except) => { const s = JSON.stringify(o); for (const c of clients.values()) if (c !== except && ready(c)) c.ws.send(s); };
// A name that is on the leaderboard belongs to whoever put it there. Somebody else asking for it, or for
// the name of a player who is online right now, gets a few characters added.
const nameKey = (n) => n.toLowerCase().replace(/[\s_\-]+/g, '');
function freeName(name, uid) {
  const k = nameKey(name);
  // on the board the name is held by the row with the most sectors (the oldest, if they are level)
  let best = null;
  for (const r of db.stat) if ((r.sectors || 0) >= 1 && nameKey(r.username) === k && (!best || r.sectors > best.sectors || (r.sectors === best.sectors && String(r.created_at) < String(best.created_at)))) best = r;
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
  if (e.length > 8) o.push(typeof e[8] === 'string' ? e[8].replace(/[^\w \-]/g, '').slice(0, 16) : null);
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
    const t = Date.now(); if (t - (c.screamT || 0) < 4000) return; c.screamT = t;
    const o = { t: 'e', from: c.id, d: { k: 'scream', x: c.state.x, y: c.state.y + 1.5, z: c.state.z } };
    for (const p of clients.values()) if (p !== c && p.state && Math.hypot(p.state.x - c.state.x, p.state.z - c.state.z) < 80) send(p, o);
  } else if (d.k === 'rtc') {
    // voice chat hand-shake: one player to one nearby player, nothing but the hand-shake itself
    if (!okRate(c, 'rtc', 30) || typeof m.to !== 'string') return;
    const p = clients.get(m.to); if (!p || p === c || !p.state || Math.hypot(p.state.x - c.state.x, p.state.z - c.state.z) > 70) return;
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
      if (!SIGN_IDS.has(d.g) || !num(d.x, -1e7, 1e7) || !num(d.y, -100, 100) || !num(d.z, -1e7, 1e7) || !num(d.r, -1e4, 1e4)) return;
      if (!c.state || Math.hypot(d.x - c.state.x, d.z - c.state.z) > 6) return;
      // by someone who is walking around in there (not a script that just connected or just teleported),
      // not on top of other signs, and only so many from one address
      const t = Date.now();
      if (walked(c) < SIGN_WALK || t < (c.holdT || 0) || t - (c.signT || 0) < 2000) { flag(c, 'sign'); return; }
      if (db.sign.filter((r) => Math.hypot(r.x - d.x, r.z - d.z) < 3).length >= SIGNS_NEAR) { flag(c, 'sign (too many in one spot)'); return; }
      const times = (signBudget.get(c.ip) || []).filter((x) => t - x < DAY);
      if (times.length >= SIGNS_PER_DAY || times.filter((x) => t - x < 3600000).length >= SIGNS_PER_HOUR) { flag(c, 'sign (too many from one address)'); return; }
      times.push(t); signBudget.set(c.ip, times); c.signT = t;
      const mine = db.sign.filter((r) => r.uid === c.uid);
      if (mine.length >= 30) { const old = mine[0]; db.sign.splice(db.sign.indexOf(old), 1); all({ t: 'c', op: 'delete', c: name, id: old.id }); }
      if (db.sign.length >= SIGNS_MAX) { const old = db.sign.shift(); all({ t: 'c', op: 'delete', c: name, id: old.id }); }
      const r = { id: rid(), g: d.g, x: d.x, y: d.y, z: d.z, r: d.r, username: c.name, uid: c.uid, a: ipTag(c.ip), created_at: new Date().toISOString() };
      db.sign.push(r); dirty = true;
      const pub = { ...r }; delete pub.uid; delete pub.a;
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
  if (cell !== c.cell) { c.cell = cell; if (!c.cells.has(cell)) { if (c.cells.size > 8000) c.cells.clear(); c.cells.add(cell); step = CELL; } }
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
// Nothing a visitor sends may take the server down: every entry point is wrapped, and whatever still
// slips through is written to the log instead of ending the process.
let oopsN = 0;
const oops = (where, e) => { if (++oopsN <= 200) console.error(new Date().toISOString(), 'error in', where + ':', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); };
process.on('uncaughtException', (e) => oops('process', e));
process.on('unhandledRejection', (e) => oops('promise', e));
wss.on('error', (e) => oops('wss', e));
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch { /* gone */ } });
wss.on('connection', (ws, req) => { try { onConnection(ws, req); } catch (e) { oops('connection', e); try { ws.terminate(); } catch { /* gone */ } } });
function onConnection(ws, req) {
  // Cloudflare's own header cannot be forged through Cloudflare, so it wins. Only when it is the
  // Worker's own address (a proxied request from another zone) is the Worker's X-Level0-IP used.
  const h = req.headers, cf = String(h['cf-connecting-ip'] || ''), key = String(h['x-level0-key'] || '');
  // compared as two digests: always the same length, whatever bytes somebody puts in the header
  const ours = KEY.length >= 16 && key.length > 0 && key.length < 200 && crypto.timingSafeEqual(crypto.createHash('sha256').update(key).digest(), KEY_HASH);
  const ip = String((ours && h['x-level0-ip']) || cf || h['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);
  const n = (perIp.get(ip) || 0) + 1;
  const now = Date.now(), recent = (connTimes.get(ip) || []).filter((x) => now - x < 60000);
  recent.push(now); connTimes.set(ip, recent);
  if (clients.size >= MAX_CLIENTS || n > MAX_PER_IP || recent.length > CONN_PER_MIN) { ws.close(1013, 'full'); return; }
  perIp.set(ip, n);
  const c = { ws, ip, id: null, name: '', uid: '', state: null, changed: false, rate: {}, alive: true, pos: null, walk: 0, secK: '', cell: '', cells: new Set(), entered: [], allow: 3, ents: new Map(), over: 0, flags: {} };
  const hello = setTimeout(() => { if (!c.id) ws.close(); }, 8000);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (buf) => { try { onMessage(buf); } catch (e) { oops('message', e); try { ws.terminate(); } catch { /* gone */ } } });
  const onMessage = (buf) => {
    if (!okRate(c, 'all', MSG_PER_S)) { if (++c.over > 300) ws.terminate(); return; }
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!c.id) {
      if (m.t !== 'hello' || typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 64) return ws.close();
      clearTimeout(hello);
      c.id = rid(); c.uid = crypto.createHash('sha256').update(m.token).digest('base64url').slice(0, 14); c.name = freeName(cleanName(m.name), c.uid);
      const peers = []; for (const p of clients.values()) peers.push([p.id, p.name, p.state]);
      clients.set(c.id, c);
      const strip = (r) => { const { uid, a, ...rest } = r; return rest; };
      send(c, { t: 'w', id: c.id, name: c.name, peers, cols: { sector_v1: db.sector.map(pubSector), sign_v1: db.sign.map(strip), stat_v1: db.stat.map(pubStat) } });
      all({ t: 'j', id: c.id, name: c.name }, c);
      return;
    }
    if (m.t === 'p') { if (!okRate(c, 'p', 20)) return; const s = cleanState(m.s); if (s) { c.state = s; c.changed = true; track(c, s); if (s.e) s.e = entities(c, s.e); } }
    else if (m.t === 'e') { if (okRate(c, 'e', 40)) event(c, m); }
    else if (m.t === 'c') collection(c, m);
  };
  ws.on('close', () => {
    clearTimeout(hello);
    perIp.set(ip, (perIp.get(ip) || 1) - 1); if (perIp.get(ip) <= 0) perIp.delete(ip);
    if (c.id) { clients.delete(c.id); all({ t: 'l', id: c.id }); }
  });
  ws.on('error', () => {});
}

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
// forget addresses that have been quiet for a day
setInterval(() => {
  const t = Date.now();
  for (const [ip, a] of connTimes) if (!a.length || t - a[a.length - 1] > 60000) connTimes.delete(ip);
  for (const [ip, a] of signBudget) if (!a.length || t - a[a.length - 1] > DAY) signBudget.delete(ip);
  for (const [ip, a] of newRows) if (!a.length || t - a[a.length - 1] > DAY) newRows.delete(ip);
  for (const [ip, b] of claimBudget) if (t - b.t > DAY) claimBudget.delete(ip);
}, 3600000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dirty && fs.writeFileSync(DATA, JSON.stringify(db)); process.exit(0); });
server.listen(PORT, HOST, () => console.log(`level0 server on ${HOST}:${PORT}, ${db.sector.length} sectors stored`));
