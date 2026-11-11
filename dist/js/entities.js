// Other players, the things that hunt, and the anomalies that come and go.
// Each client simulates the creatures it spawned and publishes them in its presence,
// so everybody nearby sees (and is hunted by) the same ones.
//
// 0.3: a director decides when anything happens (quiet, build, encounter, relief), nothing
// hostile near the entry point or early in a life, and every creature follows one rule from
// the lore that a careful wanderer can learn and live by.
import * as THREE from './three.module.min.js';
import { S, clamp, damp, angDiff, lerp, smooth } from './util.js';
import { makeSuit, animSuit, makeChair, makeDoor, makeTag, startPack, packWarmSuit } from './props.js';
import { BIOMES, ENTITIES } from './biomes.js';
import { makeHowler, animHowler, makeHound, animHound, makeFaceling, animFaceling, makeSmiler, animSmiler, makeHorde, animHorde, poseStealer, scrambleName, WARM, warmSlice } from './creatures.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
let NEXT = 1;

// ---- tuning ----
const ENTRY_X = 14.7, ENTRY_Z = 14.7;
const SAFE_R = 85;       // nothing hostile inside this radius round the entry point
const FULL_R = 300;      // presence is full from here on
const GRACE = 90;        // seconds of a fresh life with nothing at all
const SCARE_CD = 150;    // the 'scare' sting keeps its force: at most one per this many seconds
const KNOWN = new Set(['L', 'H', 'B', 'M', 'K', 'W', 'R']);
const HOSTILE = new Set(['L', 'H', 'B', 'M', 'K']);
const AUD = (c) => (ENTITIES[c] ? ENTITIES[c].audio : 'longarm');
// player speeds (player.js): walk 2.15, sprint 4.7 for 7.5 s of stamina, crouch 1.05
const SPRINT = 4.7;
const DMG = { L: 0.5, H: 0.65, B: 0.6, M: 0.55, K: 0.45, W: 0.35 };
// what the death screen says (sentence style)
export const CAUSE = {
  L: 'Struck by something tall that heard you',
  H: 'An empty suit took hold of you while you looked away',
  B: 'The grin in the dark reached you',
  M: 'The friend on your radar was not a friend',
  K: 'A Hound ran you down when you turned to run',
  W: 'The Faceling did not want to be seen',
  R: 'The crowd in the corridor caught up with you',
};
const FALLBACK_NAMES = ['wanderer', 'mara_k', 'jonas', 'quietfox', 'elin', 'drift', 'sander', 'nightshift', 'okapi', 'tove', 'vera', 'lukas_m', 'noclip', 'ida', 'max'];

const idHash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const near0 = (x, z) => Math.hypot(x - ENTRY_X, z - ENTRY_Z);

export class Entities {
  constructor(ctx) {
    Object.assign(this, ctx); // scene, world, M, tex, audio, shared
    this.players = new Map();
    this.mine = [];
    this.remote = new Map();
    this.hitCd = 0;
    this.fear = 0; this.watching = false; this.inDark = 0;
    this.tension = 0; this.run = 0;
    this.myId = 'me';
    this.darkS = 0;
    this.debug = false;
    this.anom = null;          // set by Anomalies
    this.testRun = null;       // { x0, z0, x1, z1 } in world cells, for testing Level ! before the generator has it
    this.events = [];          // { t, k, type, d } what the director did (tests, debug)
    this.clock = 0;
    this._resetLife();
  }
  _resetLife() {
    this.lifeT = 0;
    this.dir = { phase: 'quiet', t: GRACE + rnd(10, 40), real: false, type: null, el: 0, dur: 0, hintT: 0, glimpse: false, from: 0, tries: 0, second: 0 };
    this.trail = []; this.trailT = 0; this.stillT = 0; this.pickT = -99; this.takenN = -1; this.lastScare = -999;
    this.creep = null; this.wasAlive = true;
  }
  _log(k, type, extra) { const e = { t: +this.clock.toFixed(1), k, type: type || null, ...extra }; this.events.push(e); if (this.events.length > 400) this.events.shift(); if (this.debug) console.log('[ents]', e); }

  // ---------- other players ----------
  syncPlayers(peers, dt, cam) {
    const u = this.shared;
    const lights = [];
    for (const [id, p] of peers) {
      const s = p.s; if (!s || s.x === undefined) continue;
      let r = this.players.get(id);
      if (!r) {
        r = { obj: makeSuit(this.M, false), tag: makeTag(p.username || 'someone'), x: s.x, y: s.y, z: s.z, yaw: s.w || 0, sp: 0, name: p.username, vx: 0, vz: 0 };
        r.tag.position.y = 2.0; r.obj.add(r.tag);
        this.scene.add(r.obj); this.players.set(id, r);
      }
      const px = r.x, pz = r.z;
      r.x = damp(r.x, s.x, 11, dt); r.y = damp(r.y, s.y, 11, dt); r.z = damp(r.z, s.z, 11, dt);
      if (Math.hypot(s.x - r.x, s.z - r.z) > 6) { r.x = s.x; r.y = s.y; r.z = s.z; }
      r.yaw += angDiff(r.yaw, s.w || 0) * (1 - Math.exp(-12 * dt));
      const id2 = Math.max(dt, 1e-3);
      r.vx = damp(r.vx, (r.x - px) / id2, 8, dt); r.vz = damp(r.vz, (r.z - pz) / id2, 8, dt);
      r.sp = Math.hypot(r.vx, r.vz);
      r.obj.visible = s.a !== 0;
      r.obj.position.set(r.x, r.y, r.z); r.obj.rotation.y = r.yaw;
      animSuit(r.obj, dt, r.sp, !!s.c, s.p || 0);
      const d = Math.hypot(r.x - cam.position.x, r.z - cam.position.z);
      r.d = d; r.alive = s.a !== 0; r.flash = !!s.f; r.pitch = s.p || 0; r.noise = s.n || 0; r.crouch = !!s.c;
      r.tag.material.opacity = r.alive ? clamp((9 - d) / 3, 0, 1) : 0;
      if (r.flash && r.alive && d < 45) lights.push(r);
    }
    for (const [id, r] of this.players) if (!peers.has(id)) { this.scene.remove(r.obj); r.tag.material.map.dispose(); this.players.delete(id); }
    lights.sort((a, b) => a.d - b.d);
    for (let k = 0; k < 3; k++) {
      const r = lights[k];
      u.uRFOn.value[k] = r ? 1 : 0;
      if (!r) continue;
      const sy = Math.sin(r.yaw), cy = Math.cos(r.yaw), cp = Math.cos(r.pitch);
      u.uRFPos.value[k].set(r.x + cy * 0.2 - sy * 0.25, r.y + (r.crouch ? 0.7 : 1.25), r.z - sy * 0.2 - cy * 0.25);
      u.uRFDir.value[k].set(-sy * cp, Math.sin(r.pitch), -cy * cp).normalize();
    }
  }

  targets(pl, game) {
    const t = [{ id: this.myId, me: true, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw, pitch: pl.pitch, noise: pl.noise, flash: pl.flashOn, alive: game.alive, crouch: pl.crouch, vx: pl.vx, vz: pl.vz, speed: pl.speed, sprint: !!pl.sprinting }];
    for (const [id, r] of this.players) if (r.alive) t.push({ id, x: r.x, y: r.y, z: r.z, yaw: r.yaw, pitch: r.pitch, noise: r.noise, flash: r.flash, alive: true, crouch: r.crouch, vx: r.vx, vz: r.vz, speed: r.sp, sprint: r.noise > 0.9 || r.sp > 3.4, name: r.name, d: r.d });
    return t;
  }
  // can target tg see the point (view cone `half` = cos of the half angle, walls block)
  sees(tg, x, y, z, half = 0.5, maxD = 45) {
    const dx = x - tg.x, dz = z - tg.z, d = Math.hypot(dx, dz);
    if (d > maxD) return false;
    if (d < 0.6) return true;
    const cp = Math.cos(tg.pitch), fx = -Math.sin(tg.yaw) * cp, fz = -Math.cos(tg.yaw) * cp, fy = Math.sin(tg.pitch);
    const dy = y - (tg.y + 1.6), l = Math.hypot(d, dy);
    if ((dx * fx + dz * fz + dy * fy) / l < half) return false;
    return this.world.los(tg.x, tg.z, x, z);
  }
  // cos of the angle between where tg faces (plan view) and the point
  facing(tg, x, z) { const dx = x - tg.x, dz = z - tg.z, d = Math.hypot(dx, dz) || 1; return (dx * -Math.sin(tg.yaw) + dz * -Math.cos(tg.yaw)) / d; }
  findSpot(px, py, pz, minR, maxR, opts = {}) {
    const w = this.world;
    let paths = 0;
    for (let k = 0; k < 48; k++) {
      const a = opts.dir !== undefined ? opts.dir + rnd(-opts.spread, opts.spread) : Math.random() * Math.PI * 2, r = rnd(minR, maxR);
      const x = px + Math.sin(a) * r, z = pz + Math.cos(a) * r;
      const cx = Math.floor(x / S), cz = Math.floor(z / S);
      if (w.solid(cx, cz)) continue;
      const f = w.floorC(cx, cz), c = w.ceilC(cx, cz);
      if (c - f < (opts.h || 2.0) || Math.abs(f - py) > 2.2) continue;
      if (w.solid(cx + 1, cz) || w.solid(cx - 1, cz) || w.solid(cx, cz + 1) || w.solid(cx, cz - 1)) continue;
      if (w.floorC(cx + 1, cz) !== f || w.floorC(cx, cz + 1) !== f) continue;
      const cxw = (cx + 0.5) * S, czw = (cz + 0.5) * S;
      if (opts.safe && near0(cxw, czw) < SAFE_R) continue;
      const vis = w.los(px, pz, x, z);
      if (opts.hidden && vis) continue;
      if (opts.visible && !vis) continue;
      if (opts.offView !== undefined) { const dd = Math.hypot(x - px, z - pz) || 1; if (((x - px) * -Math.sin(opts.offView) + (z - pz) * -Math.cos(opts.offView)) / dd > 0.25) continue; }
      if (opts.lit && w.light(x, z) < opts.lit) continue;
      if (opts.dark && w.light(x, z) > opts.dark) continue;
      if (opts.avoid && opts.avoid(cxw, czw)) continue;
      if (opts.path) { if (++paths > 8) return null; if (!w.path(cxw, czw, px, pz, 3000)) continue; }
      return [cxw, f, czw];
    }
    return null;
  }
  // how far one can see along a direction before a wall (m)
  _ray(x, z, a, max = 24) { let d = 0; while (d < max && !this.world.solidAt(x - Math.sin(a) * (d + 0.6), z - Math.cos(a) * (d + 0.6))) d += 0.6; return d; }

