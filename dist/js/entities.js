// Other players, the things that hunt, and the anomalies that come and go.
// Each client simulates the creatures it spawned and publishes them in its presence,
// so everybody nearby sees (and is hunted by) the same ones.
import * as THREE from './three.module.min.js';
import { S, clamp, damp, angDiff, lerp } from './util.js';
import { makeSuit, animSuit, makeLongarm, animLongarm, makeEyes, makeChair, makeDoor, makeTag, startPack, packWarmSuit } from './props.js';

const rnd = (a, b) => a + Math.random() * (b - a);
let NEXT = 1;

export class Entities {
  constructor(ctx) {
    Object.assign(this, ctx); // scene, world, M, tex, audio, shared
    this.players = new Map();
    this.mine = [];
    this.remote = new Map();
    this.spawnT = 6;
    this.hitCd = 0;
    this.fear = 0; this.watching = false; this.inDark = 0;
    this.myId = 'me';
    this.darkS = 0; this.darkAt = null;
    this.debug = false;
  }

  // ---------- other players ----------
  syncPlayers(peers, dt, cam) {
    const u = this.shared;
    const lights = [];
    for (const [id, p] of peers) {
      const s = p.s; if (!s || s.x === undefined) continue;
      let r = this.players.get(id);
      if (!r) {
        r = { obj: makeSuit(this.M, false), tag: makeTag(p.username || 'someone'), x: s.x, y: s.y, z: s.z, yaw: s.w || 0, sp: 0, name: p.username };
        r.tag.position.y = 2.0; r.obj.add(r.tag);
        this.scene.add(r.obj); this.players.set(id, r);
      }
      const px = r.x, pz = r.z;
      r.x = damp(r.x, s.x, 11, dt); r.y = damp(r.y, s.y, 11, dt); r.z = damp(r.z, s.z, 11, dt);
      if (Math.hypot(s.x - r.x, s.z - r.z) > 6) { r.x = s.x; r.y = s.y; r.z = s.z; }
      r.yaw += angDiff(r.yaw, s.w || 0) * (1 - Math.exp(-12 * dt));
      r.sp = damp(r.sp, Math.hypot(r.x - px, r.z - pz) / Math.max(dt, 1e-3), 8, dt);
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
    const t = [{ id: this.myId, me: true, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw, pitch: pl.pitch, noise: pl.noise, flash: pl.flashOn, alive: game.alive, crouch: pl.crouch }];
    for (const [id, r] of this.players) if (r.alive) t.push({ id, x: r.x, y: r.y, z: r.z, yaw: r.yaw, pitch: r.pitch, noise: r.noise, flash: r.flash, alive: true, crouch: r.crouch });
    return t;
  }
  sees(tg, x, y, z, half = 0.5, maxD = 45) {
    const dx = x - tg.x, dz = z - tg.z, d = Math.hypot(dx, dz);
    if (d > maxD) return false;
    if (d < 0.6) return true;
    const cp = Math.cos(tg.pitch), fx = -Math.sin(tg.yaw) * cp, fz = -Math.cos(tg.yaw) * cp, fy = Math.sin(tg.pitch);
    const dy = y - (tg.y + 1.6), l = Math.hypot(d, dy);
    if ((dx * fx + dz * fz + dy * fy) / l < half) return false;
    return this.world.los(tg.x, tg.z, x, z);
  }
  findSpot(px, py, pz, minR, maxR, opts = {}) {
    const w = this.world;
    for (let k = 0; k < 40; k++) {
      const a = opts.dir !== undefined ? opts.dir + rnd(-opts.spread, opts.spread) : Math.random() * Math.PI * 2, r = rnd(minR, maxR);
      const x = px + Math.sin(a) * r, z = pz + Math.cos(a) * r;
      const cx = Math.floor(x / S), cz = Math.floor(z / S);
      if (w.solid(cx, cz)) continue;
      const f = w.floorC(cx, cz), c = w.ceilC(cx, cz);
      if (c - f < (opts.h || 2.0) || Math.abs(f - py) > 2.2) continue;
      if (w.solid(cx + 1, cz) || w.solid(cx - 1, cz) || w.solid(cx, cz + 1) || w.solid(cx, cz - 1)) continue;
      if (w.floorC(cx + 1, cz) !== f || w.floorC(cx, cz + 1) !== f) continue;
      const vis = w.los(px, pz, x, z);
      if (opts.hidden && vis) continue;
      if (opts.visible && !vis) continue;
      if (opts.lit && w.light(x, z) < opts.lit) continue;
      const cxw = (cx + 0.5) * S, czw = (cz + 0.5) * S;
      if (opts.path && !w.path(cxw, czw, px, pz, 3000)) continue;
      return [cxw, f, czw];
    }
    return null;
  }

  spawn(type, pl, at) {
    const spot = at || (type === 'B'
      ? this.findSpot(pl.x, pl.y, pl.z, 16, 24, {})
      : this.findSpot(pl.x, pl.y, pl.z, type === 'H' ? 14 : 20, type === 'H' ? 24 : 32, { hidden: true, path: true }));
    if (!spot) return null;
    const m = { id: this.myId + '.' + (NEXT++), type, x: spot[0], y: spot[1], z: spot[2], yaw: Math.random() * 6.28, st: 'idle', own: true, t: 0, life: 0, sp: 0, path: null, pi: 0, repath: 0, cd: 0, atk: 0, lost: 0, chase: 0, tx: spot[0], tz: spot[2], far: 0, awake: type !== 'H' ? 1 : 0 };
    if (type === 'B') { m.rad = 7.5; m.life = rnd(45, 75); m.hp = 1; }
    this._build(m);
    this.mine.push(m);
    return m;
  }
  _build(m) {
    if (m.type === 'L') m.obj = makeLongarm(this.M);
    else if (m.type === 'H') m.obj = makeSuit(this.M, true);
    else { m.obj = new THREE.Group(); m.eyes = []; for (let k = 0; k < 7; k++) { const e = makeEyes(this.M); e.visible = false; m.obj.add(e); m.eyes.push({ e, t: 0 }); } }
    this.scene.add(m.obj);
    m.obj.position.set(m.x, m.y, m.z);
  }
  _remove(m) { this.scene.remove(m.obj); this.audio.removeEntity(m.id); }
  clear() { for (const m of this.mine) this._remove(m); this.mine.length = 0; }

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
    if (d > 0.02) {
      const st = Math.min(speed * dt, d);
      const nx = m.x + dx / d * st, nz = m.z + dz / d * st;
      if (!w.solidAt(nx, nz)) { m.x = nx; m.z = nz; }
      m.yaw += angDiff(m.yaw, Math.atan2(-dx, -dz)) * (1 - Math.exp(-9 * dt));
    }
    m.y = damp(m.y, w.floorAt(m.x, m.z), 12, dt);
    m.sp = damp(m.sp, speed, 6, dt);
    return true;
  }

