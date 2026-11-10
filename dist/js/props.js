// Models built from primitives (suits, creatures, pickups, artifacts, doors, chairs)
// and the per-sector props: supplies, artifacts, exits, wall scrawls, chalk signs.
import * as THREE from './three.module.min.js';
import { S, SEC, ARTIFACTS } from './util.js';
import { labelTexture } from './textures.js';

const cache = new Map();
const geo = (k, f) => { let g = cache.get(k); if (!g) { g = f(); cache.set(k, g); } return g; };
export const box = (w, h, d) => geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
export const cyl = (r, h, r2 = r, seg = 12) => geo(`c${r},${h},${r2},${seg}`, () => new THREE.CylinderGeometry(r2, r, h, seg));
export const sph = (r, seg = 14) => geo(`s${r},${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 4)));
export const cap = (r, l) => geo(`p${r},${l}`, () => new THREE.CapsuleGeometry(r, l, 4, 10));
const plane = () => geo('pl', () => new THREE.PlaneGeometry(1, 1));

function part(g, mat, x, y, z, parent) { const m = new THREE.Mesh(g, mat); m.position.set(x, y, z); parent.add(m); return m; }

export function makeMats(mats, tex) {
  const o = mats.obj;
  return {
    suit: o(0xb58a10, { fabric: 0.8, gloss: 0.25 }), suitHollow: o(0x6f6230, { fabric: 1, gloss: 0.1 }),
    rubber: o(0x0c0c0b, { gloss: 0.4 }), visor: o(0x020203, { gloss: 1.6 }), tank: o(0x55584f, { gloss: 0.9 }),
    flesh: o(0x060504, { gloss: 0.55, fabric: 0.7 }), bone: o(0x15120d, { gloss: 0.4, fabric: 0.8 }),
    eye: o(0x000000, { emis: 0xfff2c0, emisScale: 2.2 }),
    water: o(0x9fb0a0, { gloss: 1.2, emis: 0x10140f }), cap: o(0x2a4a7a, { gloss: 0.5 }), label: o(0xd8cfa8, { fabric: 0.3 }),
    cell: o(0x16160f, { gloss: 0.8, emis: 0x061206 }), copper: o(0xa8662a, { gloss: 1.4 }),
    plastic: o(0x1b1b1a, { gloss: 0.7 }), cloth: o(0x2c2a31, { fabric: 1 }), metal: o(0x6b6b66, { gloss: 1.3 }),
    door: o(0x4a4332, { gloss: 0.3, fabric: 0.5 }), frame: o(0x8a8672, { gloss: 0.4 }),
    art: (c, e) => o(c, { gloss: 1.2, emis: e, fabric: 0.2 }),
    marks: mats.decal(tex.marks), marksFaint: mats.decal(tex.marks, { alpha: 0 }),
    signs: mats.decal(tex.signs, { alpha: 0.82 }),
    exitSign: mats.decal(tex.exit, { lit: 0, tintScale: 3.2 }),
    glow: (c, s) => mats.decal(tex.exit, { lit: 0, tint: c, tintScale: s }),
  };
}

// ---- hazmat suit: used for other players and for the Hollow ----
export function makeSuit(M, hollow) {
  const g = new THREE.Group(), fab = hollow ? M.suitHollow : M.suit;
  const body = new THREE.Group(); g.add(body);
  part(cap(0.2, 0.42), fab, 0, 1.12, 0, body).scale.set(1.08, 1, 0.82);
  part(sph(0.19), fab, 0, 0.86, 0, body).scale.set(1.05, 0.8, 0.86);
  const head = new THREE.Group(); head.position.set(0, 1.5, 0); body.add(head);
  part(sph(0.175), fab, 0, 0.1, 0, head).scale.set(1, 1.15, 1.08);
  part(box(0.24, 0.15, 0.05), M.visor, 0, 0.13, -0.16, head);
  for (const sx of [-1, 1]) part(cyl(0.045, 0.07), M.rubber, 0.078 * sx, -0.015, -0.17, head).rotation.x = Math.PI / 2;
  part(cyl(0.095, 0.42), M.tank, 0, 1.18, 0.2, body);
  const limb = (x, y, r, len) => { const p = new THREE.Group(); p.position.set(x, y, 0); body.add(p); part(cap(r, len), fab, 0, -len / 2 - r * 0.4, 0, p); return p; };
  const armL = limb(-0.27, 1.36, 0.062, 0.5), armR = limb(0.27, 1.36, 0.062, 0.5);
  part(sph(0.07), M.rubber, 0, -0.6, 0, armL); part(sph(0.07), M.rubber, 0, -0.6, 0, armR);
  const legL = limb(-0.11, 0.84, 0.085, 0.58), legR = limb(0.11, 0.84, 0.085, 0.58);
  part(box(0.13, 0.1, 0.27), M.rubber, 0, -0.77, -0.04, legL); part(box(0.13, 0.1, 0.27), M.rubber, 0, -0.77, -0.04, legR);
  if (hollow) { head.rotation.z = 0.22; head.rotation.x = 0.12; armL.rotation.z = -0.05; armR.rotation.z = 0.05; }
  g.userData = { body, head, armL, armR, legL, legR, ph: Math.random() * 6, hollow };
  return g;
}
export function animSuit(g, dt, speed, crouch, pitch) {
  const u = g.userData;
  const walk = Math.min(speed / 2.2, 1.8);
  u.ph += dt * (3 + speed * 2.4) * (speed > 0.15 ? 1 : 0.0);
  const s = Math.sin(u.ph) * 0.55 * Math.min(walk, 1.2);
  u.legL.rotation.x = s; u.legR.rotation.x = -s;
  u.armL.rotation.x = -s * 0.7; u.armR.rotation.x = u.hollow ? s * 0.7 : -0.9 + s * 0.15; // right hand holds the light
  u.body.position.y = (crouch ? -0.55 : 0) + Math.abs(Math.cos(u.ph)) * 0.03 * walk;
  u.body.rotation.x = crouch ? 0.5 : 0.04 * walk;
  if (!u.hollow) u.head.rotation.x = -pitch * 0.6;
}

// ---- Longarm: tall, thin, wet. Arms reach the floor. ----
export function makeLongarm(M) {
  const g = new THREE.Group(), f = M.flesh;
  const body = new THREE.Group(); g.add(body);
  const torso = part(cap(0.12, 0.75), f, 0, 1.75, 0.05, body); torso.scale.set(1, 1, 0.75); torso.rotation.x = 0.28;
  part(sph(0.15), M.bone, 0, 1.32, 0.12, body).scale.set(1, 0.7, 0.8);
  const neck = new THREE.Group(); neck.position.set(0, 2.2, -0.08); body.add(neck);
  part(cap(0.04, 0.28), f, 0, 0.14, 0, neck);
  const head = part(sph(0.115), f, 0, 0.36, -0.02, neck); head.scale.set(0.85, 1.25, 0.95);
  const arm = (sx) => {
    const sh = new THREE.Group(); sh.position.set(0.19 * sx, 2.05, -0.02); body.add(sh);
    part(cap(0.038, 0.9), f, 0, -0.47, 0, sh);
    const el = new THREE.Group(); el.position.set(0, -0.95, 0); sh.add(el);
    part(cap(0.03, 0.95), f, 0, -0.5, 0, el);
    for (let k = -1; k <= 1; k++) part(cap(0.012, 0.26), M.bone, k * 0.03, -1.12, 0, el).rotation.z = k * 0.12;
    return { sh, el };
  };
  const leg = (sx) => {
    const hip = new THREE.Group(); hip.position.set(0.1 * sx, 1.3, 0.1); body.add(hip);
    part(cap(0.05, 0.6), f, 0, -0.33, 0, hip);
    const kn = new THREE.Group(); kn.position.set(0, -0.66, 0); hip.add(kn);
    part(cap(0.036, 0.6), f, 0, -0.32, 0, kn);
    return { hip, kn };
  };
  g.userData = { body, neck, aL: arm(-1), aR: arm(1), lL: leg(-1), lR: leg(1), ph: 0 };
  return g;
}
export function animLongarm(g, dt, speed, chase, t) {
  const u = g.userData;
  u.ph += dt * (1.6 + speed * 1.9);
  const s = Math.sin(u.ph), c = Math.cos(u.ph), w = Math.min(speed / 1.6, 1.4);
  u.lL.hip.rotation.x = s * 0.5 * w - 0.25; u.lL.kn.rotation.x = 0.5 + Math.max(0, -c) * 0.7 * w;
  u.lR.hip.rotation.x = -s * 0.5 * w - 0.25; u.lR.kn.rotation.x = 0.5 + Math.max(0, c) * 0.7 * w;
  const reach = chase * 1.15;
  u.aL.sh.rotation.x = -s * 0.3 * w - reach + Math.sin(t * 1.3) * 0.04; u.aL.el.rotation.x = -0.15 - reach * 0.5;
  u.aR.sh.rotation.x = s * 0.3 * w - reach * 0.9 + Math.sin(t * 1.1 + 2) * 0.04; u.aR.el.rotation.x = -0.15 - reach * 0.6;
  u.aL.sh.rotation.z = -0.06 - chase * 0.1; u.aR.sh.rotation.z = 0.06 + chase * 0.1;
  u.body.position.y = Math.abs(c) * 0.05 * w - 0.06; u.body.rotation.x = 0.08 + chase * 0.2;
  u.neck.rotation.z = Math.sin(t * 0.7) * 0.25 + (chase > 0.5 ? Math.sin(t * 31) * 0.12 : 0);
  u.neck.rotation.x = -0.2 - chase * 0.3;
}

export function makeEyes(M) {
  const g = new THREE.Group();
  for (const sx of [-1, 1]) part(sph(0.022, 8), M.eye, 0.045 * sx, 0, 0, g);
  return g;
}

function makeBottle(M) {
  const g = new THREE.Group();
  part(cyl(0.036, 0.16), M.water, 0, 0.08, 0, g); part(cyl(0.037, 0.07), M.label, 0, 0.085, 0, g);
  part(cyl(0.036, 0.04, 0.016), M.water, 0, 0.18, 0, g); part(cyl(0.018, 0.022), M.cap, 0, 0.21, 0, g);
  return g;
}
function makeBattery(M) {
  const g = new THREE.Group();
  const b = part(cyl(0.034, 0.13), M.cell, 0, 0.035, 0, g); b.rotation.z = Math.PI / 2;
  const c = part(cyl(0.035, 0.025), M.copper, 0.07, 0.035, 0, g); c.rotation.z = Math.PI / 2;
  return g;
}
export function makeChair(M) {
  const g = new THREE.Group();
  part(box(0.46, 0.07, 0.46), M.cloth, 0, 0.47, 0, g);
  const b = part(box(0.44, 0.5, 0.06), M.cloth, 0, 0.82, 0.22, g); b.rotation.x = 0.12;
  part(cyl(0.025, 0.4), M.metal, 0, 0.25, 0, g);
  for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; const l = part(box(0.04, 0.03, 0.3), M.plastic, Math.sin(a) * 0.15, 0.05, Math.cos(a) * 0.15, g); l.rotation.y = a; }
  return g;
}
export function makeDoor(M, tex, withSign) {
  const g = new THREE.Group();
  part(box(0.08, 2.1, 0.12), M.frame, -0.5, 1.05, 0, g); part(box(0.08, 2.1, 0.12), M.frame, 0.5, 1.05, 0, g);
  part(box(1.08, 0.08, 0.12), M.frame, 0, 2.14, 0, g);
  part(box(0.92, 2.06, 0.05), M.door, 0, 1.03, 0, g);
  part(sph(0.035), M.metal, 0.36, 1.0, -0.05, g); part(sph(0.035), M.metal, 0.36, 1.0, 0.05, g);
  if (withSign) {
    part(box(0.46, 0.2, 0.05), M.plastic, 0, 2.4, 0, g);
    const s = part(plane(), M.exitSign, 0, 2.4, -0.03, g); s.scale.set(0.42, 0.17, 1); s.rotation.y = Math.PI;
    const s2 = part(plane(), M.exitSign, 0, 2.4, 0.03, g); s2.scale.set(0.42, 0.17, 1);
  }
  return g;
}

const ART_LOOK = [
  [0x3a3c3e, 0x2a2010, (M, m) => part(box(0.16, 0.16, 0.16), m, 0, 0, 0, new THREE.Group()).parent],
  [0xd9d6c8, 0x14140f, (M, m) => { const g = new THREE.Group(); part(box(0.2, 0.24, 0.008), m, 0, 0, 0, g); part(box(0.16, 0.15, 0.01), M.plastic, 0, 0.025, 0, g); return g; }],
  [0xc9c2a8, 0x18140a, (M, m) => { const g = new THREE.Group(); const d = part(cyl(0.12, 0.04, 0.12, 24), m, 0, 0, 0, g); d.rotation.x = Math.PI / 2; part(box(0.012, 0.09, 0.012), M.plastic, 0, 0.04, 0.025, g); const h = part(box(0.012, 0.06, 0.012), M.plastic, 0.02, 0.015, 0.025, g); h.rotation.z = -1.1; return g; }],
  [0x020202, 0x000000, (M, m) => { const g = new THREE.Group(); part(sph(0.085), m, 0, 0.03, 0, g); part(cyl(0.04, 0.07), M.metal, 0, -0.07, 0, g); return g; }],
  [0xb58a10, 0x141003, (M, m) => { const g = new THREE.Group(); part(cap(0.06, 0.09), m, 0, 0, 0, g); for (let k = 0; k < 4; k++) { const f = part(cap(0.017, 0.07), m, -0.045 + k * 0.03, 0.12, 0, g); f.rotation.x = 0.5; } const t = part(cap(0.018, 0.05), m, 0.08, 0.03, 0, g); t.rotation.z = -1; return g; }],
  [0xb08a2e, 0x2a1c04, (M, m) => { const g = new THREE.Group(); const d = part(cyl(0.07, 0.012, 0.07, 24), m, 0, 0, 0, g); d.rotation.x = Math.PI / 2; return g; }],
  [0x161616, 0x0a0a0a, (M, m) => { const g = new THREE.Group(); part(box(0.2, 0.125, 0.03), m, 0, 0, 0, g); part(box(0.12, 0.05, 0.032), M.label, 0, 0.015, 0, g); return g; }],
  [0xbfa94f, 0x1c1806, (M, m) => { const g = new THREE.Group(); const b = part(geo('cone', () => new THREE.ConeGeometry(0.06, 0.2, 4)), m, 0, 0, 0, g); b.rotation.x = Math.PI / 2; const w = part(box(0.3, 0.004, 0.09), m, 0, 0.01, 0.02, g); w.rotation.z = 0.25; return g; }],
  [0x8f9a8a, 0x0c100a, (M, m) => { const g = new THREE.Group(); part(cyl(0.065, 0.16), m, 0, 0, 0, g); part(cyl(0.06, 0.09), M.label, 0, -0.03, 0, g); part(cyl(0.068, 0.02), M.metal, 0, 0.09, 0, g); return g; }],
  [0x8a8a80, 0x16160f, (M, m) => { const g = new THREE.Group(); part(box(0.02, 0.22, 0.012), m, 0, 0, 0, g); const r = part(geo('tor', () => new THREE.TorusGeometry(0.04, 0.012, 6, 14)), m, 0, 0.14, 0, g); for (let k = 0; k < 6; k++) part(box(0.03 + (k % 3) * 0.012, 0.014, 0.012), m, 0.02, -0.1 + k * 0.025, 0, g); return g; }],
  [0x1c1b18, 0x0a0806, (M, m) => { const g = new THREE.Group(); part(box(0.22, 0.06, 0.18), m, 0, -0.04, 0, g); const h = part(box(0.24, 0.045, 0.055), m, 0, 0.03, -0.04, g); part(cyl(0.006, 0.12), M.plastic, -0.12, -0.02, 0.05, g); return g; }],
  [0xe8e4d6, 0x1a1a16, (M, m) => { const g = new THREE.Group(); part(sph(0.07), m, 0, 0, 0, g); part(sph(0.032), M.plastic, 0, 0, -0.052, g); part(sph(0.016), M.visor, 0, 0, -0.078, g); return g; }],
];
export function makeArtifact(M, kind) {
  const L = ART_LOOK[kind % ART_LOOK.length];
  const g = L[2](M, M.art(L[0], L[1]));
  g.userData.kind = kind;
  return g;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRYAW = [-Math.PI / 2, Math.PI / 2, Math.PI, 0]; // facing away from the wall

// Everything attached to one loaded sector.
export class SectorProps {
  constructor(scene, M, tex, s, taken) {
    this.group = new THREE.Group(); scene.add(this.group);
    this.items = []; this.lateMarks = [];
    const d = s.data, ox = d.sx * SEC, oz = d.sz * SEC;
    const wp = (x, z) => [(ox + x + 0.5) * S, (oz + z + 0.5) * S];
    for (const it of d.items) {
      if (taken(it.id)) continue;
      const m = it.kind === 'water' ? makeBottle(M) : makeBattery(M);
      const k = wallOffset(d, it.x, it.z);
      const [x, z] = wp(it.x, it.z);
      m.position.set(x + k[0], it.y, z + k[1]); m.rotation.y = it.x * 1.7 + it.z;
      this.group.add(m);
      this.items.push({ id: it.id, kind: it.kind, obj: m, x: m.position.x, y: it.y + 0.15, z: m.position.z });
    }
    if (d.artifact && !taken(d.artifact.id)) {
      const a = d.artifact, m = makeArtifact(M, a.kind), [x, z] = wp(a.x, a.z);
      m.position.set(x, a.y + 0.95, z); this.group.add(m);
      this.items.push({ id: a.id, kind: 'artifact', art: a.kind, obj: m, x, y: a.y + 0.95, z, float: true, base: a.y + 0.95 });
    }
    if (d.exit && d.exit.dir >= 0) {
      const e = d.exit, m = makeDoor(M, tex, true), [x, z] = wp(e.x, e.z), dr = DIRS[e.dir];
      m.position.set(x + dr[0] * 0.24, e.y, z + dr[1] * 0.24); m.rotation.y = DIRYAW[e.dir] + Math.PI;
      this.group.add(m);
      this.items.push({ id: 'exit', kind: 'exit', obj: m, x, y: e.y + 1.1, z });
    }
    for (const mk of d.marks) {
      if (mk.dir < 0) continue;
      const mat = mk.late ? M.marksFaint.clone() : M.marks;
      if (mk.late) { mat.uniforms = { ...M.marksFaint.uniforms, uAlpha: { value: 0 } }; }
      const q = new THREE.Mesh(glyphGeo(mk.glyph, 4, 4), mat), [x, z] = wp(mk.x, mk.z), dr = DIRS[mk.dir];
      q.position.set(x + dr[0] * 0.295, mk.y, z + dr[1] * 0.295); q.rotation.y = DIRYAW[mk.dir]; q.scale.set(0.62, 0.62, 1);
      this.group.add(q);
      if (mk.late) this.lateMarks.push({ q, mat, x, z, seen: false, on: false });
    }
  }
  remove(item) { this.group.remove(item.obj); this.items.splice(this.items.indexOf(item), 1); }
  dispose(scene) { scene.remove(this.group); }
}
function wallOffset(d, x, z) {
  for (const k of DIRS) { const nx = x + k[0], nz = z + k[1]; if (nx >= 0 && nz >= 0 && nx < SEC && nz < SEC && d.solid[nx + nz * SEC]) return [k[0] * 0.14, k[1] * 0.14]; }
  return [0, 0];
}
const gcache = new Map();
export function glyphGeo(i, cols, rows) {
  const key = i + ':' + cols + ':' + rows; let g = gcache.get(key);
  if (!g) {
    g = new THREE.PlaneGeometry(1, 1);
    const u0 = (i % cols) / cols, v1 = 1 - Math.floor(i / cols) / rows, u1 = u0 + 1 / cols, v0 = v1 - 1 / rows;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([u0, v1, u1, v1, u0, v0, u1, v0]), 2));
    gcache.set(key, g);
  }
  return g;
}

// Chalk signs left by players (shared, persistent).
export class Signs {
  constructor(scene, M) { this.scene = scene; this.M = M; this.map = new Map(); }
  sync(list, ids) {
    const keep = new Set();
    for (const r of list) {
      keep.add(r.id);
      if (this.map.has(r.id)) continue;
      const gi = ids.indexOf(r.g); if (gi < 0) continue;
      const q = new THREE.Mesh(glyphGeo(gi, 4, 2), this.M.signs);
      q.rotation.order = 'YXZ'; q.rotation.set(-Math.PI / 2, r.r || 0, 0);
      q.position.set(r.x, r.y + 0.012, r.z); q.scale.set(0.8, 0.8, 1);
      this.scene.add(q); this.map.set(r.id, q);
    }
    for (const [id, q] of this.map) if (!keep.has(id)) { this.scene.remove(q); this.map.delete(id); }
  }
}

export function makeTag(name) {
  const t = labelTexture(name);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0 }));
  sp.scale.set(0.9, 0.17, 1);
  return sp;
}
export { ARTIFACTS };