  // ---------- spawning ----------
  // spawn(type, pl, [x, y, z]) works for every code (test hook); without `at` the director's placement is used.
  spawn(type, pl, at, opt = {}) {
    if (!KNOWN.has(type)) return null;
    if (type === 'R') return this._spawnHorde(pl, opt.run || this._findRun(pl));
    const spot = at || this._spotFor(type, pl, opt);
    if (!spot) return null;
    const m = {
      id: this.myId + '.' + (NEXT++), type, x: spot[0], y: spot[1], z: spot[2], yaw: Math.random() * 6.28, st: 'idle', own: true,
      t: 0, life: 0, sp: 0, path: null, pi: 0, repath: 0, cd: 0, atk: 0, lost: 0, chase: 0, tx: spot[0], tz: spot[2], far: 0, unseen: 0, born: this.clock,
    };
    // face the player when it arrives
    m.yaw = Math.atan2(-(pl.x - m.x), -(pl.z - m.z));
    if (type === 'L') { m.st = 'investigate'; const j = rnd(2, 5), a = Math.random() * 6.28; m.tx = pl.x + Math.sin(a) * j; m.tz = pl.z + Math.cos(a) * j; m.search = []; }
    else if (type === 'H') { m.st = 'still'; m.goalT = 0; }
    else if (type === 'B') { m.rad = 7.5; m.life = rnd(70, 110); m.st = 'drift'; m.letGo = 0; m.gaze = 0; }
    else if (type === 'M') { m.alias = opt.alias || this._pickName(); m.reveal = 0; m.wrong = 0; m.wave = 0; m.st = 'stand'; m.seenT = 0; m.lightT = 0; m.mirror = Math.random() < 0.4; m.called = false; m.life = rnd(120, 200); }
    else if (type === 'K') { m.st = 'stalk'; m.hold = rnd(9, 15); m.circ = Math.random() < 0.5 ? 1 : -1; m.backT = 0; m.low = 0; }
    else if (type === 'W') { m.st = 'stand'; m.life = rnd(80, 150); m.lightT = 0; m.seen = false; m.hunch = 0; }
    this._build(m);
    this.mine.push(m);
    this._log('spawn', type, { d: Math.round(Math.hypot(m.x - pl.x, m.z - pl.z)) });
    return m;
  }
  _pickName() {
    const close = new Set(); for (const [, r] of this.players) if (r.name && (r.d || 0) < 60) close.add(r.name);
    const pool = (this._names || []).filter((n) => n && !close.has(n));
    return pool.length ? pick(pool) : pick(FALLBACK_NAMES.filter((n) => !close.has(n)));
  }
  _spotFor(type, pl, opt = {}) {
    const back = pl.yaw, fwd = pl.yaw + Math.PI, F = (o) => this.findSpot(pl.x, pl.y, pl.z, o.a, o.b, { safe: true, ...o });
    const behind = opt.behind || Math.random() < 0.55;
    if (type === 'L') return (behind && F({ a: 18, b: 30, hidden: true, path: true, dir: back, spread: 1.1 })) || F({ a: 18, b: 32, hidden: true, path: true });
    if (type === 'H') return (behind && F({ a: 10, b: 18, hidden: true, path: true, dir: back, spread: 1.2 })) || F({ a: 10, b: 20, hidden: true, path: true });
    if (type === 'K') return (behind && F({ a: 16, b: 26, hidden: true, path: true, dir: back, spread: 1.0 })) || F({ a: 16, b: 28, hidden: true, path: true });
    if (type === 'B') return F({ a: 14, b: 26, hidden: true }) || F({ a: 14, b: 26, offView: pl.yaw });
    // the ones that are meant to be seen: far down a hall, placed while you look the other way
    if (type === 'M') return F({ a: 20, b: 34, visible: true, offView: pl.yaw, lit: 0.3 }) || F({ a: 20, b: 34, visible: true, offView: pl.yaw });
    if (type === 'W') return F({ a: 18, b: 32, visible: true, offView: pl.yaw }) || F({ a: 14, b: 30, hidden: true, path: true });
    return null;
  }
  _build(m) {
    const M = this.M;
    if (m.type === 'L') m.obj = makeHowler(M);
    else if (m.type === 'H') m.obj = makeSuit(M, true);
    else if (m.type === 'B') m.obj = makeSmiler(M);
    else if (m.type === 'M') { m.obj = makeSuit(M, false); m.tag = makeTag(m.alias || 'someone'); m.tag.position.y = 2.0; m.obj.add(m.tag); m.tagName = m.alias; }
    else if (m.type === 'K') m.obj = makeHound(M);
    else if (m.type === 'W') m.obj = makeFaceling(M, idHash(m.id) % 3); // the outfit follows the id, so every client dresses it the same
    else if (m.type === 'R') m.obj = makeHorde(M);
    this.scene.add(m.obj);
    m.obj.position.set(m.x, m.y, m.z);
  }
  _remove(m) { this.scene.remove(m.obj); if (m.tag) m.tag.material.map.dispose(); this.audio.removeEntity(m.id); }
  clear() { for (const m of this.mine) this._remove(m); this.mine.length = 0; this._resetLife(); this.run = 0; this.tension = 0; }

  _follow(m, dt, speed, gx, gz, repathEvery) {
    const w = this.world;
    m.repath -= dt;
    const direct = Math.hypot(gx - m.x, gz - m.z) < 3.2 && w.los(m.x, m.z, gx, gz);
    if (!direct && (m.repath <= 0 || !m.path)) {
      m.path = w.path(m.x, m.z, gx, gz, 2600); m.pi = 1; m.repath = repathEvery;
      if (!m.path) return false;
    }
    let ax = gx, az = gz;
    if (!direct && m.path) {
      while (m.pi < m.path.length - 1 && Math.hypot(m.path[m.pi][0] - m.x, m.path[m.pi][1] - m.z) < 0.35) m.pi++;
      const p = m.path[Math.min(m.pi, m.path.length - 1)]; ax = p[0]; az = p[1];
    }
    const dx = ax - m.x, dz = az - m.z, d = Math.hypot(dx, dz);
    // ease the speed (accelerate, brake) and turn at a limited rate
    const acc = speed > m.sp ? (speed > 4 ? 10 : 5) : 8;
    m.sp += clamp(speed - m.sp, -acc * dt, acc * dt);
    if (d > 0.02) {
      const st = Math.min(m.sp * dt, d);
      const nx = m.x + dx / d * st, nz = m.z + dz / d * st;
      if (!w.solidAt(nx, nz)) { m.x = nx; m.z = nz; }
      this._turn(m, Math.atan2(-dx, -dz), dt, 9);
    } else m.turn = damp(m.turn || 0, 0, 8, dt);
    m.y = damp(m.y, w.floorAt(m.x, m.z), 12, dt);
    return true;
  }
  _turn(m, want, dt, k) {
    const max = (m.type === 'K' ? 7 : m.type === 'L' ? 4.5 : 3.5) * dt;
    const step = clamp(angDiff(m.yaw, want) * (1 - Math.exp(-k * dt)), -max, max);
    m.yaw += step; m.turn = damp(m.turn || 0, step / Math.max(dt, 1e-3), 8, dt);
  }
  _stand(m, dt) { m.sp = Math.max(0, m.sp - 8 * dt); m.y = damp(m.y, this.world.floorAt(m.x, m.z), 12, dt); }
  _face(m, x, z, dt, k = 6) { this._turn(m, Math.atan2(-(x - m.x), -(z - m.z)), dt, k); }
  _nearest(m, T) { let best = null, bd = 1e9; for (const tg of T) { if (!tg.alive) continue; const d = Math.hypot(tg.x - m.x, tg.z - m.z); if (d < bd) { bd = d; best = tg; } } return [best, bd]; }
  _seenBy(T, x, y, z, half = 0.5, maxD = 45) { for (const tg of T) if (tg.alive && this.sees(tg, x, y, z, half, maxD)) return tg; return null; }
  // a strike: a short wind-up ('atk', readable), then the blow ('hit', the window in which it lands)
  _strike(m, dt) {
    if (m.st === 'atk') { m.atk -= dt; this._stand(m, dt); if (m.atk <= 0) { m.st = 'hit'; m.atk = 0.3; } return true; }
    if (m.st === 'hit') { m.atk -= dt; if (m.atk <= 0) { m.st = m.after || 'chase'; m.after = null; } return true; }
    return false;
  }
  _startStrike(m, wind, after) { m.st = 'atk'; m.atk = wind; m.after = after; this.audio.play('lunge', { pos: [m.x, m.y + 1.2, m.z] }); }
  // walk off somewhere out of sight and stop existing
  _leave(m, dt, T, speed) {
    const [tg, d] = this._nearest(m, T);
    if (!m.away) m.away = tg && this.findSpot(m.x, m.y, m.z, 8, 18, { hidden: false, avoid: (x, z) => tg && Math.hypot(x - tg.x, z - tg.z) < d + 4 }) || [m.x, m.y, m.z];
    const ok = this._follow(m, dt, speed, m.away[0], m.away[2], 1.5);
    const seen = this._seenBy(T, m.x, m.y + 1.2, m.z, 0.45);
    m.unseen = seen ? 0 : m.unseen + dt;
    if (!ok || Math.hypot(m.away[0] - m.x, m.away[2] - m.z) < 0.8) m.away = null;
    if (m.unseen > 2 && (d > 10 || !tg)) m.gone = true;
    if (m.unseen > 8) m.gone = true;
  }
  _scare(pos, vol = 1) { if (this.clock - this.lastScare < SCARE_CD) return false; this.lastScare = this.clock; this.audio.play('scare', { pos, vol, delay: 0.5 }); this._log('scare'); return true; }
  _behind(m, tg, d) {
    if (m.saidBehind || !tg || !tg.me || d > 6) return;
    if (this.facing(tg, m.x, m.z) < -0.3) { m.saidBehind = true; this.audio.play('behind'); }
  }
  // the room goes quiet while something is close and still
  _hush(dt) { this._hushT = (this._hushT || 0) - dt; if (this._hushT <= 0) { this._hushT = 0.3; if (this.audio.hush) this.audio.hush(0.6); } }
  _sanctuary(tg) { return tg && near0(tg.x, tg.z) < SAFE_R - 10; }