  _longarm(m, dt, T, t) {
    let best = null, bd = 1e9, seen = false;
    for (const tg of T) {
      if (!tg.alive) continue;
      const d = Math.hypot(tg.x - m.x, tg.z - m.z);
      const dark = this.world.light(tg.x, tg.z) < 0.25 && !tg.flash;
      const range = (tg.flash ? 30 : 21) * (dark ? 0.45 : 1) * (tg.crouch ? 0.7 : 1);
      const vis = d < range && this.world.los(m.x, m.z, tg.x, tg.z);
      const heard = tg.noise * 17 > d;
      if ((vis || heard) && d < bd) { bd = d; best = tg; seen = vis; }
    }
    if (best) { m.tx = best.x; m.tz = best.z; m.lost = 0; m.target = best.id; m.st = seen ? 'chase' : (m.st === 'chase' ? 'chase' : 'hunt'); }
    else { m.lost += dt; if (m.st === 'chase' && m.lost > 3.5) m.st = 'hunt'; }
    m.cd -= dt;
    if (m.atk > 0) { m.atk -= dt; m.sp = damp(m.sp, 0, 10, dt); if (m.atk <= 0) m.st = 'chase'; }
    else if (m.st === 'chase') {
      this._follow(m, dt, 4.05, m.tx, m.tz, 0.35);
      if (best && bd < 1.25 && m.cd <= 0) { m.atk = 0.5; m.cd = 1.8; m.st = 'atk'; }
    } else if (m.st === 'hunt') {
      const ok = this._follow(m, dt, 2.5, m.tx, m.tz, 1.0);
      if (!ok || Math.hypot(m.tx - m.x, m.tz - m.z) < 1) { m.st = 'idle'; m.t = rnd(1, 4); }
    } else {
      m.t -= dt;
      if (m.st === 'idle') { m.sp = damp(m.sp, 0, 5, dt); if (m.t <= 0) { const s = this.findSpot(m.x, m.y, m.z, 6, 18, {}); if (s) { m.tx = s[0]; m.tz = s[2]; m.st = 'wander'; m.t = 20; } else m.t = 2; } }
      else { const ok = this._follow(m, dt, 1.15, m.tx, m.tz, 2.5); if (!ok || m.t <= 0 || Math.hypot(m.tx - m.x, m.tz - m.z) < 0.8) { m.st = 'idle'; m.t = rnd(1.5, 6); } }
    }
    m.chase = damp(m.chase, m.st === 'chase' || m.st === 'atk' ? 1 : 0, 4, dt);
  }
  _hollow(m, dt, T) {
    let watched = false, near = null, nd = 1e9;
    for (const tg of T) {
      if (!tg.alive) continue;
      if (this.sees(tg, m.x, m.y + 1.4, m.z, 0.48)) { watched = true; m.awake = 1; }
      const d = Math.hypot(tg.x - m.x, tg.z - m.z); if (d < nd) { nd = d; near = tg; }
    }
    m.life += dt; if (m.life > 25) m.awake = 1;
    m.cd -= dt;
    if (watched || !near || !m.awake) { m.sp = 0; m.st = 'still'; }
    else {
      m.st = 'move';
      this._follow(m, dt, 3.3, near.x, near.z, 0.4); m.sp = 3.3;
      if (nd < 0.95 && m.cd <= 0) { m.st = 'atk'; m.atk = 0.4; m.cd = 4; m.gone = true; }
    }
    if (m.atk > 0) { m.atk -= dt; m.st = 'atk'; }
    m.watched = watched;
  }
  _biter(m, dt, T, pl) {
    let near = null, nd = 1e9;
    for (const tg of T) { if (!tg.alive) continue; const d = Math.hypot(tg.x - m.x, tg.z - m.z); if (d < nd) { nd = d; near = tg; } }
    m.life -= dt;
    if (near) {
      let sp = 1.45, dx = near.x - m.x, dz = near.z - m.z;
      const d = Math.hypot(dx, dz) || 1;
      for (const tg of T) {
        if (!tg.flash || !tg.alive) continue;
        const ex = m.x - tg.x, ez = m.z - tg.z, ed = Math.hypot(ex, ez) || 1;
        if (ed < 15 && (ex * -Math.sin(tg.yaw) + ez * -Math.cos(tg.yaw)) / ed > 0.9) { sp = -2.4; m.life -= dt * 2.5; }
      }
      m.x += dx / d * sp * dt; m.z += dz / d * sp * dt;
    }
    m.st = m.life < 3 ? 'fade' : 'on';
  }

