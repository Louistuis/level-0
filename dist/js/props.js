// Every model in the game, built procedurally at load time (no asset files):
// hazmat suits (players and the Hollow), the Longarm, the biter's faces, supplies, chairs,
// doors and the twelve artifacts, plus the per-sector props, wall scrawls and chalk signs.
//
// Models are merged into one BufferGeometry each (a few draw calls per model) carrying
// per-vertex albedo + grime (aCol) and gloss / sheen / subsurface / emissive (aSurf), uv into
// one printed-surface atlas, and for characters skin weights for a small skeleton.
import * as THREE from './three.module.min.js';
import { S, SEC, ARTIFACTS, hash3, mulberry32 } from './util.js';
import { labelTexture, objectDetailTexture, propAtlas, atlasUV } from './textures.js';

const V3 = THREE.Vector3;
const cache = new Map();
const geo = (k, f) => { let g = cache.get(k); if (!g) { g = f(); cache.set(k, g); } return g; };
export const box = (w, h, d) => geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
export const cyl = (r, h, r2 = r, seg = 12) => geo(`c${r},${h},${r2},${seg}`, () => new THREE.CylinderGeometry(r2, r, h, seg));
export const sph = (r, seg = 14) => geo(`s${r},${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 4)));
export const cap = (r, l) => geo(`p${r},${l}`, () => new THREE.CapsuleGeometry(r, l, 4, 10));
const plane = () => geo('pl', () => new THREE.PlaneGeometry(1, 1));

// ======================================================================
// small math + noise
// ======================================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const gauss = (x, w) => Math.exp(-(x * x) / (w * w));
function h3(x, y, z) { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vn3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  return L(L(L(h3(xi, yi, zi), h3(xi + 1, yi, zi), fx), L(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), fx), fy),
    L(L(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), fx), L(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), fx), fy), fz);
}
const fbm3 = (x, y, z) => vn3(x, y, z) * 0.55 + vn3(x * 2.1 + 7, y * 2.1, z * 2.1) * 0.3 + vn3(x * 4.3, y * 4.3 + 3, z * 4.3) * 0.15;
function mrand(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const _q = new THREE.Quaternion(), _e = new THREE.Euler();
// transform matrix: position, euler rotation (XYZ), scale
function T(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(new V3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)).clone(), new V3(sx, sy, sz));
}
// rotation about a pivot point
function about(c, rx, ry, rz) { return new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(T(0, 0, 0, rx, ry, rz)).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2])); }
// transform that points local +Y along dir
function TY(x, y, z, dir, sx = 1, sy = sx, sz = sx, spin = 0) {
  const d = new V3(...dir).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d);
  if (spin) q.multiply(new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), spin));
  return new THREE.Matrix4().compose(new V3(x, y, z), q, new V3(sx, sy, sz));
}

// ======================================================================
// geometry generators
// ======================================================================
function finish(P, I, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(I);
  // make sure faces point outwards (closed-ish shapes): sum of n·p is 3x the volume
  let s = 0; const a = new V3(), b = new V3(), c = new V3(), n = new V3();
  for (let i = 0; i < I.length; i += 3) {
    a.fromArray(P, I[i] * 3); b.fromArray(P, I[i + 1] * 3); c.fromArray(P, I[i + 2] * 3);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a)); s += n.dot(a.add(b).add(c));
  }
  if (s < 0) { for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } g.setIndex(I); }
  g.computeVertexNormals();
  return g;
}

// Swept tube along a smooth curve through ctrl points. rf(t, a) gives the radius at
// t (0..1 along) and a (angle; a = 0 points along `up`, a = PI/2 is up x tangent).
// disp(p, t, a, dir) may push the vertex. Ends are closed with a domed pole.
function tube(ctrl, rf, o = {}) {
  const n = o.n || 16, seg = o.seg || 10;
  const curve = ctrl.length > 2 ? new THREE.CatmullRomCurve3(ctrl.map((p) => new V3(...p)), false, 'centripetal') : new THREE.LineCurve3(new V3(...ctrl[0]), new V3(...ctrl[1]));
  const pts = curve.getSpacedPoints(n - 1);
  const Ts = pts.map((p, i) => pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
  let N = new V3(...(o.up || [0, 0, -1]));
  N.addScaledVector(Ts[0], -N.dot(Ts[0]));
  if (N.lengthSq() < 1e-8) N.set(1, 0, 0).addScaledVector(Ts[0], -Ts[0].x);
  N.normalize();
  const P = [], I = [], B = new V3(), dir = new V3(), p = new V3();
  for (let i = 0; i < n; i++) {
    if (i > 0) { N.addScaledVector(Ts[i], -N.dot(Ts[i])).normalize(); }
    B.crossVectors(Ts[i], N);
    const t = i / (n - 1);
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      dir.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      p.copy(pts[i]).addScaledVector(dir, rf(t, a));
      if (o.disp) o.disp(p, t, a, dir);
      P.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * seg + j, b = i * seg + (j + 1) % seg, c = a + seg, d = b + seg;
    I.push(a, b, c, b, d, c);
  }
  const capAt = (i, len, sgn) => {
    const pole = P.length / 3, c = pts[i].clone().addScaledVector(Ts[i], sgn * len);
    P.push(c.x, c.y, c.z);
    for (let j = 0; j < seg; j++) { const a = i * seg + j, b = i * seg + (j + 1) % seg; if (sgn < 0) I.push(pole, b, a); else I.push(pole, a, b); }
  };
  if (o.cap0 !== false) capAt(0, o.cap0 ?? rf(0, 0) * 0.5, -1);
  if (o.cap1 !== false) capAt(n - 1, o.cap1 ?? rf(1, 0) * 0.5, 1);
  return finish(P, I);
}
// ellipse / superellipse radius in a tube's frame: a = 0 is "front" (rz), PI/2 is side (rx)
function sell(a, rx, rz, e = 2) { const c = Math.abs(Math.cos(a)) / rz, s = Math.abs(Math.sin(a)) / rx; return Math.pow(Math.pow(c, e) + Math.pow(s, e), -1 / e); }
// piecewise-smooth interpolation through [t, v] keys
function keys(K) {
  return (t) => {
    if (t <= K[0][0]) return K[0][1];
    for (let i = 1; i < K.length; i++) if (t <= K[i][0]) { const u = (t - K[i - 1][0]) / (K[i][0] - K[i - 1][0]); const s = u * u * (3 - 2 * u); return K[i - 1][1] + (K[i][1] - K[i - 1][1]) * s; }
    return K[K.length - 1][1];
  };
}

// Deformed sphere. fn(p) receives the unit direction in p and moves it into place.
function blob(su, sv, fn) {
  const P = [], I = [], p = new V3();
  const push = () => { fn(p); P.push(p.x, p.y, p.z); };
  p.set(0, 1, 0); push();
  for (let j = 1; j < sv; j++) {
    const ph = (j / sv) * Math.PI;
    for (let i = 0; i < su; i++) { const th = (i / su) * Math.PI * 2; p.set(Math.sin(ph) * Math.sin(th), Math.cos(ph), Math.sin(ph) * Math.cos(th)); push(); }
  }
  p.set(0, -1, 0); push();
  const last = P.length / 3 - 1;
  for (let i = 0; i < su; i++) I.push(0, 1 + i, 1 + (i + 1) % su);
  for (let j = 0; j < sv - 2; j++) for (let i = 0; i < su; i++) {
    const a = 1 + j * su + i, b = 1 + j * su + (i + 1) % su, c = a + su, d = b + su;
    I.push(a, c, b, b, c, d);
  }
  const lr = 1 + (sv - 2) * su;
  for (let i = 0; i < su; i++) I.push(last, lr + (i + 1) % su, lr + i);
  return finish(P, I);
}

// Rounded box (same trick as three's RoundedBoxGeometry).
function rbox(w, h, d, r, s = 2) {
  const seg = s * 2 + 1, g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
  const pos = g.attributes.position, nor = g.attributes.normal, half = 0.5 / seg, bx = new V3(w / 2 - r, h / 2 - r, d / 2 - r), p = new V3(), n = new V3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i); n.copy(p);
    n.x -= Math.sign(n.x) * half; n.y -= Math.sign(n.y) * half; n.z -= Math.sign(n.z) * half; n.normalize();
    pos.setXYZ(i, bx.x * Math.sign(p.x) + n.x * r, bx.y * Math.sign(p.y) + n.y * r, bx.z * Math.sign(p.z) + n.z * r);
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  return g;
}

// Lathe around +Y with analytic normals and a duplicated seam (so printed labels wrap).
// prof: list of runs; each run is a list of [r, y]. Runs meet at hard edges.
// Order each run bottom-centre -> out -> up -> top-centre for outward faces.
function lathe(prof, seg = 24, o = {}) {
  const P = [], N = [], UV = [], I = [];
  const runs = typeof prof[0][0] === 'number' ? [prof] : prof;
  const y0 = o.y0 ?? Math.min(...runs.flat().map((q) => q[1])), y1 = o.y1 ?? Math.max(...runs.flat().map((q) => q[1]));
  const ph0 = o.phi0 || 0, phl = o.phiLen || Math.PI * 2;
  for (const run of runs) {
    const base = P.length / 3, m = run.length;
    for (let i = 0; i < m; i++) {
      const a = run[Math.max(0, i - 1)], b = run[Math.min(m - 1, i + 1)];
      let nr = b[1] - a[1], ny = -(b[0] - a[0]); const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
      for (let j = 0; j <= seg; j++) {
        const ph = ph0 + (j / seg) * phl, s = Math.sin(ph), c = Math.cos(ph);
        P.push(run[i][0] * s, run[i][1], run[i][0] * c); N.push(nr * s, ny, nr * c);
        UV.push(j / seg, (run[i][1] - y0) / (y1 - y0 || 1));
      }
    }
    for (let i = 0; i < m - 1; i++) for (let j = 0; j < seg; j++) {
      const a = base + i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
      I.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I);
  return g;
}

// Flat-shaded triangles (paper, facets). tris: [[a, b, c], ...] with points [x, y, z]
function facets(tris, uvf) {
  const P = [], UV = [];
  for (const t of tris) for (const q of t) { P.push(...q); if (uvf) UV.push(...uvf(q)); else UV.push(0.5, 0.5); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.computeVertexNormals();
  return g;
}

// Extruded 2D outline (in x/y), depth along z, centred on z = 0.
function extrude(pts, depth, bevel = 0.002, curve = 6) {
  const s = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ExtrudeGeometry(s, { depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: curve });
  g.translate(0, 0, -(depth - bevel * 2) / 2);
  return g;
}

// ======================================================================
// Kit: merges parts with surface attributes and (optionally) skin weights
// ======================================================================
const _col = new THREE.Color();
const lin = (hex) => { _col.set(hex); return [_col.r, _col.g, _col.b]; };
let WHITE_UV = null;

class Kit {
  constructor(bones) {
    this.P = []; this.N = []; this.U = []; this.C = []; this.S = []; this.I = [];
    this.bones = bones || null; this.SI = []; this.SW = [];
    if (bones) { this.bi = new Map(bones.map((b, i) => [b.name, i])); }
    if (!WHITE_UV) WHITE_UV = atlasUV('white');
  }
  // s: { c: hex, gr: grime, g: gloss, sh: sheen, ss: subsurface, e: emissive, uv: atlas region name,
  //      uvf(p, n, u, v) -> [u, v] in region, paint(p, n, col4, srf4), b: bone name or [names] }
  add(gm, s = {}, m = null) {
    const pos = gm.attributes.position, nor = gm.attributes.normal, uv = gm.attributes.uv;
    const base = this.P.length / 3;
    const col = lin(s.c ?? 0xffffff), reg = s.uv ? atlasUV(s.uv) : WHITE_UV;
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const p = new V3(), n = new V3(), C = [0, 0, 0, 0], R = [0, 0, 0, 0];
    const cand = this.bones ? (Array.isArray(s.b) ? s.b : [s.b || this.bones[0].name]).map((k) => { const i = this.bi.get(k); if (i === undefined) throw new Error('bone ' + k); return i; }) : null;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i); n.fromBufferAttribute(nor, i);
      if (m) { p.applyMatrix4(m); n.applyMatrix3(nm).normalize(); }
      this.P.push(p.x, p.y, p.z); this.N.push(n.x, n.y, n.z);
      let u = 0.5, v = 0.5;
      if (s.uvf) [u, v] = s.uvf(p, n, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      else if (s.uv && uv) { u = uv.getX(i); v = uv.getY(i); }
      u = clamp(u, 0.002, 0.998); v = clamp(v, 0.002, 0.998);
      this.U.push(reg[0] + (reg[2] - reg[0]) * u, reg[1] + (reg[3] - reg[1]) * v);
      C[0] = col[0]; C[1] = col[1]; C[2] = col[2]; C[3] = s.gr ?? 0.35;
      R[0] = s.g ?? 0.3; R[1] = s.sh ?? 0; R[2] = s.ss ?? 0; R[3] = s.e ?? 0;
      if (s.paint) s.paint(p, n, C, R, i);
      this.C.push(C[0], C[1], C[2], C[3]); this.S.push(R[0], R[1], R[2], R[3]);
      if (cand && s.bw) { const W = s.bw(p); for (let k = 0; k < 4; k++) { this.SI.push(W[k] ? this.bi.get(W[k][0]) : 0); this.SW.push(W[k] ? W[k][1] : 0); } }
      else if (cand) this._skin(p, cand);
    }
    if (gm.index) { const a = gm.index.array; for (let i = 0; i < a.length; i++) this.I.push(base + a[i]); }
    else for (let i = 0; i < pos.count; i++) this.I.push(base + i);
    return this;
  }
  _skin(p, cand) {
    if (cand.length === 1) { this.SI.push(cand[0], 0, 0, 0); this.SW.push(1, 0, 0, 0); return; }
    const W = [];
    for (const bi of cand) {
      const b = this.bones[bi], ab = b._ab, ap = p.clone().sub(b._a);
      const t = clamp(ap.dot(ab) / (ab.lengthSq() || 1), 0, 1);
      const d = ap.addScaledVector(ab, -t).length() / (b.r || 1);
      W.push([bi, 1 / (d * d * d * d + 1e-7)]);
    }
    W.sort((x, y) => y[1] - x[1]);
    const k = W.slice(0, 4); let sum = 0; for (const w of k) sum += w[1];
    for (let i = 0; i < 4; i++) { this.SI.push(k[i] ? k[i][0] : 0); this.SW.push(k[i] ? k[i][1] / sum : 0); }
  }
  build() {
    const g = new THREE.BufferGeometry(), n = this.P.length / 3;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.C, 4));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.S, 4));
    if (this.bones) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.SI, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.SW, 4));
    }
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

// skeleton spec: [name, parent, head [x,y,z], tail [x,y,z], influence radius scale]
function boneSpec(list) {
  return list.map(([name, parent, a, b, r]) => ({ name, parent, a: new V3(...a), b: new V3(...b), r: r || 1, _a: new V3(...a), _ab: new V3(...b).sub(new V3(...a)) }));
}
function skinned(geom, spec, mat, sphere) {
  const bones = [], by = {};
  for (const s of spec) {
    const b = new THREE.Bone(); b.name = s.name; by[s.name] = b; bones.push(b);
    const par = s.parent ? spec.find((q) => q.name === s.parent) : null;
    b.position.copy(s.a); if (par) { b.position.sub(par.a); by[s.parent].add(b); }
  }
  const mesh = new THREE.SkinnedMesh(geom, mat);
  mesh.add(bones[0]); mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.boundingSphere = new THREE.Sphere(new V3(...sphere[0]), sphere[1]);
  for (const b of bones) b.userData.rest = b.position.clone();
  return { mesh, by };
}
const meshOf = (g, mat) => { const m = new THREE.Mesh(g, mat); return m; };

// ======================================================================
// materials
// ======================================================================
export function makeMats(mats, tex) {
  const o = mats.obj, atlas = propAtlas(), detail = objectDetailTexture();
  const V = (opt) => o(0xffffff, { vtx: true, atlas, detail, gloss: 1, ...opt });
  return {
    obj: o, detail, // factory kept for the model pack materials (built when the pack arrives)
    pvc: V({ bump: 0.0007, detScale: 4.5, sheen: 1 }),
    skin: V({ bump: 0.0008, detScale: 6, sheen: 1, sss: 1, sssCol: 0xff6040 }),
    hard: V({ bump: 0.00025, detScale: 9, sheen: 1 }),
    dark: V({ bump: 0.0008, detScale: 5, sheen: 1, sss: 1, sssCol: 0x803020 }),
    glass: o(0xb4c2b8, { gloss: 2.4, alpha: 0.2, sheen: 1.6, depthWrite: false, detail, transparent: true }),
    // flat colour materials (kept for anything that still wants them)
    rubber: o(0x0c0c0b, { gloss: 0.4, detail }), metal: o(0x6b6b66, { gloss: 1.3, detail }), plastic: o(0x1b1b1a, { gloss: 0.7, detail }),
    eye: o(0x000000, { emis: 0xfff2c0, emisScale: 2.2, detail }),
    marks: mats.decal(tex.marks), marksFaint: mats.decal(tex.marks, { alpha: 0 }),
    signs: mats.decal(tex.signs, { alpha: 0.82 }),
    exitSign: mats.decal(tex.exit, { lit: 0, tintScale: 3.2 }),
    glow: (c, s) => mats.decal(tex.exit, { lit: 0, tint: c, tintScale: s }),
  };
}

// ======================================================================
// Hazmat suit: other players, and the Hollow (the same suit with nobody in it)
// ======================================================================
const SUIT_B = boneSpec([
  ['hips', null, [0, 0.95, 0], [0, 1.1, 0], 1.25],
  ['spine', 'hips', [0, 1.1, 0], [0, 1.27, 0], 1.25],
  ['chest', 'spine', [0, 1.27, 0], [0, 1.44, 0], 1.25],
  ['neck', 'chest', [0, 1.44, 0], [0, 1.54, 0], 1],
  ['head', 'neck', [0, 1.54, 0], [0, 1.78, 0], 1.1],
  ['armL', 'chest', [-0.215, 1.39, 0], [-0.25, 1.13, 0.012], 0.9],
  ['foreL', 'armL', [-0.25, 1.13, 0.012], [-0.277, 0.89, 0], 0.9],
  ['handL', 'foreL', [-0.277, 0.89, 0], [-0.285, 0.7, 0], 0.9],
  ['armR', 'chest', [0.215, 1.39, 0], [0.25, 1.13, 0.012], 0.9],
  ['foreR', 'armR', [0.25, 1.13, 0.012], [0.277, 0.89, 0], 0.9],
  ['handR', 'foreR', [0.277, 0.89, 0], [0.285, 0.7, 0], 0.9],
  ['thighL', 'hips', [-0.1, 0.92, 0], [-0.105, 0.5, -0.006], 1],
  ['shinL', 'thighL', [-0.105, 0.5, -0.006], [-0.11, 0.09, 0], 1],
  ['footL', 'shinL', [-0.11, 0.09, 0], [-0.11, 0.03, -0.15], 0.8],
  ['thighR', 'hips', [0.1, 0.92, 0], [0.105, 0.5, -0.006], 1],
  ['shinR', 'thighR', [0.105, 0.5, -0.006], [0.11, 0.09, 0], 1],
  ['footR', 'shinR', [0.11, 0.09, 0], [0.11, 0.03, -0.15], 0.8],
]);
const TORSO_RX = keys([[0.8, 0.165], [0.88, 0.19], [0.98, 0.2], [1.08, 0.196], [1.2, 0.2], [1.3, 0.214], [1.38, 0.214], [1.44, 0.172], [1.5, 0.1]]);
const TORSO_RZ = keys([[0.8, 0.12], [0.88, 0.14], [0.98, 0.15], [1.08, 0.155], [1.2, 0.15], [1.3, 0.145], [1.38, 0.13], [1.44, 0.11], [1.5, 0.085]]);
// distance of the torso surface from the spine in front (z < 0) at x, y
function torsoZ(x, y) { const rx = TORSO_RX(y), rz = TORSO_RZ(y); return rz * Math.pow(Math.max(0.02, 1 - Math.pow(Math.abs(x) / rx, 2.4)), 1 / 2.4); }

function suitFold(p, amp) {
  // hanging folds run mostly vertically; the noise is stretched along y and bent a little
  const bend = fbm3(p.x * 3, p.y * 2, p.z * 3) * 2.5;
  const v = fbm3(p.x * 16 + bend, p.y * 2.6, p.z * 16 - bend) - 0.5;
  const l = fbm3(p.x * 5 + 9, p.y * 5, p.z * 5) - 0.5;
  return amp * (v * 1.5 + l * 0.8);
}

function suitGeo(hollow) {
  const kit = new Kit(SUIT_B);
  const R = mrand(hollow ? 77 : 11);
  const FAB = hollow ? 0x9a8642 : 0xd49c12, TAPE = 0x4c4c48, RUB = 0x121311, BLK = 0x0b0b0a;
  const fabAmp = hollow ? 0.024 : 0.011;
  // PVC fabric paint: folds darken, hollow suits carry stains and a waterline
  const fabric = (extra) => ({
    c: FAB, g: hollow ? 0.45 : 0.9, sh: hollow ? 0.25 : 0.7, gr: hollow ? 0.85 : 0.4,
    paint: (p, n, C, S) => {
      const f = suitFold(p, 1);
      const ao = clamp(0.82 + f * 1.1, 0.45, 1.08);
      C[0] *= ao; C[1] *= ao; C[2] *= ao;
      if (hollow) {
        const st = fbm3(p.x * 9, p.y * 1.2, p.z * 9);
        const streak = sstep(0.55, 0.75, st) * sstep(0.6, 1.4, p.y);
        const wet = sstep(0.42, 0.2, p.y + (fbm3(p.x * 5, 0, p.z * 5) - 0.5) * 0.1);
        const k = 1 - 0.55 * Math.max(streak, wet * 0.8);
        C[0] *= k; C[1] *= k * 0.95; C[2] *= k * 0.8; C[3] = 0.9;
      }
      if (extra) extra(p, n, C, S);
    },
  });

  // ---- torso (coverall) with the taped storm flap down the front ----
  const torso = tube([[0, 0.8, 0.005], [0, 1.15, 0.0], [0, 1.5, 0.0]], (t, a) => {
    const y = 0.8 + t * 0.7, front = Math.max(0, Math.cos(a));
    let rx = TORSO_RX(y), rz = TORSO_RZ(y) * (1 + 0.06 * front * gauss(y - 1.04, 0.09));
    if (hollow) { rz *= 1 - 0.3 * front * gauss(y - 1.27, 0.13); rx *= 1 - 0.1 * gauss(y - 1.36, 0.08); }
    return sell(a, rx, rz, 2.4);
  }, {
    n: 30, seg: 22, cap0: 0.04, cap1: 0.03,
    disp: (p, t, a, dir) => {
      const y = p.y;
      const flap = p.z < 0 ? sstep(0.07, 0.03, Math.abs(p.x)) : 0; // keep the front seam smooth under the flap
      p.addScaledVector(dir, suitFold(p, fabAmp) * sstep(0.8, 0.86, y) * sstep(1.52, 1.4, y) * (1 - flap));
      if (hollow) p.y -= 0.035 * gauss(y - 1.42, 0.06) * Math.abs(Math.sin(a)); // shoulders sag
    },
  });
  kit.add(torso, { ...fabric(), b: ['hips', 'spine', 'chest', 'thighL', 'thighR', 'armL', 'armR', 'neck'] });
  // storm flap: a taped strip of real geometry down the front
  const flapPts = [];
  for (let y = 0.87; y <= 1.461; y += 0.0295) flapPts.push([0, y, -(torsoZ(0, y) * (1 + 0.06 * gauss(y - 1.04, 0.09)) + 0.004)]);
  kit.add(tube(flapPts, (t, a) => sell(a, 0.025, 0.0045, 4), { n: 21, seg: 8, up: [0, 0, 1], cap0: 0.002, cap1: 0.002 }),
    { c: TAPE, g: 1.1, sh: 0.5, gr: 0.6, b: ['hips', 'spine', 'chest'], paint: (p, n, C) => { const k = 0.85 + 0.25 * vn3(p.x * 200, p.y * 60, 0); C[0] *= k; C[1] *= k; C[2] *= k; } });

  // ---- hood: baggy, cinched round the mask ----
  const hood = tube([[0, 1.4, 0.012], [0, 1.6, 0.0], [0, 1.79, 0.018]], (t, a) => {
    let rx = keys([[0, 0.178], [0.15, 0.166], [0.35, 0.158], [0.62, 0.168], [0.84, 0.15], [1, 0.1]])(t);
    let rz = keys([[0, 0.156], [0.15, 0.15], [0.35, 0.158], [0.62, 0.17], [0.84, 0.15], [1, 0.1]])(t);
    if (hollow) { rx *= 0.86; rz *= 0.9; const cave = sstep(0.45, 1, t) * Math.max(0, Math.sin(a)) * 0.3; rx *= 1 - cave; rz *= 1 - cave * 0.6; }
    return sell(a, rx, rz, 2.2) * (1 + 0.025 * Math.sin(a * 11) * gauss(t - 0.12, 0.08));
  }, { n: 20, seg: 20, cap0: false, cap1: 0.05, disp: (p, t, a, dir) => { p.addScaledVector(dir, suitFold(p, fabAmp * 0.8)); if (hollow) { p.x += 0.03 * sstep(0.4, 1, t); p.y -= 0.04 * sstep(0.5, 1, t) * (0.5 + 0.5 * Math.sin(a)); } } });
  kit.add(hood, { ...fabric(), b: ['chest', 'neck', 'head'] });

  // ---- full-face respirator ----
  const mz = -0.1, my = 1.585;
  const face = blob(18, 12, (p) => { const lo = Math.max(0, -p.y); p.set(p.x * 0.1 * (1 - 0.28 * lo), p.y * 0.125, p.z * 0.09 * (1 + 0.15 * lo)); p.y += my; p.z += mz; });
  kit.add(face, { c: RUB, g: 0.8, sh: 0.6, gr: 0.3, b: 'head' });
  // tape round the mask edge where it meets the hood
  kit.add(new THREE.TorusGeometry(1, 0.09, 6, 28), { c: TAPE, g: 0.8, sh: 0.3, gr: 0.6, b: 'head', paint: (p, n, C) => { const k = 0.8 + 0.3 * h3(Math.floor(Math.atan2(p.y - my, p.x) * 6), 1, 2); C[0] *= k; C[1] *= k; C[2] *= k; } }, T(0, my - 0.004, mz - 0.03, 0.1, 0, 0, 0.096, 0.12, 0.08));
  // curved panoramic lens (the Hollow's is broken through, with nothing behind it)
  const lc = [0, 1.632, -0.075], lr = 0.125, th = 0.72, ly0 = 1.588, ly1 = 1.676;
  {
    const P = [], I = [], nu = 22, nv = 6, skip = (i, j) => {
      if (!hollow) return false;
      const uu = (i + 0.5) / nu, vv = (j + 0.5) / nv, d = Math.hypot((uu - 0.66) * 2.4, (vv - 0.55) * 1.0);
      return d < 0.28 + 0.18 * h3(i, j, 5);
    };
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const a = Math.PI - th + (i / nu) * th * 2, y = ly0 + (j / nv) * (ly1 - ly0), bulge = 0.006 * Math.sin((j / nv) * Math.PI);
      P.push(lc[0] + Math.sin(a) * (lr + bulge), y, lc[2] + Math.cos(a) * (lr + bulge));
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { if (skip(i, j)) continue; const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; I.push(a, b, c, b, d, c); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals();
    // make sure the lens faces out
    const nn = g.attributes.normal; if (nn.getZ(Math.floor(nn.count / 2)) > 0) { for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } g.setIndex(I); g.computeVertexNormals(); }
    kit.add(g, { c: 0x050607, g: 2.2, sh: 1.6, gr: hollow ? 0.6 : 0.12, b: 'head', paint: (p, n, C) => {
      if (!hollow) return;
      const a = Math.atan2(p.x - lc[0], -(p.z - lc[2])), k = Math.abs(Math.sin(a * 37 + p.y * 300)) < 0.06 ? 7 : 1; C[0] *= k; C[1] *= k; C[2] *= k;
    } });
    // rubber rim round the lens
    const arc = (y) => { const pts = []; for (let k = 0; k <= 8; k++) { const a = Math.PI - th - 0.04 + (k / 8) * (th + 0.04) * 2; pts.push([lc[0] + Math.sin(a) * (lr + 0.004), y, lc[2] + Math.cos(a) * (lr + 0.004)]); } return pts; };
    const rimS = { c: 0x1a1a18, g: 0.7, sh: 0.4, gr: 0.3, b: 'head' };
    kit.add(tube(arc(ly1 + 0.006), () => 0.0085, { n: 20, seg: 6 }), rimS);
    kit.add(tube(arc(ly0 - 0.006), () => 0.0085, { n: 20, seg: 6 }), rimS);
    for (const s of [-1, 1]) { const a = Math.PI + s * (th + 0.04); kit.add(tube([[Math.sin(a) * (lr + 0.004), ly0 - 0.008, lc[2] + Math.cos(a) * (lr + 0.004)], [Math.sin(a) * (lr + 0.004), ly1 + 0.008, lc[2] + Math.cos(a) * (lr + 0.004)]], () => 0.009, { n: 4, seg: 6 }), rimS); }
    if (hollow) kit.add(blob(10, 8, (p) => { p.set(p.x * 0.085, p.y * 0.05, p.z * 0.03); p.x += 0; p.y += 1.632; p.z += -0.185; }), { c: 0x000000, g: 0, sh: 0, gr: 0, b: 'head' });
  }
  // twin filter cartridges + exhale valve
  const filt = [[0, 0], [0.03, 0], [0.031, 0.006], [0.043, 0.008], [0.045, 0.012], [0.045, 0.03], [0.041, 0.034], [0.034, 0.034], [0.032, 0.031], [0.027, 0.034], [0.022, 0.031], [0.017, 0.034], [0.011, 0.031], [0, 0.032]];
  for (const sx of [-1, 1]) {
    if (hollow && sx > 0) { kit.add(lathe([[0, 0], [0.03, 0], [0.031, 0.01], [0.024, 0.012], [0, 0.008]], 14), { c: 0x202020, g: 0.8, sh: 0.3, b: 'head' }, TY(sx * 0.074, 1.535, -0.162, [sx * 0.55, -0.3, -0.78])); continue; }
    kit.add(lathe(filt, 14), {
      c: 0x2a2a28, g: 0.9, sh: 0.5, gr: 0.35, b: 'head', uv: 'filter',
      uvf: (p, n, u, v) => [u, (v - 0.25) / 0.6],
      paint: (p, n, C, S) => { },
    }, TY(sx * 0.074, 1.535, -0.162, [sx * 0.55, -0.3, -0.78]));
  }
  kit.add(lathe([[0, 0], [0.025, 0], [0.025, 0.022], [0.019, 0.03], [0, 0.031]], 16), {
    c: 0x1c1c1a, g: 0.8, sh: 0.4, b: 'head',
    paint: (p, n, C) => { if (Math.abs(Math.sin((p.x) * 420)) < 0.35 && p.z < -0.19) { C[0] *= 0.25; C[1] *= 0.25; C[2] *= 0.25; } },
  }, TY(0, 1.507, -0.17, [0, -0.45, -0.9]));

  // ---- arms: baggy sleeves, folds at the elbow, taped to thick rubber gloves ----
  for (const sx of [-1, 1]) {
    const side = sx < 0 ? 'L' : 'R', drop = hollow ? 0.07 : 0;
    const sl = tube([[sx * 0.13, 1.4, 0], [sx * 0.22, 1.38, 0], [sx * 0.25, 1.13, 0.012], [sx * 0.277, 0.9 - drop, 0]], (t, a) => {
      const r = keys([[0, 0.085], [0.15, 0.079], [0.6, 0.067], [1, 0.058]])(t) * (1 + 0.075 * Math.sin(t * 95) * gauss(t - 0.6, 0.09));
      return hollow ? sell(a, r * 1.05, r * 0.62) : r;
    }, { n: 20, seg: 12, cap0: 0.04, cap1: 0.01, disp: (p, t, a, dir) => p.addScaledVector(dir, suitFold(p, fabAmp * 0.7) * (1 - sstep(0.82, 0.95, t))) });
    kit.add(sl, { ...fabric(), b: ['chest', 'arm' + side, 'fore' + side, 'hand' + side] });
    // two turns of tape at the wrist, slightly skewed
    for (let k = 0; k < 2; k++) kit.add(tube([[sx * 0.271, 0.94 - drop + k * 0.012, 0.002], [sx * 0.278, 0.885 - drop + k * 0.012, 0]], () => 0.066 - k * 0.002, { n: 3, seg: 14, cap0: 0.005, cap1: 0.005 }),
      { c: TAPE, g: 1.1, sh: 0.5, gr: 0.55, b: ['fore' + side, 'hand' + side], paint: (p, n, C) => { const k2 = 0.85 + 0.25 * vn3(p.x * 300, p.y * 300, p.z * 300); C[0] *= k2; C[1] *= k2; C[2] *= k2; } }, about([sx * 0.275, 0.912 - drop, 0], 0.09 * (k ? -1 : 1), 0, 0));
    gloveInto(kit, sx, side, hollow, !hollow && sx > 0, drop);
  }

  // ---- legs: bunched over the boots, taped ----
  for (const sx of [-1, 1]) {
    const side = sx < 0 ? 'L' : 'R';
    const lg = tube([[sx * 0.09, 1.0, 0], [sx * 0.1, 0.9, 0], [sx * 0.105, 0.52, -0.012], [sx * 0.11, 0.3, 0]], (t, a) => {
      const r = keys([[0, 0.1], [0.2, 0.1], [0.55, 0.088], [1, 0.074]])(t) * (hollow ? 0.88 : 1);
      return r * (1 + 0.06 * Math.sin(t * 110) * gauss(t - 0.55, 0.08) + 0.07 * Math.sin(t * 140) * sstep(0.8, 1, t));
    }, { n: 20, seg: 12, cap0: 0.03, cap1: 0.01, disp: (p, t, a, dir) => p.addScaledVector(dir, suitFold(p, fabAmp) * (1 - sstep(0.8, 0.93, t))) });
    kit.add(lg, { ...fabric(), b: ['hips', 'thigh' + side, 'shin' + side] });
    kit.add(tube([[sx * 0.11, 0.285, 0.001], [sx * 0.11, 0.35, 0]], () => 0.087, { n: 3, seg: 14, cap0: 0.005, cap1: 0.005 }), { c: TAPE, g: 1.1, sh: 0.5, gr: 0.6, b: ['shin' + side] }, about([sx * 0.11, 0.317, 0], 0.07, 0, sx * 0.05));
    // rubber boot
    kit.add(tube([[sx * 0.11, 0.07, 0.006], [sx * 0.11, 0.34, 0]], (t) => keys([[0, 0.064], [0.8, 0.068], [1, 0.071]])(t), { n: 6, seg: 12, cap0: false, cap1: 0.01 }), { c: RUB, g: 1.1, sh: 0.8, gr: 0.5, b: ['shin' + side, 'foot' + side] });
    kit.add(blob(14, 10, (p) => { const fr = Math.max(0, -p.z); p.set(p.x * 0.058 * (1 + 0.12 * fr), Math.max(p.y, -0.62) * 0.058, p.z * 0.142); p.x += sx * 0.11; p.y += 0.062; p.z -= 0.045; }), { c: RUB, g: 1.1, sh: 0.8, gr: 0.55, b: 'foot' + side });
    kit.add(rbox(0.11, 0.026, 0.278, 0.012, 1), { c: 0x1c1a16, g: 0.4, sh: 0.1, gr: 0.8, b: 'foot' + side, paint: (p, n, C) => { if (n.y < -0.5 || Math.abs(Math.sin(p.z * 160)) < 0.3) { C[0] *= 0.6; C[1] *= 0.6; C[2] *= 0.6; } } }, T(sx * 0.11, 0.015, -0.046));
  }

  // ---- breathing apparatus (players only): bottle, backplate, harness, hose, gauge ----
  if (!hollow) {
    const tz = 0.252, ty = 1.16;
    const prof = [[0, -0.29], [0.03, -0.286], [0.054, -0.272], [0.067, -0.252], [0.072, -0.222], [0.072, 0.222], [0.067, 0.252], [0.054, 0.272], [0.03, 0.286], [0, 0.29]];
    kit.add(lathe(prof, 22), { c: 0x8c9087, g: 1.3, sh: 0.6, gr: 0.45, b: ['chest', 'spine'] }, T(0, ty, tz));
    kit.add(lathe([[0.0735, -0.03], [0.0735, 0.035]], 14, { phi0: Math.PI * 0.55, phiLen: Math.PI * 0.9 }), { c: 0xffffff, g: 0.9, sh: 0.3, gr: 0.5, uv: 'tank', uvf: (p, n, u, v) => [u, v], b: ['chest', 'spine'] }, T(0, ty + 0.05, tz));
    kit.add(lathe([[0, 0], [0.022, 0], [0.022, 0.05], [0.014, 0.06], [0.014, 0.08], [0, 0.08]], 12), { c: 0x9a9a92, g: 1.6, sh: 0.8, gr: 0.3, b: 'spine' }, T(0, ty - 0.37, tz, Math.PI));
    kit.add(new THREE.TorusGeometry(0.024, 0.006, 6, 16), { c: 0x1b1b19, g: 0.6, b: 'spine' }, T(0.04, ty - 0.33, tz, 0, Math.PI / 2, 0));
    kit.add(rbox(0.25, 0.52, 0.026, 0.01, 2), { c: 0x141412, g: 0.6, sh: 0.3, gr: 0.5, b: ['spine', 'chest'] }, T(0, 1.15, 0.168));
    for (const sx of [-1, 1]) {
      const pts = [[sx * 0.08, 1.37, 0.18], [sx * 0.105, 1.445, 0.13], [sx * 0.12, 1.478, 0.0]];
      for (const y of [1.36, 1.25, 1.12, 0.99]) pts.push([sx * (0.11 + (1.36 - y) * 0.06), y, -torsoZ(0.11, y) - 0.016]);
      kit.add(tube(pts, (t, a) => sell(a, 0.026, 0.006, 4), { n: 26, seg: 8, up: [0, 0, 1], cap0: 0.003, cap1: 0.003 }), { c: 0x16161a, g: 0.5, sh: 0.2, gr: 0.6, b: ['spine', 'chest', 'neck'], paint: (p, n, C) => { const k = 0.8 + 0.4 * Math.abs(Math.sin(p.y * 900)); C[0] *= k; C[1] *= k; C[2] *= k; } });
    }
    // waist belt and buckle
    kit.add(tube([[0, 0.965, 0], [0, 1.012, 0]], (t, a) => sell(a, TORSO_RX(0.99) + 0.016, TORSO_RZ(0.99) * 1.06 + 0.016, 2.4), { n: 3, seg: 30, cap0: 0, cap1: 0 }), { c: 0x16161a, g: 0.5, sh: 0.2, gr: 0.6, b: ['hips', 'spine'] });
    kit.add(rbox(0.06, 0.05, 0.014, 0.004, 1), { c: 0x6e6e68, g: 1.6, sh: 0.8, b: 'hips' }, T(0, 0.99, -TORSO_RZ(0.99) * 1.06 - 0.022));
    // pressure gauge on the left strap
    const gz = -torsoZ(0.12, 1.22) - 0.03;
    kit.add(lathe([[0, 0], [0.023, 0], [0.025, 0.004], [0.025, 0.014], [0, 0.016]], 16), { c: 0x1b1b19, g: 1, sh: 0.6, b: 'chest', uv: 'dial', uvf: (p, n, u, v) => (n.z < -0.6 ? [0.15 + (-(p.x + 0.12) / 0.05 + 0.5) * 0.3 * 0.9, 0.5 + ((p.y - 1.22) / 0.05) * 0.9] : [0.97, 0.97]), paint: (p, n, C) => { if (n.z < -0.6) { C[0] = 1; C[1] = 1; C[2] = 1; } } }, TY(-0.122, 1.22, gz, [0, 0, -1]));
    // corrugated hose from the bottle valve, round the right side, up to the mask
    kit.add(tube([[0.05, ty - 0.37, tz - 0.01], [0.17, 0.86, 0.17], [0.22, 1.0, 0.0], [0.19, 1.2, -0.14], [0.12, 1.4, -0.18], [0.035, 1.495, -0.185]], (t) => 0.016 * (1 + 0.14 * Math.sin(t * 138)), { n: 66, seg: 7, up: [1, 0, 0] }),
      { c: 0x111110, g: 0.9, sh: 0.5, gr: 0.4, b: ['head', 'chest', 'spine', 'hips'] });
    // chest patch
    kit.add(rbox(0.1, 0.038, 0.004, 0.0015, 1), { c: 0xffffff, g: 0.5, gr: 0.5, uv: 'badge', b: 'chest' }, T(-0.1, 1.32, -torsoZ(0.1, 1.32) - 0.006, 0.12, 0.32, 0));
  } else {
    // the Hollow: the hose torn off and hanging from the mask
    kit.add(tube([[0.03, 1.5, -0.19], [0.07, 1.38, -0.2], [0.06, 1.2, -0.19], [0.09, 1.05, -0.2]], (t) => 0.016 * (1 + 0.14 * Math.sin(t * 88)) * (t > 0.95 ? 0.85 : 1), { n: 42, seg: 7, up: [1, 0, 0], cap1: 0.002 }),
      { c: 0x111110, g: 0.8, sh: 0.4, gr: 0.7, b: ['head', 'chest', 'spine'] });
  }
  return kit.build();
}

// thick rubber glove: cuff, palm, four fingers and a thumb (curled round a torch on the light hand)
function gloveInto(kit, sx, side, limp, torch, drop) {
  const GL = 0x161a13, b = 'hand' + side, y0 = -drop;
  const gs = { c: GL, g: 1.2, sh: 0.85, gr: 0.4, b };
  kit.add(tube([[sx * 0.277, 0.93 + y0, 0], [sx * 0.282, 0.845 + y0, 0]], (t) => mix(0.054, 0.046, t), { n: 5, seg: 14, cap0: 0.01, cap1: 0.02 }), { ...gs, b: ['fore' + side, b] });
  kit.add(rbox(0.036, 0.095, limp ? 0.075 : 0.082, 0.015, 2), gs, T(sx * 0.284, 0.8 + y0, -0.004, 0, 0, sx * 0.05, 1, 1, 1));
  const fz = [-0.029, -0.01, 0.009, 0.027], fl = [0.068, 0.075, 0.071, 0.058];
  for (let k = 0; k < 4; k++) {
    const z = fz[k], L = fl[k], top = 0.758 + y0;
    let pts;
    if (limp) pts = [[sx * 0.285, top, z], [sx * 0.287, top - L * 0.5, z - 0.003], [sx * 0.287, top - L, z - 0.004]];
    else if (torch) pts = [[sx * 0.286, top + 0.004, z], [sx * 0.27, top - 0.03, z - 0.012], [sx * 0.25, top - 0.04, z - 0.004]];
    else pts = [[sx * 0.285, top, z], [sx * 0.278, top - L * 0.55, z - 0.006], [sx * 0.262, top - L * 0.92, z - 0.009]];
    kit.add(tube(pts, (t, a) => { const r = mix(0.0118, 0.0098, t) * (1 + 0.06 * Math.sin(t * 40)); return limp ? sell(a, r, r * 0.6) : r; }, { n: 6, seg: 6, cap0: 0.004, cap1: 0.008, up: [sx, 0, 0] }), gs);
  }
  const tp = limp ? [[sx * 0.278, 0.81 + y0, -0.04], [sx * 0.28, 0.77 + y0, -0.05], [sx * 0.282, 0.735 + y0, -0.052]]
    : torch ? [[sx * 0.275, 0.805 + y0, -0.038], [sx * 0.262, 0.778 + y0, -0.05], [sx * 0.25, 0.765 + y0, -0.038]]
      : [[sx * 0.276, 0.805 + y0, -0.038], [sx * 0.268, 0.77 + y0, -0.055], [sx * 0.262, 0.745 + y0, -0.05]];
  kit.add(tube(tp, (t) => mix(0.0135, 0.0105, t), { n: 5, seg: 6, cap0: 0.004, cap1: 0.008 }), gs);
  if (torch) {
    kit.add(lathe([[0, 0], [0.016, 0], [0.017, 0.004], [0.017, 0.11], [0.022, 0.13], [0.024, 0.16], [0.024, 0.172], [0.02, 0.175], [0, 0.175]], 14),
      { c: 0x1d1d1c, g: 1.4, sh: 0.8, gr: 0.3, b, paint: (p, n, C, S) => { if (p.y < 0.66 + y0 && n.y < -0.7) { C[0] = 1; C[1] = 0.95; C[2] = 0.8; S[3] = 0.3; S[0] = 2; } else if (Math.abs(Math.sin(p.y * 500)) < 0.25 && p.y > 0.71) { C[0] *= 0.5; C[1] *= 0.5; C[2] *= 0.5; } } },
      TY(sx * 0.262, 0.83 + y0, -0.006, [0, -1, 0]));
  }
}

export function makeSuit(M, hollow) {
  const gm = geo(hollow ? 'suitH' : 'suit', () => suitGeo(hollow));
  const g = new THREE.Group();
  const { mesh, by } = skinned(gm, SUIT_B, M.pvc, [[0, 0.95, 0], 1.25]);
  g.add(mesh);
  const sp = new Float32Array(16);
  g.userData = { b: by, mesh, ph: Math.random() * 6, t: Math.random() * 10, seed: Math.random() * 10, wk: 0, cr: 0, hollow, sp, lx: NaN, lz: NaN, ly: 0 };
  animSuit(g, 1 / 60, 0, false, 0);
  if (hollow) for (let i = 0; i < 40; i++) animSuit(g, 1 / 60, 0, false, 0);
  whenPack(g, () => packSuit(g, M));
  return g;
}

function legIK(th, sh, ft, hz, hy, tz, ty, L1, L2, pitch) {
  const f = -(tz - hz), d = hy - ty;
  const D = clamp(Math.hypot(f, d), 0.08, L1 + L2 - 0.003);
  const k = Math.acos(clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1));
  const al = Math.acos(clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
  th.rotation.x = Math.atan2(f, d) + al; sh.rotation.x = -(Math.PI - k);
  ft.rotation.x = -(th.rotation.x + sh.rotation.x) + pitch;
}
// damped spring on slot i (value i, velocity i+1)
function spring(sp, i, target, k, c, dt) { sp[i + 1] += (k * (target - sp[i]) - c * sp[i + 1]) * dt; sp[i] += sp[i + 1] * dt; return sp[i]; }

export function animSuit(g, dt, speed, crouch, pitch) {
  if (g.userData.pk) { animPack(g, dt, speed, crouch, pitch); return; }
  const u = g.userData, b = u.b, sp = u.sp;
  dt = Math.min(dt, 0.05);
  const mv = speed > 0.15, H = u.hollow;
  u.t += dt;
  const om = 3 + speed * 2.4;
  if (mv) u.ph += dt * om;
  u.wk += ((mv ? Math.min(speed / 2.2, 1.4) : 0) - u.wk) * (1 - Math.exp(-5 * dt));
  u.cr += ((crouch ? 1 : 0) - u.cr) * (1 - Math.exp(-8 * dt));
  const w = u.wk, cr = u.cr, ph = u.ph, s = Math.sin(ph), c = Math.cos(ph), t = u.t;
  const A = Math.min(0.32, (speed * Math.PI) / (2 * om)) * Math.min(1, w * 1.6);
  const br = Math.sin(t * 1.7 + u.seed);
  // root sway: idle weight shift, walk side to side
  const sway = (1 - w) * Math.sin(t * 0.45 + u.seed) * 0.014 + c * 0.022 * w;
  // movement of the whole model drives the floppy parts (the Hollow's cloth lags)
  const px = g.position.x, pz = g.position.z;
  let acc = 0;
  if (u.lx === u.lx && dt > 0) { const v = Math.hypot(px - u.lx, pz - u.lz) / dt; acc = clamp((v - u.ly) / dt, -30, 30); u.ly = v; }
  u.lx = px; u.lz = pz;
  const hb = b.hips;
  let hy = 0.95 + 0.022 * w * Math.cos(2 * ph) - 0.006 - cr * 0.43 + br * 0.003;
  if (H) hy += 0.02 * w * Math.abs(Math.sin(ph)) + 0.015;
  hb.position.set(sway, hy, cr * 0.07);
  hb.rotation.set(0, s * 0.1 * w, -sway * 1.4);
  // legs: feet planted, lifted through the swing
  const lift = H ? 0.15 : 0.1, toe = H ? 0.45 : 0;
  const hj = hy - 0.03, hz = cr * 0.07;
  for (let k = 0; k < 2; k++) {
    const p2 = ph + k * Math.PI, ss = Math.sin(p2), cc = Math.cos(p2);
    const fz = -A * ss + cr * 0.02, fy = 0.09 + Math.max(0, cc) * lift * w;
    const th = k ? b.thighR : b.thighL, sh = k ? b.shinR : b.shinL, ft = k ? b.footR : b.footL;
    legIK(th, sh, ft, hz, hj, fz, H ? fy - 0.03 : fy, 0.42, 0.41, (H ? toe : -Math.max(0, cc) * 0.25 * w) + (H ? 0 : cr * 0.25));
    th.rotation.z = (k ? 1 : -1) * (0.02 + cr * 0.12) + sway * 1.4; th.rotation.y = H ? (k ? -0.25 : 0.2) : 0;
  }
  // spine, breathing, counter twist
  b.spine.rotation.set(-0.04 * w - cr * 0.32 + br * 0.008 + (H ? -0.16 : 0), -s * 0.08 * w, sway * 0.8);
  b.chest.rotation.set(-0.03 * w + br * 0.014 + (H ? -0.1 : 0), -s * 0.04 * w, sway * 0.4);
  b.chest.scale.set(1 + br * 0.006, 1, 1 + br * 0.01);
  if (H) {
    // limp arms and a head that lolls, all on springs
    const aL = spring(sp, 0, -s * 0.55 * w + 0.12, 26, 2.2, dt), aR = spring(sp, 2, s * 0.55 * w + 0.12, 22, 2.0, dt);
    const roll = spring(sp, 4, 0.36 + sway * 4 + acc * 0.004, 18, 1.6, dt), nod = spring(sp, 6, -0.26 - Math.abs(c) * 0.2 * w + acc * 0.01, 30, 2.4, dt);
    const fL = spring(sp, 8, 0.25 + Math.max(0, -s) * 0.5 * w, 30, 2.5, dt), fR = spring(sp, 10, 0.1 + Math.max(0, s) * 0.5 * w, 30, 2.5, dt);
    b.armL.rotation.set(aL, 0, -0.06); b.armR.rotation.set(aR, 0, 0.16);
    b.foreL.rotation.set(fL, 0, 0); b.foreR.rotation.set(fR, 0, 0);
    b.handL.rotation.set(0.2, 0, -0.1); b.handR.rotation.set(-0.1, 0, 0.2);
    b.neck.rotation.set(nod * 0.4, 0, roll * 0.55); b.head.rotation.set(nod, 0.15, roll * 0.6);
    b.armR.position.y = b.armR.userData.rest.y - 0.04; // one shoulder hangs lower
  } else {
    b.armL.rotation.set(-s * 0.42 * w + cr * 0.35 + 0.02, 0, -0.1 - cr * 0.1);
    b.foreL.rotation.set(0.18 + Math.max(0, -s) * 0.45 * w + cr * 0.3, 0, 0);
    b.handL.rotation.set(0.05, 0, 0);
    // the light hand points where they look
    const aim = 1.0 + pitch * 0.85 - cr * 0.15;
    b.armR.rotation.set(aim + s * 0.04 * w, 0, 0.06);
    b.foreR.rotation.set(0.45, 0, 0);
    b.handR.rotation.set(Math.PI / 2 + pitch - aim - 0.45 + 0.02 * br, 0, 0);
    b.neck.rotation.set(pitch * 0.3 + cr * 0.15, (1 - w) * Math.sin(t * 0.31 + u.seed) * 0.08, 0);
    b.head.rotation.set(pitch * 0.45 + cr * 0.15, (1 - w) * Math.sin(t * 0.23 + u.seed * 2) * 0.22, Math.sin(t * 0.17 + u.seed) * 0.04 * (1 - w));
  }
}

// ======================================================================
// Longarm: too tall, too thin, wet. Ribs and spine under the skin, an extra joint
// in every limb, hands that reach the floor, a head that is almost a face.
// ======================================================================
const LA_FING = [[-0.046, 0.3], [-0.016, 0.34], [0.012, 0.33], [0.037, 0.27]]; // [z, length] per finger
const LA_B = (() => {
  const L = [
    ['hips', null, [0, 1.27, 0.06], [0, 1.5, 0.07], 1.4],
    ['spine1', 'hips', [0, 1.5, 0.07], [0, 1.76, 0.045], 1.4],
    ['spine2', 'spine1', [0, 1.76, 0.045], [0, 1.98, 0.005], 1.4],
    ['chest', 'spine2', [0, 1.98, 0.005], [0, 2.12, -0.02], 1.3],
    ['neck', 'chest', [0, 2.12, -0.02], [0, 2.3, -0.085], 0.8],
    ['head', 'neck', [0, 2.3, -0.085], [0, 2.54, -0.11], 1.2],
    ['jaw', 'head', [0, 2.335, -0.12], [0, 2.3, -0.2], 0.7],
  ];
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    L.push(['clav' + sd, 'chest', [sx * 0.04, 2.08, -0.02], [sx * 0.19, 2.07, 0.02], 0.8]);
    L.push(['uarm' + sd, 'clav' + sd, [sx * 0.19, 2.07, 0.02], [sx * 0.23, 1.55, 0.03], 0.8]);
    L.push(['fa' + sd, 'uarm' + sd, [sx * 0.23, 1.55, 0.03], [sx * 0.26, 1.04, 0.0], 0.8]);
    L.push(['fb' + sd, 'fa' + sd, [sx * 0.26, 1.04, 0.0], [sx * 0.27, 0.46, -0.02], 0.8]);
    L.push(['hand' + sd, 'fb' + sd, [sx * 0.27, 0.46, -0.02], [sx * 0.275, 0.345, -0.025], 0.7]);
    LA_FING.forEach(([fz, len], k) => {
      L.push([`f${k}a${sd}`, 'hand' + sd, [sx * 0.275, 0.345, fz], [sx * 0.28, 0.345 - len * 0.5, fz - 0.01], 0.6]);
      L.push([`f${k}b${sd}`, `f${k}a${sd}`, [sx * 0.28, 0.345 - len * 0.5, fz - 0.01], [sx * 0.285, 0.345 - len, fz - 0.02], 0.6]);
    });
    L.push(['thumb' + sd, 'hand' + sd, [sx * 0.268, 0.41, -0.05], [sx * 0.255, 0.23, -0.075], 0.6]);
    L.push(['thigh' + sd, 'hips', [sx * 0.105, 1.25, 0.06], [sx * 0.125, 0.8, -0.1], 1]);
    L.push(['shin' + sd, 'thigh' + sd, [sx * 0.125, 0.8, -0.1], [sx * 0.13, 0.32, 0.1], 1]);
    L.push(['meta' + sd, 'shin' + sd, [sx * 0.13, 0.32, 0.1], [sx * 0.13, 0.05, -0.02], 0.9]);
    L.push(['toes' + sd, 'meta' + sd, [sx * 0.13, 0.05, -0.02], [sx * 0.13, 0.012, -0.17], 0.8]);
  }
  return boneSpec(L);
})();

const LA_RX = keys([[1.18, 0.085], [1.27, 0.122], [1.36, 0.108], [1.48, 0.07], [1.6, 0.078], [1.7, 0.122], [1.83, 0.148], [1.96, 0.15], [2.05, 0.15], [2.12, 0.09], [2.17, 0.05]]);
const LA_RZ = keys([[1.18, 0.065], [1.27, 0.082], [1.36, 0.072], [1.48, 0.052], [1.6, 0.06], [1.7, 0.095], [1.83, 0.108], [1.96, 0.104], [2.05, 0.09], [2.12, 0.06], [2.17, 0.045]]);

function longarmGeo() {
  const kit = new Kit(LA_B);
  const SKIN = 0x2c2823, PALE = 0x6a6152, DARK = 0x0f0c0a;
  const sk = lin(SKIN), pa = lin(PALE), dk = lin(DARK);
  const ridge = [];
  // skin paint: mottled, pale where bone presses through (ridge > 0), dark in hollows
  const skin = (extra) => ({
    c: SKIN, g: 1.0, sh: 1.0, ss: 0.4, gr: 0.55,
    paint: (p, n, C, S, i) => {
      const r = ridge[i] || 0, m = fbm3(p.x * 14, p.y * 9, p.z * 14), v = fbm3(p.x * 40, p.y * 40, p.z * 40);
      let k = 0.75 + 0.5 * m;
      C[0] = sk[0] * k; C[1] = sk[1] * k; C[2] = sk[2] * k * 0.95;
      if (r > 0) { const t = clamp(r, 0, 1); C[0] = mix(C[0], pa[0], t); C[1] = mix(C[1], pa[1], t); C[2] = mix(C[2], pa[2], t); S[0] = 1.2; }
      else if (r < 0) { const t = clamp(-r, 0, 1); C[0] = mix(C[0], dk[0], t); C[1] = mix(C[1], dk[1], t); C[2] = mix(C[2], dk[2], t); }
      // veins and blotches
      if (v > 0.66) { C[0] *= 0.7; C[1] *= 0.72; C[2] *= 0.8; }
      if (extra) extra(p, n, C, S, i);
    },
  });
  const rec = (start) => { let idx = start; return (val) => { ridge[idx++] = val; }; };

  // ---- torso: pelvis, a waist you could close a hand round, ribcage, spine, shoulder blades ----
  {
    const put = rec(0);
    const tor = tube([[0, 1.18, 0.07], [0, 1.45, 0.075], [0, 1.75, 0.04], [0, 2.0, 0.0], [0, 2.17, -0.035]], (t, a) => {
      const y = 1.18 + t * 0.99, front = Math.max(0, Math.cos(a));
      return sell(a, LA_RX(y), LA_RZ(y) * (1 - 0.3 * front * sstep(1.38, 1.5, y) * sstep(1.7, 1.6, y)), 2.2);
    }, {
      n: 42, seg: 22, cap0: 0.05, cap1: 0.02,
      disp: (p, t, a, dir) => {
        const y = 1.18 + t * 0.99, ca = Math.cos(a), sa = Math.abs(Math.sin(a));
        let r = 0;
        // ribs: slope down toward the front, stop short of the sternum and the spine
        const ribZone = sstep(1.68, 1.76, y) * sstep(2.08, 2.0, y) * sstep(0.12, 0.3, sa) * sstep(-0.85, -0.6, ca);
        const ph = (y + 0.07 * ca) / 0.047;
        const rib = Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 3) - 0.35;
        r += ribZone * rib * 0.011;
        // sternum
        const st = sstep(0.12, 0.0, sa) * (ca > 0 ? 1 : 0) * sstep(1.74, 1.8, y) * sstep(2.06, 2.0, y);
        r += st * 0.006;
        // spine: a row of knuckles down the back
        const sp = sstep(-0.86, -0.97, ca) * sstep(1.22, 1.3, y) * sstep(2.16, 2.08, y);
        const vb = Math.pow(Math.max(0, Math.sin((y / 0.036) * Math.PI)), 2);
        r += sp * (0.006 + 0.011 * vb);
        // shoulder blades
        const sb = (ca < -0.2 ? 1 : 0) * gauss(sa - 0.55, 0.2) * gauss(y - 1.95, 0.08);
        r += sb * 0.022;
        // hip bones
        r += (ca > 0.2 ? 1 : 0) * gauss(sa - 0.72, 0.18) * gauss(y - 1.32, 0.04) * 0.018;
        p.addScaledVector(dir, r + (fbm3(p.x * 25, p.y * 25, p.z * 25) - 0.5) * 0.004);
        put(clamp(ribZone * rib * 2.2 + st * 1.5 + sp * vb * 1.6 + sb * 0.8, -1, 1));
      },
    });
    kit.add(tor, { ...skin(), b: ['hips', 'spine1', 'spine2', 'chest', 'thighL', 'thighR', 'clavL', 'clavR', 'neck'] });
  }
  // ---- neck: long, corded ----
  const part = (gm, bones, rarr, extra) => kit.add(gm, { ...skin(extra), b: bones, paint: (p, n, C, S, i) => { const r = rarr ? rarr[i] || 0 : 0; skinPaint(p, n, C, S, r); if (extra) extra(p, n, C, S, i); } });
  const skinPaint = (p, n, C, S, r) => {
    const m = fbm3(p.x * 14, p.y * 9, p.z * 14), v = fbm3(p.x * 40, p.y * 40, p.z * 40);
    const k = 0.75 + 0.5 * m;
    C[0] = sk[0] * k; C[1] = sk[1] * k; C[2] = sk[2] * k * 0.95;
    if (r > 0) { const t = clamp(r, 0, 1); C[0] = mix(C[0], pa[0], t); C[1] = mix(C[1], pa[1], t); C[2] = mix(C[2], pa[2], t); S[0] = 1.2; }
    else if (r < 0) { const t = clamp(-r, 0, 1); C[0] = mix(C[0], dk[0], t); C[1] = mix(C[1], dk[1], t); C[2] = mix(C[2], dk[2], t); }
    if (v > 0.66) { C[0] *= 0.7; C[1] *= 0.72; C[2] *= 0.8; }
  };
  const recArr = () => { const a = []; return [a, (v) => a.push(v)]; };
  {
    const [ra, put] = recArr();
    const nk = tube([[0, 2.07, 0.0], [0, 2.2, -0.035], [0, 2.33, -0.095]], (t) => mix(0.046, 0.034, t), {
      n: 14, seg: 14, cap0: 0.01, cap1: 0.01,
      disp: (p, t, a, dir) => { const sa = Math.sin(a), ca = Math.cos(a); const ten = gauss(Math.abs(sa) - 0.45, 0.15) * (ca > 0 ? 1 : 0); const tr = gauss(sa, 0.25) * (ca > 0 ? 1 : 0) * Math.pow(Math.abs(Math.sin(t * 30)), 2); p.addScaledVector(dir, ten * 0.007 + tr * 0.003); put(ten * 0.8 + tr * 0.5); },
    });
    part(nk, ['chest', 'neck', 'head'], ra);
  }

  // ---- head: long skull, sockets set too low, no nose, a lipless mouth too wide ----
  {
    const hc = new V3(0, 2.41, -0.12), ra = [];
    const mouthY = (x) => -0.07 + 13 * x * x;
    const hd = blob(36, 30, (p) => {
      const dx = p.x, dy = p.y, dz = p.z;
      // narrow skull, long jaw, the face pushed forward and down
      let x = dx * 0.07 * (1 - 0.3 * Math.max(0, -dy)), y = dy * (dy < 0 ? 0.13 : 0.112), z = dz * 0.092 * (dz < 0 ? 1.0 : 1.08);
      if (dz < 0 && dy < 0) z -= 0.012 * -dy * -dz;
      let r = 0;
      if (dz < -0.1) {
        const fw = sstep(-0.1, -0.45, dz);
        // big sunken sockets set too low, with nothing in them
        for (const sx of [-1, 1]) { const d = Math.hypot((x - sx * 0.028) * 1.1, y + 0.012); r -= 0.03 * gauss(d, 0.026) * fw; r += 0.007 * gauss(Math.hypot(x - sx * 0.03, y - 0.022), 0.014) * fw; }
        // cheekbones
        for (const sx of [-1, 1]) r += 0.009 * gauss(Math.hypot(x - sx * 0.048, y + 0.045), 0.018) * fw;
        // two slits where a nose should be
        for (const sx of [-1, 1]) r -= 0.006 * gauss(x - sx * 0.007, 0.004) * gauss(y + 0.042, 0.012) * fw;
        r += 0.004 * gauss(x, 0.01) * gauss(y + 0.03, 0.02) * fw;
        // the mouth: a long lipless cut that curls up toward the ears
        const m = gauss(y - mouthY(x), 0.008) * sstep(0.075, 0.045, Math.abs(x));
        r -= 0.016 * m * fw;
        ra.push(clamp(-m * 1.5 + (r > 0 ? r * 70 : r * 28), -1, 1));
      } else ra.push(0);
      r += 0.004 * gauss(x, 0.008) * sstep(0.0, 0.5, dy);
      p.set(x, y, z); const l = p.length() || 1; p.multiplyScalar((l + r) / l); p.add(hc);
    });
    part(hd, ['head', 'jaw'], ra, (p, n, C) => { const lx = p.x, ly = p.y - hc.y; if (p.z < hc.z - 0.04 && Math.abs(ly - mouthY(lx)) < 0.007 && Math.abs(lx) < 0.068) { C[0] *= 0.08; C[1] *= 0.05; C[2] *= 0.05; } });
    // jaw weights on the head: overwrite the last part's skin with explicit head/jaw split
    const start = kit.SI.length / 4 - hd.attributes.position.count;
    for (let i = 0; i < hd.attributes.position.count; i++) {
      const y = kit.P[(start + i) * 3 + 1] - hc.y, x = kit.P[(start + i) * 3], z = kit.P[(start + i) * 3 + 2] - hc.z;
      const j = sstep(mouthY(x) + 0.004, mouthY(x) - 0.02, y) * sstep(0.04, -0.03, z);
      const hi = LA_B.findIndex((b) => b.name === 'head'), ji = LA_B.findIndex((b) => b.name === 'jaw'), ni = LA_B.findIndex((b) => b.name === 'neck');
      const nw = sstep(-0.09, -0.135, y) * 0.5;
      kit.SI.splice((start + i) * 4, 4, hi, ji, ni, 0); kit.SW.splice((start + i) * 4, 4, (1 - j) * (1 - nw), j * (1 - nw), nw, 0);
    }
    // teeth: small, many, a little crooked; each sits on the nearest skin vertex along the cut
    const R = mrand(5), hp = hd.attributes.position, near = (x, y) => { let best = 1e9, bz = 0; for (let i = 0; i < hp.count; i++) { const z = hp.getZ(i); if (z > hc.z - 0.03) continue; const d = (hp.getX(i) - x) ** 2 + (hp.getY(i) - y) ** 2 * 4; if (d < best) { best = d; bz = z; } } return bz; };
    for (let k = 0; k < 22; k++) {
      const up = k % 2 === 0, x = -0.044 + (Math.floor(k / 2) / 10) * 0.088 + (R() - 0.5) * 0.002;
      const y = hc.y + mouthY(x) + (up ? 0.004 : -0.004), z = near(x, y) + 0.004;
      kit.add(new THREE.ConeGeometry(0.0024, 0.006 + R() * 0.004, 4, 1), { c: 0xb3a685, g: 1.4, sh: 0.8, gr: 0.6, b: up ? 'head' : 'jaw' }, T(x, y, z, up ? Math.PI : 0, 0, (R() - 0.5) * 0.4));
    }
  }

  // ---- arms: shoulder, upper arm, two forearms, hands with long fingers ----
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    // clavicle ridge and shoulder knob
    part(blob(12, 9, (p) => { p.multiplyScalar(0.044); p.y *= 0.85; p.x *= 0.8; p.add(new V3(sx * 0.175, 2.07, 0.02)); }), ['chest', 'clav' + sd, 'uarm' + sd], null, (p, n, C) => { const k = sstep(0.0, 0.04, Math.abs(p.x) - 0.17); C[0] = mix(C[0], pa[0], k * 0.5); C[1] = mix(C[1], pa[1], k * 0.5); C[2] = mix(C[2], pa[2], k * 0.5); });
    const [ra, put] = recArr();
    const tE = 0.33, tJ = 0.655;
    const arm = tube([[sx * 0.19, 2.07, 0.02], [sx * 0.23, 1.55, 0.03], [sx * 0.26, 1.04, 0.0], [sx * 0.27, 0.46, -0.02]], (t) => {
      let r = keys([[0, 0.042], [0.15, 0.036], [0.3, 0.031], [0.5, 0.028], [0.64, 0.025], [0.85, 0.023], [1, 0.02]])(t);
      r += 0.014 * gauss(t - tE, 0.03) + 0.012 * gauss(t - tJ, 0.028) + 0.005 * gauss(t - 1, 0.03);
      return r;
    }, { n: 40, seg: 10, cap0: 0.02, cap1: 0.01, disp: (p, t, a, dir) => { const k = gauss(t - tE, 0.035) + gauss(t - tJ, 0.03); const ul = gauss(Math.cos(a) + 1, 0.4) * sstep(0.36, 0.42, t) * sstep(0.95, 0.85, t); p.addScaledVector(dir, ul * 0.003); put(k * 0.9 + ul * 0.4 - 0.15 * gauss(t - tE + 0.05, 0.02)); } });
    part(arm, ['clav' + sd, 'uarm' + sd, 'fa' + sd, 'fb' + sd, 'hand' + sd], ra);
    // narrow palm
    part(blob(12, 10, (p) => { p.set(p.x * 0.017, p.y * 0.068, p.z * 0.036); p.add(new V3(sx * 0.272, 0.4, -0.026)); }), ['fb' + sd, 'hand' + sd]);
    LA_FING.forEach(([fz, len], k) => {
      const [fa, putf] = recArr();
      const top = 0.352;
      const f = tube([[sx * 0.274, top, fz], [sx * 0.28, top - len * 0.5, fz - 0.01], [sx * 0.285, top - len, fz - 0.02]], (t) => mix(0.011, 0.0055, t) + 0.0035 * gauss(t, 0.06) + 0.003 * gauss(t - 0.5, 0.05) + 0.0025 * gauss(t - 0.78, 0.04), {
        n: 15, seg: 6, cap0: 0.006, cap1: 0.016, disp: (p, t) => putf(gauss(t, 0.06) + gauss(t - 0.5, 0.05) * 0.8 + gauss(t - 0.78, 0.04) * 0.6),
      });
      part(f, ['hand' + sd, `f${k}a${sd}`, `f${k}b${sd}`], fa, (p, n, C, S) => { if (p.y < top - len + 0.022) { C[0] = 0.03; C[1] = 0.028; C[2] = 0.022; S[0] = 1.8; } });
    });
    part(tube([[sx * 0.268, 0.415, -0.05], [sx * 0.262, 0.32, -0.07], [sx * 0.255, 0.23, -0.075]], (t) => mix(0.011, 0.006, t) + 0.003 * gauss(t - 0.5, 0.06), { n: 12, seg: 7, cap0: 0.006, cap1: 0.014 }), ['hand' + sd, 'thumb' + sd], null, (p, n, C, S) => { if (p.y < 0.25) { C[0] = 0.03; C[1] = 0.028; C[2] = 0.022; S[0] = 1.8; } });
  }

  // ---- legs: knee forward, ankle high off the ground, long toes ----
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    const [ra, put] = recArr();
    const lg = tube([[sx * 0.1, 1.3, 0.065], [sx * 0.125, 0.8, -0.1], [sx * 0.13, 0.32, 0.1], [sx * 0.13, 0.05, -0.02]], (t) => {
      return keys([[0, 0.066], [0.15, 0.054], [0.33, 0.04], [0.45, 0.036], [0.62, 0.03], [0.72, 0.026], [0.9, 0.022], [1, 0.02]])(t) + 0.014 * gauss(t - 0.36, 0.03) + 0.012 * gauss(t - 0.72, 0.03);
    }, { n: 38, seg: 10, cap0: 0.03, cap1: 0.012, disp: (p, t, a, dir) => { const sh = gauss(Math.cos(a) - 1, 0.4) * sstep(0.4, 0.45, t) * sstep(0.7, 0.62, t); p.addScaledVector(dir, sh * 0.004); put(gauss(t - 0.36, 0.035) + gauss(t - 0.72, 0.03) * 0.9 + sh * 0.5); } });
    part(lg, ['hips', 'thigh' + sd, 'shin' + sd, 'meta' + sd, 'toes' + sd], ra);
    for (let k = -1; k <= 1; k++) {
      const [ta, putt] = recArr();
      part(tube([[sx * 0.13, 0.05, -0.015], [sx * 0.13 + k * 0.025, 0.025, -0.09], [sx * 0.13 + k * 0.04, 0.012, -0.16 + Math.abs(k) * 0.02]], (t) => mix(0.013, 0.006, t) + 0.003 * gauss(t - 0.5, 0.07), { n: 9, seg: 6, cap0: 0.006, cap1: 0.012, disp: (p, t) => putt(gauss(t - 0.5, 0.07)) }),
        ['meta' + sd, 'toes' + sd], ta, (p, n, C, S) => { if (p.z < -0.15 + Math.abs(k) * 0.02) { C[0] = 0.03; C[1] = 0.028; C[2] = 0.022; S[0] = 1.8; } });
    }
  }
  return kit.build();
}

export function makeLongarm(M) {
  const gm = geo('longarm', longarmGeo);
  const g = new THREE.Group();
  const { mesh, by } = skinned(gm, LA_B, M.skin, [[0, 1.3, -0.2], 1.9]);
  g.add(mesh);
  g.userData = { b: by, mesh, ph: 0, t: 0, seed: Math.random() * 100, wk: 0, tw: new Float32Array(24), sp: new Float32Array(16), twT: 0 };
  animLongarm(g, 1 / 60, 0, 0, 0);
  return g;
}

// general 2-bone IK in the sagittal plane for bones whose rest pose is not vertical
function ik2(th, sh, hz, hy, tz, ty, L1, L2, r1, r2, bendBack) {
  const f = -(tz - hz), d = hy - ty;
  const D = clamp(Math.hypot(f, d), 0.08, L1 + L2 - 0.004);
  const k = Math.acos(clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1));
  const al = Math.acos(clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
  const p1 = Math.atan2(f, d) + (bendBack ? -al : al), p2 = p1 + (bendBack ? (Math.PI - k) : -(Math.PI - k));
  th.rotation.x = p1 - r1; sh.rotation.x = (p2 - r2) - (p1 - r1);
  return p2 - r2; // absolute deviation of the shin
}
const LA_R = (() => { const r = {}; for (const b of LA_B) { const v = b.b.clone().sub(b.a); r[b.name] = { len: v.length(), ang: Math.atan2(-v.z, -v.y) }; } return r; })();

export function animLongarm(g, dt, speed, chase, t) {
  const u = g.userData, b = u.b, tw = u.tw, sp = u.sp;
  dt = Math.min(dt, 0.05);
  const om = 1.5 + speed * 1.7;
  u.ph += dt * om;
  u.wk += (Math.min(speed / 1.6, 1.4) - u.wk) * (1 - Math.exp(-4 * dt));
  const w = Math.min(u.wk, 1.2), ph = u.ph, s = Math.sin(ph), c = Math.cos(ph), ch = chase;
  const A = Math.min(0.42, (speed * Math.PI) / (2 * om)) * Math.min(1, w * 1.5);
  const br = Math.sin(t * 0.9 + u.seed) + 0.3 * Math.sin(t * 2.3 + u.seed);
  // twitch targets: hold, then snap somewhere else
  u.twT -= dt;
  if (u.twT <= 0) {
    const h = (k) => h3(Math.floor(t * 10), k, u.seed * 7 | 0) * 2 - 1;
    u.twT = ch > 0.5 ? 0.06 + Math.abs(h(9)) * 0.18 : 0.35 + Math.abs(h(9)) * 1.6;
    tw[0] = h(1) * (0.45 + ch * 0.3); tw[1] = h(2) * 0.3; tw[2] = h(3) * 0.2 - 0.1; // head roll, yaw, nod
    for (let k = 0; k < 10; k++) tw[4 + k] = h(10 + k);
  }
  const snap = 1 - Math.exp(-(ch > 0.5 ? 30 : 16) * dt);
  for (let k = 0; k < 3; k++) tw[16 + k] += (tw[k] - tw[16 + k]) * snap;
  // hips: low and forward when it runs
  const hy = 1.27 - ch * 0.12 + 0.035 * w * Math.cos(2 * ph) - 0.03 * w + br * 0.004;
  const sway = Math.sin(t * 0.37 + u.seed) * 0.02 * (1 - w) + c * 0.035 * w;
  b.hips.position.set(sway, hy, 0.06 + ch * 0.05);
  b.hips.rotation.set(0, s * 0.12 * w, -sway * 1.2);
  // legs: plant the ball of the foot, keep the long metatarsal angled, toes flat
  const L1 = LA_R.thighL.len, L2 = LA_R.shinL.len, L3 = LA_R.metaL.len, a3 = LA_R.metaL.ang;
  for (let k = 0; k < 2; k++) {
    const sd = k ? 'R' : 'L', p2 = ph + k * Math.PI, ss = Math.sin(p2), cc = Math.cos(p2);
    const lift = Math.max(0, cc) * (0.16 + ch * 0.06) * w;
    const bz = -0.02 - A * ss, by2 = 0.05 + lift;
    const m3 = a3 - Math.max(0, cc) * 0.35 * w; // meta swings back during the swing
    const az = bz + Math.sin(m3) * L3, ay = by2 + Math.cos(m3) * L3;
    const sx = k ? 1 : -1;
    const hipZ = 0.06 + ch * 0.05, hipY = hy - 0.02;
    const dev2 = ik2(b['thigh' + sd], b['shin' + sd], hipZ, hipY, az, ay, L1, L2, LA_R['thigh' + sd].ang, LA_R['shin' + sd].ang, false);
    b['meta' + sd].rotation.x = (m3 - a3) - dev2;
    b['toes' + sd].rotation.x = -(m3 - a3) + Math.max(0, cc) * 0.5 * w - 0.05;
    b['thigh' + sd].rotation.z = sx * 0.03 + sway;
  }
  // spine: hunched, more when it hunts; breathing shows in the ribs
  const hunch = 0.2 + ch * 0.2;
  b.spine1.rotation.set(-hunch * 0.6 + br * 0.01, -s * 0.06 * w, sway * 0.6);
  b.spine2.rotation.set(-hunch * 0.8, -s * 0.05 * w, 0);
  b.chest.rotation.set(-hunch * 0.5 + br * 0.015, 0, 0);
  b.chest.scale.set(1 + br * 0.012, 1, 1 + br * 0.02);
  // neck and head: slow wrong tilts, snapping, a tremor; violent when it runs
  const trem = Math.sin(t * 37) * 0.012 + Math.sin(t * 23) * 0.01;
  b.neck.rotation.set(0.02 + ch * 0.3 + tw[18] * 0.5, tw[17] * 0.6, tw[16] * 0.5);
  b.head.rotation.set(0.0 + ch * 0.25 + tw[18] + trem + (ch > 0.5 ? Math.sin(t * 31) * 0.1 * ch : 0), tw[17], tw[16] + trem * 0.5);
  b.jaw.rotation.x = 0.06 + ch * 0.45 + (ch > 0.3 ? Math.max(0, Math.sin(t * 19)) * 0.12 * ch : 0) + Math.max(0, br) * 0.03;
  // arms: hang and swing with lag, reach forward when it chases
  const reach = ch * 1.75;
  for (let k = 0; k < 2; k++) {
    const sd = k ? 'R' : 'L', sx = k ? 1 : -1, sw = (k ? s : -s) * 0.22 * w;
    const a = spring(sp, k * 4, sw + reach * (k ? 0.92 : 1) + tw[4 + k] * 0.04, 20, 3, dt);
    b['clav' + sd].rotation.set(0, 0, sx * (0.05 + ch * 0.08) - sx * br * 0.01);
    b['uarm' + sd].rotation.set(a, 0, sx * (0.05 + ch * 0.06));
    b['fa' + sd].rotation.set(spring(sp, k * 4 + 2, 0.08 + ch * 0.35 + Math.max(0, sw) * 0.4, 18, 3, dt), 0, 0);
    b['fb' + sd].rotation.set(-0.12 + ch * 0.25, 0, -sx * 0.05);
    b['hand' + sd].rotation.set(ch * 0.4 + tw[6 + k] * 0.08, 0, sx * 0.05);
    // fingers: idle curl and crawl, spread and hooked in a chase
    for (let f = 0; f < 4; f++) {
      const curl = (0.12 + 0.18 * (0.5 + 0.5 * Math.sin(t * 1.3 + f * 1.7 + k * 3 + u.seed))) * (1 - ch) + ch * (0.5 + Math.sin(t * 9 + f) * 0.15);
      const spread = (f - 1.5) * (0.05 + ch * 0.12);
      b[`f${f}a${sd}`].rotation.set(spread, 0, -sx * curl);
      b[`f${f}b${sd}`].rotation.set(0, 0, -sx * curl * 1.2 + tw[8 + f] * 0.05);
    }
    b['thumb' + sd].rotation.set(0, 0, -sx * (0.2 + ch * 0.3));
  }
}

// ======================================================================
// The biter: eyes in the dark. When a light finds one, there is a face round them.
// The group is turned with lookAt, so the face looks along +Z.
// ======================================================================
function biterGeo() {
  const kit = new Kit();
  const SK = { c: 0x0a0908, g: 1.5, sh: 1.2, ss: 0.5, gr: 0.4 };
  const R = mrand(9);
  // the maw: wide, open, curling up at the corners
  const mouth = (x) => -0.05 + 5 * x * x, gape = (x) => 0.022 * sstep(0.1, 0.0, Math.abs(x));
  const head = blob(30, 22, (p) => {
    let x = p.x * 0.1, y = p.y * (p.y > 0 ? 0.11 : 0.09), z = p.z * 0.12;
    x *= 1 + 0.08 * Math.sin(p.y * 3 + 1); // a little lopsided
    let r = 0;
    if (p.z > 0.05) {
      const fw = sstep(0.05, 0.4, p.z);
      for (const sx of [-1, 1]) r -= 0.03 * gauss(Math.hypot(x - sx * 0.04, (y - 0.012) * 1.3), 0.02) * fw;
      const my = mouth(x), d = y - my;
      const open = sstep(0.1, 0.07, Math.abs(x)) * gauss(d, gape(x) + 0.006);
      r -= 0.06 * open * fw;
      r += 0.008 * gauss(d - gape(x) - 0.008, 0.005) * sstep(0.1, 0.06, Math.abs(x)) * fw; // upper lip ridge
      r += 0.006 * gauss(d + gape(x) + 0.008, 0.005) * sstep(0.1, 0.06, Math.abs(x)) * fw;
      r += (fbm3(x * 60, y * 60, 3) - 0.5) * 0.004 * fw; // wrinkles
    }
    p.set(x, y, z); const l = p.length() || 1; p.multiplyScalar((l + r) / l); p.z -= 0.095;
  });
  kit.add(head, { ...SK, paint: (p, n, C, S) => {
    const d = p.y - mouth(p.x), m = sstep(gape(p.x) + 0.004, gape(p.x) - 0.006, Math.abs(d)) * sstep(0.1, 0.07, Math.abs(p.x)) * (p.z > -0.03 ? 1 : 0);
    if (m > 0) { C[0] = mix(C[0], 0.09, m); C[1] = mix(C[1], 0.008, m); C[2] = mix(C[2], 0.006, m); S[1] = 1.6; S[2] = 1; }
    const v = fbm3(p.x * 50, p.y * 50, p.z * 50); const k = 0.6 + v * 0.8; C[0] *= k; C[1] *= k; C[2] *= k;
  } });
  // needle teeth, two crooked rows top and bottom, some broken, some missing
  for (let k = 0; k < 44; k++) {
    if (R() < 0.15) continue;
    const up = k % 2 === 0, row = (k >> 1) % 2, i = k >> 2, x = -0.085 + (i / 10) * 0.17 + (R() - 0.5) * 0.008;
    const g = gape(x), y = mouth(x) + (up ? g + 0.002 : -g - 0.002), z = Math.sqrt(Math.max(0, 1 - (x / 0.105) ** 2)) * 0.12 - 0.095 - 0.012 - row * 0.012;
    const L = (0.008 + R() * 0.018) * (row ? 0.7 : 1) * (R() < 0.12 ? 0.4 : 1);
    kit.add(new THREE.ConeGeometry(0.0018 + R() * 0.001, L, 4, 1), { c: R() < 0.3 ? 0xa89c7a : 0xd2c8aa, g: 1.6, sh: 1, gr: 0.6 }, T(x, y - (up ? L * 0.45 : -L * 0.45), z, (up ? Math.PI : 0) + (R() - 0.5) * 0.5, 0, (R() - 0.5) * 0.7));
  }
  // the eyes: small, reflective, slit pupils
  for (const sx of [-1, 1]) {
    kit.add(blob(12, 9, (p) => { p.multiplyScalar(0.019); p.z *= 0.75; p.x += sx * 0.04; p.y += 0.012; }), {
      c: 0xfff2c0, g: 2, sh: 1, e: 2.4, gr: 0,
      paint: (p, n, C) => { const lx = p.x - sx * 0.04, ly = p.y - 0.012; if (Math.abs(lx + ly * 0.15 * sx) < 0.0032 && p.z > 0.004) { C[0] = 0.02; C[1] = 0.02; C[2] = 0.015; } else { const r = Math.hypot(lx, ly) / 0.019; const k = 1 - 0.6 * r; C[0] *= k; C[1] *= k * 0.9; C[2] *= k * 0.6; } },
    });
  }
  // a long neck, ridged along the top, going back and down into the dark
  kit.add(tube([[0, -0.01, -0.14], [0.02, -0.03, -0.45], [0.1, -0.12, -0.85], [0.16, -0.35, -1.25], [0.12, -0.7, -1.5]], (t) => mix(0.06, 0.11, t) * (1 + 0.05 * Math.sin(t * 60)), {
    n: 30, seg: 10, up: [0, 1, 0], cap0: false,
    disp: (p, t, a, dir) => { const top = gauss(Math.cos(a) - 1, 0.3); p.addScaledVector(dir, top * 0.022 * Math.pow(Math.abs(Math.sin(t * 34)), 3) + (fbm3(p.x * 9, p.y * 9, p.z * 9) - 0.5) * 0.025); },
  }), { ...SK, g: 1.2 });
  return kit.build();
}
export function makeEyes(M) {
  const g = new THREE.Group();
  g.add(meshOf(geo('biter', biterGeo), M.dark));
  return g;
}

// ======================================================================
// Supplies: almond water and batteries
// ======================================================================
function bottleGeo() {
  const kit = new Kit();
  const prof = [[0, 0], [0.024, 0], [0.03, 0.002], [0.034, 0.006], [0.036, 0.014]];
  for (let k = 0; k <= 8; k++) { const y = 0.016 + k * 0.0042; prof.push([0.036 - (k % 2) * 0.0016, y]); }
  prof.push([0.0362, 0.052], [0.0362, 0.118]);
  for (let k = 0; k <= 6; k++) { const y = 0.12 + k * 0.0044; prof.push([0.036 - (k % 2) * 0.0016, y]); }
  prof.push([0.0355, 0.152], [0.033, 0.162], [0.027, 0.172], [0.02, 0.18], [0.0155, 0.186], [0.0145, 0.19], [0.019, 0.191], [0.019, 0.194], [0.0145, 0.195], [0.0145, 0.2], [0, 0.2]);
  const fill = 0.165;
  kit.add(lathe(prof, 18), {
    c: 0xd8cfb6, g: 2.2, sh: 1.4, gr: 0.25, ss: 0.6,
    paint: (p, n, C, S) => { if (p.y > fill) { C[0] = 0.08; C[1] = 0.09; C[2] = 0.085; S[0] = 2.6; S[2] = 0; } else if (p.y > fill - 0.004) { C[0] *= 1.15; C[1] *= 1.15; C[2] *= 1.1; } },
  });
  kit.add(lathe([[0.0366, 0.054], [0.0366, 0.117]], 18), { c: 0xffffff, g: 0.8, sh: 0.6, gr: 0.3, uv: 'bottle', uvf: (p, n, u, v) => [u, v] });
  kit.add(tube([[0, 0.199, 0], [0, 0.221, 0]], (t, a) => 0.0168 * (1 + (Math.sin(a * 18) > 0 ? 0.045 : 0)), { n: 3, seg: 36, up: [0, 0, 1], cap0: 0.001, cap1: 0.002 }), { c: 0x2a4c84, g: 1.2, sh: 0.6, gr: 0.4 });
  return kit.build();
}
function batteryGeo() {
  const kit = new Kit();
  const m = T(0, 0.0345, 0, 0, 0, -Math.PI / 2);
  kit.add(lathe([[0.0335, -0.06], [0.0345, -0.057], [0.0345, 0.057], [0.0335, 0.06]], 24, { y0: -0.06, y1: 0.06 }), { c: 0xffffff, g: 1.2, sh: 0.6, gr: 0.45, uv: 'battery', uvf: (p, n, u, v) => [u, v] }, m);
  kit.add(lathe([[0, -0.0655], [0.028, -0.0655], [0.031, -0.0635], [0.0336, -0.0605], [0.0336, -0.058]], 24), { c: 0xa9a9a2, g: 1.8, sh: 0.9, gr: 0.5 }, m);
  kit.add(lathe([[0.0336, 0.058], [0.0336, 0.0605], [0.031, 0.0635], [0.027, 0.0645], [0.0095, 0.0645], [0.0095, 0.0705], [0.008, 0.072], [0, 0.072]], 24), { c: 0xb4b4ac, g: 2, sh: 1, gr: 0.4 }, m);
  return kit.build();
}
function makeBottle(M) { const g = new THREE.Group(); g.add(meshOf(geo('bottle', bottleGeo), M.hard)); return g; }
function makeBattery(M) { const g = new THREE.Group(); g.add(meshOf(geo('battery', batteryGeo), M.hard)); return g; }

// ======================================================================
// Office chair: padded seat and back, gas lift, five-star base on castors, armrests
// ======================================================================
function chairGeo() {
  const kit = new Kit();
  const FAB = 0x2f323a, PL = 0x151515, CHR = 0x9c9c98;
  const fabric = { c: FAB, g: 0.2, sh: 0, gr: 0.75, paint: (p, n, C) => { const st = fbm3(p.x * 9, p.y * 9, p.z * 9); const k = 0.82 + 0.35 * st - (st > 0.68 ? 0.3 : 0); C[0] *= k; C[1] *= k; C[2] *= k * 0.95; } };
  // seat cushion, domed on top
  const seat = rbox(0.48, 0.08, 0.47, 0.035, 3), sp = seat.attributes.position;
  for (let i = 0; i < sp.count; i++) { const x = sp.getX(i), y = sp.getY(i), z = sp.getZ(i); if (y > 0) sp.setY(i, y + 0.016 * (1 - (x / 0.24) ** 2) * (1 - (z / 0.235) ** 2) - 0.008 * Math.max(0, -z / 0.235) ** 4); }
  seat.computeVertexNormals();
  kit.add(seat, fabric, T(0, 0.475, -0.01));
  kit.add(rbox(0.43, 0.03, 0.42, 0.012, 1), { c: PL, g: 0.6, gr: 0.5 }, T(0, 0.43, -0.01));
  // backrest, wrapped round the sitter and leaning back
  const back = rbox(0.44, 0.46, 0.075, 0.035, 3), bp = back.attributes.position;
  for (let i = 0; i < bp.count; i++) { const x = bp.getX(i), y = bp.getY(i); bp.setZ(i, bp.getZ(i) + 0.07 * (x / 0.22) ** 2 - 0.03 * Math.sin((y / 0.23 + 1) * 1.5)); bp.setX(i, x * (1 - 0.1 * Math.max(0, y / 0.23) ** 2)); }
  back.computeVertexNormals();
  kit.add(back, fabric, T(0, 0.84, 0.255, 0.12));
  kit.add(rbox(0.38, 0.4, 0.025, 0.01, 1), { c: PL, g: 0.6, gr: 0.5 }, T(0, 0.84, 0.3, 0.12));
  // spine bar from under the seat into the back
  kit.add(tube([[0, 0.425, 0.08], [0, 0.44, 0.27], [0, 0.6, 0.31], [0, 0.72, 0.315]], (t, a) => sell(a, 0.03, 0.01, 4), { n: 12, seg: 8, up: [0, 0, 1] }), { c: PL, g: 0.8, sh: 0.3, gr: 0.5 });
  kit.add(rbox(0.17, 0.05, 0.22, 0.01, 1), { c: 0x1d1d1c, g: 0.9, sh: 0.3, gr: 0.6 }, T(0, 0.395, 0.0));
  kit.add(tube([[0.08, 0.39, -0.06], [0.16, 0.38, -0.12]], () => 0.006, { n: 2, seg: 6 }), { c: PL, g: 0.8 });
  // gas lift: chrome piston in a plastic sleeve
  kit.add(lathe([[0, 0.24], [0.024, 0.24], [0.024, 0.38], [0.03, 0.385], [0, 0.39]], 16), { c: CHR, g: 2.2, sh: 1.4, gr: 0.35 });
  kit.add(lathe([[0, 0.08], [0.036, 0.08], [0.036, 0.1], [0.031, 0.12], [0.03, 0.26], [0.026, 0.265], [0, 0.265]], 16), { c: PL, g: 0.8, sh: 0.3, gr: 0.5 });
  // five-star base on castors
  kit.add(lathe([[0, 0.065], [0.055, 0.065], [0.05, 0.1], [0, 0.11]], 16), { c: PL, g: 0.7, sh: 0.3, gr: 0.55 });
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3, dx = Math.sin(a), dz = Math.cos(a);
    kit.add(tube([[dx * 0.03, 0.09, dz * 0.03], [dx * 0.17, 0.085, dz * 0.17], [dx * 0.31, 0.064, dz * 0.31]], (t, q) => sell(q, mix(0.022, 0.016, t), mix(0.02, 0.013, t), 3.5), { n: 8, seg: 8, up: [0, 1, 0], cap1: 0.008 }), { c: PL, g: 0.9, sh: 0.4, gr: 0.55 });
    const sw = (k * 1.9) % 6.28, cx = dx * 0.31, cz = dz * 0.31;
    kit.add(rbox(0.026, 0.03, 0.04, 0.008, 1), { c: PL, g: 0.7, gr: 0.6 }, T(cx, 0.045, cz, 0, sw, 0));
    for (const o of [-1, 1]) kit.add(new THREE.CylinderGeometry(0.024, 0.024, 0.011, 14), { c: 0x101010, g: 1, sh: 0.4, gr: 0.7 }, T(cx + Math.cos(sw) * 0.012 * o + Math.sin(sw) * 0.015, 0.025, cz - Math.sin(sw) * 0.012 * o + Math.cos(sw) * 0.015, 0, sw, Math.PI / 2));
  }
  // armrests
  for (const sx of [-1, 1]) {
    kit.add(tube([[sx * 0.15, 0.43, 0.05], [sx * 0.235, 0.44, 0.05], [sx * 0.25, 0.53, 0.04], [sx * 0.25, 0.63, 0.03]], (t, a) => sell(a, 0.02, 0.012, 3), { n: 12, seg: 8, up: [0, 0, -1] }), { c: PL, g: 0.8, sh: 0.3, gr: 0.5 });
    kit.add(rbox(0.065, 0.032, 0.25, 0.014, 2), { c: 0x1a1a1a, g: 0.5, sh: 0.2, gr: 0.7 }, T(sx * 0.25, 0.65, 0.0));
  }
  return kit.build();
}
export function makeChair(M) { const g = new THREE.Group(); g.add(meshOf(geo('chair', chairGeo), M.hard)); return g; }

// ======================================================================
// Door: frame and casing, panelled slab, lever handles, hinges, kick plates, EXIT box
// ======================================================================
function doorGeo(withSign) {
  const kit = new Kit();
  const FR = 0x8f8a74, WD = 0x7a6245;
  const chip = { c: FR, g: 0.7, sh: 0.2, gr: 0.75 };
  for (const sx of [-1, 1]) {
    kit.add(rbox(0.08, 2.18, 0.12, 0.006, 1), chip, T(sx * 0.5, 1.09, 0));
    for (const sz of [-1, 1]) kit.add(rbox(0.1, 2.24, 0.016, 0.005, 1), chip, T(sx * 0.52, 1.12, sz * 0.062));
  }
  kit.add(rbox(1.08, 0.08, 0.12, 0.006, 1), chip, T(0, 2.14, 0));
  for (const sz of [-1, 1]) kit.add(rbox(1.14, 0.1, 0.016, 0.005, 1), chip, T(0, 2.2, sz * 0.062));
  // slab with wood grain and two raised panels each side
  const wood = (k = 1) => ({ c: WD, g: 0.55, sh: 0.25, gr: 0.85, paint: (p, n, C) => { C[0] *= k; C[1] *= k; C[2] *= k; } });
  kit.add(rbox(0.91, 2.06, 0.044, 0.006, 1), wood(), T(0, 1.035, 0));
  for (const sz of [-1, 1]) {
    for (const [py, ph] of [[1.5, 0.84], [0.62, 0.7]]) {
      kit.add(rbox(0.66, ph + 0.05, 0.008, 0.003, 1), wood(0.72), T(0, py, sz * 0.024));
      kit.add(rbox(0.6, ph, 0.01, 0.005, 1), wood(1.06), T(0, py, sz * 0.027));
    }
    kit.add(new THREE.BoxGeometry(0.84, 0.2, 0.003), { c: 0x7c7c76, g: 1.0, sh: 0.15, gr: 0.8, paint: (p, n, C) => { const k = 0.85 + 0.3 * vn3(p.x * 200, p.y * 6, 0); C[0] *= k; C[1] *= k; C[2] *= k; } }, T(0, 0.12, sz * 0.0235));
    // lever handle on a round rose, with a key escutcheon below
    kit.add(lathe([[0, 0], [0.032, 0], [0.032, 0.006], [0.02, 0.012], [0.012, 0.016], [0, 0.016]], 16), { c: 0x9a978c, g: 1.8, sh: 1, gr: 0.4 }, TY(0.36, 1.0, sz * 0.022, [0, 0, sz]));
    kit.add(tube([[0.36, 1.0, sz * 0.034], [0.355, 1.0, sz * 0.064], [0.33, 1.0, sz * 0.072], [0.235, 0.995, sz * 0.072]], (t) => mix(0.011, 0.009, t), { n: 14, seg: 10, cap1: 0.006 }), { c: 0x9a978c, g: 1.8, sh: 1, gr: 0.4 });
    kit.add(rbox(0.03, 0.05, 0.004, 0.0015, 1), { c: 0x9a978c, g: 1.6, sh: 0.8, gr: 0.45, paint: (p, n, C) => { if (Math.abs(p.x - 0.36) < 0.003 && Math.abs(p.y - 0.915) < 0.012 && Math.abs(n.z) > 0.6) { C[0] = C[1] = C[2] = 0.01; } } }, T(0.36, 0.915, sz * 0.024));
  }
  // three hinges on the hinge side
  for (const hy of [0.25, 1.05, 1.85]) {
    kit.add(new THREE.CylinderGeometry(0.009, 0.009, 0.1, 10), { c: 0x7c6c48, g: 1.4, sh: 0.6, gr: 0.6 }, T(-0.458, hy, -0.024));
    for (const y of [hy - 0.052, hy + 0.052]) kit.add(new THREE.SphereGeometry(0.0095, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), { c: 0x7c6c48, g: 1.4, sh: 0.6 }, T(-0.458, y, -0.024, y > hy ? 0 : Math.PI));
    kit.add(rbox(0.04, 0.1, 0.003, 0.001, 1), { c: 0x7c6c48, g: 1.2, sh: 0.5, gr: 0.6 }, T(-0.44, hy, -0.0235));
  }
  kit.add(rbox(1.0, 0.012, 0.12, 0.004, 1), { c: 0x8a8a84, g: 1.2, sh: 0.4, gr: 0.8 }, T(0, 0.006, 0));
  if (withSign) {
    kit.add(rbox(0.46, 0.2, 0.07, 0.014, 2), { c: 0xd9d5c8, g: 0.8, sh: 0.4, gr: 0.5 }, T(0, 2.4, 0));
    for (const sz of [-1, 1]) {
      const pl = new THREE.PlaneGeometry(0.4, 0.15);
      kit.add(pl, { c: 0xffffff, g: 1.6, sh: 0.6, gr: 0.1, e: 3.2, uv: 'exit' }, T(0, 2.4, sz * 0.0362, 0, sz > 0 ? 0 : Math.PI, 0));
    }
    kit.add(rbox(0.3, 0.04, 0.03, 0.006, 1), { c: 0x9a978c, g: 0.8, gr: 0.6 }, T(0, 2.4, 0.045));
  }
  return kit.build();
}
export function makeDoor(M, tex, withSign) {
  const g = new THREE.Group();
  g.add(meshOf(geo(withSign ? 'doorS' : 'door', () => doorGeo(withSign)), M.hard));
  return g;
}

// ======================================================================
// The twelve artifacts (index-aligned with ARTIFACTS in util.js). Centred on the origin.
// ======================================================================
const ART_BUILD = [
  // 0 Humming Cube: dull machined metal, seams that glow faintly warm
  (kit) => {
    kit.add(rbox(0.15, 0.15, 0.15, 0.012, 2), { c: 0x4a4c4a, g: 1.2, sh: 0.6, gr: 0.7, paint: (p, n, C) => { const k = 0.8 + 0.4 * fbm3(p.x * 40, p.y * 40, p.z * 40); C[0] *= k; C[1] *= k; C[2] *= k; } });
    const glow = { c: 0xffa040, g: 1, e: 0.9, gr: 0 };
    for (let f = 0; f < 6; f++) {
      const ax = f >> 1, sg = f & 1 ? 1 : -1, rot = [[0, 0, 0], [0, Math.PI / 2, 0], [Math.PI / 2, 0, 0]][ax];
      const o = [0, 0, 0]; o[[2, 0, 1][ax]] = sg * 0.0752;
      for (const [w, h, x, y] of [[0.1, 0.003, 0, 0.05], [0.1, 0.003, 0, -0.05], [0.003, 0.1, 0.05, 0], [0.003, 0.1, -0.05, 0], [0.04, 0.003, 0, 0], [0.003, 0.04, 0, 0]]) {
        const m = T(o[0], o[1], o[2], ...rot).multiply(T(x, y, 0));
        kit.add(new THREE.BoxGeometry(w > h ? w : w * 0.5, h > w ? h : h * 0.5, 0.001), glow, m);
      }
    }
  },
  // 1 Wet Polaroid: curled card, the corridor behind you on its face
  (kit) => {
    const card = new THREE.BoxGeometry(0.16, 0.195, 0.003, 10, 10, 1), cp = card.attributes.position;
    for (let i = 0; i < cp.count; i++) { const x = cp.getX(i), y = cp.getY(i); cp.setZ(i, cp.getZ(i) + 0.014 * (x / 0.08) ** 2 + 0.006 * (y / 0.1) ** 2); }
    card.computeVertexNormals();
    kit.add(card, { c: 0xffffff, g: 2, sh: 1.6, gr: 0.4, uv: 'photo', uvf: (p, n, u, v) => (n.z < -0.5 ? [u, v] : [0.03, 0.03]), paint: (p, n, C) => { if (n.z >= -0.5) { C[0] = 0.86; C[1] = 0.84; C[2] = 0.78; } } });
  },
  // 2 Unwound Clock: wall clock, a thirteenth hour, hands stopped just short of twelve
  (kit) => {
    const m = T(0, 0, 0, Math.PI / 2, 0, 0);
    kit.add(lathe([[0, -0.022], [0.105, -0.022], [0.118, -0.018], [0.124, -0.008], [0.125, 0.006], [0.121, 0.016], [0.113, 0.02], [0.108, 0.014], [0.106, 0.006]], 36), { c: 0x2a2826, g: 1, sh: 0.6, gr: 0.5 }, m);
    kit.add(lathe([[0.107, 0.004], [0, 0.004]], 36), { c: 0xffffff, g: 0.5, sh: 0.2, gr: 0.3, uv: 'clock', uvf: (p) => [0.5 + p.x / 0.214, 0.5 + p.y / 0.214] }, m);
    const hand = (len, w, ang) => kit.add(new THREE.BoxGeometry(w, len, 0.0015), { c: 0x101010, g: 0.8 }, T(0, 0, 0.007).multiply(T(0, 0, 0, 0, 0, -ang)).multiply(T(0, len * 0.38, 0)));
    hand(0.06, 0.008, -0.05); hand(0.088, 0.005, -0.21); hand(0.095, 0.0015, 2.4);
    kit.add(new THREE.CylinderGeometry(0.006, 0.006, 0.006, 10), { c: 0x101010, g: 1 }, T(0, 0, 0.008, Math.PI / 2));
  },
  // 3 Black Bulb: a light bulb in black glass on a brass screw base
  (kit) => {
    const prof = [[0, -0.09], [0.008, -0.09], [0.012, -0.086]];
    for (let k = 0; k <= 10; k++) prof.push([0.0135 + (k % 2) * 0.0015, -0.084 + k * 0.0045]);
    kit.add(lathe([prof, [[0, -0.094], [0.007, -0.094], [0.008, -0.089], [0, -0.088]]], 18), { c: 0xa0864e, g: 1.6, sh: 0.9, gr: 0.6, paint: (p, n, C) => { if (p.y < -0.087) { C[0] = C[1] = C[2] = 0.02; } } });
    const bulb = [[0.014, -0.037], [0.016, -0.03], [0.02, -0.018], [0.03, 0.0], [0.042, 0.02], [0.05, 0.04], [0.052, 0.058], [0.048, 0.076], [0.038, 0.091], [0.022, 0.1], [0, 0.103]];
    kit.add(lathe(bulb, 30), { c: 0x030303, g: 2.6, sh: 2.2, gr: 0.15 });
  },
  // 4 Left Glove: inflated, fingers curled round nothing
  (kit) => {
    const GL = { c: 0x161a13, g: 1.3, sh: 0.9, gr: 0.4 };
    kit.add(tube([[0, -0.13, 0.0], [0, -0.06, 0.0]], (t) => mix(0.055, 0.05, t), { n: 5, seg: 16, cap0: 0.02, cap1: 0.01 }), GL);
    kit.add(tube([[0, -0.115, 0.001], [0, -0.09, 0]], () => 0.059, { n: 3, seg: 18, cap0: 0.004, cap1: 0.004 }), { c: 0x6a6a64, g: 1.1, sh: 0.5, gr: 0.6 });
    kit.add(blob(14, 10, (p) => { p.set(p.x * 0.05, p.y * 0.062, p.z * 0.03); p.y += -0.01; }), GL);
    const fx = [-0.03, -0.01, 0.01, 0.03], fl = [0.075, 0.085, 0.08, 0.065];
    for (let k = 0; k < 4; k++) {
      const x = fx[k], L = fl[k];
      kit.add(tube([[x, 0.04, 0], [x, 0.04 + L * 0.55, -0.012], [x * 1.05, 0.04 + L * 0.75, -0.05], [x * 1.05, 0.04 + L * 0.5, -0.07]], (t) => mix(0.015, 0.012, t) * (1 + 0.05 * Math.sin(t * 30)), { n: 10, seg: 8, cap0: 0.004, cap1: 0.011, up: [0, 0, -1] }), GL);
    }
    kit.add(tube([[0.045, -0.02, -0.01], [0.07, 0.01, -0.035], [0.06, 0.03, -0.06]], (t) => mix(0.017, 0.013, t), { n: 10, seg: 9, cap0: 0.004, cap1: 0.012 }), GL);
  },
  // 5 Warm Coin: both faces the same door
  (kit) => {
    const m = T(0, 0, 0, Math.PI / 2, 0, 0);
    kit.add(lathe([[0, -0.0035], [0.058, -0.0035], [0.0605, -0.004], [0.065, -0.0045], [0.067, -0.003], [0.067, 0.003], [0.065, 0.0045], [0.0605, 0.004], [0.058, 0.0035], [0, 0.0035]], 40), { c: 0xffffff, g: 2, sh: 1.2, gr: 0.4, e: 0.05, uv: 'coin', uvf: (p, n) => (Math.abs(n.z) > 0.5 ? [0.5 + (n.z > 0 ? p.x : -p.x) / 0.134, 0.5 + p.y / 0.134] : [0.02, 0.5]), paint: (p, n, C) => { if (Math.abs(n.z) <= 0.5) { C[0] = 0.62; C[1] = 0.44; C[2] = 0.16; } else if (Math.sin(Math.atan2(p.y, p.x) * 90) > 0 && Math.hypot(p.x, p.y) > 0.064) { C[0] *= 0.8; C[1] *= 0.8; C[2] *= 0.8; } } }, m);
    for (const sz of [-1, 1]) {
      kit.add(extrude([[-0.013, -0.024], [0.013, -0.024], [0.013, 0.016], [0.0, 0.025], [-0.013, 0.016]], 0.003, 0.0008, 4), { c: 0xc89438, g: 2.2, sh: 1.3, gr: 0.3, e: 0.05 }, T(0, 0.0, sz * 0.0042));
    }
  },
  // 6 Blank Tape: a cassette with a handwritten label
  (kit) => {
    const SH = { c: 0x1d1c1a, g: 1.2, sh: 0.8, gr: 0.5 };
    kit.add(rbox(0.18, 0.114, 0.022, 0.006, 2), SH);
    kit.add(extrude([[-0.06, -0.057], [0.06, -0.057], [0.05, -0.035], [-0.05, -0.035]], 0.026, 0.002, 1), SH);
    kit.add(rbox(0.15, 0.07, 0.002, 0.0008, 1), { c: 0xffffff, g: 0.5, gr: 0.4, uv: 'tape', uvf: (p, n, u, v) => (n.z < -0.5 ? [1 - u, v] : [u, v]) }, T(0, 0.012, -0.0112));
    kit.add(rbox(0.15, 0.07, 0.002, 0.0008, 1), { c: 0xffffff, g: 0.5, gr: 0.4, uv: 'tape' }, T(0, 0.012, 0.0112, 0, Math.PI, 0));
    for (const sz of [-1, 1]) {
      kit.add(rbox(0.08, 0.026, 0.002, 0.004, 1), { c: 0x060606, g: 2.4, sh: 1.8, gr: 0.2 }, T(0, 0.006, sz * 0.0123));
      for (const sx of [-1, 1]) {
        kit.add(lathe([[0.006, 0], [0.011, 0], [0.011, 0.002], [0.006, 0.002]], 12), { c: 0xe8e4d8, g: 1, gr: 0.3 }, T(sx * 0.03, 0.006, sz * 0.0115, sz * Math.PI / 2));
      }
      for (const [x, y] of [[-0.082, 0.049], [0.082, 0.049], [-0.082, -0.049], [0.082, -0.049], [0, -0.045]]) kit.add(new THREE.CylinderGeometry(0.0035, 0.0035, 0.002, 8), { c: 0x8a8a84, g: 1.6, sh: 0.6 }, T(x, y, sz * 0.0111, Math.PI / 2));
    }
  },
  // 7 Paper Bird: an origami crane folded from the wallpaper
  (kit) => {
    const K = [0, -0.03, 0], F = [0, 0.012, 0.05], B = [0, 0.012, -0.05], L = [-0.02, 0.014, 0], R = [0.02, 0.014, 0];
    const WL = [-0.17, 0.075, -0.035], WR = [0.17, 0.06, -0.02];
    const N1 = [-0.006, -0.014, 0.028], N2 = [0.006, -0.014, 0.028], NT = [0, 0.1, 0.13], H1 = [-0.004, 0.094, 0.122], H2 = [0.004, 0.094, 0.122], HT = [0, 0.074, 0.168];
    const T1 = [-0.006, -0.014, -0.028], T2 = [0.006, -0.014, -0.028], TT = [0, 0.115, -0.135];
    const tris = [
      [K, L, F], [K, B, L], [K, R, B], [K, F, R], // the body, folded underneath
      [F, L, WL], [L, B, WL], [F, WR, R], [R, WR, B], // wings, creased where they leave the body
      [N1, NT, F], [F, NT, N2], [H1, HT, H2], // neck and the folded head
      [T1, B, TT], [B, T2, TT], // tail
    ];
    const both = []; for (const t of tris) { both.push(t); both.push([t[0], t[2], t[1]]); }
    kit.add(facets(both, (q) => [0.5 + q[0] * 2.6, 0.5 + q[2] * 2.6 + q[1]]), { c: 0xffffff, g: 0.35, sh: 0.1, gr: 0.5, uv: 'paper', uvf: (p, n, u, v) => [u, v] });
  },
  // 8 Jar of Carpet: a sealed mason jar packed with damp fibres (glass is a second mesh)
  (kit) => {
    kit.add(tube([[0, -0.072, 0], [0, 0.045, 0]], (t, a) => 0.05, { n: 8, seg: 20, cap0: 0.004, cap1: 0.004, disp: (p, t, a, dir) => { const n = fbm3(p.x * 60, p.y * 60, p.z * 60); p.addScaledVector(dir, (n - 0.5) * 0.004); if (t > 0.98) p.y += (n - 0.5) * 0.02; } }),
      { c: 0x7a6a40, g: 0.7, sh: 0.6, gr: 0.9, paint: (p, n, C) => { const k = 0.55 + 0.7 * fbm3(p.x * 90, p.y * 30, p.z * 90); C[0] *= k; C[1] *= k; C[2] *= k * 0.9; if (p.y < -0.02) { C[0] *= 0.6; C[1] *= 0.6; C[2] *= 0.55; } } });
    kit.add(lathe([[0.046, 0.068], [0.047, 0.07], [0.047, 0.09], [0.045, 0.092], [0, 0.093]], 24), { c: 0xa48f5c, g: 1.5, sh: 0.8, gr: 0.6, paint: (p, n, C) => { if (Math.abs(Math.sin(p.y * 900)) < 0.3 && p.y < 0.088) { C[0] *= 0.6; C[1] *= 0.6; C[2] *= 0.6; } } });
  },
  // 9 Toothed Key: an old key with far too many teeth
  (kit) => {
    const KB = { c: 0x8f7a4c, g: 1.6, sh: 0.9, gr: 0.6, paint: (p, n, C) => { const k = 0.7 + 0.5 * fbm3(p.x * 80, p.y * 80, p.z * 80); C[0] *= k; C[1] *= k; C[2] *= k; } };
    const bow = new THREE.Shape(); bow.absarc(0, 0, 0.034, 0, Math.PI * 2, false);
    const hole = new THREE.Path(); hole.absarc(0, 0, 0.019, 0, Math.PI * 2, true); bow.holes.push(hole);
    const bg = new THREE.ExtrudeGeometry(bow, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 1, curveSegments: 14 }); bg.translate(0, 0, -0.002);
    kit.add(bg, KB, T(0, 0.085, 0));
    kit.add(new THREE.TorusGeometry(0.008, 0.003, 6, 12), KB, T(0, 0.048, 0, Math.PI / 2));
    kit.add(new THREE.CylinderGeometry(0.0055, 0.0055, 0.16, 10), KB, T(0, -0.02, 0));
    kit.add(new THREE.SphereGeometry(0.0055, 10, 6), KB, T(0, -0.1, 0));
    const R = mrand(31), pts = [[0, -0.095]];
    for (let k = 0; k < 14; k++) { const y = -0.095 + k * 0.0072; const d = 0.008 + R() * 0.016; pts.push([d, y + 0.0012], [d, y + 0.0048], [0.003, y + 0.006]); }
    pts.push([0, 0.006]);
    kit.add(extrude(pts, 0.004, 0.0006, 2), KB, T(0.004, 0, 0));
  },
  // 10 Desk Phone: beige office phone, handset on the cradle, coiled cord
  (kit) => {
    const BG = { c: 0xb7ab8c, g: 0.9, sh: 0.5, gr: 0.6 };
    kit.add(extrude([[-0.075, 0], [0.075, 0], [0.075, 0.03], [-0.06, 0.068], [-0.075, 0.066]], 0.19, 0.008, 4), BG, T(0, -0.05, 0, 0, Math.PI / 2, 0));
    // keypad on the slope
    const slope = Math.atan2(0.038, 0.135);
    for (let i = 0; i < 12; i++) {
      const c = i % 3, r = Math.floor(i / 3), u0 = c / 3, v1 = 1 - r / 4;
      const kz = 0.035 - r * 0.026, kx = -0.03 + c * 0.03, ky = -0.05 + 0.03 + 0.038 * (0.075 - kz) / 0.135 + 0.004;
      kit.add(new THREE.BoxGeometry(0.024, 0.008, 0.019), { c: 0xffffff, g: 0.8, sh: 0.3, gr: 0.5, uv: 'keypad', uvf: (p, n) => (n.y > 0.5 ? [u0 + 0.02 + ((p.x - kx) / 0.024 + 0.5) * 0.29, v1 - 0.02 - ((p.z - kz) / 0.019 + 0.5) * 0.21] : [u0 + 0.15, v1 - 0.23]) }, T(kx, ky, kz, slope, 0, 0));
    }
    // cradle and handset
    for (const sx of [-1, 1]) kit.add(rbox(0.026, 0.02, 0.04, 0.006, 1), BG, T(sx * 0.07, 0.02, -0.045));
    kit.add(tube([[-0.11, 0.035, -0.045], [-0.07, 0.06, -0.045], [0.07, 0.06, -0.045], [0.11, 0.035, -0.045]], (t, a) => sell(a, 0.021, 0.014), { n: 16, seg: 10, up: [0, 1, 0] }), BG);
    for (const sx of [-1, 1]) kit.add(lathe([[0, 0], [0.028, 0], [0.03, 0.006], [0.026, 0.024], [0, 0.026]], 16), { ...BG, paint: (p, n, C) => { if (n.y < -0.8 && Math.sin(p.x * 900) * Math.sin(p.z * 900) > 0.3) { C[0] *= 0.4; C[1] *= 0.4; C[2] *= 0.4; } } }, T(sx * 0.105, 0.012, -0.045, 0, 0, 0));
    // coiled cord from the handset down to the base
    const cord = []; const N = 120;
    for (let i = 0; i <= N; i++) { const t = i / N, a = t * Math.PI * 2 * 11, cx = 0.13 - 0.02 * t, cy = 0.02 - 0.06 * t, cz = -0.045 + 0.1 * t; cord.push([cx + Math.cos(a) * 0.007, cy + Math.sin(a) * 0.007, cz]); }
    kit.add(tube(cord, () => 0.0028, { n: 96, seg: 4, up: [0, 1, 0] }), { c: 0xa59a7e, g: 1, sh: 0.5, gr: 0.6 });
  },
  // 11 Glass Eye: veined white, a green-brown iris, wet
  (kit) => {
    kit.add(blob(28, 20, (p) => { const th = Math.acos(clamp(p.z, -1, 1)); p.multiplyScalar(0.06); p.z += 0.007 * gauss(th, 0.45); }), {
      c: 0xffffff, g: 2.6, sh: 2, ss: 0.3, gr: 0.2, uv: 'eye',
      uvf: (p) => { const r = Math.hypot(p.x, p.y), th = Math.atan2(r, p.z), q = (th / Math.PI) * 0.5, l = r || 1; return [0.5 + (p.x / l) * q, 0.5 + (p.y / l) * q]; },
    });
  },
];
const ART_GLASS = {
  2: () => lathe([[0, 0.022], [0.07, 0.019], [0.1, 0.013], [0.108, 0.008], [0.108, 0.006]].reverse().map((q) => q), 32),
  8: () => lathe([[0, -0.078], [0.05, -0.078], [0.054, -0.074], [0.056, -0.06], [0.056, 0.04], [0.054, 0.05], [0.046, 0.058], [0.046, 0.07], [0, 0.07]], 28),
};
export function makeArtifact(M, kind) {
  const k = ((kind % ART_BUILD.length) + ART_BUILD.length) % ART_BUILD.length;
  const g = new THREE.Group();
  g.add(meshOf(geo('art' + k, () => { const kit = new Kit(); ART_BUILD[k](kit); return kit.build(); }), M.hard));
  if (ART_GLASS[k]) {
    const gg = geo('artg' + k, () => { const q = ART_GLASS[k](); if (k === 2) q.rotateX(Math.PI / 2); return q; });
    const gm = new THREE.Mesh(gg, M.glass); gm.renderOrder = 2; g.add(gm);
  }
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
      // the pack's double exit door needs ~2.1 m of straight wall; otherwise the procedural door stays
      // (it may slide up to one cell along the wall to find room; the interaction point stays put)
      for (const o of [0, 0.5, -0.5, 1, -1]) {
        if (!wallSpan(d, e.x, e.z, e.dir, Math.floor(o - 2.25) + 1, 2.3, Math.ceil(o + 2.25) - 1)) continue;
        const th = m.rotation.y, t = [dr[1], dr[0]];
        const lx = (t[0] * Math.cos(th) - t[1] * Math.sin(th)) * o * S;
        whenPack(this.group, () => packExit(m, d, e, lx));
        break;
      }
    }
    // cosmetic clutter from the model pack, the same for everybody (hash of the sector), with colliders
    this.colliders = [];
    const plan = planClutter(d, wp);
    if (plan.length) whenPack(this.group, () => this._clutter(plan));
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
  _clutter(plan) {
    for (const c of plan) {
      const key = c.kind === 'window' ? 'window' : c.kind;
      const pr = PACK.props[key]; if (!pr) continue;
      const mats = PACK.propMats(key, CLUTTER_MAT[key] || {});
      const g = new THREE.Group(), inner = new THREE.Group();
      pr.parts.forEach((p, i) => inner.add(new THREE.Mesh(p.geometry, mats[i])));
      if (c.kind === 'window') {
        // a high window onto nothing: black behind the panes
        const bk = new THREE.Mesh(new THREE.PlaneGeometry(pr.size[0] * 0.94, pr.size[1] * 0.84), PACK.black ||= packBlack());
        bk.position.set(0, pr.size[1] / 2, -0.004); bk.rotation.y = Math.PI; inner.add(bk);
      }
      inner.rotation.set(c.rx || 0, 0, c.rz || 0);
      if (c.rx || c.rz) {
        // fallen over: put the lowest point on the floor and centre the footprint where it was planned
        const bb = new THREE.Box3().setFromBufferAttribute(pr.geometry.attributes.position);
        inner.updateMatrix(); bb.applyMatrix4(inner.matrix);
        inner.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
      }
      g.add(inner); g.position.set(c.x, c.y, c.z); g.rotation.y = c.yaw;
      this.group.add(g);
      if (c.col) this.colliders.push(c.col);
    }
  }
}
const CLUTTER_MAT = {
  armchair: { gloss: 0.22, sheen: 0, mapSat: 0.8, mapFlat: 0.72, fabric: 0.35, detScale: 3 },
  bookshelf: { gloss: 0.75, sheen: 0.2, mapSat: 0.62, mapFlat: 0.7, mapGain: 0.85, fabric: 0.25 },
  window: { gloss: 0.6, sheen: 0.15, mapSat: 0.7 },
};
function packBlack() { return PACK.M.obj(0x000000, { gloss: 0 }); }

// is there a straight run of wall behind cells (x + t*k, z + t*k), |k| <= half, with floor level and headroom?
function wallSpan(d, x, z, dir, half, minH, hi) {
  const dr = DIRS[dir], tx = dr[1], tz = dr[0], c0 = x + z * SEC, f0 = d.floor[c0];
  const k0 = hi === undefined ? -half : half, k1 = hi === undefined ? half : hi;
  for (let k = k0; k <= k1; k++) {
    const fx = x + tx * k, fz = z + tz * k, bx = fx + dr[0], bz = fz + dr[1];
    if (fx < 1 || fz < 1 || fx >= SEC - 1 || fz >= SEC - 1 || bx < 0 || bz < 0 || bx >= SEC || bz >= SEC) return false;
    const c = fx + fz * SEC;
    if (d.solid[c] || !d.solid[bx + bz * SEC] || Math.abs(d.floor[c] - f0) > 0.02 || d.ceil[c] - f0 < minH) return false;
  }
  return true;
}

function packExit(m, d, e, lx = 0) {
  const door = PACK.props.exitDoor; if (!door) return;
  const c0 = e.x + e.z * SEC, head = d.ceil[c0] - e.y;
  const g = new THREE.Group();
  const dm = PACK.propMats('exitDoor', { gloss: 0.7, sheen: 0.25, mapFlat: 0.75, mapSat: 0.8 });
  door.parts.forEach((p, i) => g.add(new THREE.Mesh(p.geometry, dm[i])));
  const sign = PACK.props.exitSign;
  if (sign && head > 2.42) {
    const sm = PACK.propMats('exitSign', { gloss: 0.8, mapEmis: 0.35, flicker: true }, { gloss: 1, mapEmis: 2.6, mapFlat: 1, flicker: true });
    const sg = new THREE.Group(); sign.parts.forEach((p, i) => sg.add(new THREE.Mesh(p.geometry, sm[i])));
    const k = clamp((head - door.size[1] - 0.06) / sign.size[1], 1, 1.5);
    sg.scale.setScalar(k); sg.position.y = Math.min(door.size[1] + 0.03, head - sign.size[1] * k - 0.02);
    g.add(sg);
  }
  // m is 0.24 m out from the cell centre with +z into the wall; the wall face is 0.3 m out
  g.position.set(lx, 0, 0.063);
  for (const ch of [...m.children]) m.remove(ch);
  m.add(g);
}

// Clutter plan for one sector (no pack needed): armchairs and bookshelves tucked against walls and
// into corners, some tipped over, and once in a while a high window onto blackness.
// Each entry: { kind, x, y, z, yaw, rx, rz, lift, col: { x, z, c, s, hx, hz } } in world metres.
const CLUT = { armchair: [1.3, 1.28, 1.33], bookshelf: [0.92, 0.43, 1.23] }; // width, depth, height
function planClutter(d, wp) {
  const rng = mulberry32(hash3(d.sx * 7919 + 13, d.sz * 104729 + 7, 0x5eed));
  const out = [], taken = [];
  const busy = [];
  for (const it of d.items) busy.push([it.x, it.z, 2]);
  if (d.artifact) busy.push([d.artifact.x, d.artifact.z, 3]);
  if (d.exit) busy.push([d.exit.x, d.exit.z, 4]);
  for (const mk of d.marks) busy.push([mk.x, mk.z, 2]);
  const near = (x, z) => busy.some(([bx, bz, r]) => Math.abs(bx - x) <= r && Math.abs(bz - z) <= r) || taken.some(([bx, bz, r]) => Math.abs(bx - x) <= r && Math.abs(bz - z) <= r);
  const open = (lx, lz, f0) => { // lx, lz: sector-local metres
    const cx = Math.floor(lx / S), cz = Math.floor(lz / S);
    if (cx < 1 || cz < 1 || cx >= SEC - 1 || cz >= SEC - 1) return false;
    const c = cx + cz * SEC; return !d.solid[c] && Math.abs(d.floor[c] - f0) < 0.02;
  };
  const n = rng() < 0.4 ? 0 : rng() < 0.7 ? 1 : 2;
  for (let k = 0; k < n; k++) {
    for (let tries = 0; tries < 30; tries++) {
      const x = 3 + Math.floor(rng() * (SEC - 6)), z = 3 + Math.floor(rng() * (SEC - 6)), c = x + z * SEC;
      const kind = rng() < 0.5 ? 'armchair' : 'bookshelf', tip = rng() < 0.3, jit = rng();
      if (d.solid[c] || near(x, z)) continue;
      let dir = -1; const d0 = Math.floor(rng() * 4);
      for (let q = 0; q < 4; q++) { const kk = (d0 + q) % 4; if (d.solid[(x + DIRS[kk][0]) + (z + DIRS[kk][1]) * SEC]) { dir = kk; break; } }
      if (dir < 0) continue;
      const dr = DIRS[dir], t = [dr[1], dr[0]], f0 = d.floor[c];
      // corner? (a side wall next to us)
      let side = 0;
      if (d.solid[(x + t[0]) + (z + t[1]) * SEC]) side = 1; else if (d.solid[(x - t[0]) + (z - t[1]) * SEC]) side = -1;
      const [W0, D0, Hh] = CLUT[kind];
      // tipped: the armchair lies on its back (top towards the wall), the bookshelf on its side
      const W = tip && kind === 'bookshelf' ? Hh : W0, D = tip && kind === 'armchair' ? Hh : D0;
      const ht = !tip ? Hh : kind === 'armchair' ? D0 : W0;
      if (d.ceil[c] - f0 < ht + 0.2) continue;
      const lcx = (x + 0.5) * S, lcz = (z + 0.5) * S;
      const along = side ? side * (0.3 - W / 2 - 0.03) : (jit - 0.5) * 0.3;
      const gap = 0.03 + jit * 0.05;
      const cxm = lcx + dr[0] * (0.3 - D / 2 - gap) + t[0] * along, czm = lcz + dr[1] * (0.3 - D / 2 - gap) + t[1] * along;
      // footprint free, and 1.5 m clear in front of it so it never closes a corridor
      let ok = true;
      for (let a = -W / 2 + 0.05; a <= W / 2 - 0.05 + 1e-6 && ok; a += 0.25) for (let b = -D / 2 + 0.05; b <= D / 2 + 1.5 && ok; b += 0.25) {
        const px = cxm + t[0] * a - dr[0] * b, pz = czm + t[1] * a - dr[1] * b;
        if (!open(px, pz, f0)) ok = false;
      }
      if (!ok) continue;
      const yaw = DIRYAW[dir] + Math.PI + (tip ? 0 : (jit - 0.5) * 0.18);
      const [wx0, wz0] = wp(0, 0), ox = wx0 - 0.5 * S, oz = wz0 - 0.5 * S;
      const e = { kind, x: ox + cxm, y: f0, z: oz + czm, yaw, rx: 0, rz: 0, lift: 0 };
      if (tip) { if (kind === 'armchair') e.rx = Math.PI / 2; else e.rz = (jit < 0.5 ? 1 : -1) * Math.PI / 2; }
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      e.col = { x: e.x, z: e.z, c: cy, s: sy, hx: W / 2, hz: D / 2 };
      out.push(e); taken.push([x, z, 3]);
      break;
    }
  }
  // a high window onto blackness: rare
  if (rng() < 0.14) {
    for (let tries = 0; tries < 30; tries++) {
      const x = 4 + Math.floor(rng() * (SEC - 8)), z = 4 + Math.floor(rng() * (SEC - 8)), c = x + z * SEC;
      if (d.solid[c] || near(x, z)) continue;
      let dir = -1; for (let q = 0; q < 4; q++) if (d.solid[(x + DIRS[q][0]) + (z + DIRS[q][1]) * SEC]) { dir = q; break; }
      if (dir < 0 || !wallSpan(d, x, z, dir, 2, 2.45)) continue;
      const dr = DIRS[dir], [wx, wz] = wp(x, z), f0 = d.floor[c];
      out.push({ kind: 'window', x: wx + dr[0] * 0.303, y: f0 + Math.min(1.45, d.ceil[c] - f0 - 0.95), z: wz + dr[1] * 0.303, yaw: DIRYAW[dir] + Math.PI });
      taken.push([x, z, 3]);
      break;
    }
  }
  return out;
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

// ======================================================================
// Optional model pack (dist/assets/pack, CC BY 4.0, credits in assets.js). It loads once, in the
// background, after play starts (startPack). Until it arrives, or for any piece that failed, the
// procedural models above stay; objects built before it arrived swap in place when it lands.
// ======================================================================
let PACK = null, packAsked = false;
const packWaiting = new Set();
const weak = typeof WeakRef !== 'undefined' ? (o) => new WeakRef(o) : (o) => ({ deref: () => o });
// run fn now if the pack is here, else when it arrives (only while obj is still alive)
function whenPack(obj, fn) {
  if (PACK) { fn(); return; }
  const u = obj.userData; if (!u.onPack) { u.onPack = []; packWaiting.add(weak(obj)); }
  u.onPack.push(fn);
}
export function packReady() { return !!PACK; }
export function startPack(M, delay = 1200) {
  if (packAsked) return; packAsked = true;
  setTimeout(() => {
    import('./assets.js').then((A) => A.loadPack({ anisotropy: 4 })).then((pk) => {
      PACK = buildPack(pk, M);
      for (const r of packWaiting) {
        const o = r.deref(); const fs = o && o.userData.onPack;
        if (fs) { o.userData.onPack = null; for (const f of fs) { try { f(); } catch (e) { console.warn('model pack swap', e); } } }
      }
      packWaiting.clear();
    }).catch((e) => console.warn('model pack', e));
  }, delay);
}
// One of each pack suit, built ahead of time so the first monster or the first other player does not
// cost a frozen second (texture work, shader compile, upload). Entities shows it for a few frames,
// shrunk to nothing, right after the pack lands.
export function packWarmSuit(M, hollow) {
  if (!PACK) return null;
  const g = makeSuit(M, hollow); g.traverse((o) => { o.frustumCulled = false; });
  g.scale.setScalar(0.001);
  return g;
}
const PACK_SKINNED = true; // one skinned mesh per suit (no joint gaps); false = six rigid parts

function buildPack(pk, M) {
  const o = M.obj, detail = M.detail;
  // baked-lit textures: keep most colour, flatten most of the baked light, cool the warm cast a little
  const mat = (part, opt = {}) => o(part.color ? part.color.getHex() : 0xffffff, { map: part.map || null, detail, gloss: 0.5, mapSat: 0.85, mapFlat: 0.7, mapTint: 0xfff4e6, ...opt });
  const P = { pk, M, props: pk.props || {}, suits: pk.suits || {}, mats: new Map() };
  const once = (k, f) => { let m = P.mats.get(k); if (!m) { m = f(); P.mats.set(k, m); } return m; };
  P.propMats = (key, opt, optE) => once(key, () => (P.props[key] ? P.props[key].parts.map((p) => mat(p, p.emissive ? optE || opt : opt)) : []));
  P.suitMat = (hollow) => once(hollow ? 'suitH' : 'suitP', () => {
    const s = P.suits[hollow ? 'hazmat' : 'operator'];
    return mat({ map: hollow ? emptyFaceMap(s) : s.map }, hollow ? { gloss: 0.6, sheen: 0.35, mapGain: 0.78, mapSat: 0.78, fabric: 0.55, detScale: 3 } : { gloss: 0.75, sheen: 0.3, mapGain: 0.95 });
  });
  return P;
}

// The Hollow is an empty suit: the face that shows through the mask lens is painted out of a copy
// of the atlas (skin-coloured texels inside the triangles in front of the face become black rubber),
// so the lens looks into nothing.
function emptyFaceMap(s) {
  const img = s.map && s.map.image; if (!img) return s.map;
  const W = img.width || 1024, H = img.height || 1024;
  // the triangles in front of the face, and the patch of the atlas they cover (only that patch is read back)
  const g = s.geometry, pos = g.attributes.position, uv = g.attributes.uv, idx = g.index;
  const n = idx ? idx.count : pos.count, vi = (k) => (idx ? idx.getX(k) : k);
  const tris = []; let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let k = 0; k < n; k += 3) {
    const a = vi(k), b = vi(k + 1), c = vi(k + 2);
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    if (!(z < -0.05 && Math.abs(x) < 0.085 && y > 1.56 && y < 1.78)) continue;
    const t = [uv.getX(a) * W, uv.getY(a) * H, uv.getX(b) * W, uv.getY(b) * H, uv.getX(c) * W, uv.getY(c) * H];
    for (let i = 0; i < 6; i += 2) { x0 = Math.min(x0, t[i]); x1 = Math.max(x1, t[i]); y0 = Math.min(y0, t[i + 1]); y1 = Math.max(y1, t[i + 1]); }
    tris.push(t);
  }
  x0 = Math.max(0, Math.floor(x0) - 1); y0 = Math.max(0, Math.floor(y0) - 1); x1 = Math.min(W, Math.ceil(x1) + 1); y1 = Math.min(H, Math.ceil(y1) + 1);
  const w = x1 - x0, h = y1 - y0;
  if (!tris.length || w <= 0 || h <= 0) return s.map;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0, W, H);
  const mk = document.createElement('canvas'); mk.width = w; mk.height = h;
  const mx = mk.getContext('2d', { willReadFrequently: true }); mx.fillStyle = '#fff'; mx.translate(-x0, -y0);
  for (const t of tris) { mx.beginPath(); mx.moveTo(t[0], t[1]); mx.lineTo(t[2], t[3]); mx.lineTo(t[4], t[5]); mx.closePath(); mx.fill(); }
  const im = cx.getImageData(x0, y0, w, h), d = im.data, m = mx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < d.length; i += 4) {
    if (m[i] < 128) continue;
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    if (r > gg + 8 && gg >= b * 0.9 && b > r * 0.36 && r + gg + b > 120) { const k = 0.06 + 0.04 * Math.random(); d[i] = r * k; d[i + 1] = gg * k; d[i + 2] = b * k; }
  }
  cx.putImageData(im, x0, y0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.flipY = s.map.flipY; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
}
const SUIT_PARTS_IDX = { torso: 0, head: 1, armL: 2, armR: 3, legL: 4, legR: 5 };

function torchGeo() {
  const kit = new Kit();
  kit.add(lathe([[0, 0], [0.016, 0], [0.017, 0.004], [0.017, 0.11], [0.022, 0.13], [0.024, 0.16], [0.024, 0.172], [0.02, 0.175], [0, 0.175]], 14),
    { c: 0x1d1d1c, g: 1.4, sh: 0.8, gr: 0.3, paint: (p, n, C, S) => { if (p.y < 0.003 && n.y < -0.7) { C[0] = 1; C[1] = 0.95; C[2] = 0.8; S[3] = 0.3; S[0] = 2; } else if (Math.abs(Math.sin(p.y * 500)) < 0.25 && p.y > 0.05) { C[0] *= 0.5; C[1] *= 0.5; C[2] *= 0.5; } } });
  return kit.build();
}

// swap a makeSuit group onto the pack suit (keeps the group, its tag and its userData)
function packSuit(g, M) {
  const u = g.userData, s = PACK.suits[u.hollow ? 'hazmat' : 'operator'];
  if (!s) return;
  const mt = PACK.suitMat(u.hollow);
  let mesh, bones;
  if (PACK_SKINNED && s.skinned && s.rig) {
    const gm = s.skinned;
    mesh = new THREE.SkinnedMesh(gm, mt);
    const r = s.rig(); mesh.add(r.root); mesh.bind(r.skeleton); bones = r.bones;
    mesh.boundingSphere = new THREE.Sphere(new V3(0, 0.95, 0), 1.3);
  } else {
    mesh = new THREE.Group(); bones = {};
    for (const k of Object.keys(SUIT_PARTS_IDX)) { if (!s.parts[k]) return; bones[k] = new THREE.Group(); bones[k].add(new THREE.Mesh(s.parts[k].geometry, mt)); }
    bones.torso.position.copy(s.pivots.torso); mesh.add(bones.torso);
    for (const k of Object.keys(SUIT_PARTS_IDX)) if (k !== 'torso') { bones[k].position.copy(s.pivots[k]).sub(s.pivots.torso); bones.torso.add(bones[k]); }
  }
  for (const k in bones) bones[k].userData.rest = bones[k].position.clone();
  if (!u.hollow && s.parts.armR) {
    // the light the other players carry, in the right fist, lens out of the bottom of the hand
    const bb = s.parts.armR.geometry.boundingBox, t = new THREE.Mesh(geo('ptorch', torchGeo), M.hard);
    t.position.set((bb.min.x + bb.max.x) / 2, bb.min.y + 0.02, (bb.min.z + bb.max.z) / 2 - 0.01);
    bones.armR.add(t);
  }
  g.remove(u.mesh); g.add(mesh);
  u.mesh = mesh; u.pk = { bones, tw: 0, twT: 1 + Math.random() * 3, roll: 0.3 };
  animPack(g, 1 / 60, 0, false, 0);
}

// Pack suits: six parts. Rigid parts show ragged hips past ~0.45 rad of leg swing and the yellow
// suit's sleeves are fused to its torso, so limbs move little; the body does the walking.
function animPack(g, dt, speed, crouch, pitch) {
  const u = g.userData, P = u.pk, b = P.bones, H = u.hollow, sp = u.sp;
  dt = Math.min(dt, 0.05);
  const mv = speed > 0.15; u.t += dt;
  const om = 3 + speed * 2.4; if (mv) u.ph += dt * om;
  u.wk += ((mv ? Math.min(speed / 2.2, 1.4) : 0) - u.wk) * (1 - Math.exp(-5 * dt));
  u.cr += ((crouch ? 1 : 0) - u.cr) * (1 - Math.exp(-8 * dt));
  const w = Math.min(u.wk, 1), cr = u.cr, ph = u.ph, s = Math.sin(ph), c = Math.cos(ph), t = u.t;
  const br = Math.sin(t * 1.7 + u.seed);
  const T0 = b.torso.userData.rest;
  if (H) {
    // stands slightly wrong: slumped, hip cocked, head dropped onto one shoulder, and it twitches
    P.twT -= dt;
    if (P.twT <= 0) { P.twT = 0.6 + Math.random() * 3.5; P.roll = (Math.random() < 0.7 ? 0.32 : -0.12) + Math.random() * 0.12; P.tw = (Math.random() - 0.5) * 0.5; }
    const roll = spring(sp, 0, P.roll, 140, 9, dt), yawH = spring(sp, 2, P.tw, 120, 8, dt);
    b.torso.position.set(T0.x + 0.018, T0.y - 0.02 + 0.012 * w * Math.abs(c), T0.z);
    b.torso.rotation.set(-0.1 - 0.05 * w, s * 0.05 * w, 0.06 + s * 0.03 * w);
    b.head.rotation.set(-0.32, yawH, roll);
    const aw = 0.07 * w * s; // fused sleeves: a small swing only
    b.armL.rotation.set(0.1 + 0.1 - aw, 0, 0.0); b.armR.rotation.set(0.1 + 0.05 + aw, 0, 0);
    b.armR.position.y = b.armR.userData.rest.y - 0.025;
    const la = 0.24 * w;
    b.legL.rotation.set(0.1 + s * la, 0, -0.04); b.legR.rotation.set(0.1 - s * la, 0.08, 0.02);
    return;
  }
  // players
  const legA = 0.42 * w, drop = cr * 0.33;
  const lean = -0.06 * w - cr * 0.45 + br * 0.006;
  b.torso.position.set(T0.x + c * 0.018 * w, T0.y + 0.025 * w * Math.cos(2 * ph) - 0.012 * w - drop + br * 0.003, T0.z + cr * 0.05);
  b.torso.rotation.set(lean, s * 0.09 * w, -c * 0.03 * w);
  b.torso.scale.set(1 + br * 0.006, 1, 1 + br * 0.008);
  // legs stay under the body (cancel the lean), swing while walking, fold forward to crouch
  // crouch: a wide, low squat (no knees to bend, so the legs open and fold forward together)
  const fold = cr * 0.7;
  b.legL.rotation.set(-lean + s * legA + fold, -cr * 0.3, -0.03 - cr * 0.42);
  b.legR.rotation.set(-lean - s * legA + fold, cr * 0.3, 0.03 + cr * 0.42);
  b.armL.rotation.set(-s * 0.32 * w + cr * 0.5 + 0.05, 0, -0.06);
  // the light arm points where they look
  const aim = clamp(1.32 + pitch * 0.9, 0.2, 2.6) - lean * 0.6;
  b.armR.rotation.set(aim + s * 0.03 * w, 0, 0.12);
  b.head.rotation.set(clamp(pitch * 0.6 - lean * 0.7, -0.6, 0.6), (1 - w) * Math.sin(t * 0.23 + u.seed * 2) * 0.22, Math.sin(t * 0.17 + u.seed) * 0.04 * (1 - w));
}