  // ---------- L: Howler. Hunts by sound, then by sight. ----------
  _howler(m, dt, T) {
    const w = this.world;
    let seenTg = null, sd = 1e9, heardTg = null, hd = 1e9;
    for (const tg of T) {
      if (!tg.alive) continue;
      const d = Math.hypot(tg.x - m.x, tg.z - m.z);
      const dark = w.light(tg.x, tg.z) < 0.25 && !tg.flash;
      const range = (tg.flash ? 30 : 21) * (dark ? 0.45 : 1) * (tg.crouch ? 0.55 : 1);
      // it looks where it faces, but feels anything close
      const ahead = ((tg.x - m.x) * -Math.sin(m.yaw) + (tg.z - m.z) * -Math.cos(m.yaw)) / (d || 1);
      const vis = d < range && (ahead > -0.25 || d < 4 || (m.st === 'chase' && m.lost < 1)) && w.los(m.x, m.z, tg.x, tg.z);
      if (vis && d < sd) { sd = d; seenTg = tg; }
      if (tg.noise * 18 > d && d < hd) { hd = d; heardTg = tg; }
    }
    if (this._sanctuary(seenTg || heardTg)) m.st = 'leave';
    if (m.st === 'leave') { this._leave(m, dt, T, 2.2); m.chase = damp(m.chase, 0, 3, dt); return; }
    if (this._strike(m, dt)) { m.chase = 1; return; }
    m.cd -= dt;
    if (seenTg) {
      m.tx = seenTg.x; m.tz = seenTg.z; m.lost = 0; m.target = seenTg.id; m.seen = 1;
      if (m.st !== 'chase' && m.st !== 'howl') { m.st = 'howl'; m.t = 1.15; this._log('howl', 'L', { d: Math.round(sd) }); if (sd < 12 && seenTg.me) this._scare([m.x, m.y + 2, m.z], 0.8); }
    } else {
      m.seen = 0; m.lost += dt;
      if (heardTg && m.st !== 'howl') {
        // a noise: go and look. The further, the less sure it is where.
        const err = Math.min(4, hd * 0.15), a = Math.random() * 6.28;
        if (m.st !== 'chase' || m.lost > 1.5) { m.tx = heardTg.x + Math.sin(a) * err * Math.random(); m.tz = heardTg.z + Math.cos(a) * err * Math.random(); }
        if (m.st === 'roam' || m.st === 'listen' || m.st === 'search') { m.st = 'investigate'; m.search = []; }
      }
    }
    if (m.st === 'howl') {
      // stops, turns, and howls. Then it comes.
      this._stand(m, dt); this._face(m, m.tx, m.tz, dt, 10); m.t -= dt;
      if (m.t <= 0) { m.st = 'chase'; this.audio.play('lunge', { pos: [m.x, m.y + 2, m.z], vol: 0.8 }); }
    } else if (m.st === 'chase') {
      this._follow(m, dt, 4.05, m.tx, m.tz, 0.35);
      if (seenTg && sd < 1.3 && m.cd <= 0) { m.cd = 1.8; this._startStrike(m, 0.45, 'chase'); }
      // lost you: walk to where it last knew you were, then search there
      if (!seenTg && Math.hypot(m.tx - m.x, m.tz - m.z) < 1.0) { m.st = 'search'; m.search = null; this._log('lost', 'L'); }
    } else if (m.st === 'investigate') {
      const ok = this._follow(m, dt, 1.7, m.tx, m.tz, 1.0);
      if (!ok || Math.hypot(m.tx - m.x, m.tz - m.z) < 1) { m.st = 'search'; m.search = null; }
    } else if (m.st === 'search') {
      // check the side rooms round the last place it knew of: a few points it cannot see from there, a pause at each
      if (!m.search) {
        m.search = []; const cx = m.tx, cz = m.tz;
        for (let k = 0; k < 4; k++) { const s = this.findSpot(cx, m.y, cz, 3, 9, { hidden: k < 3 }); if (s) m.search.push(s); }
        m.searchN = 0;
      }
      if (!m.search.length) { m.st = 'roam'; m.t = 0; m.searched = (m.searched || 0) + 1; }
      else {
        const s = m.search[0];
        if (m.t > 0) { m.t -= dt; this._stand(m, dt); if (m.t <= 0) m.search.shift(); }
        else { const ok = this._follow(m, dt, 1.9, s[0], s[2], 1.2); if (!ok || Math.hypot(s[0] - m.x, s[2] - m.z) < 0.7) { m.t = rnd(1.4, 2.8); if (!ok) m.search.shift(); } }
      }
    } else if (m.st === 'listen') {
      this._stand(m, dt); m.t -= dt; if (m.t <= 0) m.st = 'roam';
    } else { // roam
      m.st = 'roam';
      if (!m.wander || Math.hypot(m.wander[0] - m.x, m.wander[2] - m.z) < 0.8) { m.wander = this.findSpot(m.x, m.y, m.z, 6, 16, {}); if (Math.random() < 0.4) { m.st = 'listen'; m.t = rnd(1.5, 4); } }
      if (m.wander && !this._follow(m, dt, 1.15, m.wander[0], m.wander[2], 2.5)) m.wander = null;
      // bored: after two fruitless searches it drifts off
      if ((m.searched || 0) >= 2 && this.clock - m.born > 70) m.st = 'leave';
    }
    m.chase = damp(m.chase, m.st === 'chase' || m.st === 'atk' || m.st === 'hit' ? 1 : m.st === 'howl' ? 0.6 : 0, 4, dt);
  }

  // ---------- H: Hollow. Moves only when nobody is looking; ends up behind you or at the end of your hall. ----------
  _hollow(m, dt, T) {
    let watched = false;
    for (const tg of T) if (tg.alive && this.sees(tg, m.x, m.y + 1.4, m.z, 0.42)) watched = true;
    const [tg, nd] = this._nearest(m, T);
    m.watched = watched; m.life += dt;
    if (watched) m.awake = 1; else if (m.life > 6) m.awake = 1;
    if (this._sanctuary(tg)) m.gone = true;
    if (this._strike(m, dt)) return;
    m.cd -= dt;
    if (watched || !tg || !m.awake) { m.sp = 0; m.st = 'still'; m.unseen = 0; return; }
    m.unseen += dt;
    if (m.life > 140 && m.unseen > 3) { m.gone = true; return; }
    // pick where to be: right behind them, or waiting at the far end of the hall they walk down
    m.goalT -= dt;
    if (m.goalT <= 0 || !m.goal) {
      m.goalT = 1.5;
      const back = tg.yaw, behind = [tg.x + Math.sin(back) * 1.4, tg.z + Math.cos(back) * 1.4];
      let goal = behind;
      if ((tg.speed || 0) > 1 && nd > 4) {
        const fwd = tg.yaw, L = this._ray(tg.x, tg.z, fwd, 22);
        if (L > 8) { const e = L - 1.2; const g2 = [tg.x - Math.sin(fwd) * e, tg.z - Math.cos(fwd) * e]; if (!this.world.solidAt(g2[0], g2[1]) && Math.random() < 0.6) goal = g2; }
      }
      if (this.world.solidAt(goal[0], goal[1])) goal = [tg.x, tg.z];
      m.goal = goal;
    }
    const close = Math.hypot(m.goal[0] - m.x, m.goal[1] - m.z) < 0.6;
    if (close && nd > 2) { m.st = 'wait'; this._stand(m, dt); this._face(m, tg.x, tg.z, dt); }
    else { m.st = 'move'; this._follow(m, dt, 3.3, nd < 3 ? tg.x : m.goal[0], nd < 3 ? tg.z : m.goal[1], 0.4); }
    this._behind(m, tg, nd);
    if (nd < 0.95 && m.cd <= 0) { m.cd = 4; m.st = 'atk'; m.atk = 0.12; m.after = 'gone'; this.audio.play('lunge', { pos: [m.x, m.y + 1.4, m.z] }); if (tg.me) this._scare([m.x, m.y + 1.5, m.z]); }
  }

  // ---------- B: Smiler. Only in the dark. Drawn to light and to running. Hold its gaze and back away. ----------
  _smiler(m, dt, T, game) {
    const [tg, d] = this._nearest(m, T);
    m.life -= dt;
    if (!tg) { m.st = 'fade'; return; }
    if (this._sanctuary(tg)) m.life = Math.min(m.life, 2.5);
    if (this._strike(m, dt)) return;
    m.cd -= dt;
    const los = this.world.los(m.x, m.z, tg.x, tg.z);
    const look = this.facing(tg, m.x, m.z), gazed = los && d < 30 && look > 0.9;
    const lit = tg.flash && gazed && look > 0.94 && d < 22; // the beam is on it
    const ran = (tg.sprint || (tg.speed || 0) > 3.3) && (los || d < 20);
    m.stare = gazed && !lit ? 1 : 0;
    if (m.life < 3 || m.st === 'fade') { m.st = 'fade'; this._stand(m, dt); return; }
    // held: you look at it, no light in its face, you do not run. Back away and it lets you go.
    if (gazed && !lit && !ran) {
      if (!m.gaze && tg.me) this.audio.play('smilerSeen', { pos: [m.x, m.y + 1.6, m.z] });
      m.gaze += dt; m.st = 'stare'; this._stand(m, dt);
      const away = d > (m.lastD || d) + 0.0005 || d > 9;
      m.letGo += dt * (away ? 1 : 0.35);
      m.lastD = d;
      if (m.letGo > 5.5) { m.st = 'fade'; m.life = 2.5; this._log('letgo', 'B'); }
      return;
    }
    m.lastD = d;
    let sp = d > 7 ? 1.0 : 0.6;
    if (tg.flash && los && d < 32) sp = 1.9;   // drawn to the light
    if (ran) sp = 3.9;                          // and to running (slower than a sprint, not than a walk)
    m.st = ran ? 'rush' : tg.flash ? 'drawn' : 'drift';
    this._follow(m, dt, sp, tg.x, tg.z, 0.5);
    if (d < 1.15 && m.cd <= 0) { m.cd = 1.4; this._startStrike(m, 0.25, 'drift'); }
  }