  update(dt, t, pl, game) {
    startPack(this.M); // the optional model pack: once, in the background, after play has begun
    // warm the two pack suits one after the other, a few frames apart, shrunk to nothing under the floor
    if (this._warm !== 3) {
      const w = this._warmObj || (this._warmObj = []);
      this._warmN = (this._warmN || 0) + 1;
      if (!this._warm && this._warmN % 12 === 0) { const g = packWarmSuit(this.M, true); if (g) { w.push(g); this.scene.add(g); this._warm = 1; this._warmN = 0; } }
      else if (this._warm === 1 && this._warmN === 12) { const g = packWarmSuit(this.M, false); if (g) { w.push(g); this.scene.add(g); } this._warm = 2; this._warmN = 0; }
      else if (this._warm === 2 && this._warmN === 12) { for (const g of w) this.scene.remove(g); this._warmObj = null; this._warm = 3; }
      for (const g of w) g.position.set(pl.x, pl.y - 3, pl.z);
    }
    const T = this.targets(pl, game);
    // spawning
    this.spawnT -= dt;
    if (this.spawnT <= 0 && game.alive && !game.safe) {
      this.spawnT = 4;
      const sec = this.world.sectorOf(pl.x, pl.z), dng = (sec && sec.data ? sec.data.danger : 0) + (1 - game.sanity) * 0.3;
      const cnt = (ty, r) => this.mine.filter((m) => m.type === ty).length + [...this.remote.values()].filter((m) => m.type === ty && Math.hypot(m.x - pl.x, m.z - pl.z) < r).length;
      if (dng > 0.06) {
        if (cnt('L', 70) < (dng > 0.8 ? 2 : 1) && Math.random() < dng * 0.2) this.spawn('L', pl);
        else if (dng > 0.15 && cnt('H', 80) < 1 && Math.random() < dng * 0.11) this.spawn('H', pl);
        else if (cnt('B', 90) < 1 && Math.random() < ((sec && sec.data && /dark|hall|tunnels/.test(sec.data.type)) ? 0.09 : game.sanity < 0.4 ? 0.06 : 0)) this.spawn('B', pl);
      }
    }
    // simulate my own
    for (let i = this.mine.length - 1; i >= 0; i--) {
      const m = this.mine[i];
      if (m.type === 'L') this._longarm(m, dt, T, t); else if (m.type === 'H') this._hollow(m, dt, T); else this._biter(m, dt, T, pl);
      let nd = 1e9; for (const tg of T) nd = Math.min(nd, Math.hypot(tg.x - m.x, tg.z - m.z));
      m.far = nd > 75 ? m.far + dt : 0;
      const dead = m.far > 12 || (m.type === 'B' && m.life <= 0) || (m.gone && m.atk <= 0) || this.world.solidAt(m.x, m.z) && m.type !== 'B';
      if (dead) { this._remove(m); this.mine.splice(i, 1); }
    }
    // draw + affect the local player
    this.hitCd -= dt;
    let fear = 0, watching = false, dark = null, darkD = 1e9;
    const all = [...this.mine, ...this.remote.values()];
    for (const m of all) {
      const d = Math.hypot(m.x - pl.x, m.z - pl.z);
      if (m.type === 'L') {
        m.obj.position.set(m.x, m.y, m.z); m.obj.rotation.y = m.yaw;
        const ch = m.own ? m.chase : (m.cv = damp(m.cv || 0, m.st === 'chase' || m.st === 'atk' ? 1 : 0, 4, dt));
        animLongarm(m.obj, dt, m.own ? m.sp : (m.st === 'chase' ? 4 : m.st === 'idle' ? 0 : 1.5), ch, t);
        this.audio.entity(m.id, 'longarm', m.x, m.y + 1.8, m.z, { chase: ch });
        fear = Math.max(fear, ch > 0.4 ? clamp(1.15 - d / 26, 0, 1) : clamp(0.6 - d / 22, 0, 0.6));
        if (m.st === 'atk' && d < 1.75 && this.hitCd <= 0 && game.alive) { this.hitCd = 1.5; game.hurt(0.5, 'Struck by something tall', m.x, m.z); }
      } else if (m.type === 'H') {
        m.obj.position.set(m.x, m.y, m.z); m.obj.rotation.y = m.yaw;
        const mv = m.st === 'move' ? 1 : 0;
        if (mv) animSuit(m.obj, dt * 1.7, 3.3, false, 0);
        this.audio.entity(m.id, 'hollow', m.x, m.y + 1.4, m.z, { moving: mv });
        const iSee = game.alive && this.sees(T[0], m.x, m.y + 1.4, m.z, 0.55, 40);
        if (iSee) { watching = true; fear = Math.max(fear, clamp(0.75 - d / 30, 0.15, 0.75)); }
        else if (d < 8) fear = Math.max(fear, 0.35);
        if (m.st === 'atk' && d < 1.5 && this.hitCd <= 0 && game.alive) { this.hitCd = 2; game.hurt(0.65, 'An empty suit took hold of you', m.x, m.z); }
      } else {
        const rad = m.rad || 7.5;
        if (d < darkD) { darkD = d; dark = m; }
        const near = clamp(1 - d / (rad * 1.6), 0, 1);
        this.audio.entity(m.id, 'biter', m.x, pl.y + 1.2, m.z, { near });
        if (d < rad) { fear = Math.max(fear, 0.45 + 0.4 * (1 - d / rad)); game.drain(dt * 0.055); if (d < 2.3 && game.alive && !pl.flashOn) game.hurt(dt * 0.2, 'The dark closed over you', m.x, m.z, true); }
        for (const e of m.eyes || []) {
          e.t -= dt;
          const ex = e.e.position.x, ez = e.e.position.z;
          const looked = e.e.visible && this.sees(T[0], ex, e.e.position.y, ez, 0.86, 30);
          if (e.t <= 0 || (looked && e.t < e.life - 0.8)) {
            const a = Math.random() * 6.28, r = rnd(1.5, rad * 0.8), x = m.x + Math.sin(a) * r, z = m.z + Math.cos(a) * r;
            e.t = e.life = rnd(1.5, 5); e.e.visible = !this.world.solidAt(x, z) && m.st !== 'fade' && Math.hypot(x - pl.x, z - pl.z) > 2.5;
            e.e.position.set(x, this.world.floorAt(x, z) + rnd(0.5, 2.2), z);
          }
          if (e.e.visible) e.e.lookAt(pl.x, pl.y + 1.6, pl.z);
        }
      }
    }
    // darkness uniform follows the nearest biter
    const D = this.shared.uDark.value;
    const want = dark && dark.st !== 'fade' ? 1 : 0;
    this.darkS = damp(this.darkS, want, want ? 0.9 : 0.6, dt);
    if (dark) { D.x = dark.x; D.y = dark.z; D.z = dark.rad || 7.5; }
    D.w = this.darkS * 0.985;
    this.inDark = dark ? clamp(1 - darkD / (dark.rad || 7.5), 0, 1) * this.darkS : 0;
    this.fear = damp(this.fear, fear, fear > this.fear ? 3 : 0.5, dt);
    this.watching = watching;
  }

