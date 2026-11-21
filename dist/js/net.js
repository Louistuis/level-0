// Networking. One game, three transports with the same small surface:
//   websim  - WebsimSocket (presence, events, persistent collections) inside websim.com
//   nord    - our own tiny WebSocket server (server/server.mjs), used on backrooms.lou15.com
//   offline - nothing reachable: the world still works, alone, saved in localStorage
// The shared world is a set of "sector claims": the first client that needs a sector
// generates it and stores its seed and their name. Everybody after that builds the
// sector from the stored seed, so it stays the way it was first found.
import { hash3, WORLD_SEED, SIGNS } from './util.js';

// ---- nothing another player sends is used as it comes ------------------------------------------
// On websim.com there is no server of ours between the players: presence and records arrive exactly
// as somebody's browser wrote them. Everything is rebuilt here from checked values, the same way
// server/server.mjs does it for backrooms.lou15.com.
const fin = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const text = (v, n, d) => (typeof v === 'string' && v.length ? v.slice(0, n) : d);
// (never Number(v) or String(v) on something a stranger wrote: an object can make those throw)
const count = (v) => { const n = Math.floor(typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN); return Number.isFinite(n) ? Math.min(1e7, Math.max(0, n)) : 0; };
const SIGN_OK = new Set(SIGNS.map((x) => x.id));
function cleanEnt(e, pid) {
  if (!Array.isArray(e) || e.length < 7 || e.length > 12 || typeof e[0] !== 'string' || typeof e[1] !== 'string' || !/^[LHBMKWR]$/.test(e[1])) return null;
  if (!fin(e[2], -1e7, 1e7) || !fin(e[3], -100, 100) || !fin(e[4], -1e7, 1e7) || !fin(e[5], -1e4, 1e4) || typeof e[6] !== 'string' || e[6].length > 16) return null;
  // a creature's id belongs to the player whose game runs it
  const id = e[0].startsWith(pid + '.') ? e[0].slice(0, 80) : pid + '.' + e[0].replace(/[^\w.\-]/g, '').slice(0, 24);
  const o = [id, e[1], e[2], e[3], e[4], e[5], e[6]];
  if (e.length > 7) o.push(fin(e[7], -1e6, 1e6) ? e[7] : 0);
  if (e.length > 8) o.push(typeof e[8] === 'string' ? e[8].replace(/[^\w \-]/g, '').slice(0, 16) : null);
  if (e.length > 9) o.push(e[9] ? 1 : 0);
  if (e.length > 10) o.push(Array.isArray(e[10]) && e[10].length === 4 && e[10].every((v) => Number.isInteger(v) && Math.abs(v) < 2e7) ? e[10].slice() : null);
  if (e.length > 11) o.push(fin(e[11], 0, 50) ? e[11] : 0);
  return o;
}
function cleanPeer(s, pid) {
  if (!s || typeof s !== 'object' || !fin(s.x, -1e7, 1e7) || !fin(s.z, -1e7, 1e7) || !fin(s.y, -100, 100)) return undefined;
  const o = { x: s.x, y: s.y, z: s.z, w: fin(s.w, -1e4, 1e4) ? s.w : 0, p: fin(s.p, -2, 2) ? s.p : 0, f: s.f ? 1 : 0, c: s.c ? 1 : 0, a: s.a === 0 ? 0 : 1, n: fin(s.n, 0, 1) ? s.n : 0, v: s.v ? 1 : 0 };
  if (Array.isArray(s.e)) { o.e = []; for (let i = 0; i < s.e.length && i < 8; i++) { const e = cleanEnt(s.e[i], pid); if (e) o.e.push(e); } }
  return o;
}

const now = () => performance.now();
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } } };

class WebsimTransport {
  constructor() { this.kind = 'websim'; this.onEvent = () => {}; this._peers = new Map(); }
  async init() {
    this.room = new window.WebsimSocket();
    await this.room.initialize();
    this.id = this.room.clientId;
    const me = (this.room.peers && this.room.peers[this.id]) || {};
    this.username = me.username || 'anonymous'; this.avatarUrl = me.avatarUrl || '';
    try { const u = await window.websim.getCurrentUser(); if (u && u.username) { this.username = u.username; this.avatarUrl = u.avatar_url || this.avatarUrl; } } catch { /* fine */ }
    if (this.username === 'anonymous') this.username = 'guest-' + String(this.id).slice(0, 4);
    this.room.onmessage = (ev) => { const d = ev && ev.data; if (!d || d.type !== 'ev' || d.clientId === this.id || typeof d.clientId !== 'string') return; if (d.to && d.to !== this.id) return; if (d.d && typeof d.d === 'object') this.onEvent(d.clientId, d.d); };
    this._seen = new WeakMap(); // raw presence object -> checked copy (it is checked once, not every frame)
  }
  peers() {
    const out = this._peers; out.clear();
    const P = this.room.peers || {}, S = this.room.presence || {};
    let n = 0;
    for (const id in P) {
      if (id === this.id || !P[id]) continue;
      if (++n > 100) break; // more than a room ever holds
      const raw = S[id]; let s;
      if (raw && typeof raw === 'object') { s = this._seen.get(raw); if (s === undefined) { s = cleanPeer(raw, id) || null; this._seen.set(raw, s); } }
      out.set(id, { username: text(P[id].username, 32, 'someone'), s: s || undefined });
    }
    return out;
  }
  setPresence(s) { this.room.updatePresence(s); }
  send(d, to) { this.room.send({ type: 'ev', d, to: to || null }); }
  coll(name) {
    const c = this.room.collection(name);
    return { list: () => c.getList() || [], create: (d) => c.create(d), update: (id, d) => c.update(id, d), remove: (id) => c.delete(id), sub: (cb) => c.subscribe(cb) };
  }
}