  // ---------- M: Skin-Stealer. A wanderer's suit and name. It waves. It wants you to follow. ----------
  _stealer(m, dt, T, game) {
    const [tg, d] = this._nearest(m, T);
    m.life -= dt;
    if (!tg) return;
    const me = T[0];
    if (this._sanctuary(tg) && !m.reveal) { m.gone = true; return; }
    if (this._strike(m, dt)) return;
    const seenBy = this._seenBy(T, m.x, m.y + 1.5, m.z, 0.82, 45);
    // the tells: too close, or a light held on its face
    if (!m.reveal) {
      if (seenBy && seenBy.flash && this.facing(seenBy, m.x, m.z) > 0.97 && Math.hypot(seenBy.x - m.x, seenBy.z - m.z) < 14) m.lightT += dt; else m.lightT = Math.max(0, m.lightT - dt * 0.5);
      if (d < 2.5 || m.lightT > 1.0) {
        m.reveal = 1; m.st = 'turn'; m.t = 1.0; this.audio.play('stealerTurn', { pos: [m.x, m.y + 1.6, m.z] }); this._log('reveal', 'M', { d: Math.round(d) });
        if (tg.me) this._scare([m.x, m.y + 1.6, m.z]);
      }
    }
    if (m.st === 'turn') { this._stand(m, dt); this._face(m, tg.x, tg.z, dt, 12); m.t -= dt; if (m.t <= 0) { m.st = 'lunge'; m.t = 5; this.audio.play('lunge', { pos: [m.x, m.y + 1.4, m.z] }); } return; }
    if (m.st === 'lunge') {
      m.t -= dt; this._follow(m, dt, 4.4, tg.x, tg.z, 0.3);
      if (d < 1.15) { this._startStrike(m, 0.2, 'flee'); }
      if (m.t <= 0) m.st = 'flee';
      return;
    }
    if (m.st === 'flee') { this._leave(m, dt, T, 3.5); return; }
    if (m.life < 0 && !seenBy) { m.gone = true; return; }
    // the lure
    if (seenBy) m.seenT += dt; else m.seenT = Math.max(0, m.seenT - dt * 0.5);
    if (m.st === 'stand') {
      this._stand(m, dt); this._face(m, tg.x, tg.z, dt, 3);
      m.wave = damp(m.wave, m.seenT > 0.5 && m.seenT < 3.5 ? 1 : 0, 4, dt);
      if (m.seenT > 0.5 && !m.called) { m.called = true; this.audio.play('stealerCall', { pos: [m.x, m.y + 1.6, m.z] }); }
      // mirror: while you watch it, it moves as your reflection does
      if (m.mirror && seenBy && seenBy.me && d < 28 && d > 3) {
        const nx = (m.x - me.x) / d, nz = (m.z - me.z) / d, vp = me.vx * nx + me.vz * nz;
        let vx = me.vx - 2 * vp * nx, vz = me.vz - 2 * vp * nz; const l = Math.hypot(vx, vz); if (l > 2.2) { vx *= 2.2 / l; vz *= 2.2 / l; }
        const x2 = m.x + vx * dt, z2 = m.z + vz * dt;
        if (!this.world.solidAt(x2, z2)) { m.x = x2; m.z = z2; m.sp = l; }
      }
      // seen long enough, or you come closer: it turns and walks off round a corner, for you to follow
      if (m.seenT > 3.5 || (seenBy && d < 15)) {
        const away = this.findSpot(m.x, m.y, m.z, 7, 15, { path: true, avoid: (x, z) => Math.hypot(x - tg.x, z - tg.z) < d + 3 || this.world.los(tg.x, tg.z, x, z) });
        if (away) { m.goal = away; m.st = 'lead'; m.wave = 0; m.called = false; m.seenT = 0; }
      }
      // lost from sight for a while: it gets ahead of you again
      if (!seenBy && !m.goal) { m.unseen += dt; if (m.unseen > 14) { const s = this._spotFor('M', me); if (s && !this._seenBy(T, s[0], s[1] + 1.5, s[2], 0.3)) { m.x = s[0]; m.y = s[1]; m.z = s[2]; m.unseen = 0; } } } else m.unseen = 0;
    } else if (m.st === 'lead') {
      m.wave = damp(m.wave, 0, 4, dt);
      const ok = this._follow(m, dt, 1.9, m.goal[0], m.goal[2], 1.2);
      if (!ok || Math.hypot(m.goal[0] - m.x, m.goal[2] - m.z) < 0.7) { m.st = 'stand'; m.goal = null; m.seenT = 0; }
    }
  }

  // ---------- K: Hound. Chases what runs. Face it and stand your ground. ----------
  _hound(m, dt, T) {
    const [tg, d] = this._nearest(m, T);
    if (!tg) return;
    if (this._sanctuary(tg) && m.st !== 'leave') { m.st = 'leave'; m.away = null; }
    if (this._strike(m, dt)) return;
    m.cd -= dt;
    const los = this.world.los(m.x, m.z, tg.x, tg.z);
    const faced = this.facing(tg, m.x, m.z);
    const fled = tg.sprint || (tg.speed || 0) > 3.3;
    const rush = (why) => { if (m.st === 'rush') return; m.st = 'rush'; m.t = 5; this.audio.play('houndBark', { pos: [m.x, m.y + 0.7, m.z] }); this.audio.play('houndRush', { pos: [m.x, m.y + 0.7, m.z] }); this._log('rush', 'K', { why }); if (tg.me && d < 14) this._scare([m.x, m.y + 0.7, m.z], 0.8); };
    if (m.st === 'leave') { this._leave(m, dt, T, 5); m.low = 0; return; }
    if (m.st === 'stalk') {
      m.low = 0.4;
      this._follow(m, dt, 2.4, tg.x, tg.z, 0.6);
      this._behind(m, tg, d);
      if (los && fled && d < 22) rush('ran');
      else if (los && d < 8.5) { m.st = 'hold'; this.audio.play('houndBark', { pos: [m.x, m.y + 0.7, m.z], vol: 0.6 }); this._log('hold', 'K'); }
    } else if (m.st === 'hold') {
      // circles at arm's length and growls; looks for its moment
      m.low = 1; m.hold -= dt;
      const a = Math.atan2(m.x - tg.x, m.z - tg.z) + m.circ * 0.45, R = 6.5;
      let gx = tg.x + Math.sin(a) * R, gz = tg.z + Math.cos(a) * R;
      if (this.world.solidAt(gx, gz)) { m.circ = -m.circ; gx = m.x; gz = m.z; }
      this._follow(m, dt, d < 5 ? 1.2 : 1.8, gx, gz, 0.5);
      this._face(m, tg.x, tg.z, dt, 8);
      if (faced < 0.25) m.backT += dt; else m.backT = Math.max(0, m.backT - dt * 2);
      if (fled) rush('ran');
      else if (m.backT > 0.7) rush('back');
      else if (!los && d > 10) m.st = 'stalk';
      else if (m.hold <= 0) { m.st = 'leave'; m.away = null; this._log('leave', 'K'); }
    } else if (m.st === 'rush') {
      m.low = 0.2; m.t -= dt;
      this._follow(m, dt, 6.0, tg.x, tg.z, 0.25);
      // face it and stop: it skids and goes back to circling
      if (faced > 0.6 && (tg.speed || 0) < 1.2 && d > 2) { m.st = 'hold'; m.backT = 0; m.hold = Math.max(m.hold, 4); }
      if (d < 1.25 && m.cd <= 0) { m.cd = 1.2; this._startStrike(m, 0.18, 'retreat'); }
      if (m.t <= 0) { m.st = 'hold'; m.backT = 0; }
    } else if (m.st === 'retreat') {
      m.low = 0.6;
      const a = Math.atan2(m.x - tg.x, m.z - tg.z);
      this._follow(m, dt, 3.5, tg.x + Math.sin(a) * 7, tg.z + Math.cos(a) * 7, 0.5);
      m.rt = (m.rt || 0) + dt;
      if (d > 6 || m.rt > 3) { m.st = 'hold'; m.backT = 0; m.rt = 0; }
    }
  }

  // ---------- W: Faceling. Somebody with no face. Harmless, until it is not. ----------
  _faceling(m, dt, T, game) {
    const [tg, d] = this._nearest(m, T);
    m.life -= dt;
    if (!tg) return;
    if (this._strike(m, dt)) return;
    const seenBy = this._seenBy(T, m.x, m.y + 1.6, m.z, 0.82, 50);
    m.watched = !!seenBy;
    if (m.st === 'hostile') {
      m.hunch = damp(m.hunch, 1, 6, dt); m.t -= dt;
      if (m.t < 1.6) this._follow(m, dt, 6, tg.x, tg.z, 0.3); else { this._stand(m, dt); this._face(m, tg.x, tg.z, dt, 10); }
      if (d < 1.2) this._startStrike(m, 0.1, 'gone');
      if (m.t <= 0) m.st = 'gone';
      return;
    }
    if (m.st === 'gone') { m.gone = true; return; }
    // the lamp held on where its face should be, or running into it
    if (seenBy && seenBy.flash && this.facing(seenBy, m.x, m.z) > 0.97 && Math.hypot(seenBy.x - m.x, seenBy.z - m.z) < 14) m.lightT += dt; else m.lightT = Math.max(0, m.lightT - dt);
    if (m.lightT > 3 || (d < 1.8 && (tg.speed || 0) > 2.6)) { m.st = 'hostile'; m.t = 2.4; this._log('hostile', 'W'); if (tg.me) this._scare([m.x, m.y + 1.6, m.z], 0.7); return; }
    if (seenBy && !m.seen && seenBy.me) { m.seen = true; this.audio.play('facelingSeen', { pos: [m.x, m.y + 1.6, m.z] }); }
    if (m.life < 0 && !seenBy) { m.st = 'gone'; return; }
    if (d > 55) { m.gone = true; return; }
    // it only comes closer while nobody looks, and never closer than about 6 m
    if (!seenBy && d > 6.2) { m.st = 'walk'; this._follow(m, dt, 1.4, tg.x, tg.z, 1.0); }
    else { m.st = 'stand'; this._stand(m, dt); this._face(m, tg.x, tg.z, dt, 1.2); }
  }