  // creatures simulated by other clients
  syncRemote(peers, dt) {
    const seen = new Set();
    for (const [, p] of peers) {
      const list = p.s && p.s.e; if (!list) continue;
      for (const e of list) {
        const id = e[0]; seen.add(id);
        let m = this.remote.get(id);
        if (!m) { m = { id, type: e[1], x: e[2], y: e[3], z: e[4], yaw: e[5], st: e[6], own: false, rad: 7.5 }; this._build(m); this.remote.set(id, m); }
        m.x = damp(m.x, e[2], 10, dt); m.y = damp(m.y, e[3], 10, dt); m.z = damp(m.z, e[4], 10, dt);
        if (Math.hypot(e[2] - m.x, e[4] - m.z) > 8) { m.x = e[2]; m.z = e[4]; }
        m.yaw += angDiff(m.yaw, e[5]) * (1 - Math.exp(-10 * dt)); m.st = e[6];
      }
    }
    for (const [id, m] of this.remote) if (!seen.has(id)) { this._remove(m); this.remote.delete(id); }
  }
  serialize() {
    const r2 = (v) => Math.round(v * 100) / 100;
    return this.mine.map((m) => [m.id, m.type, r2(m.x), r2(m.y), r2(m.z), r2(m.yaw), m.st]);
  }
}

