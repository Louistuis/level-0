// Networking. One game, three transports with the same small surface:
//   websim  - WebsimSocket (presence, events, persistent collections) inside websim.com
//   nord    - our own tiny WebSocket server (server/server.mjs), used on backrooms.lou15.com
//   offline - nothing reachable: the world still works, alone, saved in localStorage
// The shared world is a set of "sector claims": the first client that needs a sector
// generates it and stores its seed and their name. Everybody after that builds the
// sector from the stored seed, so it stays the way it was first found.
import { hash3, WORLD_SEED } from './util.js';

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
    this.room.onmessage = (ev) => { const d = ev && ev.data; if (!d || d.type !== 'ev' || d.clientId === this.id) return; if (d.to && d.to !== this.id) return; this.onEvent(d.clientId, d.d); };
  }
  peers() {
    const out = this._peers; out.clear();
    const P = this.room.peers || {}, S = this.room.presence || {};
    for (const id in P) if (id !== this.id) out.set(id, { username: P[id].username || 'someone', s: S[id] });
    return out;
  }
  setPresence(s) { this.room.updatePresence(s); }
  send(d, to) { this.room.send({ type: 'ev', d, to: to || null }); }
  coll(name) {
    const c = this.room.collection(name);
    return { list: () => c.getList() || [], create: (d) => c.create(d), update: (id, d) => c.update(id, d), remove: (id) => c.delete(id), sub: (cb) => c.subscribe(cb) };
  }
}

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
      for (const c in d.cols) { this.cols[c] = d.cols[c]; this._fire(c); }
      if (this._last) this.setPresence(this._last);
    } else if (d.t === 'P') { for (const u of d.u) { const p = this._peers.get(u[0]); if (p) p.s = u[1]; } }
    else if (d.t === 'j') this._peers.set(d.id, { username: d.name, s: undefined });
    else if (d.t === 'l') this._peers.delete(d.id);
    else if (d.t === 'e') this.onEvent(d.from, d.d);
    else if (d.t === 'c') {
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
    tr.onEvent = (from, d) => { const h = d && this.handlers[d.k]; if (h) h(from, d); };
  }
  get id() { return this.tr.id; }
  get username() { return this.tr.username; }
  get online() { return this.tr.peers().size + 1; }
  peers() { return this.tr.peers(); }
  on(k, fn) { this.handlers[k] = fn; }
  send(k, d = {}, to) { this.tr.send({ ...d, k }, to); }

  start() {
    this.cSector = this.tr.coll('sector_v1'); this.cSign = this.tr.coll('sign_v1'); this.cStat = this.tr.coll('stat_v1');
    const onSectors = (list) => this._sectors(list || []);
    this.cSector.sub(onSectors);
    this.cSign.sub((l) => { this.signs = l || []; this.onSigns(this.signs); });
    this.cStat.sub((l) => this._stats(l || []));
    // collections may arrive a moment after the socket opens
    const first = () => { onSectors(this.cSector.list()); this.signs = this.cSign.list(); this.onSigns(this.signs); this._stats(this.cStat.list()); this.claimsReady = true; };
    if (this.kind === 'websim') setTimeout(first, 1400); else first();
  }
  _sectors(list) {
    const win = new Map();
    for (const r of list) {
      if (!r || typeof r.k !== 'string') continue;
      const cur = win.get(r.k);
      if (!cur || String(r.created_at) < String(cur.created_at) || (r.created_at === cur.created_at && String(r.id) < String(cur.id))) win.set(r.k, r);
    }
    for (const [k, r] of win) {
      const seed = Number(r.s) >>> 0, cur = this.claims.get(k), mine = r.username === this.username;
      if (cur && cur.seed === seed) { cur.by = r.username; cur.mine = mine; cur.pending = false; continue; }
      this.claims.set(k, { seed, by: r.username, mine, pending: false });
      if (cur) { const [sx, sz] = k.split(',').map(Number); this.onClaimChange(sx, sz, seed); }
    }
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
  _stats(list) {
    const best = new Map();
    for (const r of list) { if (!r || !r.username) continue; const c = best.get(r.username); if (!c || (r.sectors || 0) >= (c.sectors || 0)) best.set(r.username, r); if (r.username === this.username && (!this.myStat || this.myStat.id === r.id || !this.myStat.id)) this.myStat = r; }
    this.board = [...best.values()].sort((a, b) => (b.sectors || 0) - (a.sectors || 0) || (b.artifacts || 0) - (a.artifacts || 0)).slice(0, 25)
      .map((r) => ({ username: r.username, sectors: r.sectors || 0, artifacts: r.artifacts || 0, escapes: r.escapes || 0, you: r.username === this.username }));
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
    const url = q.get('ws') || (local ? 'ws://' + location.hostname + ':8791' : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    try { tr = new NordTransport(url, opts.name); await tr.init(); } catch (e) { console.warn('server unreachable, playing alone', e); tr = null; }
  }
  if (!tr) { tr = new OfflineTransport(opts.name); await tr.init(); }
  const net = new Net(tr);
  return net;
}
export { LS };