  // ---------- R: the horde (Level !) ----------
  _findRun(pl) {
    if (this.testRun) return this.testRun;
    const sx0 = Math.floor(pl.x / (S * 48)), sz0 = Math.floor(pl.z / (S * 48));
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const s = this.world.sec(sx0 + dx, sz0 + dz), r = s && s.data && s.data.run;
      if (r && this._inRun(r, pl.x, pl.z)) return r;
    }
    return null;
  }
  _runGeo(r) {
    if (r._g) return r._g;
    const ax = (r.x0 + 0.5) * S, az = (r.z0 + 0.5) * S, bx = (r.x1 + 0.5) * S, bz = (r.z1 + 0.5) * S, L = Math.hypot(bx - ax, bz - az) || 1;
    const g = { ax, az, bx, bz, L, ux: (bx - ax) / L, uz: (bz - az) / L, key: [r.x0, r.z0, r.x1, r.z1].join(',') };
    Object.defineProperty(r, '_g', { value: g, enumerable: false });
    return g;
  }
  _along(g, x, z) { const dx = x - g.ax, dz = z - g.az; return [dx * g.ux + dz * g.uz, Math.abs(dx * g.uz - dz * g.ux)]; }
  _inRun(r, x, z) { const g = this._runGeo(r), [s, c] = this._along(g, x, z); return s > -1 && s < g.L + 1 && c < 3.2; }
  // speed profile: starts just above a walk and keeps accelerating (never past 92% of a sprint), so it
  // falls behind early and closes in at the end. Tuned against someone who simply holds sprint the
  // whole way (measured 2.91 m/s on average with the stamina system): they reach the exit about eight
  // seconds ahead of it. Anyone who walks, stops or turns back is caught.
  _hordeProfile(L) {
    const v0 = 2.2, vmax = SPRINT * 0.92, Th = Math.max(4, (L - 10) / 2.78 + 4);
    const dist = (acc) => { const tc = (vmax - v0) / Math.max(acc, 1e-6); return Th <= tc ? v0 * Th + 0.5 * acc * Th * Th : v0 * tc + 0.5 * acc * tc * tc + vmax * (Th - tc); };
    let lo = 0, hi = 3;
    if (dist(0) >= L) return { v0: L / Th, acc: 0, vmax };
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (dist(mid) < L) lo = mid; else hi = mid; }
    return { v0, acc: hi, vmax };
  }
  _spawnHorde(pl, run) {
    if (!run) return null;
    const g = this._runGeo(run);
    for (const m of [...this.mine, ...this.remote.values()]) if (m.type === 'R' && m.runKey === g.key) return null;
    const cd = this._runCD || (this._runCD = new Map());
    if (this.clock - (cd.get(g.key) ?? -1e9) < 25) return null;
    cd.set(g.key, this.clock);
    const pr = this._hordeProfile(g.L);
    const m = { id: this.myId + '.' + (NEXT++), type: 'R', own: true, run: { x0: run.x0, z0: run.z0, x1: run.x1, z1: run.z1 }, runKey: g.key, s: 0, v: pr.v0, prof: pr, t: 0, out: 0, fadeT: 0, st: 'run', x: g.ax, z: g.az, y: this.world.floorAt(g.ax, g.az), yaw: Math.atan2(-g.ux, -g.uz), born: this.clock, nearT: 0 };
    this._build(m); this.mine.push(m);
    this.audio.play('alarmStart', { pos: [g.ax, m.y + 1.5, g.az] });
    this._log('horde', 'R', { L: Math.round(g.L), v0: +pr.v0.toFixed(2), acc: +pr.acc.toFixed(3) });
    return m;
  }
  _horde(m, dt, T) {
    const g = this._runGeo(m.run);
    m.t += dt;
    m.v = Math.min(m.prof.vmax, m.prof.v0 + m.prof.acc * m.t);
    if (m.st === 'run') m.s = Math.min(g.L, m.s + m.v * dt);
    m.x = g.ax + g.ux * m.s; m.z = g.az + g.uz * m.s; m.y = this.world.floorAt(m.x, m.z);
    let inside = false;
    for (const tg of T) if (tg.alive && this._inRun(m.run, tg.x, tg.z) && this._along(g, tg.x, tg.z)[0] > m.s - 2) inside = true;
    m.out = inside ? 0 : m.out + dt;
    if (m.out > 20 || m.s >= g.L) { m.st = 'fade'; m.fadeT += dt; if (m.fadeT > 2.5) m.gone = true; }
  }
  // Level !: start the horde once someone is ~10 m into the corridor
  _runWatch(pl, game) {
    if (!game.alive) return;
    const run = this._findRun(pl);
    if (!run) return;
    const g = this._runGeo(run), [s, c] = this._along(g, pl.x, pl.z);
    if (s > 10 && s < g.L && c < 3.2) this._spawnHorde(pl, run);
  }

  // ---------- the director ----------
  presence(pl, game) {
    const d = near0(pl.x, pl.z);
    const sec = this.world.sectorOf(pl.x, pl.z), dng = sec && sec.data ? sec.data.danger || 0 : 0.3;
    const place = this._place(pl, game), bd = (BIOMES[place] || BIOMES[0]).danger;
    let p = smooth(SAFE_R, FULL_R, d) * clamp(0.45 + 0.35 * dng + 0.4 * bd, 0, 1.2);
    if (place === 4) p *= 0.12; // Level 37: almost kind
    p *= 1 + (1 - (game.sanity ?? 1)) * 0.3;
    return clamp(p, 0, 1);
  }
  _place(pl, game) { if (game.place !== undefined) return game.place | 0; return this.world.bioAt ? this.world.bioAt(pl.x, pl.z) | 0 : 0; }
  _isDark(pl, game) {
    const a = this.anom;
    if (a && a.blackout && a.big) return true;
    if (this._place(pl, game) === 2) return true;
    const sec = this.world.sectorOf(pl.x, pl.z), ty = sec && sec.data ? sec.data.type || '' : '';
    return this.world.light(pl.x, pl.z) < 0.28 || /dark|tunnels/.test(ty);
  }
  _chooseType(pl, game, p) {
    const d = near0(pl.x, pl.z), place = this._place(pl, game), dark = this._isDark(pl, game), bo = this.anom && this.anom.blackout && this.anom.big;
    if (place === 4) return Math.random() < 0.85 ? 'W' : 'H';
    if (place === 5) return null; // Level !: the corridor has its own
    const w = {
      L: [1, 1, 1.2, 0.7][place] ?? 1,
      H: place === 3 ? 1.1 : 0.55,
      B: dark ? (bo ? 2.4 : place === 2 ? 1.4 : 1.1) : 0,
      M: d > 150 ? 0.75 : 0,
      K: d > 120 ? ([0.45, 0.8, 0.9, 0.6][place] ?? 0.5) : 0,
      W: 0.65,
    };
    if (this.lastType && w[this.lastType]) w[this.lastType] *= 0.35; // rarely the same thing twice in a row
    let sum = 0; for (const k in w) sum += w[k];
    let r = Math.random() * sum; for (const k in w) { r -= w[k]; if (r <= 0) return k; }
    return 'L';
  }
  // moments when the player is not braced for anything
  _opening(pl, game) {
    if (game.mapOpen) return 'map';
    if (game.handOn) return 'radar';
    if (this.clock - this.pickT < 4) return 'pickup';
    if (this.anom && this.anom.blackout && this.anom.big) return 'blackout';
    if (!pl.flashOn && this.world.light(pl.x, pl.z) < 0.25) return 'dark';
    if (this.stillT > 6) return 'still';
    const tr = this.trail;
    if (tr.length >= 12 && pl.speed > 1) {
      const a = tr[tr.length - 12], b = tr[tr.length - 4], hx = b[0] - a[0], hz = b[1] - a[1], hl = Math.hypot(hx, hz);
      if (hl > 6 && (pl.vx * hx + pl.vz * hz) / (hl * pl.speed) < -0.6) return 'backtrack';
    }
    return null;
  }
  _hint(pl, dir, close) {
    // a sound from where it will come from (or from nowhere at all)
    const a = dir + rnd(-0.6, 0.6), r = close ? rnd(7, 12) : rnd(18, 34), pos = [pl.x + Math.sin(a) * r, pl.y + 1.3, pl.z + Math.cos(a) * r];
    const k = Math.random();
    if (k < 0.3) this.audio.play('farRun', { pos, vol: close ? 0.8 : 0.6 });
    else if (k < 0.5) this.audio.play('knock', { pos });
    else if (k < 0.62) this.audio.play('doorCreak', { pos });
    else if (k < 0.72 && this._place(pl, {}) === 2) this.audio.play('steamHiss', { pos });
    else this.audio.whisper(pos[0], pos[1], pos[2], pick(['murmur', 'whisper', 'call', 'cry', 'mimic']));
    this._log('hint', null, { close: !!close });
  }
  // lights going out one after another down the hall, toward you
  creepStart(pl) {
    if (this.creep) return false;
    const fwd = pl.yaw, L = this._ray(pl.x, pl.z, fwd, 26);
    if (L < 12) return false;
    this.creep = { x0: pl.x - Math.sin(fwd) * L, z0: pl.z - Math.cos(fwd) * L, x1: pl.x - Math.sin(fwd) * 1.5, z1: pl.z - Math.cos(fwd) * 1.5, t: 0, dur: 3.2, hold: rnd(2.5, 4.5), pops: 0 };
    return true;
  }
  _director(dt, pl, game, T) {
    const D = this.dir;
    D.t -= dt; D.el += dt;
    const p = this.presence(pl, game);
    this.pres = p;
    let others = 0; for (const [, r] of this.players) if (r.alive && (r.d || 99) < 60) others++;
    const hostiles = [...this.mine, ...this.remote.values()].filter((m) => HOSTILE.has(m.type) && Math.hypot(m.x - pl.x, m.z - pl.z) < 80).length;
    const myLive = this.mine.filter((m) => m.type !== 'R').length;
    const sec = this.world.sectorOf(pl.x, pl.z), dng = sec && sec.data ? sec.data.danger || 0 : 0;
    const cap = (p > 0.85 && dng > 0.8 ? 2 : 1) + Math.floor(others / 2);
    const startQuiet = (mult = 1) => { D.phase = 'quiet'; D.el = 0; D.t = clamp(lerp(170, 60, Math.sqrt(p)) * rnd(0.85, 1.15), 60, 180) * mult * (1 + 0.5 * others); this._log('quiet', null, { dur: Math.round(D.t) }); };
    if (this.lifeT < GRACE) { if (D.phase !== 'quiet') startQuiet(); D.t = Math.max(D.t, GRACE - this.lifeT); }
    if (D.phase === 'quiet') {
      if (D.t <= 0) {
        // near the entry the level stays quiet; a little further out it only teases
        const tease = near0(pl.x, pl.z) > 45 ? 0.2 : 0;
        if (p < 0.03 && tease === 0) { startQuiet(); return; }
        D.phase = 'build'; D.el = 0; D.dur = rnd(14, 34); D.hintT = rnd(2, 6); D.glimpse = false; D.from = pl.yaw + (Math.random() < 0.6 ? 0 : rnd(-1.6, 1.6));
        const bo = this.anom && this.anom.blackout && this.anom.big;
        D.real = p > 0.03 && hostiles < cap && Math.random() < clamp(0.35 + 0.6 * p + (bo ? 0.25 : 0), 0, 0.92);
        D.type = D.real ? this._chooseType(pl, game, p) : null;
        if (!D.type) D.real = false;
        this._log('build', D.type, { p: +p.toFixed(2), real: D.real });
      }
    } else if (D.phase === 'build') {
      D.hintT -= dt;
      if (D.hintT <= 0) {
        D.hintT = rnd(5, 11);
        // sometimes something is seen instead of heard: a figure crossing a doorway far ahead, or the lights
        if (!D.glimpse && Math.random() < 0.35 && this.anom) { D.glimpse = true; const k = Math.random(); if (k < 0.4) this.anom.trigger('cross', pl); else if (k < 0.65 && !this.creep && this.creepStart(pl)) this._log('creep'); else this.anom.trigger(pick(['chair', 'door', 'figure', 'lights']), pl); }
        else this._hint(pl, D.from, false);
      }
      const open = this._opening(pl, game);
      const ready = D.el > D.dur * 0.4 && open;
      if (D.real && (ready || D.el > D.dur)) {
        if (hostiles >= cap && HOSTILE.has(D.type)) { D.real = false; return; }
        const m = this.spawn(D.type, pl, null, { behind: open === 'map' || open === 'radar' || open === 'pickup' || open === 'backtrack' });
        if (m) { D.phase = 'encounter'; D.el = 0; D.second = rnd(30, 60); this.lastType = D.type; this._log('encounter', D.type, { why: open || 'time', d: Math.round(near0(pl.x, pl.z)) }); }
        else if (++D.tries > 30) { D.real = false; D.tries = 0; }
      } else if (!D.real && D.el > D.dur) {
        // a false alarm: one last sound, close, and then nothing
        if (Math.random() < 0.6) this._hint(pl, pl.yaw, true);
        D.phase = 'relief'; D.t = rnd(15, 30); D.el = 0; this._log('false');
      }
    } else if (D.phase === 'encounter') {
      // a second one, only deep in dangerous places
      if (cap > 1 && D.el > D.second && hostiles < cap && Math.random() < dt * 0.02) { const ty = this._chooseType(pl, game, p); if (ty && HOSTILE.has(ty)) this.spawn(ty, pl, null, {}); D.second = 1e9; }
      if (myLive === 0 || D.el > 240) { D.phase = 'relief'; D.t = rnd(20, 40); D.el = 0; this._log('relief'); }
    } else if (D.phase === 'relief') {
      if (D.t <= 0 && myLive === 0) startQuiet();
    }
  }

  // warm the heavy models in the background, one per few frames, shrunk to nothing under the floor
  _warmStep(pl) {
    if (this._warmDone) return;
    // the Skin-Stealer's suit is one solid build of about half a second (props.js, not sliceable):
    // do it on the very first frame of play, while the screen is still black from the load
    const q = this._wq || (this._wq = ['stealer', ...WARM, 'hollow', 'show']);
    this._wN = (this._wN || 0) + 1;
    const k = q[0];
    if (!k) { this._warmDone = true; return; }
    if (k === 'hollow' && this._wN % 6) return; // the old suit builds in one go: give it a frame of its own
    const t0 = performance.now();
    let done = true;
    if (k === 'stealer') {
      // disguised and revealed share the suit; the name tag (and its scrambled frames) is a sprite
      const st = makeSuit(this.M, false), tag = makeTag(scrambleName('someone', 0.5));
      tag.material.opacity = 0.01; tag.position.y = 2.0; st.add(tag); poseStealer(st, 1, 1, 0);
      // drawn now too, so its programs and buffers are uploaded in the same dark frames
      st.traverse((o) => { o.frustumCulled = false; }); st.scale.setScalar(0.001); this.scene.add(st);
      this._warmShow = [st]; this._warmShowT = 2;
    } else if (k === 'hollow') (this._warmObjs || (this._warmObjs = [])).push(makeSuit(this.M, true));
    else if (k === 'show') {
      // one of each, drawn once so the shaders and buffers are uploaded before they matter
      const M = this.M, list = [...(this._warmObjs || []), makeHowler(M), makeHound(M), makeFaceling(M, 0), makeFaceling(M, 1), makeFaceling(M, 2), makeSmiler(M), makeHorde(M)];
      for (const g of list) { g.traverse((o) => { o.frustumCulled = false; }); g.scale.setScalar(0.001); this.scene.add(g); }
      this._warmShow = list; this._warmShowT = 3;
    } else done = warmSlice(k, 8);
    if (done) q.shift();
    const ms = performance.now() - t0; this.warmMs = Math.max(this.warmMs || 0, ms); const wl = this.warmLog || (this.warmLog = {}); wl[k] = Math.max(wl[k] || 0, +ms.toFixed(1));
  }

  update(dt, t, pl, game) {
    this.clock += dt;
    startPack(this.M); // the optional model pack: once, in the background, after play has begun
    // warm the two pack suits one after the other, a few frames apart, shrunk to nothing under the floor
    if (this._warm !== 3) {
      const w = this._warmObj || (this._warmObj = []);
      this._warmN = (this._warmN || 0) + 1;
      // their shaders are compiled in the background first; only then is the suit drawn (out of sight)
      const show = (g, next) => { this._warmBusy = true; const go = () => { w.push(g); this.scene.add(g); this._warm = next; this._warmN = 0; this._warmBusy = false; }; const p = this.precompile ? this.precompile(g) : null; if (p && p.then) p.then(go, go); else go(); };
      if (this._warmBusy) { /* waiting for the compiler */ }
      else if (!this._warm && this._warmN % 12 === 0) { const g = packWarmSuit(this.M, true); if (g) show(g, 1); }
      else if (this._warm === 1 && this._warmN >= 12) { const g = packWarmSuit(this.M, false); if (g) show(g, 2); else { this._warm = 2; this._warmN = 0; } }
      else if (this._warm === 2 && this._warmN >= 12) { for (const g of w) this.scene.remove(g); this._warmObj = null; this._warm = 3; }
      for (const g of w) g.position.set(pl.x, pl.y - 3, pl.z);
    }
    this._warmStep(pl);
    if (this._warmShow) { for (const g of this._warmShow) g.position.set(pl.x, pl.y - 3, pl.z); if ((this._warmShowT -= 1) < 0) { for (const g of this._warmShow) this.scene.remove(g); this._warmShow = null; this._warmObjs = null; } }

    if (game.alive && !this.wasAlive) this._resetLife();
    this.wasAlive = game.alive;
    if (game.alive) this.lifeT += dt;
    this._names = game.names || [];
    // what the player is doing: still, backtracking, picking things up
    this.stillT = pl.speed < 0.3 ? this.stillT + dt : 0;
    this.trailT -= dt; if (this.trailT <= 0) { this.trailT = 2.5; this.trail.push([pl.x, pl.z]); if (this.trail.length > 16) this.trail.shift(); }
    const tk = Object.keys(game.taken || {}).length + (game.arts ? game.arts.length : 0);
    if (this.takenN >= 0 && tk > this.takenN) this.pickT = this.clock;
    this.takenN = tk;

    const T = this.targets(pl, game);
    if (game.alive && !game.safe && !this.noDirector) this._director(dt, pl, game, T);
    this._runWatch(pl, game);
    // simulate my own
    for (let i = this.mine.length - 1; i >= 0; i--) {
      const m = this.mine[i];
      if (m.freeze) { /* test hook: posed, no brain */ }
      else if (m.type === 'L') this._howler(m, dt, T);
      else if (m.type === 'H') this._hollow(m, dt, T);
      else if (m.type === 'B') this._smiler(m, dt, T, game);
      else if (m.type === 'M') this._stealer(m, dt, T, game);
      else if (m.type === 'K') this._hound(m, dt, T);
      else if (m.type === 'W') this._faceling(m, dt, T, game);
      else if (m.type === 'R') this._horde(m, dt, T);
      if (m.st === 'gone') m.gone = true;
      let nd = 1e9; for (const tg of T) nd = Math.min(nd, Math.hypot(tg.x - m.x, tg.z - m.z));
      m.far = nd > 75 ? m.far + dt : 0;
      const dead = (m.far > 12 && m.type !== 'R') || (m.type === 'B' && (m.life <= 0 || (m.st === 'fade' && m.life <= 0))) || (m.gone && m.st !== 'atk' && m.st !== 'hit') || (this.world.solidAt(m.x, m.z) && m.type !== 'B' && m.type !== 'R');
      if (dead) { this._log('gone', m.type); if (m.type === 'W') this.audio.play('facelingGone', { pos: [m.x, m.y + 1.6, m.z] }); this._remove(m); this.mine.splice(i, 1); }
    }
    this._draw(dt, t, pl, game, T);
    // tension for the sound engine
    const D = this.dir, ph = D.phase;
    const want = ph === 'quiet' ? 0.03 : ph === 'build' ? lerp(0.15, 0.5, clamp(D.el / (D.dur || 1), 0, 1)) : ph === 'encounter' ? Math.max(0.6, this.fear) : 0.12;
    this.tension = damp(this.tension, Math.max(want, this.fear * 0.9), want > this.tension ? 0.8 : 0.25, dt);
  }

  _draw(dt, t, pl, game, T) {
    this.hitCd -= dt;
    let fear = 0, watching = false, dark = null, darkD = 1e9, run = 0;
    const me = T[0], all = [...this.mine, ...this.remote.values()];
    const hit = (m, d, reach) => { if ((m.st === 'hit') && d < reach && this.hitCd <= 0 && game.alive) { this.hitCd = 1.2; game.hurt(DMG[m.type] || 0.4, CAUSE[m.type], m.x, m.z); } };
    for (const m of all) {
      const d = Math.hypot(m.x - pl.x, m.z - pl.z);
      const near = clamp(1 - d / 30, 0, 1);
      const iSee = game.alive && this.sees(me, m.x, m.y + 1.2, m.z, 0.6, 45);
      const toMe = Math.atan2(-(pl.x - m.x), -(pl.z - m.z));
      m.obj.position.set(m.x, m.y, m.z); m.obj.rotation.y = m.yaw;
      if (m.type === 'L') {
        const ch = m.own ? m.chase : (m.cv = damp(m.cv || 0, m.st === 'chase' || m.st === 'atk' || m.st === 'hit' ? 1 : m.st === 'howl' ? 0.6 : 0, 4, dt));
        const spd = m.own ? m.sp : m.rv || 0;
        // what it attends to: you once it knows, else the place it heard something
        const att = m.st === 'chase' || m.st === 'howl' || m.st === 'atk' || m.st === 'hit' || (m.st === 'listen' && d < 14) ? toMe : (m.st === 'investigate' || m.st === 'search') && m.own ? Math.atan2(-(m.tx - m.x), -(m.tz - m.z)) : m.yaw;
        m.coilV = damp(m.coilV || 0, m.st === 'atk' || m.st === 'howl' ? 1 : 0, 9, dt); m.swingV = damp(m.swingV || 0, m.st === 'hit' ? 1 : 0, 16, dt);
        animHowler(m.obj, dt, spd, { chase: ch, look: angDiff(m.yaw, att), pitch: m.st === 'chase' || m.st === 'howl' ? -0.1 : 0, turn: m.turn || 0, coil: m.st === 'howl' ? m.coilV * 0.5 : m.coilV, swing: m.swingV, search: m.st === 'search' || m.st === 'listen' ? 1 : 0 });
        this.audio.entity(m.id, AUD('L'), m.x, m.y + 1.8, m.z, { moving: spd > 0.2 ? 1 : 0, near, seen: m.st === 'chase' || m.st === 'howl' ? 1 : 0, search: m.st === 'search' || m.st === 'investigate' ? 1 : 0, chase: ch, rush: m.st === 'atk' || m.st === 'hit' ? 1 : 0, attack: m.st === 'hit', howl: m.st === 'howl' ? 1 : 0, stare: iSee ? 1 : 0 });
        fear = Math.max(fear, ch > 0.4 ? clamp(1.15 - d / 26, 0, 1) : clamp(0.6 - d / 22, 0, 0.6));
        hit(m, d, 1.9);
      } else if (m.type === 'H') {
        const mv = m.st === 'move' ? 1 : 0, hs = m.own ? m.sp : m.rv || 0;
        animSuit(m.obj, mv ? dt : dt * 0.15, hs, false, 0);
        // the empty hood turns, slowly, to keep you in view
        const u = m.obj.userData, hb = u.pk ? u.pk.bones.head : u.b.head;
        m.hy = damp(m.hy || 0, clamp(angDiff(m.yaw, toMe), -1.3, 1.3), iSee ? 0.6 : 3, dt); hb.rotation.y += m.hy;
        this.audio.entity(m.id, AUD('H'), m.x, m.y + 1.4, m.z, { moving: mv, near, stare: iSee ? 1 : 0, seen: 1, chase: mv ? clamp(1 - d / 14, 0, 0.8) : 0, rush: m.st === 'atk' || m.st === 'hit' ? 1 : 0, attack: m.st === 'atk' || m.st === 'hit' });
        if (iSee && d < 6) this._hush(dt);
        if (iSee) { watching = true; fear = Math.max(fear, clamp(0.75 - d / 30, 0.15, 0.75)); }
        else if (d < 8) fear = Math.max(fear, 0.35);
        if ((m.st === 'atk' || m.st === 'hit') && d < 1.5) hit({ ...m, st: 'hit' }, d, 1.5);
      } else if (m.type === 'B') {
        const rad = m.rad || 7.5;
        if (m.st !== 'fade' && d < darkD) { darkD = d; dark = m; }
        const stare = m.st === 'stare' ? 1 : 0, rush = m.st === 'rush' ? 1 : 0;
        animSmiler(m.obj, dt, m.st === 'fade' ? 0.6 : rush ? 1.45 : m.st === 'drawn' ? 1.25 : 1, stare);
        m.obj.position.y = this.world.floorAt(m.x, m.z) + 1.55;
        m.obj.lookAt(pl.x, pl.y + 1.6, pl.z);
        m.fv = damp(m.fv ?? 0, m.st === 'fade' ? 0 : 1, m.st === 'fade' ? 2 : 1.2, dt);
        m.obj.scale.setScalar(Math.max(0.001, m.fv));
        this.audio.entity(m.id, AUD('B'), m.x, m.obj.position.y, m.z, { near: clamp(1 - d / (rad * 2), 0, 1), moving: m.st === 'drift' || m.st === 'drawn' || rush ? 1 : 0, seen: m.st === 'drawn' || rush ? 1 : 0, chase: m.st === 'drawn' ? 0.6 : rush ? 1 : stare ? 0.15 : 0.05, rush, stare, attack: m.st === 'hit' });
        if (stare && d < 12) this._hush(dt);
        if (d < rad * 1.5) { fear = Math.max(fear, 0.45 + 0.45 * (1 - d / (rad * 1.5))); game.drain(dt * 0.04); }
        else if (iSee) fear = Math.max(fear, 0.35);
        if (iSee) watching = true;
        hit(m, d, 1.6);
      } else if (m.type === 'M') {
        const wrong = m.reveal ? 1 : 0;
        m.wv = damp(m.wv || 0, wrong, 3, dt);
        const spd = m.own ? m.sp : m.rv || 0;
        animSuit(m.obj, dt, spd, false, m.st === 'stand' ? -0.15 : 0);
        poseStealer(m.obj, m.own ? m.wave || 0 : (m.st === 'stand' && iSee ? 1 : 0), m.wv, t);
        // the tag: the same as a player's, until it is not
        if (m.tag) {
          let want = m.alias || 'someone';
          if (m.reveal) { m.scrT = (m.scrT || 0) - dt; if (m.scrT <= 0) { m.scrT = 0.09; want = scrambleName(m.alias || 'someone', 0.5 + Math.random() * 0.5); } else want = m.tagName; }
          if (want !== m.tagName) { const old = m.tag; m.tag = makeTag(want); m.tag.position.y = 2.0; m.obj.remove(old); old.material.map.dispose(); m.obj.add(m.tag); m.tagName = want; }
          m.tag.material.opacity = m.reveal ? (Math.random() < 0.7 ? clamp((14 - d) / 4, 0, 1) : 0) : clamp((9 - d) / 3, 0, 1);
        }
        this.audio.entity(m.id, AUD('M'), m.x, m.y + 1.6, m.z, { moving: spd > 0.2 ? 1 : 0, near, reveal: m.wv, seen: iSee ? 1 : 0, chase: m.st === 'lunge' ? 1 : m.st === 'turn' ? 0.4 : 0, rush: m.st === 'lunge' || m.st === 'atk' || m.st === 'hit' ? 1 : 0, attack: m.st === 'hit', stare: iSee ? 1 : 0 });
        if (m.reveal) fear = Math.max(fear, clamp(1.1 - d / 20, 0.3, 1));
        hit(m, d, 1.7);
      } else if (m.type === 'K') {
        const low = m.own ? m.low : (m.st === 'hold' ? 1 : m.st === 'stalk' ? 0.4 : 0.2);
        const spd = m.own ? m.sp : m.rv || 0;
        m.coilV = damp(m.coilV || 0, m.st === 'atk' ? 1 : 0, 12, dt); m.swingV = damp(m.swingV || 0, m.st === 'hit' ? 1 : 0, 16, dt);
        animHound(m.obj, dt, spd, low, m.st === 'hold' ? 0.4 : m.st === 'rush' ? 1 : 0.1, angDiff(m.yaw, toMe), m.coilV, m.swingV);
        const hold = m.st === 'hold' ? 1 : 0, rush = m.st === 'rush' || m.st === 'atk' || m.st === 'hit' ? 1 : 0;
        this.audio.entity(m.id, AUD('K'), m.x, m.y + 0.7, m.z, { moving: spd > 0.3 ? 1 : 0, near, seen: m.st !== 'stalk' ? 1 : 0, hold, chase: rush ? 1 : hold ? 0.3 : m.st === 'stalk' ? 0.05 : 0, rush, attack: m.st === 'hit', stare: iSee ? 1 : 0 });
        fear = Math.max(fear, rush ? clamp(1.2 - d / 20, 0.5, 1) : hold ? 0.7 : clamp(0.5 - d / 30, 0, 0.5));
        hit(m, d, 1.7);
      } else if (m.type === 'W') {
        const spd = m.own ? m.sp : m.rv || 0;
        m.hv = damp(m.hv || 0, m.st === 'hostile' || m.st === 'atk' || m.st === 'hit' ? 1 : 0, 6, dt);
        animFaceling(m.obj, dt, spd, angDiff(m.yaw, toMe), m.hv);
        this.audio.entity(m.id, AUD('W'), m.x, m.y + 1.6, m.z, { moving: spd > 0.2 ? 1 : 0, near, stare: iSee ? 1 : 0, chase: m.hv, rush: m.hv > 0.5 ? 1 : 0, attack: m.st === 'hit', seen: 1 });
        if (iSee && d < 12 && m.hv < 0.5) this._hush(dt);
        if (iSee) { watching = true; game.drain(dt * 0.008 * clamp(1.4 - d / 30, 0.3, 1)); fear = Math.max(fear, clamp(0.55 - d / 50, 0.2, 0.55)); }
        if (m.hv > 0.5) fear = Math.max(fear, 0.9);
        hit(m, d, 1.6);
      } else if (m.type === 'R') {
        animHorde(m.obj, dt, m.v || 4);
        if (m.st === 'fade') m.obj.position.y = m.y - Math.min(2.5, (m.fadeT || 0) * 1.2);
        const g = this._runGeo(m.run), [s, c] = this._along(g, pl.x, pl.z), inside = this._inRun(m.run, pl.x, pl.z);
        const gap = s - (m.s ?? 0);
        if (inside && game.alive) {
          run = Math.max(run, clamp(1 - gap / 40, 0.15, 1));
          fear = Math.max(fear, clamp(1.1 - gap / 30, 0.4, 1));
          if (gap < 8) { m.nearT = (m.nearT || 0) - dt; if (m.nearT <= 0) { m.nearT = 6; this.audio.play('hordeNear', { pos: [m.x, m.y + 1.4, m.z] }); } }
          if (gap < 0.4 && m.st !== 'fade') game.hurt(5, CAUSE.R, m.x, m.z);
        }
        this.audio.entity(m.id, AUD('R'), m.x, m.y + 1.4, m.z, { near: inside ? clamp(1 - gap / 40, 0, 1) : near * 0.5, moving: 1, chase: 1, rush: clamp(((m.v || 3) - 2.4) / 2, 0, 1) });
      }
    }
    // the lights die round the nearest Smiler; or, as a scare, down the hall toward you
    const Du = this.shared.uDark.value;
    let want = 0;
    if (dark) { want = 1; Du.x = dark.x; Du.y = dark.z; Du.z = dark.rad || 7.5; }
    else if (this.creep) {
      const c = this.creep; c.t += dt;
      const k = clamp(c.t / c.dur, 0, 1), e = k * k * (3 - 2 * k);
      Du.x = lerp(c.x0, c.x1, e); Du.y = lerp(c.z0, c.z1, e); Du.z = lerp(4, 7, e); want = c.t < c.dur + c.hold ? 1 : 0;
      const pops = Math.floor(e * 5); while (c.pops < pops) { c.pops++; this.audio.play('lampPop', { pos: [Du.x, pl.y + 2.6, Du.y], vol: 0.6 }); }
      if (k >= 1) fear = Math.max(fear, 0.5);
      if (c.t > c.dur + c.hold + 2) this.creep = null;
      this.darkS = damp(this.darkS, want, 3.5, dt);
    }
    if (dark) this.darkS = damp(this.darkS, want, 0.9, dt);
    else if (!this.creep) this.darkS = damp(this.darkS, 0, 0.6, dt);
    Du.w = this.darkS * 0.985;
    this.inDark = dark ? clamp(1 - darkD / (dark.rad || 7.5), 0, 1) * this.darkS : (this.creep ? this.darkS * clamp(1 - Math.hypot(Du.x - pl.x, Du.y - pl.z) / Du.z, 0, 1) : 0);
    this.fear = damp(this.fear, fear, fear > this.fear ? 3 : 0.5, dt);
    this.watching = watching;
    this.run = damp(this.run, run, 3, dt);
  }

  // creatures simulated by other clients
  syncRemote(peers, dt) {
    const seen = new Set();
    for (const [, p] of peers) {
      const list = p.s && p.s.e; if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (!Array.isArray(e) || !KNOWN.has(e[1])) continue; // types from a newer (or older) version: ignore
        const id = e[0]; seen.add(id);
        let m = this.remote.get(id);
        if (!m) {
          m = { id, type: e[1], x: e[2], y: e[3], z: e[4], yaw: e[5], st: e[6], own: false, rad: 7.5, alias: typeof e[8] === 'string' ? e[8] : null, reveal: e[9] ? 1 : 0 };
          if (m.type === 'R') { if (!Array.isArray(e[10])) continue; m.run = { x0: e[10][0], z0: e[10][1], x1: e[10][2], z1: e[10][3] }; m.runKey = this._runGeo(m.run).key; }
          try { this._build(m); } catch (err) { console.warn('remote entity', err); continue; }
          this.remote.set(id, m);
        }
        // eased toward the latest update; the speed the legs use is the speed it really moves at
        const ox = m.x, oz = m.z, oy = m.yaw;
        m.x = damp(m.x, e[2], 8, dt); m.y = damp(m.y, e[3], 8, dt); m.z = damp(m.z, e[4], 8, dt);
        if (Math.hypot(e[2] - m.x, e[4] - m.z) > 8) { m.x = e[2]; m.z = e[4]; }
        m.yaw += angDiff(m.yaw, e[5]) * (1 - Math.exp(-8 * dt)); m.st = e[6];
        const id2 = Math.max(dt, 1e-3);
        m.rv = damp(m.rv || 0, Math.min(8, Math.hypot(m.x - ox, m.z - oz) / id2), 6, dt);
        m.turn = damp(m.turn || 0, angDiff(oy, m.yaw) / id2, 6, dt);
        if (typeof e[7] === 'number') m.k = e[7];
        if (m.type === 'M') { if (typeof e[8] === 'string') m.alias = e[8]; m.reveal = e[9] ? 1 : 0; }
        if (m.type === 'R') { m.s = typeof e[7] === 'number' ? e[7] : m.s; m.v = e[11] || m.v; m.fadeT = m.st === 'fade' ? (m.fadeT || 0) + dt : 0; m.x = e[2]; m.z = e[4]; }
      }
    }
    for (const [id, m] of this.remote) if (!seen.has(id)) { this._remove(m); this.remote.delete(id); }
  }
  // [id, type, x, y, z, yaw, state, k, alias, reveal, run, v]
  //   k: Howler chase 0..1, Hound crouch 0..1, Skin-Stealer wave 0..1, horde: distance along the corridor (m)
  serialize() {
    const r2 = (v) => Math.round(v * 100) / 100;
    return this.mine.map((m) => {
      const e = [m.id, m.type, r2(m.x), r2(m.y), r2(m.z), r2(m.yaw), m.st];
      if (m.type === 'L') e.push(r2(m.chase || 0));
      else if (m.type === 'K') e.push(r2(m.low || 0));
      else if (m.type === 'M') e.push(r2(m.wave || 0), m.alias || '', m.reveal ? 1 : 0);
      else if (m.type === 'R') e.push(r2(m.s), null, 0, [m.run.x0, m.run.z0, m.run.x1, m.run.z1], r2(m.v));
      return e;
    });
  }
}