// Things that are there when you look back. Local to each player: nobody else can confirm them.
export class Anomalies {
  constructor(ctx) {
    Object.assign(this, ctx); // scene, world, M, tex, audio, ents
    this.timer = rnd(35, 60); this.active = []; this.blackout = 0; this.blackT = 0; this.pulse = 1; this.stingAt = 0;
  }
  _view(pl, x, z, half = 0.55) {
    const dx = x - pl.x, dz = z - pl.z, d = Math.hypot(dx, dz) || 1;
    return (dx * -Math.sin(pl.yaw) + dz * -Math.cos(pl.yaw)) / d > half && d < 30 && this.world.los(pl.x, pl.z, x, z);
  }
  trigger(kind, pl) {
    const E = this.ents, back = pl.yaw; // +sin(yaw), +cos(yaw) points behind the player
    if (kind === 'chair' || kind === 'door') {
      const s = E.findSpot(pl.x, pl.y, pl.z, 3.5, 9, { dir: back, spread: 1.0 });
      if (!s) return this.trigger('sound', pl);
      const obj = kind === 'chair' ? makeChair(this.M) : makeDoor(this.M, this.tex, false);
      obj.position.set(s[0], s[1], s[2]); obj.rotation.y = Math.atan2(pl.x - s[0], pl.z - s[2]) + (kind === 'chair' ? Math.PI : 0);
      this.scene.add(obj); this.active.push({ kind, obj, x: s[0], z: s[2], seen: false, away: 0, life: 120 });
      this.audio.play('apparition', { pos: [s[0], s[1] + 1, s[2]] });
    } else if (kind === 'figure') {
      const s = E.findSpot(pl.x, pl.y, pl.z, 12, 26, { dir: back + Math.PI, spread: 0.45, visible: true, lit: 0.35 });
      if (!s) return this.trigger('sound', pl);
      const obj = makeSuit(this.M, true);
      obj.position.set(s[0], s[1], s[2]); obj.rotation.y = Math.atan2(-(pl.x - s[0]), -(pl.z - s[2]));
      this.scene.add(obj); this.active.push({ kind, obj, x: s[0], z: s[2], seen: false, look: rnd(1.0, 2.6), life: 40 });
    } else if (kind === 'lights') {
      this.blackT = rnd(0.9, 3.2); this.stingAt = Math.random() < 0.25 ? 1 : 0;
      this.audio.play('flashOff', { vol: 0.5 });
    } else {
      const a = Math.random() * 6.28, r = rnd(8, 20), pos = [pl.x + Math.sin(a) * r, pl.y + 1.4, pl.z + Math.cos(a) * r];
      const k = Math.random();
      if (k < 0.3) this.audio.play('knock', { pos }); else if (k < 0.45) this.audio.play('doorSlam', { pos });
      else this.audio.whisper(pos[0], pos[1], pos[2], ['whisper', 'call', 'cry', 'mimic', 'laugh'][Math.floor(Math.random() * 5)]);
    }
  }
  update(dt, t, pl, game, propsList) {
    const sec = this.world.sectorOf(pl.x, pl.z), dng = sec && sec.data ? sec.data.danger : 0;
    if (game.alive) this.timer -= dt * (1 + (1 - game.sanity) * 2.2 + dng);
    if (this.timer <= 0) {
      this.timer = rnd(40, 95);
      const r = Math.random();
      this.trigger(r < 0.2 ? 'chair' : r < 0.3 ? 'door' : r < 0.52 ? 'figure' : r < 0.67 ? 'lights' : 'sound', pl);
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i], v = this._view(pl, a.x, a.z), d = Math.hypot(a.x - pl.x, a.z - pl.z);
      a.life -= dt; let kill = false;
      if (a.kind === 'figure') {
        if (v) { a.seen = true; a.look -= dt; }
        if ((a.seen && a.look <= 0) || d < 8) { kill = true; this.blackT = Math.max(this.blackT, 0.22); if (d < 8) this.audio.play('stinger', { vol: 0.5 }); }
        else if (a.life <= 0 && !v) kill = true;
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
      this.pulse = Math.random() < 0.06 ? 0.5 : 0.015;
      if (this.blackT <= 0) { this.audio.play('flashOn', { vol: 0.4 }); if (this.stingAt) { this.stingAt = 0; this.audio.play('stinger'); this.trigger('figure', pl); } }
    } else { this.blackout = 0; this.pulse = damp(this.pulse, 1, 14, dt); }
  }
  clear() { for (const a of this.active) this.scene.remove(a.obj); this.active.length = 0; this.blackT = 0; }
}
export { lerp };