const COLS = ['sector_v1', 'sign_v1', 'stat_v1']; // the three lists the server keeps; nothing else is taken from it
class NordTransport {
  constructor(url, name) { this.kind = 'nord'; this.url = url; this.username = name; this.avatarUrl = ''; this.onEvent = () => {}; this._peers = new Map(); this.cols = {}; this.subs = {}; this.pending = new Map(); this.rid = 1; this.open = false; }
  init() {
    let token = LS.get('level0.token', null);
    if (!token) { token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); LS.set('level0.token', token); }
    this.token = token;
    return new Promise((res, rej) => {
      let done = false;
      const fail = (e) => { if (!done) { done = true; rej(e); } };
      const go = () => {
        const ws = new WebSocket(this.url); this.ws = ws;
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: this.username, token, v: 1 }));
        ws.onmessage = (m) => { let d; try { d = JSON.parse(m.data); } catch { return; } this._msg(d); if (d.t === 'w' && !done) { done = true; res(); } };
        ws.onclose = () => { this.open = false; if (!done) return fail(new Error('closed')); this._peers.clear(); setTimeout(go, 2500); };
        ws.onerror = () => fail(new Error('ws error'));
      };
      go(); setTimeout(() => fail(new Error('timeout')), 7000);
    });
  }
  _fire(c) { for (const cb of this.subs[c] || []) cb(this.cols[c]); }
  _msg(d) {
    if (d.t === 'w') {
      this.id = d.id; this.username = d.name; this.open = true; this._peers.clear();
      for (const p of d.peers) this._peers.set(p[0], { username: p[1], s: p[2] || undefined });
      for (const c of COLS) if (Array.isArray(d.cols && d.cols[c])) { this.cols[c] = d.cols[c]; this._fire(c); }
      if (this._last) this.setPresence(this._last);
    } else if (d.t === 'P') { for (const u of d.u) { const p = this._peers.get(u[0]); if (p) p.s = u[1]; } }
    else if (d.t === 'j') this._peers.set(d.id, { username: d.name, s: undefined });
    else if (d.t === 'l') this._peers.delete(d.id);
    else if (d.t === 'e') this.onEvent(d.from, d.d);
    else if (d.t === 'c') {
      if (!COLS.includes(d.c) || (d.op !== 'delete' && (!d.r || typeof d.r !== 'object'))) return;
      const L = this.cols[d.c] || (this.cols[d.c] = []);
      if (d.op === 'create') { if (!L.some((r) => r.id === d.r.id)) L.unshift(d.r); }
      else if (d.op === 'update') { const i = L.findIndex((r) => r.id === d.r.id); if (i >= 0) L[i] = d.r; else L.unshift(d.r); }
      else if (d.op === 'delete') { const i = L.findIndex((r) => r.id === d.id); if (i >= 0) L.splice(i, 1); }
      this._fire(d.c);
      if (d.rid && this.pending.has(d.rid)) { this.pending.get(d.rid)(d.r); this.pending.delete(d.rid); }
    }
  }
  _tx(o) { if (this.open && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  peers() { return this._peers; }
  setPresence(s) { this._last = s; this._tx({ t: 'p', s }); }
  send(d, to) { this._tx({ t: 'e', d, to: to || undefined }); }
  coll(name) {
    return {
      list: () => this.cols[name] || [],
      create: (d) => new Promise((res) => { const rid = this.rid++; this.pending.set(rid, res); this._tx({ t: 'c', op: 'create', c: name, d, rid }); setTimeout(() => { if (this.pending.delete(rid)) res(null); }, 5000); }),
      update: (id, d) => { this._tx({ t: 'c', op: 'update', c: name, id, d }); return Promise.resolve(); },
      remove: (id) => { this._tx({ t: 'c', op: 'delete', c: name, id }); return Promise.resolve(); },
      sub: (cb) => { (this.subs[name] || (this.subs[name] = [])).push(cb); },
    };
  }
}

class OfflineTransport {
  constructor(name) { this.kind = 'offline'; this.id = 'solo'; this.username = name || 'you'; this.avatarUrl = ''; this.onEvent = () => {}; this._peers = new Map(); this.subs = {}; }
  async init() {}
  peers() { return this._peers; }
  setPresence() {} send() {}
  coll(name) {
    const key = 'level0.off.' + name, fire = () => { for (const cb of this.subs[name] || []) cb(LS.get(key, [])); };
    return {
      list: () => LS.get(key, []),
      create: async (d) => { const L = LS.get(key, []); const r = { ...d, id: Math.random().toString(36).slice(2), username: this.username, created_at: new Date().toISOString() }; L.unshift(r); LS.set(key, L.slice(0, 4000)); fire(); return r; },
      update: async (id, d) => { const L = LS.get(key, []); const r = L.find((x) => x.id === id); if (r) Object.assign(r, d); LS.set(key, L); fire(); },
      remove: async (id) => { LS.set(key, LS.get(key, []).filter((x) => x.id !== id)); fire(); },
      sub: (cb) => { (this.subs[name] || (this.subs[name] = [])).push(cb); },
    };
  }
}

export class Net {
  constructor(tr) {
    this.tr = tr; this.kind = tr.kind;
    this.claims = new Map();          // "sx,sz" -> { seed, by, mine, at }
    this.claimsReady = false;
    this.onClaimChange = () => {}; this.onSigns = () => {}; this.handlers = {};
    this.queue = []; this.lastTx = 0; this.lastState = 0; this.state = null; this.stateDirty = false;
    this.signs = []; this.board = []; this.myStat = null; this.statDirty = false; this.statT = 0;
    tr.onEvent = (from, d) => { const h = d && typeof d.k === 'string' && Object.hasOwn(this.handlers, d.k) ? this.handlers[d.k] : null; if (h) { try { h(from, d); } catch (e) { /* a bad event is dropped */ } } };
  }
  get id() { return this.tr.id; }
  get username() { return this.tr.username; }
  get online() { return this.tr.peers().size + 1; }
  peers() { return this.tr.peers(); }
  on(k, fn) { this.handlers[k] = fn; }
  send(k, d = {}, to) { this.tr.send({ ...d, k }, to); }

  start() {
    this.cSector = this.tr.coll('sector_v1'); this.cSign = this.tr.coll('sign_v1'); this.cStat = this.tr.coll('stat_v1');
    const onSectors = (list) => { try { this._sectors(Array.isArray(list) ? list : []); } catch (e) { console.warn('sectors', e); } };
    this.cSector.sub(onSectors);
    this.cSign.sub((l) => { try { this.signs = this._signs(l); this.onSigns(this.signs); } catch (e) { console.warn('signs', e); } });
    this.cStat.sub((l) => { try { this._stats(l); } catch (e) { console.warn('stats', e); } });
    // collections may arrive a moment after the socket opens
    // each part on its own: whatever is in one collection, the world still opens
    const first = () => {
      try { onSectors(this.cSector.list()); } catch (e) { console.warn('sectors', e); }
      this.claimsReady = true;
      try { this.signs = this._signs(this.cSign.list()); this.onSigns(this.signs); } catch (e) { console.warn('signs', e); }
      try { this._stats(this.cStat.list()); } catch (e) { console.warn('stats', e); }
    };
    if (this.kind === 'websim') setTimeout(first, 1400); else first();
  }
  // chalk signs: one of the real marks, at a real place, and no more than anyone may leave
  _signs(list) {
    const out = [], per = new Map();
    if (!Array.isArray(list)) return out;
    for (const r of list) {
      if (!r || typeof r !== 'object' || !SIGN_OK.has(r.g) || !fin(r.x, -1e7, 1e7) || !fin(r.z, -1e7, 1e7)) continue;
      const u = text(r.username, 32, 'someone'), n = (per.get(u) || 0) + 1;
      if (n > 30) continue;
      per.set(u, n);
      out.push({ id: text(r.id, 64, 's' + out.length), g: r.g, x: r.x, y: fin(r.y, -100, 100) ? r.y : 0, z: r.z, r: fin(r.r, -1e4, 1e4) ? r.r : 0, username: u, created_at: text(r.created_at, 40, '') });
      if (out.length >= 4000) break;
    }
    return out;
  }
  _sectors(list) {
    const win = new Map();
    for (const r of list) {
      if (!r || typeof r !== 'object' || typeof r.k !== 'string' || !/^-?\d{1,6},-?\d{1,6}$/.test(r.k) || typeof r.s !== 'number') continue;
      // a sector has one possible seed (see seedFor). A record with another one would change the place
      // for everybody who believed it, so it is not believed.
      const [kx, kz] = r.k.split(',').map(Number);
      if ((r.s >>> 0) !== hash3(kx, kz, WORLD_SEED ^ 0x1234)) continue;
      const cur = win.get(r.k), at = text(r.created_at, 40, ''), id = text(r.id, 64, '');
      if (!cur || at < cur.at || (at === cur.at && id < cur.id)) win.set(r.k, { s: r.s, username: r.username, at, id });
    }
    for (const [k, r] of win) {
      const seed = r.s >>> 0, cur = this.claims.get(k), by = text(r.username, 32, 'someone'), mine = by === this.username;
      if (cur && cur.seed === seed) { cur.by = by; cur.mine = mine; cur.pending = false; continue; }
      this.claims.set(k, { seed, by, mine, pending: false });
      if (cur) { const [sx, sz] = k.split(',').map(Number); this.onClaimChange(sx, sz, seed); }
    }
    if (this._statRaw && this.claimsReady && this.kind === 'websim') this._stats(this._statRaw);
  }
  // Seed of a sector. If nobody has generated it yet, we do, right now.
  seedFor(sx, sz) {
    if (!this.claimsReady) return null;
    const k = sx + ',' + sz, c = this.claims.get(k);
    if (c) return c.seed;
    // The seed is derived from the world seed, so two people arriving at the same instant
    // (or someone whose write fails) still build the identical sector. The claim records who was first.
    const seed = hash3(sx, sz, WORLD_SEED ^ 0x1234);
    this.claims.set(k, { seed, by: this.username, mine: true, pending: true });
    this.queue.push({ k, s: seed });
    return seed;
  }
  claim(sx, sz) { return this.claims.get(sx + ',' + sz) || null; }

  setState(s) { this.state = s; this.stateDirty = true; }
  tick() {
    const t = now();
    if (this.stateDirty && t - this.lastState > 110) { this.lastState = t; this.stateDirty = false; this.tr.setPresence(this.state); }
    if (this.queue.length && t - this.lastTx > 140) {
      this.lastTx = t; const q = this.queue.shift();
      // the answer is the winning record for that sector, ours or somebody faster
      Promise.resolve(this.cSector.create({ k: q.k, s: q.s })).then((r) => {
        if (r && r.k) this._sectors([r]);
        else if ((q.n = (q.n || 0) + 1) < 6) setTimeout(() => { const c = this.claims.get(q.k); if (c && c.pending) this.queue.push(q); }, 2500);
      }).catch(() => {});
    }
    if (this.statDirty && t - this.statT > 15000) { this.statT = t; this.statDirty = false; this._pushStat(); }
  }

  placeSign(g, x, y, z, r) {
    const mine = this.signs.filter((s) => s.username === this.username);
    if (mine.length >= 30) { const old = mine[mine.length - 1]; Promise.resolve(this.cSign.remove(old.id)).catch(() => {}); }
    const q = (v) => Math.round(v * 100) / 100;
    return Promise.resolve(this.cSign.create({ g, x: q(x), y: q(y), z: q(z), r: q(r) })).catch(() => {});
  }
  // The leaderboard: numbers are made numbers, and nobody is shown with more sectors than there are
  // sectors with their name on them (on websim.com a score is whatever a browser wrote).
  _stats(list) {
    if (!Array.isArray(list)) list = [];
    this._statRaw = list;
    // (backrooms.lou15.com counts scores on its own server, so there the rows are taken as they are)
    const check = this.kind === 'websim' && this.claimsReady, owned = new Map();
    if (check) for (const c of this.claims.values()) if (!c.pending && c.by) owned.set(c.by, (owned.get(c.by) || 0) + 1);
    const best = new Map();
    for (let i = 0; i < list.length && i < 20000; i++) {
      const r = list[i]; if (!r || typeof r !== 'object' || typeof r.username !== 'string' || !r.username) continue;
      const u = r.username.slice(0, 32);
      let sectors = count(r.sectors); if (check) sectors = Math.min(sectors, owned.get(u) || 0);
      const c = best.get(u);
      if (!c || sectors >= c.sectors) best.set(u, { username: u, sectors, artifacts: Math.min(12, count(r.artifacts)), escapes: check ? Math.min(sectors + 3, count(r.escapes)) : count(r.escapes), you: u === this.username });
      if (u === this.username && (!this.myStat || this.myStat.id === r.id || !this.myStat.id)) this.myStat = r;
    }
    this.board = [...best.values()].sort((a, b) => b.sectors - a.sectors || b.artifacts - a.artifacts).slice(0, 25);
  }
  saveStats(st) { this.pendingStat = { sectors: st.sectors | 0, artifacts: st.artifacts | 0, escapes: st.escapes | 0, deaths: st.deaths | 0, far: st.far | 0 }; this.statDirty = true; }
  _pushStat() {
    const d = this.pendingStat; if (!d) return;
    if (this.myStat && this.myStat.id) Promise.resolve(this.cStat.update(this.myStat.id, d)).catch(() => {});
    else Promise.resolve(this.cStat.create(d)).then((r) => { if (r) this.myStat = r; }).catch(() => {});
  }
}

// Decide which world we are plugged into and connect.
export async function connect(opts) {
  let tr = null;
  const q = new URLSearchParams(location.search);
  if (opts.edition === 'websim' && window.WebsimSocket && !q.get('offline')) {
    try { tr = new WebsimTransport(); await tr.init(); } catch (e) { console.warn('websim transport failed', e); tr = null; }
  } else if (opts.edition === 'lou15' && !q.get('offline')) {
    const local = /^(localhost|127\.|\[::1\])/.test(location.host);
    // (another server can only be named on a developer's own machine: a link must never send a player's identity somewhere else)
    const url = (local && q.get('ws')) || (local ? 'ws://' + location.hostname + ':8791' : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    try { tr = new NordTransport(url, opts.name); await tr.init(); } catch (e) { console.warn('server unreachable, playing alone', e); tr = null; }
  }
  if (!tr) { tr = new OfflineTransport(opts.name); await tr.init(); }
  const net = new Net(tr);
  return net;
}
export { LS };