// Things that are there when you look back. Local to each player: nobody else can confirm them.
// In 0.3 the director in Entities decides when they happen (trigger); this class draws them,
// runs the writing on the walls and the blackouts (the short flickers and the long Level 1 ones).
export class Anomalies {
  constructor(ctx) {
    Object.assign(this, ctx); // scene, world, M, tex, audio, ents
    this.active = []; this.blackout = 0; this.blackT = 0; this.pulse = 1; this.stingAt = 0; this.big = false;
    this.l1T = rnd(60, 140);
    if (this.ents) this.ents.anom = this;
  }
  _view(pl, x, z, half = 0.55) {
    const dx = x - pl.x, dz = z - pl.z, d = Math.hypot(dx, dz) || 1;
    return (dx * -Math.sin(pl.yaw) + dz * -Math.cos(pl.yaw)) / d > half && d < 30 && this.world.los(pl.x, pl.z, x, z);
  }
  trigger(kind, pl) {
    const E = this.ents, back = pl.yaw; // +sin(yaw), +cos(yaw) points behind the player
    if (E && E._log) E._log('anomaly', null, { kind });
    if (kind === 'chair' || kind === 'door') {
      const s = E.findSpot(pl.x, pl.y, pl.z, 3.5, 9, { dir: back, spread: 1.0 });
      if (!s) return this.trigger('sound', pl);
      const obj = kind === 'chair' ? makeChair(this.M) : makeDoor(this.M, this.tex, false);
      obj.position.set(s[0], s[1], s[2]); obj.rotation.y = Math.atan2(pl.x - s[0], pl.z - s[2]) + (kind === 'chair' ? Math.PI : 0);
      this.scene.add(obj); this.active.push({ kind, obj, x: s[0], z: s[2], seen: false, away: 0, life: 120 });
      this.audio.play('apparition', { pos: [s[0], s[1] + 1, s[2]] });
    } else if (kind === 'figure') {
      // standing still at the edge of the light, facing you; gone when you look a second time
      const s = E.findSpot(pl.x, pl.y, pl.z, 12, 26, { dir: back + Math.PI, spread: 0.45, visible: true, offView: pl.yaw, lit: 0.2 }) || E.findSpot(pl.x, pl.y, pl.z, 12, 26, { visible: true, offView: pl.yaw });
      if (!s) return this.trigger('sound', pl);
      const obj = makeSuit(this.M, true);
      obj.position.set(s[0], s[1], s[2]); obj.rotation.y = Math.atan2(-(pl.x - s[0]), -(pl.z - s[2]));
      this.scene.add(obj); this.active.push({ kind, obj, x: s[0], z: s[2], seen: false, look: rnd(1.0, 2.6), life: 40 });
    } else if (kind === 'cross') {
      // somebody crosses a doorway far ahead, once, from one side to the other
      const fwd = pl.yaw + Math.PI;
      for (let k = 0; k < 12; k++) {
        const s = E.findSpot(pl.x, pl.y, pl.z, 15, 28, { dir: fwd, spread: 0.3, visible: true });
        if (!s) break;
        const dx = s[0] - pl.x, dz = s[2] - pl.z, d = Math.hypot(dx, dz), px = -dz / d, pz = dx / d;
        const side = (sg) => { for (let j = 0.6; j < 4.5; j += 0.3) { const x = s[0] + px * sg * j, z = s[2] + pz * sg * j; if (this.world.solidAt(x, z)) return null; if (!this.world.los(pl.x, pl.z, x, z)) return [x, z]; } return null; };
        const a = side(1), b = side(-1);
        if (!a || !b) continue;
        const obj = makeSuit(this.M, Math.random() < 0.5);
        obj.position.set(a[0], s[1], a[1]); obj.rotation.y = Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
        this.scene.add(obj); this.active.push({ kind, obj, x: a[0], z: a[1], y: s[1], ax: a[0], az: a[1], bx: b[0], bz: b[1], u: 0, len: Math.hypot(b[0] - a[0], b[1] - a[1]), life: 8 });
        return;
      }
      return this.trigger('sound', pl);
    } else if (kind === 'lights') {
      this.blackT = rnd(0.9, 3.2); this.stingAt = Math.random() < 0.25 ? 1 : 0; this.big = false;
      this.audio.play('flashOff', { vol: 0.5 });
    } else {
      const a = Math.random() * 6.28, r = rnd(8, 20), pos = [pl.x + Math.sin(a) * r, pl.y + 1.4, pl.z + Math.cos(a) * r];
      const k = Math.random();
      if (k < 0.3) this.audio.play('knock', { pos }); else if (k < 0.45) this.audio.play('doorSlam', { pos });
      else this.audio.whisper(pos[0], pos[1], pos[2], ['whisper', 'call', 'cry', 'mimic', 'laugh'][Math.floor(Math.random() * 5)]);
    }
  }
  update(dt, t, pl, game, propsList) {
    // Level 1: the lights go out for half a minute, now and then
    const place = game.place !== undefined ? game.place | 0 : (this.world.bioAt ? this.world.bioAt(pl.x, pl.z) | 0 : 0);
    const life = this.ents ? this.ents.lifeT : 999;
    if (game.alive && place === 1 && life > 90) {
      this.l1T -= dt;
      if (this.l1T <= 0 && this.blackT <= 0) { this.l1T = rnd(90, 200); this.blackT = rnd(20, 40); this.big = true; this.stingAt = 0; this.audio.play('blackoutStart'); if (this.ents) this.ents._log('blackout'); }
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i], v = this._view(pl, a.x, a.z), d = Math.hypot(a.x - pl.x, a.z - pl.z);
      a.life -= dt; let kill = false;
      if (a.kind === 'figure') {
        if (v) { a.seen = true; a.look -= dt; }
        if ((a.seen && a.look <= 0) || d < 8) { kill = true; this.blackT = Math.max(this.blackT, 0.22); if (d < 8) this.audio.play('stinger', { vol: 0.5 }); }
        else if (a.life <= 0 && !v) kill = true;
      } else if (a.kind === 'cross') {
        a.u += dt * 1.7; const k = Math.min(1, a.u / a.len);
        a.x = lerp(a.ax, a.bx, k); a.z = lerp(a.az, a.bz, k);
        a.obj.position.set(a.x, a.y, a.z); animSuit(a.obj, dt, 1.7, false, 0);
        if (k >= 1 || a.life <= 0) kill = true;
      } else {
        if (v) { a.seen = true; a.away = 0; } else if (a.seen) a.away += dt;
        if (a.away > 1.2 || (a.life <= 0 && !v) || d > 40) kill = true;
      }
      if (kill) { this.scene.remove(a.obj); this.active.splice(i, 1); }
    }
    // writing that was not on the wall a moment ago
    for (const p of propsList) for (const m of p.lateMarks) {
      if (m.on) { if (m.mat.uniforms.uAlpha.value < 1) m.mat.uniforms.uAlpha.value = Math.min(1, m.mat.uniforms.uAlpha.value + dt * 4); continue; }
      const d = Math.hypot(m.x - pl.x, m.z - pl.z), v = this._view(pl, m.x, m.z, 0.3);
      if (v && d < 11) m.seen = true;
      else if (m.seen && !v && d < 14) { m.on = true; if (Math.random() < 0.5) this.audio.play('sign', { pos: [m.x, pl.y + 1.3, m.z], vol: 0.6 }); }
    }
    // blackouts
    if (this.blackT > 0) {
      this.blackT -= dt; this.blackout = 1;
      this.pulse = this.big ? (Math.random() < 0.004 ? 0.4 : 0.012) : (Math.random() < 0.06 ? 0.5 : 0.015);
      if (this.blackT <= 0) {
        if (this.big) { this.audio.play('blackoutEnd'); this.big = false; }
        else this.audio.play('flashOn', { vol: 0.4 });
        if (this.stingAt) { this.stingAt = 0; this.audio.play('stinger'); this.trigger('figure', pl); }
      }
    } else { this.blackout = 0; this.pulse = damp(this.pulse, 1, 14, dt); }
  }
  clear() { for (const a of this.active) this.scene.remove(a.obj); this.active.length = 0; this.blackT = 0; this.big = false; this.l1T = rnd(60, 140); }
}
export { lerp };
