// Dressing for the other places (0.3): numbered hotel doors, sconces, pipe runs, valves, crates,
// puddles, drains, pool ladders, alarm strobes, signs and water coolers, from sector.decor
// (see biomes.js). No collision. Everything in a sector is merged into one mesh per material,
// so a sector costs a handful of draw calls however much dressing it has.
import * as THREE from './three.module.min.js';
import { S, SEC } from './util.js';
import { WATER } from './shaders.js';

const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
let MATS = null, SIGNS = null, DIGITS = null;

function makeMats(M) {
  if (MATS) return MATS;
  const o = M.obj, det = M.detail;
  MATS = {
    wood: o(0x4a2a16, { gloss: 0.8, detail: det, fabric: 0.35, bump: 0.0004, detScale: 2.5 }),
    brass: o(0x9a7430, { gloss: 1.8, detail: det, fabric: 0.35, sheen: 0.6 }),
    steel: o(0x55585a, { gloss: 1.1, detail: det, fabric: 0.7, bump: 0.0003, detScale: 3 }),
    rust: o(0x5b3620, { gloss: 0.45, detail: det, fabric: 1, bump: 0.0007, detScale: 3 }),
    green: o(0x2c4a3a, { gloss: 0.9, detail: det, fabric: 0.7, bump: 0.0003, detScale: 3 }),
    red: o(0x7a1410, { gloss: 1.0, detail: det, fabric: 0.5 }),
    crate: o(0x7b5a33, { gloss: 0.18, detail: det, fabric: 0.8, bump: 0.0006, detScale: 1.6 }),
    white: o(0xd6d6d0, { gloss: 1.0, detail: det, fabric: 0.25 }),
    chrome: o(0xc4c8ca, { gloss: 2.4, sheen: 1.3, detail: det }),
    dark: o(0x0e0e0d, { gloss: 0.5, detail: det, fabric: 0.3 }),
    glow: o(0xf6e2c0, { emis: 0xffb070, emisScale: 1.1, flicker: true, detail: det }),
    alarm: o(0x3a0604, { emis: 0xff1c0c, emisScale: 5, alarm: true, gloss: 1.4, detail: det }),
    bottle: o(0x8ab8e0, { gloss: 2.3, sheen: 1.5, alpha: 0.5, depthWrite: false, transparent: true, detail: det }),
  };
  // puddles: the pool water shader on a thin film (mirrors the ceiling and lamps), over a dark wet stain
  MATS.puddle = WATER.mat || o(0x060606, { gloss: 2.4, sheen: 1.8 });
  MATS.stain = o(0x000000, { alpha: 0.3, depthWrite: false, transparent: true, detail: det });
  MATS.stain.polygonOffset = true; MATS.stain.polygonOffsetFactor = -1; MATS.stain.polygonOffsetUnits = -1;  return MATS;
}
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
// Painted signs: 8 slots of 256 x 128 in a 512 x 512 atlas
// printed plaques for the SIGNS of util.js (sign v = index): This way, Turn back, Safe, Danger,
// Dead end, Exit?, It watches, Supplies
const SIGN_TEXT = [
  ['THIS WAY', '\u2192', '#e9eef0', '#1d4c70'], ['TURN BACK', '', '#f0ece0', '#8a1a14'], ['SAFE', 'ROOM', '#e8efe6', '#1e6a34'],
  ['DANGER', 'DO NOT STOP', '#e8b51a', '#141310'], ['DEAD END', '', '#d8d2b8', '#2a2a26'], ['EXIT', '?', '#0e3018', '#62ff96'],
  ['IT WATCHES', '', '#f0f0ec', '#b01810'], ['SUPPLIES', '\u2193', '#efe6cc', '#3a2614'],
];
function signAtlas() {
  if (SIGNS) return SIGNS;
  const c = canvas(512, 512), x = c.getContext('2d');
  SIGN_TEXT.forEach(([a, b, bg, fg], i) => {
    const ox = (i % 2) * 256, oy = ((i / 2) | 0) * 128;
    x.fillStyle = bg; x.fillRect(ox, oy, 256, 128);
    x.strokeStyle = fg; x.lineWidth = 5; x.strokeRect(ox + 8, oy + 8, 240, 112);
    x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `800 ${b ? 40 : 48}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`; x.fillText(a, ox + 128, oy + (b ? 46 : 64));
    if (b) { x.font = '700 26px "Helvetica Neue", Arial, sans-serif'; x.fillText(b, ox + 128, oy + 90); }
    for (let k = 0; k < 300; k++) { x.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; x.fillRect(ox + Math.random() * 256, oy + Math.random() * 128, 2, 2); }
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  SIGNS = t; return t;
}
// brass room-number digits, 10 slots of 64 x 128
function digitAtlas() {
  if (DIGITS) return DIGITS;
  const c = canvas(640, 128), x = c.getContext('2d');
  x.clearRect(0, 0, 640, 128); x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '700 104px Georgia, "Times New Roman", serif';
  for (let i = 0; i < 10; i++) { x.fillStyle = '#7a5418'; x.fillText(String(i), i * 64 + 34, 70); x.fillStyle = '#d6b060'; x.fillText(String(i), i * 64 + 32, 68); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  DIGITS = t; return t;
}

// ---- tiny mesh builder: per material arrays, merged at the end ----
class Acc {
  constructor() { this.p = []; this.n = []; this.uv = []; this.i = []; }
  quad(a, b, c, d, n, uv = [0, 0, 1, 0, 1, 1, 0, 1]) {
    const v = this.p.length / 3;
    this.p.push(...a, ...b, ...c, ...d); for (let k = 0; k < 4; k++) this.n.push(...n); this.uv.push(...uv);
    this.i.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
}
function build(accs, mats, group) {
  for (const k in accs) {
    const a = accs[k]; if (!a.i.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(a.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(a.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2));
    g.setIndex(a.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(a.i, 1) : new THREE.Uint16BufferAttribute(a.i, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats[k]); m.matrixAutoUpdate = false; group.add(m);
  }
}

// Build the dressing of one sector. M = props materials (M.obj factory, M.decal), d = sector data.
// Returns a THREE.Group (empty when there is nothing to show).
export function buildDecor(M, d) {
  const group = new THREE.Group();
  if (!d || !Array.isArray(d.decor) || !d.decor.length) return group;
  const mats = makeMats(M), accs = {};
  const A = (k) => accs[k] || (accs[k] = new Acc());
  const ox = d.sx * SEC, oz = d.sz * SEC;
  // oriented box: centre, half sizes along (t, up, n), frame t / n in plan
  const obox = (k, cx, cy, cz, hx, hy, hz, t, n, uvs) => {
    const P = (a, b, c) => [cx + t[0] * a + n[0] * c, cy + b, cz + t[1] * a + n[1] * c];
    const acc = A(k), F = (a, b, c, dd, nn, uv) => acc.quad(a, b, c, dd, nn, uv);
    const nx = [n[0], 0, n[1]], tx = [t[0], 0, t[1]];
    F(P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz), nx, uvs);                       // front (+n)
    F(P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz), [-n[0], 0, -n[1]]);         // back
    F(P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz), tx);                             // +t
    F(P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz), [-t[0], 0, -t[1]]);         // -t
    F(P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz), [0, 1, 0]);                      // top
    F(P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz), [0, -1, 0]);                 // bottom
  };
  // cylinder between two points
  const cyl = (k, a, b, r, seg = 10, caps = false) => {
    const ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...ax); if (L < 1e-4) return;
    const w = ax.map((v) => v / L), up = Math.abs(w[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let u = [w[1] * up[2] - w[2] * up[1], w[2] * up[0] - w[0] * up[2], w[0] * up[1] - w[1] * up[0]]; const ul = Math.hypot(...u); u = u.map((v) => v / ul);
    const v2 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    const acc = A(k);
    for (let s = 0; s < seg; s++) {
      const a0 = s / seg * Math.PI * 2, a1 = (s + 1) / seg * Math.PI * 2;
      const d0 = u.map((x, i) => Math.cos(a0) * x + Math.sin(a0) * v2[i]), d1 = u.map((x, i) => Math.cos(a1) * x + Math.sin(a1) * v2[i]);
      const p = (base, dd) => [base[0] + dd[0] * r, base[1] + dd[1] * r, base[2] + dd[2] * r];
      const v0 = acc.p.length / 3;
      acc.p.push(...p(a, d0), ...p(b, d0), ...p(b, d1), ...p(a, d1));
      acc.n.push(...d0, ...d0, ...d1, ...d1);
      acc.uv.push(s / seg, 0, s / seg, L, (s + 1) / seg, L, (s + 1) / seg, 0);
      acc.i.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
      if (caps) for (const [c, nn, f] of [[a, w.map((x) => -x), 1], [b, w, 0]]) {
        const vv = acc.p.length / 3; acc.p.push(...c, ...p(c, d0), ...p(c, d1)); acc.n.push(...nn, ...nn, ...nn); acc.uv.push(0.5, 0.5, 0, 0, 1, 0);
        if (f) acc.i.push(vv, vv + 2, vv + 1); else acc.i.push(vv, vv + 1, vv + 2);
      }
    }
  };
  // flat irregular blob on the floor (puddles)
  const blob = (k, cx, y, cz, r, seed, seg = 14) => {
    const acc = A(k), v0 = acc.p.length / 3;
    acc.p.push(cx, y, cz); acc.n.push(0, 1, 0); acc.uv.push(0.5, 0.5);
    for (let s = 0; s < seg; s++) {
      const a = s / seg * Math.PI * 2, rr = r * (0.7 + 0.45 * Math.abs(Math.sin(seed * 12.9898 + s * 1.7) * 43758.5453 % 1));
      acc.p.push(cx + Math.cos(a) * rr * 1.3, y, cz + Math.sin(a) * rr); acc.n.push(0, 1, 0); acc.uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let s = 0; s < seg; s++) acc.i.push(v0, v0 + 1 + ((s + 1) % seg), v0 + 1 + s);
  };
  // decal quad on a wall (signs, room numbers): uv rect [u0, v0, u1, v1]
  const decals = [];
  const wallQuad = (list, cx, cy, cz, hw, hh, t, n, uv) => {
    const P = (a, b) => [cx + t[0] * a, cy + b, cz + t[1] * a];
    list.push({ p: [...P(-hw, -hh), ...P(hw, -hh), ...P(hw, hh), ...P(-hw, hh)], n: [n[0], 0, n[1]], uv: [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]] });
  };
  const signQ = [], digitQ = [];

  for (const e of d.decor) {
    if (!e || typeof e.k !== 'string') continue;
    const ix = Math.floor(e.x), iz = Math.floor(e.z);
    const inside = ix >= 0 && iz >= 0 && ix < SEC && iz < SEC, ci = inside ? ix + iz * SEC : -1;
    const fl = inside ? d.floor[ci] : (e.y || 0), ce = inside ? d.ceil[ci] : fl + 2.6;
    const dir = D4[e.dir] || D4[0];
    const n = [-dir[0], -dir[1]], t = [n[1], -n[0]];   // n out of the wall, t to the right seen from the room
    const cx = (ox + e.x + 0.5) * S, cz = (oz + e.z + 0.5) * S;
    const wx = cx + dir[0] * S / 2, wz = cz + dir[1] * S / 2;          // on the wall face
    const at = (o) => [wx + n[0] * o, wz + n[1] * o];
    const h = ((e.x * 73.1 + e.z * 19.7) % 1 + 1) % 1;                  // per-piece variety
    switch (e.k) {
      case 'hdoor': {
        // panelled room door, casing, brass knob and number
        const [x0, z0] = at(0.025);
        obox('wood', x0, fl + 1.03, z0, 0.46, 1.03, 0.025, t, n);
        for (const sgn of [-1, 1]) { const [x1, z1] = at(0.012); obox('wood', x1 + t[0] * sgn * 0.52, fl + 1.1, z1 + t[1] * sgn * 0.52, 0.05, 1.1, 0.03, t, n); }
        { const [x1, z1] = at(0.012); obox('wood', x1, fl + 2.15, z1, 0.57, 0.05, 0.03, t, n); }
        for (const [py, ph] of [[1.5, 0.36], [0.55, 0.36]]) for (const sx of [-0.18, 0.18]) { const [x1, z1] = at(0.055); obox('wood', x1 + t[0] * sx, fl + py, z1 + t[1] * sx, 0.14, ph, 0.006, t, n); }
        { const [x1, z1] = at(0.07); obox('brass', x1 + t[0] * 0.36, fl + 1.0, z1 + t[1] * 0.36, 0.03, 0.03, 0.03, t, n); obox('brass', x1 + t[0] * 0.36, fl + 0.88, z1 + t[1] * 0.36, 0.012, 0.025, 0.008, t, n); }
        const num = String(Math.max(0, Math.round(e.v || 100 + Math.floor(h * 40))) % 1000);
        const [x2, z2] = at(0.052);
        obox('brass', x2, fl + 1.72, z2, 0.05 + num.length * 0.03, 0.065, 0.003, t, n);
        [...num].forEach((ch, i) => {
          const dgt = +ch, a = (i - (num.length - 1) / 2) * 0.056, [x3, z3] = at(0.057);
          wallQuad(digitQ, x3 + t[0] * a, fl + 1.72, z3 + t[1] * a, 0.028, 0.056, t, n, [dgt / 10, 0, (dgt + 1) / 10, 1]);
        });
        break;
      }
      case 'sconce': {
        const y = Math.min(ce - 0.35, fl + 1.75), [x0, z0] = at(0.012), [x1, z1] = at(0.11);
        obox('brass', x0, y, z0, 0.05, 0.08, 0.012, t, n);
        cyl('brass', [x0, y - 0.02, z0], [x1, y - 0.02, z1], 0.01, 6);
        cyl('glow', [x1, y - 0.04, z1], [x1, y + 0.11, z1], 0.065, 10, true);
        cyl('brass', [x1, y - 0.06, z1], [x1, y - 0.04, z1], 0.04, 8, true);
        break;
      }
      case 'pipe': {
        // a run of v cells along the wall in dir, toward +z (dir 0, 1) or +x (dir 2, 3), from this cell's
        // near edge; one to three pipes stacked on wall brackets, high on the wall
        const len = Math.max(1, e.v || 4) * S, run = e.dir < 2 ? [0, 1] : [1, 0];
        const sx0 = cx - run[0] * S / 2, sz0 = cz - run[1] * S / 2;
        const count = 1 + Math.floor(h * 2.99), top = Math.min(ce - 0.18, fl + 2.6);
        for (let k = 0; k < count; k++) {
          const hk = (h * 7.31 + k * 0.37) % 1, r = 0.03 + 0.055 * hk, off = 0.06 + r + 0.04 * k;
          const y = top - k * 0.22 - r, px0 = sx0 + dir[0] * (S / 2 - off), pz0 = sz0 + dir[1] * (S / 2 - off);
          const mk = hk < 0.4 ? 'rust' : hk < 0.75 ? 'steel' : 'green';
          cyl(mk, [px0, y, pz0], [px0 + run[0] * len, y, pz0 + run[1] * len], r, 10);
          for (let a = 0.3; a < len; a += 1.2) {
            const px = px0 + run[0] * a, pz = pz0 + run[1] * a;
            cyl(mk, [px - run[0] * 0.02, y, pz - run[1] * 0.02], [px + run[0] * 0.02, y, pz + run[1] * 0.02], r * 1.45, 10, true);
            cyl('steel', [px, y - r - 0.012, pz], [px + dir[0] * off, y - r - 0.012, pz + dir[1] * off], 0.012, 5);
          }
        }
        break;
      }
      case 'valve': {
        const y = fl + 1.15 + 0.3 * h, [x0, z0] = at(0.0), [x1, z1] = at(0.16), [x2, z2] = at(0.17);
        cyl('steel', [x0, y, z0], [x1, y, z1], 0.035, 8, true);
        // the hand wheel: a ring of short spokes and rim segments
        const R = 0.12 + 0.05 * h, seg = 12;
        for (let s = 0; s < seg; s++) {
          const a0 = s / seg * Math.PI * 2, a1 = (s + 1) / seg * Math.PI * 2;
          const P = (a) => [x2 + t[0] * Math.cos(a) * R, y + Math.sin(a) * R, z2 + t[1] * Math.cos(a) * R];
          cyl('red', P(a0), P(a1), 0.012, 5);
          if (s % 3 === 0) cyl('red', [x2, y, z2], P(a0), 0.008, 4);
        }
        // gauge beside it
        const [x3, z3] = at(0.05), gx = x3 + t[0] * 0.3, gz = z3 + t[1] * 0.3;
        cyl('steel', [x0 + t[0] * 0.3, y + 0.1, z0 + t[1] * 0.3], [gx, y + 0.1, gz], 0.01, 5);
        cyl('white', [gx, y + 0.1, gz], [gx + n[0] * 0.03, y + 0.1, gz + n[1] * 0.03], 0.06, 12, true);
        break;
      }
      case 'crate': {
        // stacked supply crates: plank faces, battens round the edges
        const sz = 0.32 + 0.1 * h, [x0, z0] = at(sz + 0.03);
        const stack = 1 + Math.floor(h * 2.4);
        let base = fl;
        for (let k = 0; k < stack; k++) {
          const s2 = sz * (1 - k * 0.12), y = base + s2, sh = k ? (h - 0.5) * 0.1 : 0; base += s2 * 2;
          const px = x0 + t[0] * sh, pz = z0 + t[1] * sh;
          obox('crate', px, y, pz, s2, s2, s2, t, n);
          for (const b of [-1, 1]) obox('crate', px, y + b * (s2 - 0.03), pz, s2 + 0.012, 0.03, s2 + 0.012, t, n);
          for (const b of [-1, 1]) obox('crate', px + t[0] * b * (s2 - 0.03), y, pz + t[1] * b * (s2 - 0.03), 0.03, s2 - 0.06, s2 + 0.012, t, n);
        }
        break;
      }
      case 'puddle': {
        const px = cx + (h - 0.5) * 0.3, pz = cz + (h * 7 % 1 - 0.5) * 0.3, pr = 0.25 + 0.35 * h;
        blob('stain', px, fl + 0.002, pz, pr * 1.18, h * 100, 20);
        blob('puddle', px, fl + 0.004, pz, pr, h * 100, 20);
        break;
      }
      case 'drain': {
        obox('steel', cx, fl + 0.002, cz, 0.12, 0.003, 0.12, [1, 0], [0, 1]);
        for (let k = -3; k <= 3; k++) obox('dark', cx + k * 0.03, fl + 0.0045, cz, 0.008, 0.001, 0.09, [1, 0], [0, 1]);
        break;
      }
      case 'ladder': {
        // stainless pool ladder: anchored on the dry rim, bent over the edge (dir points at the pool),
        // treads down to the pool floor
        const px2 = ix + dir[0], pz2 = iz + dir[1], pin = px2 >= 0 && pz2 >= 0 && px2 < SEC && pz2 < SEC;
        const low = pin && !d.solid[px2 + pz2 * SEC] ? d.floor[px2 + pz2 * SEC] : fl - 0.9;
        const top = fl + 0.9;
        // the handrails arch over the coping and drop into the pool
        const path = [[0.24, fl], [0.24, top], [0.2, top + 0.09], [0.1, top + 0.13], [0.0, top + 0.08], [-0.07, top - 0.06], [-0.1, top - 0.3], [-0.1, low]];
        for (const sx of [-0.24, 0.24]) {
          const pts = path.map(([o, y]) => { const [px, pz] = at(o); return [px + t[0] * sx, y, pz + t[1] * sx]; });
          for (let k = 0; k + 1 < pts.length; k++) cyl('chrome', pts[k], pts[k + 1], 0.022, 8);
        }
        for (let yy = fl - 0.25; yy > low + 0.12; yy -= 0.27) { const [x1, z1] = at(-0.06); obox('chrome', x1, yy, z1, 0.24, 0.012, 0.05, t, n); }
        break;
      }
      case 'strobe': {
        const y = Math.min(ce - 0.25, fl + 2.1), [x0, z0] = at(0.04), [x1, z1] = at(0.1);
        obox('dark', x0, y, z0, 0.07, 0.07, 0.04, t, n);
        cyl('alarm', [x0, y, z0], [x1, y, z1], 0.06, 12, true);
        break;
      }
      case 'sign': {
        const v = ((e.v | 0) % SIGN_TEXT.length + SIGN_TEXT.length) % SIGN_TEXT.length, y = Math.min(ce - 0.3, fl + 1.9), [x0, z0] = at(0.012);
        const u0 = (v % 2) * 0.5, v1 = 1 - ((v / 2) | 0) * 0.25;
        obox('dark', x0 - n[0] * 0.004, y, z0 - n[1] * 0.004, 0.3, 0.15, 0.008, t, n);
        wallQuad(signQ, x0 + n[0] * 0.006, y, z0 + n[1] * 0.006, 0.29, 0.145, t, n, [u0, v1 - 0.25, u0 + 0.5, v1]);
        break;
      }
      case 'cooler': {
        const [x0, z0] = at(0.2);
        obox('white', x0, fl + 0.5, z0, 0.15, 0.5, 0.16, t, n);
        obox('dark', x0 + n[0] * 0.161, fl + 0.82, z0 + n[1] * 0.161, 0.1, 0.06, 0.005, t, n);
        for (const sx of [-0.05, 0.05]) obox(sx < 0 ? 'red' : 'steel', x0 + n[0] * 0.17 + t[0] * sx, fl + 0.86, z0 + n[1] * 0.17 + t[1] * sx, 0.015, 0.02, 0.015, t, n);
        cyl('bottle', [x0, fl + 1.0, z0], [x0, fl + 1.34, z0], 0.13, 14, true);
        cyl('bottle', [x0, fl + 1.34, z0], [x0, fl + 1.4, z0], 0.05, 10, true);
        break;
      }
      default: break;   // unknown kinds are skipped
    }
  }
  build(accs, mats, group);
  for (const [list, map] of [[signQ, signAtlas()], [digitQ, digitAtlas()]]) {
    if (!list.length) continue;
    const g = new THREE.BufferGeometry(), p = [], nn = [], uv = [], ii = [];
    list.forEach((q, k) => { p.push(...q.p); for (let j = 0; j < 4; j++) nn.push(...q.n); uv.push(...q.uv); ii.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3); });
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(ii);
    g.computeBoundingSphere();
    const key = map === SIGNS ? '_signMat' : '_digitMat';
    if (!MATS[key]) MATS[key] = M.decal ? M.decal(map) : null;
    if (!MATS[key]) continue;
    const m = new THREE.Mesh(g, MATS[key]); m.matrixAutoUpdate = false; group.add(m);
  }
  return group;
}
