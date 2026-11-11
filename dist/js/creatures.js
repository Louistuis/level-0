// The 0.3 roster's bodies: the Hound, the Faceling, the Smiler, the horde, and the poses that
// turn a borrowed suit into the Skin-Stealer. Same toolkit as props.js (Kit, tubes, blobs,
// skinning); every geometry is built once, cached by geo(), and shared by every copy.
import * as THREE from './three.module.min.js';
import { propAtlas } from './textures.js';
import { Kit, tube, blob, rbox, lathe, boneSpec, skinned, geo, meshOf, keys, sell, mrand, fbm3, gauss, sstep, mix, T, TY, lin, legIK, spring, ik2, SUIT_B, makeTag } from './props.js';

const V3 = THREE.Vector3;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// Creature materials built from the shared object factory (same shader as M.skin, so no new
// program to compile): matte skin with strong bump for the Hound, cloth and skin for people.
const MATS = new WeakMap();
function creatureMat(M, key) {
  let o = MATS.get(M); if (!o) MATS.set(M, (o = {}));
  if (!o[key]) {
    const opt = key === 'hound' ? { bump: 0.0026, detScale: 7, sheen: 0.03, sss: 0.22, sssCol: 0x7a3a2c } : { bump: 0.0011, detScale: 9, sheen: 0.25, sss: 0.7, sssCol: 0xff6a50 };
    o[key] = M.obj(0xffffff, { vtx: true, atlas: propAtlas(), detail: M.detail, gloss: key === 'hound' ? 0.6 : 1, ...opt });
  }
  return o[key];
}

// ======================================================================
// Howler (the Longarm, reworked for 0.3): too tall, too thin, wet. Ribs and spine under the skin,
// an extra joint in every limb, hands that reach the floor, a head that is almost a face.
// ======================================================================
const HW_FING = [[-0.046, 0.3], [-0.016, 0.34], [0.012, 0.33], [0.037, 0.27]]; // [z, length] per finger
const HW_B = (() => {
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
    HW_FING.forEach(([fz, len], k) => {
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

const HW_RX = keys([[1.18, 0.085], [1.27, 0.122], [1.36, 0.108], [1.48, 0.07], [1.6, 0.078], [1.7, 0.122], [1.83, 0.148], [1.96, 0.15], [2.05, 0.15], [2.12, 0.09], [2.17, 0.05]]);
const HW_RZ = keys([[1.18, 0.065], [1.27, 0.082], [1.36, 0.072], [1.48, 0.052], [1.6, 0.06], [1.7, 0.095], [1.83, 0.108], [1.96, 0.104], [2.05, 0.09], [2.12, 0.06], [2.17, 0.045]]);

function* howlerGeo() {
  const kit = new Kit(HW_B);
  const SKIN = 0x2c2823, PALE = 0x6a6152, DARK = 0x0f0c0a;
  const sk = lin(SKIN), pa = lin(PALE), dk = lin(DARK);
  const ridge = [];
  // skin paint: mottled, pale where bone presses through (ridge > 0), dark in hollows
  const skin = (extra) => ({
    c: SKIN, g: 0.75, sh: 0.45, ss: 0.5, gr: 0.6,
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

  yield;
  // ---- torso: pelvis, a waist you could close a hand round, ribcage, spine, shoulder blades ----
  {
    const put = rec(0);
    const tor = tube([[0, 1.18, 0.07], [0, 1.45, 0.075], [0, 1.75, 0.04], [0, 2.0, 0.0], [0, 2.17, -0.035]], (t, a) => {
      const y = 1.18 + t * 0.99, front = Math.max(0, Math.cos(a));
      return sell(a, HW_RX(y), HW_RZ(y) * (1 - 0.3 * front * sstep(1.38, 1.5, y) * sstep(1.7, 1.6, y)), 2.2);
    }, {
      n: 56, seg: 30, cap0: 0.05, cap1: 0.02,
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
  yield;
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
      n: 16, seg: 18, cap0: 0.01, cap1: 0.01,
      disp: (p, t, a, dir) => { const sa = Math.sin(a), ca = Math.cos(a); const ten = gauss(Math.abs(sa) - 0.45, 0.15) * (ca > 0 ? 1 : 0); const tr = gauss(sa, 0.25) * (ca > 0 ? 1 : 0) * Math.pow(Math.abs(Math.sin(t * 30)), 2); p.addScaledVector(dir, ten * 0.007 + tr * 0.003); put(ten * 0.8 + tr * 0.5); },
    });
    part(nk, ['chest', 'neck', 'head'], ra);
  }

  yield;
  // ---- head: long skull, sockets set too low, no nose, a lipless mouth too wide ----
  {
    const hc = new V3(0, 2.41, -0.12), ra = [];
    const mouthY = (x) => -0.07 + 13 * x * x;
    const hd = blob(46, 38, (p) => {
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
      const hi = HW_B.findIndex((b) => b.name === 'head'), ji = HW_B.findIndex((b) => b.name === 'jaw'), ni = HW_B.findIndex((b) => b.name === 'neck');
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

  yield;
  // ---- arms: shoulder, upper arm, two forearms, hands with long fingers ----
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    yield;
    // clavicle ridge and shoulder knob
    part(blob(18, 14, (p) => { p.multiplyScalar(0.044); p.y *= 0.85; p.x *= 0.8; p.add(new V3(sx * 0.175, 2.07, 0.02)); }), ['chest', 'clav' + sd, 'uarm' + sd], null, (p, n, C) => { const k = sstep(0.0, 0.04, Math.abs(p.x) - 0.17); C[0] = mix(C[0], pa[0], k * 0.5); C[1] = mix(C[1], pa[1], k * 0.5); C[2] = mix(C[2], pa[2], k * 0.5); });
    const [ra, put] = recArr();
    const tE = 0.33, tJ = 0.655;
    const arm = tube([[sx * 0.19, 2.07, 0.02], [sx * 0.23, 1.55, 0.03], [sx * 0.26, 1.04, 0.0], [sx * 0.27, 0.46, -0.02]], (t) => {
      let r = keys([[0, 0.042], [0.15, 0.036], [0.3, 0.031], [0.5, 0.028], [0.64, 0.025], [0.85, 0.023], [1, 0.02]])(t);
      r += 0.014 * gauss(t - tE, 0.03) + 0.012 * gauss(t - tJ, 0.028) + 0.005 * gauss(t - 1, 0.03);
      return r;
    }, { n: 52, seg: 14, cap0: 0.02, cap1: 0.01, disp: (p, t, a, dir) => { const k = gauss(t - tE, 0.035) + gauss(t - tJ, 0.03); const ul = gauss(Math.cos(a) + 1, 0.4) * sstep(0.36, 0.42, t) * sstep(0.95, 0.85, t); p.addScaledVector(dir, ul * 0.003); put(k * 0.9 + ul * 0.4 - 0.15 * gauss(t - tE + 0.05, 0.02)); } });
    part(arm, ['clav' + sd, 'uarm' + sd, 'fa' + sd, 'fb' + sd, 'hand' + sd], ra);
    // narrow palm
    part(blob(16, 14, (p) => { p.set(p.x * 0.017, p.y * 0.068, p.z * 0.036); p.add(new V3(sx * 0.272, 0.4, -0.026)); }), ['fb' + sd, 'hand' + sd]);
    HW_FING.forEach(([fz, len], k) => {
      const [fa, putf] = recArr();
      const top = 0.352;
      const f = tube([[sx * 0.274, top, fz], [sx * 0.28, top - len * 0.5, fz - 0.01], [sx * 0.285, top - len, fz - 0.02]], (t) => mix(0.011, 0.0055, t) + 0.0035 * gauss(t, 0.06) + 0.003 * gauss(t - 0.5, 0.05) + 0.0025 * gauss(t - 0.78, 0.04), {
        n: 16, seg: 8, cap0: 0.006, cap1: 0.016, disp: (p, t) => putf(gauss(t, 0.06) + gauss(t - 0.5, 0.05) * 0.8 + gauss(t - 0.78, 0.04) * 0.6),
      });
      part(f, ['hand' + sd, `f${k}a${sd}`, `f${k}b${sd}`], fa, (p, n, C, S) => { if (p.y < top - len + 0.022) { C[0] = 0.03; C[1] = 0.028; C[2] = 0.022; S[0] = 1.8; } });
    });
    part(tube([[sx * 0.268, 0.415, -0.05], [sx * 0.262, 0.32, -0.07], [sx * 0.255, 0.23, -0.075]], (t) => mix(0.011, 0.006, t) + 0.003 * gauss(t - 0.5, 0.06), { n: 12, seg: 8, cap0: 0.006, cap1: 0.014 }), ['hand' + sd, 'thumb' + sd], null, (p, n, C, S) => { if (p.y < 0.25) { C[0] = 0.03; C[1] = 0.028; C[2] = 0.022; S[0] = 1.8; } });
  }

  yield;
  // ---- legs: knee forward, ankle high off the ground, long toes ----
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    yield;
    const [ra, put] = recArr();
    const lg = tube([[sx * 0.1, 1.3, 0.065], [sx * 0.125, 0.8, -0.1], [sx * 0.13, 0.32, 0.1], [sx * 0.13, 0.05, -0.02]], (t) => {
      return keys([[0, 0.066], [0.15, 0.054], [0.33, 0.04], [0.45, 0.036], [0.62, 0.03], [0.72, 0.026], [0.9, 0.022], [1, 0.02]])(t) + 0.014 * gauss(t - 0.36, 0.03) + 0.012 * gauss(t - 0.72, 0.03);
    }, { n: 50, seg: 14, cap0: 0.03, cap1: 0.012, disp: (p, t, a, dir) => { const sh = gauss(Math.cos(a) - 1, 0.4) * sstep(0.4, 0.45, t) * sstep(0.7, 0.62, t); p.addScaledVector(dir, sh * 0.004); put(gauss(t - 0.36, 0.035) + gauss(t - 0.72, 0.03) * 0.9 + sh * 0.5); } });
    part(lg, ['hips', 'thigh' + sd, 'shin' + sd, 'meta' + sd, 'toes' + sd], ra);
    for (let k = -1; k <= 1; k++) {
      const [ta, putt] = recArr();
      part(tube([[sx * 0.13, 0.05, -0.015], [sx * 0.13 + k * 0.025, 0.025, -0.09], [sx * 0.13 + k * 0.04, 0.012, -0.16 + Math.abs(k) * 0.02]], (t) => mix(0.013, 0.006, t) + 0.003 * gauss(t - 0.5, 0.07), { n: 10, seg: 8, cap0: 0.006, cap1: 0.012, disp: (p, t) => putt(gauss(t - 0.5, 0.07)) }),
        ['meta' + sd, 'toes' + sd], ta, (p, n, C, S) => { if (p.z < -0.15 + Math.abs(k) * 0.02) { C[0] = 0.03; C[1] = 0.028; C[2] = 0.022; S[0] = 1.8; } });
    }
  }
  yield;
  return kit.build();
}

export function makeHowler(M) {
  const gm = built('howler');
  const g = new THREE.Group();
  const { mesh, by } = skinned(gm, HW_B, M.skin, [[0, 1.3, -0.2], 1.9]);
  g.add(mesh);
  g.userData = { b: by, mesh, ph: 0, t: 0, seed: Math.random() * 100, wk: 0, tw: new Float32Array(24), sp: new Float32Array(20), twT: 0, lean: 0 };
  animHowler(g, 1 / 60, 0, {});
  return g;
}

const HW_R = (() => { const r = {}; for (const b of HW_B) { const v = b.b.clone().sub(b.a); r[b.name] = { len: v.length(), ang: Math.atan2(-v.z, -v.y) }; } return r; })();


// o: { chase 0..1, look (head yaw relative to the body, rad), pitch (head pitch), turn (rad/s, for leaning),
//      coil 0..1 (the wind-up before a blow), swing 0..1 (the blow itself), search 0..1 (sweeping, listening) }
// Gait is driven by distance travelled, so the feet stay planted at any speed or frame rate.
export function animHowler(g, dt, speed, o = {}) {
  const u = g.userData, b = u.b, sp = u.sp;
  dt = Math.min(Math.max(dt, 0), 0.05);
  u.t += dt; const t = u.t;
  const ch = o.chase || 0, coil = o.coil || 0, swing = o.swing || 0, search = o.search || 0;
  const stride = 0.55 + 0.2 * Math.min(speed, 4.5);           // metres per half cycle
  u.ph += (speed * dt / stride) * Math.PI;
  u.wk += (Math.min(speed / 1.6, 1.4) - u.wk) * (1 - Math.exp(-5 * dt));
  const w = Math.min(u.wk, 1.2), ph = u.ph, s = Math.sin(ph), c = Math.cos(ph);
  const A = Math.min(0.42, stride * 0.33) * Math.min(1, w * 1.5);
  const br = Math.sin(t * 0.9 + u.seed) + 0.3 * Math.sin(t * 2.3 + u.seed);
  // twitches: new targets now and then, reached through stiff springs (fast, never a cut)
  u.twT -= dt;
  if (u.twT <= 0) {
    const h = (k) => h3(Math.floor(t * 10), k, (u.seed * 7) | 0) * 2 - 1;
    u.twT = ch > 0.5 ? 0.12 + Math.abs(h(9)) * 0.25 : 0.5 + Math.abs(h(9)) * 1.8;
    u.tw[0] = h(1) * (0.4 + ch * 0.25); u.tw[1] = h(2) * 0.25; u.tw[2] = h(3) * 0.16 - 0.08;
    for (let k = 0; k < 10; k++) u.tw[4 + k] = h(10 + k);
  }
  const kq = ch > 0.5 ? 260 : 120, cq = ch > 0.5 ? 22 : 15;
  const roll = spring(sp, 8, u.tw[0], kq, cq, dt), twy = spring(sp, 10, u.tw[1], kq, cq, dt), nod = spring(sp, 12, u.tw[2], kq, cq, dt);
  // attention: the head turns to what it attends to, the neck takes part of it, both lag a little
  const lk = Math.max(-1.25, Math.min(1.25, (o.look || 0) + search * Math.sin(t * 0.9) * 0.9));
  const ly = spring(sp, 14, lk, 40, 9, dt);
  const lp = spring(sp, 16, Math.max(-0.5, Math.min(0.5, o.pitch || 0)), 40, 9, dt);
  // lean into turns
  u.lean = (u.lean || 0) + ((Math.max(-1, Math.min(1, (o.turn || 0) * 0.25)) * Math.min(1, speed / 2)) - (u.lean || 0)) * (1 - Math.exp(-6 * dt));
  // hips: low and forward when it runs; it rocks back to wind up and drops into the blow
  const hy = 1.27 - ch * 0.12 + 0.035 * w * Math.cos(2 * ph) - 0.03 * w + br * 0.004 - coil * 0.08 - swing * 0.05;
  const sway = Math.sin(t * 0.37 + u.seed) * 0.02 * (1 - w) + c * 0.035 * w;
  const hipZ = 0.06 + ch * 0.05 + coil * 0.06 - swing * 0.1;
  b.hips.position.set(sway, hy, hipZ);
  b.hips.rotation.set(0, s * 0.12 * w + ly * 0.1, -sway * 1.2 - u.lean * 0.12);
  // legs: plant the ball of the foot, keep the long metatarsal angled, toes flat
  const L1 = HW_R.thighL.len, L2 = HW_R.shinL.len, L3 = HW_R.metaL.len, a3 = HW_R.metaL.ang;
  for (let k = 0; k < 2; k++) {
    const sd = k ? 'R' : 'L', p2 = ph + k * Math.PI, ss = Math.sin(p2), cc = Math.cos(p2);
    const lift = Math.max(0, cc) * (0.14 + ch * 0.06) * w;
    const stance = (k ? 0.04 : -0.04) * (coil - swing); // one foot back to brace
    const bz = -0.02 - A * ss + stance, by2 = 0.05 + lift;
    const m3 = a3 - Math.max(0, cc) * 0.35 * w;
    const az = bz + Math.sin(m3) * L3, ay = by2 + Math.cos(m3) * L3;
    const dev2 = ik2(b['thigh' + sd], b['shin' + sd], hipZ, hy - 0.02, az, ay, L1, L2, HW_R['thigh' + sd].ang, HW_R['shin' + sd].ang, false);
    b['meta' + sd].rotation.x = (m3 - a3) - dev2;
    b['toes' + sd].rotation.x = -(m3 - a3) + Math.max(0, cc) * 0.5 * w - 0.05;
    b['thigh' + sd].rotation.z = (k ? 1 : -1) * 0.03 + sway + u.lean * 0.05;
  }
  // spine: hunched, more when it hunts; breathing in the ribs; it rears back to wind up
  const hunch = 0.2 + ch * 0.2 - coil * 0.35 + swing * 0.45;
  b.spine1.rotation.set(-hunch * 0.6 + br * 0.01, -s * 0.06 * w + ly * 0.12, sway * 0.6 + u.lean * 0.1);
  b.spine2.rotation.set(-hunch * 0.8, -s * 0.05 * w + ly * 0.12, u.lean * 0.08);
  b.chest.rotation.set(-hunch * 0.5 + br * 0.015, ly * 0.1, 0);
  b.chest.scale.set(1 + br * 0.012, 1, 1 + br * 0.02);
  const trem = Math.sin(t * 37) * 0.01 + Math.sin(t * 23) * 0.008;
  b.neck.rotation.set(0.02 + ch * 0.3 + nod * 0.5 + lp * 0.3, ly * 0.35 + twy * 0.5, roll * 0.5);
  b.head.rotation.set(ch * 0.25 + nod + trem + lp * 0.5 + (ch > 0.5 ? Math.sin(t * 31) * 0.06 * ch : 0), ly * 0.35 + twy, roll + trem * 0.5);
  b.jaw.rotation.x = 0.06 + ch * 0.4 + coil * 0.35 + swing * 0.2 + (ch > 0.3 ? Math.max(0, Math.sin(t * 19)) * 0.1 * ch : 0) + Math.max(0, br) * 0.03;
  // arms: hang and trail on springs, reach forward when it chases, go back and up, then come down
  const reach = ch * 1.6;
  for (let k = 0; k < 2; k++) {
    const sd = k ? 'R' : 'L', sx = k ? 1 : -1, sw = (k ? s : -s) * 0.22 * w;
    // the blow: both arms go up over the head (anticipation), then come down forward through the target
    let tgt = sw + reach * (k ? 0.92 : 1) + u.tw[4 + k] * 0.03;
    tgt = mix(tgt, 2.75 - k * 0.15, coil);
    tgt = mix(tgt, 0.55 + k * 0.1, swing);
    const a = spring(sp, k * 4, tgt, 30, 5, dt);
    b['clav' + sd].rotation.set(0, 0, sx * (0.05 + ch * 0.08 + coil * 0.12) - sx * br * 0.01);
    b['uarm' + sd].rotation.set(a, 0, sx * (0.05 + ch * 0.06 + coil * 0.25));
    b['fa' + sd].rotation.set(spring(sp, k * 4 + 2, 0.08 + ch * 0.35 + coil * 0.6 - swing * 0.2 + Math.max(0, sw) * 0.4, 22, 4, dt), 0, 0);
    b['fb' + sd].rotation.set(-0.12 + ch * 0.25 + coil * 0.3, 0, -sx * 0.05);
    b['hand' + sd].rotation.set(ch * 0.4 + coil * 0.3 + u.tw[6 + k] * 0.06, 0, sx * 0.05);
    for (let f = 0; f < 4; f++) {
      const spread = (f - 1.5) * (0.05 + ch * 0.12 + coil * 0.15);
      const curl = (0.12 + 0.18 * (0.5 + 0.5 * Math.sin(t * 1.3 + f * 1.7 + k * 3 + u.seed))) * (1 - ch) + ch * (0.5 + Math.sin(t * 9 + f) * 0.12) - coil * 0.2 + swing * 0.5;
      b[`f${f}a${sd}`].rotation.set(spread, 0, -sx * curl);
      b[`f${f}b${sd}`].rotation.set(0, 0, -sx * curl * 1.2 + u.tw[8 + f] * 0.04);
    }
    b['thumb' + sd].rotation.set(0, 0, -sx * (0.2 + ch * 0.3));
  }
}
function h3(x, y, z) { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

// ======================================================================
// Hound: a starved person on hands and feet. Spine, ribs, shoulder blades and hip bones
// under grey, bruised, dirty skin; hind legs folded like someone crouching; fingers and toes
// splayed into the carpet; the head hangs low and looks up through long matted black hair.
// Faces -Z. Rest pose is the crouch.
// ======================================================================
const HB = (() => {
  const L = [
    ['hips', null, [0, 0.72, 0.31], [0, 0.73, 0.12], 1.3],
    ['spine', 'hips', [0, 0.73, 0.12], [0, 0.69, -0.08], 1.3],
    ['chest', 'spine', [0, 0.69, -0.08], [0, 0.62, -0.26], 1.3],
    ['neck', 'chest', [0, 0.615, -0.27], [0, 0.53, -0.37], 0.9],
    ['head', 'neck', [0, 0.53, -0.37], [0, 0.5, -0.53], 1.1],
    ['jaw', 'head', [0, 0.47, -0.42], [0, 0.41, -0.52], 0.7],
  ];
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    L.push(['uarm' + sd, 'chest', [sx * 0.17, 0.62, -0.23], [sx * 0.25, 0.34, -0.17], 0.9]);
    L.push(['farm' + sd, 'uarm' + sd, [sx * 0.25, 0.34, -0.17], [sx * 0.215, 0.06, -0.3], 0.9]);
    L.push(['hand' + sd, 'farm' + sd, [sx * 0.215, 0.06, -0.3], [sx * 0.22, 0.01, -0.43], 0.7]);
    L.push(['thigh' + sd, 'hips', [sx * 0.115, 0.69, 0.31], [sx * 0.17, 0.31, 0.06], 1]);
    L.push(['shin' + sd, 'thigh' + sd, [sx * 0.17, 0.31, 0.06], [sx * 0.15, 0.13, 0.43], 1]);
    L.push(['foot' + sd, 'shin' + sd, [sx * 0.15, 0.13, 0.43], [sx * 0.15, 0.01, 0.29], 0.8]);
  }
  return boneSpec(L);
})();
const HOUND_HEAD = new V3(0, 0.49, -0.455), HOUND_TILT = 0.42;

function* houndGeo() {
  const kit = new Kit(HB);
  const SK = lin(0x5d5b56), PA = lin(0x8a857b), DK = lin(0x2a2420), BR = lin(0x55404c), YE = lin(0x8a8456), DI = lin(0x3a2f24), VE = lin(0x4a5262);
  const paintSkin = (p, C, S, r) => {
    const m = fbm3(p.x * 11, p.y * 11, p.z * 11), v = fbm3(p.x * 38 + 3, p.y * 38, p.z * 38);
    const k = 0.62 + 0.6 * m;
    C[0] = SK[0] * k; C[1] = SK[1] * k; C[2] = SK[2] * k;
    const mixc = (c, t) => { C[0] = mix(C[0], c[0], t); C[1] = mix(C[1], c[1], t); C[2] = mix(C[2], c[2], t); };
    // bruises: purple at the heart, yellow at the edge
    const b = fbm3(p.x * 7 + 11, p.y * 7, p.z * 7 - 4);
    if (b > 0.53) mixc(YE, clamp((b - 0.53) * 10, 0, 0.5));
    if (b > 0.58) mixc(BR, clamp((b - 0.58) * 8, 0, 0.8));
    // veins under thin skin
    if (Math.abs(v - 0.5) < 0.012) mixc(VE, 0.35);
    // bone pressing through, and the hollows between
    if (r > 0) { mixc(PA, clamp(r, 0, 1) * 0.4); S[0] = 0.3; } else if (r < 0) mixc(DK, clamp(-r, 0, 1) * 0.75);
    // filth: hands, feet, knees, belly
    const dirt = sstep(0.28, 0.03, p.y) * (0.55 + 0.6 * fbm3(p.x * 16, p.y * 16, p.z * 16)) + 0.55 * sstep(0.58, 0.72, fbm3(p.x * 5 - 7, p.y * 5, p.z * 5 + 2));
    mixc(DI, clamp(dirt, 0, 0.85));
  };
  const SKS = { c: 0xffffff, g: 0.22, sh: 0.04, ss: 0.6, gr: 0.9 };
  const part = (gm, bones, ra, extra) => kit.add(gm, { ...SKS, b: bones, paint: (p, n, C, S, i) => { paintSkin(p, C, S, ra ? ra[i] || 0 : 0); if (extra) extra(p, n, C, S, i); } });
  yield;
  // torso: buttocks to shoulders; pelvis, a waist you could close two hands round, the ribcage
  {
    const ra = [];
    const RX = keys([[0, 0.11], [0.1, 0.135], [0.22, 0.12], [0.38, 0.092], [0.52, 0.118], [0.7, 0.145], [0.86, 0.158], [1, 0.12]]);
    const RZ = keys([[0, 0.075], [0.1, 0.095], [0.22, 0.085], [0.38, 0.066], [0.52, 0.085], [0.7, 0.1], [0.86, 0.095], [1, 0.075]]);
    const LEN = 0.74;
    const tor = tube([[0, 0.72, 0.4], [0, 0.74, 0.22], [0, 0.712, 0.02], [0, 0.668, -0.13], [0, 0.6, -0.3]], (t, a) => sell(a, RX(t), RZ(t) * (Math.cos(a) < 0 ? 1 - 0.3 * sstep(0.24, 0.4, t) * sstep(0.62, 0.48, t) : 1), 2.2), {
      n: 60, seg: 30, up: [0, 1, 0], cap0: 0.06, cap1: 0.03,
      disp: (p, t, a, dir) => {
        const ca = Math.cos(a), sa = Math.abs(Math.sin(a));
        // spine: a row of knuckles all the way down the back
        const top = sstep(0.86, 0.985, ca) * sstep(0.03, 0.08, t) * sstep(0.99, 0.93, t);
        const vert = Math.pow(Math.max(0, Math.sin((t * LEN / 0.034) * Math.PI)), 2);
        let r = top * (0.005 + 0.011 * vert), q = top * (0.25 + vert * 0.6);
        // ribs, sloping, from the spine round to the breastbone, with the gaps between them
        const rz = sstep(0.48, 0.56, t) * sstep(0.95, 0.88, t) * sstep(0.2, 0.4, sa) * sstep(0.75, 0.45, ca);
        const rib = Math.pow(Math.max(0, Math.sin(((t * LEN + 0.03 * ca) / 0.03) * Math.PI)), 2.5) - 0.3;
        const rj = 0.6 + 0.8 * fbm3(p.x * 9, p.y * 30, p.z * 9); r += rz * rib * 0.007 * rj; q += rz * rib * 0.8 * rj;
        // shoulder blades: two plates standing up off the back, pushed up by the arms
        const sb = gauss(t - 0.8, 0.07) * gauss(sa - 0.45, 0.17) * (ca > 0.25 ? 1 : 0);
        r += sb * 0.03; q += sb * 0.9;
        // hip bones and the sacrum
        const hb = gauss(t - 0.13, 0.05) * gauss(sa - 0.78, 0.17) * (ca > -0.3 ? 1 : 0) + gauss(t - 0.05, 0.04) * sstep(0.8, 0.95, ca) * 0.6;
        r += hb * 0.022; q += hb * 0.9;
        r += (fbm3(p.x * 22, p.y * 22, p.z * 22) - 0.5) * 0.005;
        p.addScaledVector(dir, r); ra.push(clamp(q, -1, 1));
      },
    });
    yield;
    part(tor, ['hips', 'spine', 'chest', 'thighL', 'thighR', 'uarmL', 'uarmR', 'neck'], ra);
  }
  yield;
  // neck: thin and corded, the vertebrae showing at the back
  {
    const ra = [];
    part(tube([[0, 0.635, -0.24], [0, 0.585, -0.32], [0, 0.53, -0.395]], (t) => mix(0.05, 0.04, t), {
      n: 14, seg: 16, cap0: 0.01, cap1: 0.01, up: [0, 1, 0],
      disp: (p, t, a, dir) => { const ca = Math.cos(a), sa = Math.sin(a); const ten = gauss(Math.abs(sa) - 0.6, 0.15) * (ca < 0 ? 1 : 0); const vb = sstep(0.85, 0.98, ca) * Math.pow(Math.max(0, Math.sin(t * 9)), 2); p.addScaledVector(dir, ten * 0.008 + vb * 0.01); ra.push(ten * 0.7 + vb); },
    }), ['chest', 'neck', 'head'], ra);
  }
  yield;
  // head: a starved human skull hanging low; the eyes deep in their sockets, rolled up toward you;
  // the mouth a little open over crowded, broken teeth
  {
    const hc = HOUND_HEAD, ra = [], ax = new V3(1, 0, 0);
    const mouthY = (x) => -0.05 + 5 * x * x;
    const hd = blob(42, 34, (p) => {
      let x = p.x * 0.07 * (1 - 0.18 * sstep(0.0, -0.6, p.y)), y = p.y * (p.y > 0 ? 0.09 : 0.105), z = p.z * (p.z < 0 ? 0.1 : 0.095);
      let r = 0;
      if (p.z < -0.1) {
        const fw = sstep(-0.1, -0.5, p.z);
        for (const sx of [-1, 1]) {
          r -= 0.026 * gauss(Math.hypot(x - sx * 0.029, y - 0.014), 0.018) * fw;              // sockets
          r += 0.006 * gauss(Math.hypot(x - sx * 0.03, y - 0.037), 0.01) * fw;                // brow
          r += 0.008 * gauss(Math.hypot(x - sx * 0.05, y + 0.02), 0.014) * fw;                // cheekbones
          r -= 0.008 * gauss(Math.hypot(x - sx * 0.045, y + 0.05), 0.018) * fw;               // hollow cheeks
        }
        r += 0.009 * gauss(x, 0.007) * gauss(y + 0.005, 0.018) * fw;                           // nose
        const m = gauss(y - mouthY(x), 0.008) * sstep(0.062, 0.035, Math.abs(x));
        r -= 0.02 * m * fw;
        ra.push(clamp(-m * 1.5 + (r > 0 ? r * 60 : r * 25), -1, 1));
      } else ra.push(0);
      p.set(x, y, z); const l = p.length() || 1; p.multiplyScalar((l + r) / l);
      p.applyAxisAngle(ax, HOUND_TILT); p.add(hc);
    });
    const local = (p) => p.clone().sub(hc).applyAxisAngle(ax, -HOUND_TILT);
    yield;
    part(hd, ['head', 'jaw'], ra, (p, n, C, S) => {
      const q = local(p);
      if (q.y > 0.005 + 0.06 * sstep(-0.02, -0.08, q.z) || q.z > 0.02) { C[0] = 0.018; C[1] = 0.016; C[2] = 0.015; S[0] = 0.8; S[1] = 0.4; S[2] = 0; } // scalp under the hair
      if (q.z < -0.04 && Math.abs(q.y - mouthY(q.x)) < 0.008 && Math.abs(q.x) < 0.058) { C[0] = 0.06; C[1] = 0.012; C[2] = 0.012; S[1] = 1.2; }
      for (const sx of [-1, 1]) if (q.z < -0.03 && Math.hypot(q.x - sx * 0.029, q.y - 0.014) < 0.015) { C[0] = 0.012; C[1] = 0.01; C[2] = 0.01; }
    });
    const start = kit.SI.length / 4 - hd.attributes.position.count;
    const hi = HB.findIndex((b) => b.name === 'head'), ji = HB.findIndex((b) => b.name === 'jaw'), ni = HB.findIndex((b) => b.name === 'neck');
    for (let i = 0; i < hd.attributes.position.count; i++) {
      const q = local(new V3(kit.P[(start + i) * 3], kit.P[(start + i) * 3 + 1], kit.P[(start + i) * 3 + 2]));
      const j = sstep(mouthY(q.x) + 0.004, mouthY(q.x) - 0.016, q.y) * sstep(0.03, -0.04, q.z), nw = sstep(-0.06, -0.1, q.y) * 0.4;
      kit.SI.splice((start + i) * 4, 4, hi, ji, ni, 0); kit.SW.splice((start + i) * 4, 4, (1 - j) * (1 - nw), j * (1 - nw), nw, 0);
    }
    // eyes: wet, pale, looking up from the bottom of the sockets
    for (const sx of [-1, 1]) {
      const e = new V3(sx * 0.029, 0.01, -0.072).applyAxisAngle(ax, HOUND_TILT).add(hc);
      kit.add(blob(10, 8, (p) => { p.multiplyScalar(0.011); p.add(e); }), { c: 0xb8b2a0, g: 2.4, sh: 1.4, gr: 0.1, b: 'head', paint: (p, n, C) => { const d = p.clone().sub(e); if (d.y > 0.004 && d.z < -0.005) { C[0] = 0.02; C[1] = 0.02; C[2] = 0.02; } } });
    }
    // teeth: two crowded rows, crooked, some broken, yellowed
    const R = mrand(31);
    for (let k = 0; k < 34; k++) {
      if (R() < 0.1) continue;
      const up = k % 2 === 0, x = -0.046 + (Math.floor(k / 2) / 16) * 0.092 + (R() - 0.5) * 0.004;
      const L = (0.007 + R() * 0.008) * (R() < 0.15 ? 0.5 : 1);
      const q = new V3(x, mouthY(x) + (up ? 0.003 : -0.003), -Math.sqrt(Math.max(0, 1 - (x / 0.068) ** 2)) * 0.093 + 0.007 + (R() - 0.5) * 0.004).applyAxisAngle(ax, HOUND_TILT).add(hc);
      kit.add(new THREE.ConeGeometry(0.0032 + R() * 0.0015, L, 5, 1), { c: R() < 0.4 ? 0x9a8c62 : 0xc4b894, g: 1.3, sh: 0.6, gr: 0.75, b: up ? 'head' : 'jaw' }, T(q.x, q.y - (up ? -L * 0.1 : L * 0.1), q.z, (up ? Math.PI : 0) + HOUND_TILT + (R() - 0.5) * 0.4, 0, (R() - 0.5) * 0.6));
    }
  }
  yield;
  // hair: long, black, matted into ropes, hanging past the chin almost to the floor; parted
  // just enough in front for the face to look through
  {
    const R = mrand(77), ax = new V3(1, 0, 0), hc = HOUND_HEAD;
    const HC = { c: 0x0c0a09, g: 0.9, sh: 0.5, gr: 0.5, b: 'head', paint: (p, n, C) => { const v = 0.6 + fbm3(p.x * 60, p.y * 12, p.z * 60) * 0.8; C[0] *= v; C[1] *= v; C[2] *= v; } };
    for (let k = 0; k < 64; k++) {
      if ((k & 3) === 0) yield;
      // a root on the scalp: top, sides and back, plus a fringe at the front hairline
      const th = R() * Math.PI * 2, ph = R() * 1.25;
      let d = new V3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
      if (d.z < -0.55 && Math.abs(d.x) < 0.22) d.x = Math.sign(d.x || 1) * (0.22 + R() * 0.1); // the parting
      const root = new V3(d.x * 0.074, d.y * 0.094, d.z * 0.1).applyAxisAngle(ax, HOUND_TILT).add(hc);
      const out = new V3(d.x, d.y * 0.4, d.z).applyAxisAngle(ax, HOUND_TILT).normalize();
      const len = 0.2 + R() * 0.22 + (d.z < 0 ? 0.04 : 0.1);
      const p1 = root.clone().addScaledVector(out, 0.035);
      const p2 = p1.clone().add(new V3((R() - 0.5) * 0.04 + out.x * 0.03, -len * 0.45, out.z * 0.03 + (R() - 0.5) * 0.03));
      const p3 = p2.clone().add(new V3((R() - 0.5) * 0.05, -len * 0.55, (R() - 0.5) * 0.04));
      p3.y = Math.max(p3.y, 0.03);
      const r0 = 0.011 + R() * 0.007;
      kit.add(tube([[root.x, root.y, root.z], [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], [p3.x, p3.y, p3.z]], (t, a) => sell(a, r0 * (1 - 0.75 * t), r0 * 0.6 * (1 - 0.7 * t)) * (1 + 0.15 * Math.sin(t * 40 + k)), { n: 12, seg: 6, cap0: 0.004, cap1: 0.006, up: [out.x, 0, out.z] }), HC);
    }
  }
  yield;
  // arms: shoulder, a bony elbow pointing out and back, forearm with the ulna showing; hands flat
  // on the floor with the fingers splayed and dug in
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    yield;
    {
      const ra = [];
      part(tube([[sx * 0.15, 0.64, -0.23], [sx * 0.215, 0.49, -0.2], [sx * 0.25, 0.34, -0.17], [sx * 0.235, 0.2, -0.235], [sx * 0.215, 0.065, -0.3]], (t) => {
        return keys([[0, 0.046], [0.12, 0.044], [0.3, 0.031], [0.47, 0.03], [0.6, 0.029], [0.85, 0.023], [1, 0.021]])(t) + 0.012 * gauss(t - 0.12, 0.06) + 0.01 * gauss(t - 0.5, 0.035) + 0.005 * gauss(t - 1, 0.04);
      }, { n: 44, seg: 16, cap0: 0.02, cap1: 0.01, disp: (p, t, a, dir) => { const ul = gauss(Math.cos(a) + 1, 0.4) * sstep(0.52, 0.58, t) * sstep(0.98, 0.9, t); p.addScaledVector(dir, ul * 0.004); ra.push(gauss(t - 0.5, 0.04) * 1.2 + ul * 0.6 + gauss(t - 1, 0.04) * 0.6); } }), ['chest', 'uarm' + sd, 'farm' + sd, 'hand' + sd], ra);
    }
    yield;
    const hx = sx * 0.218;
    part(blob(14, 10, (p) => { p.set(p.x * 0.034, p.y * (p.y > 0 ? 0.016 : 0.009), p.z * 0.046); p.add(new V3(hx, 0.022, -0.335)); }), ['farm' + sd, 'hand' + sd]);
    for (let f = 0; f < 4; f++) {
      const a = (f - 1.5) * 0.2 * -sx, L = [0.062, 0.072, 0.07, 0.058][sx < 0 ? 3 - f : f];
      const bx = hx + (f - 1.5) * 0.017 * -sx, bz = -0.365;
      const fx = (d) => bx + Math.sin(a) * d, fz = (d) => bz - Math.cos(a) * d;
      part(tube([[bx, 0.026, bz], [fx(L * 0.35), 0.04, fz(L * 0.35)], [fx(L * 0.7), 0.028, fz(L * 0.7)], [fx(L), 0.006, fz(L)]], (t) => mix(0.0105, 0.0075, t) + 0.002 * gauss(t - 0.35, 0.08) + 0.0015 * gauss(t - 0.7, 0.07), { n: 12, seg: 7, cap0: 0.004, cap1: 0.007 }), ['hand' + sd], null, (p, n, C) => { if (Math.hypot(p.x - fx(L), p.z - fz(L)) < 0.012) { C[0] = 0.05; C[1] = 0.04; C[2] = 0.03; } });
    }
    part(tube([[hx + sx * -0.028, 0.026, -0.325], [hx + sx * -0.05, 0.03, -0.35], [hx + sx * -0.058, 0.008, -0.375]], (t) => mix(0.012, 0.008, t), { n: 9, seg: 7, cap0: 0.004, cap1: 0.007 }), ['hand' + sd]);
  }
  yield;
  // legs: folded like someone crouching, knee forward and low, the heel up, toes gripping
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    yield;
    {
      const ra = [];
      part(tube([[sx * 0.105, 0.71, 0.33], [sx * 0.15, 0.5, 0.2], [sx * 0.17, 0.31, 0.06], [sx * 0.168, 0.21, 0.25], [sx * 0.15, 0.13, 0.43]], (t) => {
        return keys([[0, 0.072], [0.2, 0.06], [0.42, 0.045], [0.5, 0.043], [0.62, 0.04], [0.8, 0.032], [1, 0.027]])(t) + 0.01 * gauss(t - 0.5, 0.035);
      }, { n: 48, seg: 16, cap0: 0.03, cap1: 0.012, disp: (p, t, a, dir) => { const pat = gauss(t - 0.5, 0.03) * sstep(0.2, 0.8, -Math.cos(a)); const sh = gauss(Math.cos(a) + 1, 0.45) * sstep(0.55, 0.6, t) * sstep(0.98, 0.9, t); p.addScaledVector(dir, pat * 0.012 + sh * 0.003); ra.push(pat * 1.2 + gauss(t - 0.5, 0.04) * 0.5 + sh * 0.6); } }), ['hips', 'thigh' + sd, 'shin' + sd, 'foot' + sd], ra);
    }
    yield;
    part(blob(12, 10, (p) => { p.set(p.x * 0.026, p.y * 0.03, p.z * 0.03); p.add(new V3(sx * 0.15, 0.115, 0.45)); }), ['shin' + sd, 'foot' + sd]); // heel
    part(tube([[sx * 0.15, 0.13, 0.43], [sx * 0.15, 0.07, 0.375], [sx * 0.15, 0.024, 0.315]], (t) => mix(0.029, 0.026, t), { n: 10, seg: 12, cap0: 0.02, cap1: 0.02 }), ['shin' + sd, 'foot' + sd]);
    for (let k = 0; k < 5; k++) {
      const x = sx * (0.15 + (k - 2) * 0.012 * (k === 0 ? 1.3 : 1)), a = (k - 2) * 0.12 * sx, L = [0.05, 0.04, 0.036, 0.032, 0.026][sx < 0 ? 4 - k : k];
      part(tube([[x, 0.022, 0.31], [x - Math.sin(a) * L * 0.5, 0.03, 0.31 - L * 0.5], [x - Math.sin(a) * L, 0.006, 0.31 - L]], (t) => mix(k === (sx < 0 ? 4 : 0) ? 0.011 : 0.008, 0.006, t), { n: 8, seg: 6, cap0: 0.004, cap1: 0.006 }), ['foot' + sd]);
    }
  }
  yield;
  return kit.build();
}

export function makeHound(M) {
  const gm = built('hound');
  const g = new THREE.Group();
  const { mesh, by } = skinned(gm, HB, creatureMat(M, 'hound'), [[0, 0.45, 0], 1.0]);
  g.add(mesh);
  g.userData = { b: by, mesh, ph: Math.random() * 6, t: 0, wk: 0, low: 0, sp: new Float32Array(8), look: 0 };
  animHound(g, 1 / 60, 0, 0, 0, 0);
  return g;
}
// speed m/s, low 0..1 (crouched, ready to spring), open 0..1 (jaw), look: head yaw toward the target (rad),
// coil 0..1 (gathers itself to spring), swing 0..1 (the lunge and the bite)
export function animHound(g, dt, speed, low, open, look, coil = 0, swing = 0) {
  const u = g.userData, b = u.b; dt = Math.min(Math.max(dt, 0), 0.05);
  u.t += dt; const t = u.t;
  const stride = 0.3 + 0.13 * Math.min(speed, 6.5);           // metres per half cycle: longer bounds when it runs
  u.ph += (speed * dt / stride) * Math.PI;
  u.wk += (Math.min(speed / 2.4, 1.3) - u.wk) * (1 - Math.exp(-6 * dt));
  u.low += (low - u.low) * (1 - Math.exp(-5 * dt));
  const w = u.wk, ph = u.ph, lw = u.low, br = Math.sin(t * (1.6 + lw * 3)) * (0.5 + lw);
  const bound = clamp((speed - 3.2) / 1.5, 0, 1);
  const H0 = b.hips.userData.rest;
  b.hips.position.set(H0.x, H0.y - lw * 0.08 + 0.025 * w * Math.cos(2 * ph) + br * 0.004 - coil * 0.11 + swing * 0.13, H0.z + coil * 0.1 - swing * 0.48);
  b.hips.rotation.set(-0.06 * bound * Math.sin(ph), Math.sin(ph) * 0.08 * w * (1 - bound), Math.sin(ph) * 0.06 * w);
  b.spine.rotation.set(0.1 * bound * Math.sin(ph + 0.6) + lw * 0.06 + br * 0.01, 0, Math.sin(ph) * 0.03 * w);
  b.chest.rotation.set(-0.1 * bound * Math.sin(ph + 1.2) - lw * 0.08 + br * 0.012 + coil * 0.16 - swing * 0.42, -Math.sin(ph) * 0.06 * w, 0);
  b.chest.scale.set(1 + br * 0.01, 1 + br * 0.006, 1);
  // head: hangs; when it holds you it lifts its eyes to you. Tracks with a lag, jerks a little.
  u.look += (clamp(look, -1.1, 1.1) - u.look) * (1 - Math.exp(-7 * dt));
  const jit = (Math.sin(t * 29) + Math.sin(t * 17.3)) * 0.01 * (0.3 + lw);
  b.neck.rotation.set(0.1 * lw - 0.08 * bound + swing * 0.2, u.look * 0.5, Math.sin(t * 0.7) * 0.12 * (1 - w));
  b.head.rotation.set(0.28 * lw + jit - swing * 0.45 + coil * 0.15, u.look * 0.5, Math.sin(t * 0.43) * 0.22 * (1 - w) + jit + 0.12 * lw);
  b.jaw.rotation.x = 0.06 + Math.max(open, coil * 0.6, swing) * 0.55 + (open > 0.3 ? Math.max(0, Math.sin(t * 17)) * 0.1 : 0);
  const A = Math.min(0.55, stride * 0.55) * Math.min(1, w * 1.5);
  for (let k = 0; k < 2; k++) {
    const sd = k ? 'R' : 'L', sx = k ? 1 : -1;
    const pf = bound > 0.5 ? ph + k * 0.3 : ph + k * Math.PI;
    const pb = bound > 0.5 ? ph + Math.PI + k * 0.3 : ph + (1 - k) * Math.PI;
    const sf = Math.sin(pf), cf = Math.cos(pf), sb = Math.sin(pb), cb = Math.cos(pb);
    // front: the elbow folds as the hand lifts, the hand peels off the floor heel first
    b['uarm' + sd].rotation.set(sf * A - lw * 0.18 - coil * 0.25 + swing * 1.45, 0, sx * (0.05 + lw * 0.14 + swing * 0.22));
    b['farm' + sd].rotation.set(-Math.max(0, cf) * 0.75 * w + lw * 0.35 + coil * 0.3 - swing * 0.35, 0, -sx * lw * 0.08);
    b['hand' + sd].rotation.set(Math.max(0, cf) * 0.55 * w - lw * 0.15 - sf * A * 0.6, 0, 0);
    // hind: the knee swings forward under the belly, the foot lifts and plants again
    b['thigh' + sd].rotation.set(sb * A * 1.05 + lw * 0.22 + coil * 0.34 - swing * 0.55, 0, sx * (0.04 + lw * 0.08));
    b['shin' + sd].rotation.set(Math.max(0, cb) * 0.55 * w - lw * 0.28 - coil * 0.2 + swing * 0.3, 0, 0);
    b['foot' + sd].rotation.set(-Math.max(0, cb) * 0.4 * w - sb * A * 0.5, 0, 0);
  }
}

// ======================================================================
// Faceling: somebody from an office, on the suit skeleton (SUIT_B) so it stands and walks like
// a person. Three outfits (shirt and tie, cardigan, long coat), picked from the entity id.
// The face is skin over the hint of a skull: brow, cheekbones, the hollows where eyes would be.
// ======================================================================
const FACE_OUTFITS = [
  { shirt: 0xb4c0c9, pants: 0x2a2b30, shoe: 0x0e0c0b, tie: 0x55181c, hair: 0x231a13, over: null },
  { shirt: 0xd8d3c6, pants: 0x3b3229, shoe: 0x2a1a10, tie: null, hair: 0x4a3524, over: { kind: 'cardigan', c: 0x5f5a34 } },
  { shirt: 0xd2d0cb, pants: 0x1f222b, shoe: 0x0c0b0a, tie: 0x1d2433, hair: 0x15110e, over: { kind: 'coat', c: 0x4a443b } },
];
function* facelingGeo(v) {
  const O = FACE_OUTFITS[v], kit = new Kit(SUIT_B), R = mrand(500 + v);
  const SKIN = 0xb98f78;
  const fold = (p, k = 1) => (fbm3(p.x * 14 + v, p.y * 4.5, p.z * 14) - 0.5) * k;
  const cloth = (c, b, extra, o = {}) => ({ c, g: o.g ?? 0.16, sh: o.sh ?? 0.05, gr: 0.55, b, paint: (p, n, C, S) => { const f = fold(p); const k = clamp(0.9 + f * 0.7, 0.55, 1.12); C[0] *= k; C[1] *= k; C[2] *= k; if (extra) extra(p, n, C, S); } });
  const skin = (b, extra) => ({ c: SKIN, g: 0.4, sh: 0.12, ss: 1, gr: 0.35, b, paint: (p, n, C, S) => { const m = fbm3(p.x * 30, p.y * 30, p.z * 30); const k = 0.9 + m * 0.2; C[0] *= k; C[1] *= k * 0.98; C[2] *= k * 0.97; if (extra) extra(p, n, C, S); } });
  const coat = O.over && O.over.kind === 'coat', card = O.over && O.over.kind === 'cardigan';
  yield;
  // trousers: a front crease, folds behind the knee, a break where they meet the shoe
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    yield;
    kit.add(tube([[sx * 0.095, 0.98, 0], [sx * 0.1, 0.72, -0.005], [sx * 0.105, 0.5, -0.006], [sx * 0.11, 0.25, 0.0], [sx * 0.112, 0.06, 0.012]], (t, a) => mix(0.085, 0.058, t) + 0.005 * gauss(t - 0.5, 0.06) + 0.006 * sstep(0.85, 1, t), {
      n: 40, seg: 22, cap0: 0.02, cap1: false,
      disp: (p, t, a, dir) => {
        const ca = Math.cos(a);
        let r = 0.0035 * Math.pow(Math.max(0, -ca), 14);                                  // crease (front is -Z: the tube's 'up' default)
        r += 0.004 * Math.sin(p.y * 95) * sstep(0.2, 0.08, p.y);                           // the break over the shoe
        r += 0.003 * Math.sin(p.y * 70 + a) * gauss(p.y - 0.5, 0.05) * sstep(0, 1, ca);    // behind the knee
        p.addScaledVector(dir, r + fold(p, 0.008));
      },
    }), cloth(O.pants, ['hips', 'thigh' + sd, 'shin' + sd, 'foot' + sd], null, { g: 0.22, sh: 0.08 }));
    yield;
  // shoe: a real last with a toe, a heel and a sole
    kit.add(blob(20, 14, (p) => { const toe = p.z < 0 ? 1 : 0; p.set(p.x * 0.05 * (1 - 0.25 * toe * -p.z), (p.y > 0 ? p.y * 0.048 * (1 - 0.5 * toe * -p.z) : p.y * 0.012), p.z * 0.14); p.add(new V3(sx * 0.112, 0.03, -0.045)); }),
      { c: O.shoe, g: 1.6, sh: 0.9, gr: 0.25, b: 'foot' + sd });
    kit.add(rbox(0.1, 0.02, 0.29, 0.008, 2), { c: 0x0a0908, g: 0.5, sh: 0.1, gr: 0.5, b: 'foot' + sd }, T(sx * 0.112, 0.01, -0.045));
  }
  yield;
  // shirt: tucked in, bloused a little over the belt, folds, a placket with buttons
  const TRX = keys([[0.88, 0.162], [0.98, 0.165], [1.05, 0.17], [1.15, 0.172], [1.27, 0.186], [1.36, 0.192], [1.42, 0.17], [1.47, 0.12], [1.52, 0.075]]);
  const TRZ = keys([[0.88, 0.11], [0.98, 0.112], [1.05, 0.118], [1.15, 0.116], [1.27, 0.122], [1.36, 0.116], [1.42, 0.1], [1.47, 0.08], [1.52, 0.06]]);
  const over = coat ? 0.022 : card ? 0.012 : 0;
  kit.add(tube([[0, 0.86, 0], [0, 1.15, 0.0], [0, 1.4, 0.0], [0, 1.52, 0.0]], (t, a) => { const y = 0.86 + t * 0.66; return sell(a, TRX(y) + over * sstep(1.5, 1.38, y), TRZ(y) + over * sstep(1.5, 1.38, y), 2.05); }, {
    n: 48, seg: 34, cap0: 0.03, cap1: 0.02,
    disp: (p, t, a, dir) => {
      const y = 0.86 + t * 0.66, front = Math.max(0, Math.cos(a));
      let r = fold(p, 0.014) * sstep(0.98, 1.06, y);
      r += 0.008 * gauss(y - 1.0, 0.025) + 0.003 * Math.sin(a * 13) * gauss(y - 0.995, 0.02);   // bloused over the belt
      if (!coat && !card) r += 0.0025 * Math.pow(front, 60) * sstep(0.97, 1.0, y);              // placket
      p.addScaledVector(dir, r);
    },
  }), cloth(card ? O.over.c : coat ? O.over.c : O.shirt, ['hips', 'spine', 'chest', 'neck'], (p, n, C, S) => {
    if (p.y < 0.97) { const pc = lin(O.pants); C[0] = pc[0]; C[1] = pc[1]; C[2] = pc[2]; }
    const inV = (card && p.z < 0 && Math.abs(p.x) < 0.008 + (p.y - 1.14) * 0.2 && p.y > 1.14) || (coat && p.z < 0 && Math.abs(p.x) < 0.006 + (p.y - 1.2) * 0.22 && p.y > 1.2); // open fronts
    if (inV) { const sc = lin(O.shirt); const k = 0.9 + fold(p) * 0.6; C[0] = sc[0] * k; C[1] = sc[1] * k; C[2] = sc[2] * k; }
    if (card && !inV && p.y > 1.0) { const rib = 0.85 + 0.15 * Math.sin(p.x * 500); C[0] *= rib; C[1] *= rib; C[2] *= rib; }  // knit
  }));
  yield;
  // belt and buckle
  kit.add(tube([[0, 0.93, 0], [0, 0.968, 0]], (t, a) => sell(a, TRX(0.95) + 0.006, TRZ(0.95) + 0.006, 2.05), { n: 3, seg: 34, cap0: false, cap1: false }), { c: 0x120d0a, g: 1.2, sh: 0.5, gr: 0.3, b: 'hips' });
  kit.add(rbox(0.05, 0.036, 0.008, 0.004, 1), { c: 0x8a826a, g: 2.2, sh: 1, gr: 0.2, b: 'hips' }, T(0, 0.949, -TRZ(0.95) - 0.008));
  // buttons down the front
  if (!coat) for (let k = 0; k < 6; k++) { const y = 1.05 + k * 0.075, bx = card ? 0 : 0; kit.add(blob(6, 5, (p) => { p.set(p.x * 0.006, p.y * 0.006, p.z * 0.0025); p.add(new V3(bx, y, -TRZ(y) - 0.004)); }), { c: 0xe8e4da, g: 1.8, sh: 0.8, gr: 0.2, b: 'chest' }); }
  yield;
  // collar: a band round the neck and two points
  kit.add(tube([[0, 1.465, 0.004], [0, 1.515, 0.0]], (t, a) => sell(a, 0.068, 0.07) + 0.004, { n: 3, seg: 22, cap0: false, cap1: false }), cloth(O.shirt, ['chest', 'neck']));
  for (const sx of [-1, 1]) kit.add(rbox(0.055, 0.004, 0.04, 0.002, 1), cloth(O.shirt, 'chest'), T(sx * 0.03, 1.475, -0.07, 0.9, sx * 0.5, sx * -0.35));
  if (O.tie) {
    // the tie: a knot under the collar, then it hangs, touching the chest, off the belly a little
    kit.add(blob(10, 8, (p) => { p.set(p.x * 0.017, p.y * 0.017, p.z * 0.011); p.add(new V3(0, 1.462, -0.088)); }), { c: O.tie, g: 0.8, sh: 0.6, gr: 0.3, b: 'chest' });
    kit.add(tube([[0, 1.45, -0.094 - over * 0.3], [0, 1.33, -0.124 - over], [0, 1.18, -0.126 - over], [0, 1.05, -0.132 - over]], (t, a) => sell(a, mix(0.016, 0.04, sstep(0, 0.9, t)) * (t > 0.95 ? 0.6 : 1), 0.0035), { n: 16, seg: 8, cap0: 0.003, cap1: 0.02, up: [0, 0, -1] }),
      { c: O.tie, g: 0.8, sh: 0.6, gr: 0.3, b: ['chest', 'spine'], paint: (p, n, C) => { if (Math.sin((p.y + p.x) * 140) > 0.8) { C[0] *= 0.7; C[1] *= 0.7; C[2] *= 0.7; } } });
  }
  if (coat) {
    // the long coat: skirt to the knee, lapels, buttons
    kit.add(tube([[0, 0.98, 0.0], [0, 0.75, 0.01], [0, 0.52, 0.02]], (t, a) => sell(a, mix(0.19, 0.215, t), mix(0.135, 0.15, t), 2.1), {
      n: 14, seg: 34, cap0: false, cap1: false,
      disp: (p, t, a, dir) => { const front = Math.cos(a); let r = fold(p, 0.016) + 0.004 * Math.sin(a * 9) * t; if (front > 0.985) r -= 0.01 * t; p.addScaledVector(dir, r); },
    }), cloth(O.over.c, ['hips', 'thighL', 'thighR']));
    for (const sx of [-1, 1]) kit.add(rbox(0.07, 0.2, 0.008, 0.004, 1), cloth(O.over.c, 'chest'), T(sx * 0.055, 1.33, -TRZ(1.33) - over - 0.004, -0.1, sx * 0.35, sx * 0.25));
    for (let k = 0; k < 3; k++) kit.add(blob(6, 5, (p) => { p.set(p.x * 0.01, p.y * 0.01, p.z * 0.004); p.add(new V3(0.02, 1.0 + k * 0.1, -TRZ(1.0 + k * 0.1) - over - 0.006)); }), { c: 0x1a1612, g: 1.5, sh: 0.6, gr: 0.3, b: 'spine' });
  }
  yield;
  // arms: a round shoulder, a sleeve with folds at the elbow, a cuff, hands with fingers
  const SLV = coat || card ? O.over.c : O.shirt, thick = coat ? 0.014 : card ? 0.008 : 0;
  for (const [sx, sd] of [[-1, 'L'], [1, 'R']]) {
    yield;
    kit.add(blob(16, 12, (p) => { p.multiplyScalar(0.07 + thick); p.y *= 0.85; p.add(new V3(sx * 0.178, 1.39, 0)); }), cloth(SLV, ['chest', 'arm' + sd]));
    kit.add(tube([[sx * 0.18, 1.4, 0], [sx * 0.225, 1.3, 0.005], [sx * 0.25, 1.13, 0.012], [sx * 0.266, 1.0, 0.006], [sx * 0.277, 0.905, 0]], (t) => mix(0.064, 0.047, t) + thick - 0.006 * gauss(t - 0.5, 0.1), {
      n: 36, seg: 20, cap0: 0.04, cap1: 0.01,
      disp: (p, t, a, dir) => { const e = gauss(t - 0.52, 0.09); p.addScaledVector(dir, e * 0.005 * Math.sin(a * 2 + t * 70) + fold(p, 0.008)); },
    }), cloth(SLV, ['chest', 'arm' + sd, 'fore' + sd], (p, n, C) => { if (card && p.y < 0.93) { const r = 0.8 + 0.2 * Math.sin(p.y * 600); C[0] *= r; C[1] *= r; C[2] *= r; } }));
    kit.add(tube([[sx * 0.277, 0.915, 0], [sx * 0.279, 0.885, 0]], (t) => 0.048 + thick * 0.5, { n: 3, seg: 20, cap0: false, cap1: 0.04 }), cloth(coat ? O.shirt : SLV, 'fore' + sd));
    yield;
    // hand: palm, four fingers in a loose curl, a thumb
    const hx = sx * 0.283;
    kit.add(blob(14, 12, (p) => { p.set(p.x * 0.022, p.y * 0.05, p.z * 0.043); p.add(new V3(hx, 0.835, -0.004)); }), skin(['fore' + sd, 'hand' + sd]));
    for (let f = 0; f < 4; f++) {
      const z = -0.03 + f * 0.019, L = [0.07, 0.08, 0.076, 0.062][f];
      kit.add(tube([[hx, 0.795, z], [hx - sx * 0.004, 0.795 - L * 0.5, z - 0.008], [hx - sx * 0.012, 0.795 - L, z - 0.004]], (t) => mix(0.0095, 0.0075, t), { n: 8, seg: 7, cap0: 0.004, cap1: 0.007 }), skin('hand' + sd));
    }
    kit.add(tube([[hx - sx * 0.008, 0.83, -0.035], [hx - sx * 0.016, 0.8, -0.05], [hx - sx * 0.02, 0.775, -0.048]], (t) => mix(0.011, 0.008, t), { n: 7, seg: 7, cap0: 0.004, cap1: 0.007 }), skin('hand' + sd));
  }
  yield;
  // neck
  kit.add(tube([[0, 1.44, 0.008], [0, 1.6, 0.0]], (t) => mix(0.06, 0.054, t), { n: 8, seg: 20, cap0: false, cap1: false }), skin(['chest', 'neck', 'head']));
  yield;
  // head: a cranium wider at the back, the face a smooth plane over a brow, cheekbones,
  // shallow sockets and a jaw; hair with a side parting; ears
  const hc = new V3(0, 1.655, 0.006);
  const isHair = (px, py, pz) => (pz > -0.35 ? py > -0.38 + 0.25 * sstep(-0.35, 0.3, -pz) : py > 0.5 + 0.08 * px) && !(Math.abs(px) > 0.85 && py < 0.15 && pz < 0.3);
  kit.add(blob(40, 32, (p) => {
    const px = p.x, py = p.y, pz = p.z;
    let x = px * 0.073 * (1 - 0.2 * sstep(-0.2, -0.8, py) * sstep(0, -0.6, pz)), y = py * (py > 0 ? 0.11 : 0.112), z = pz * (pz < 0 ? 0.094 : 0.1);
    let r = 0;
    if (pz < -0.2) {
      const fw = sstep(-0.2, -0.7, pz);
      r += 0.007 * gauss(py - 0.2, 0.07) * gauss(px, 0.55) * fw;                                       // brow ridge
      for (const s of [-1, 1]) {
        r -= 0.008 * gauss(Math.hypot(px - s * 0.34, py - 0.05), 0.14) * fw;                          // where the eyes should be
        r += 0.006 * gauss(Math.hypot(px - s * 0.52, py + 0.13), 0.14) * fw;                          // cheekbones
        r -= 0.004 * gauss(Math.hypot(px - s * 0.48, py + 0.38), 0.16) * fw;                          // under the cheekbones
      }
      r += 0.005 * gauss(px, 0.07) * gauss(py + 0.08, 0.16) * fw;                                       // the ghost of a nose
      r += 0.006 * gauss(py + 0.78, 0.12) * gauss(px, 0.3) * fw;                                        // chin
    }
    for (const s of [-1, 1]) r -= 0.004 * gauss(Math.hypot(Math.abs(px) - 0.88, py - 0.2), 0.14) * (s === Math.sign(px) ? 1 : 0); // temples
    for (const s of [-1, 1]) r += 0.014 * gauss(Math.hypot(px - s, py + 0.02, pz - 0.05), 0.2);          // ears
    if (isHair(px, py, pz)) r += 0.009 + 0.006 * Math.max(0, py) + 0.003 * (fbm3(px * 9, py * 9, pz * 9) - 0.5) - 0.004 * gauss(px - 0.35, 0.04) * sstep(0.3, 0.7, py);
    p.set(x, y, z); const l = p.length() || 1; p.multiplyScalar((l + r) / l); p.add(hc);
  }), skin('head', (p, n, C, S) => {
    const q = p.clone().sub(hc), px = q.x / 0.073, py = q.y / 0.11, pz = q.z / 0.097, l = Math.hypot(px, py, pz) || 1;
    if (isHair(px / l, py / l, pz / l)) { const h = lin(O.hair), s = 0.6 + fbm3(p.x * 160, p.y * 40, p.z * 160) * 0.7; C[0] = h[0] * s; C[1] = h[1] * s; C[2] = h[2] * s; S[0] = 0.7; S[1] = 0.4; S[2] = 0; }
  }));
  yield;
  return kit.build();
}
export function makeFaceling(M, variant = 0) {
  const v = ((variant | 0) % 3 + 3) % 3;
  const gm = built('faceling' + v);
  const g = new THREE.Group();
  const { mesh, by } = skinned(gm, SUIT_B, creatureMat(M, 'person'), [[0, 0.95, 0], 1.25]);
  g.add(mesh);
  // a slightly wrong way of standing: the head a few degrees off, one shoulder low
  g.userData = { b: by, mesh, ph: 0, t: Math.random() * 10, wk: 0, sp: new Float32Array(8), look: 0, seed: Math.random() * 10, tilt: (v === 1 ? -1 : 1) * (0.07 + v * 0.02), drop: 0.025 + v * 0.008 };
  animFaceling(g, 1 / 60, 0, 0, 0);
  return g;
}
// look: head yaw toward the player (rad); hunch 0..1 (hostile)
export function animFaceling(g, dt, speed, look, hunch) {
  const u = g.userData, b = u.b; dt = Math.min(Math.max(dt, 0), 0.05);
  u.t += dt; const t = u.t;
  const stride = 0.62 + 0.12 * Math.min(speed, 5);
  u.ph += (speed * dt / stride) * Math.PI;
  u.wk += ((speed > 0.1 ? Math.min(speed / 2.2, 1.2) : 0) - u.wk) * (1 - Math.exp(-5 * dt));
  const w = u.wk, ph = u.ph, s = Math.sin(ph), c = Math.cos(ph);
  const A = Math.min(0.36, stride * 0.5) * Math.min(1, w * 1.6);
  const hy = 0.95 + 0.02 * w * Math.cos(2 * ph) - 0.008 - hunch * 0.05;
  b.hips.position.set(c * 0.02 * w, hy, 0); b.hips.rotation.set(0, s * 0.08 * w, -u.drop * 0.6);
  for (let k = 0; k < 2; k++) {
    const p2 = ph + k * Math.PI, ss = Math.sin(p2), cc = Math.cos(p2);
    legIK(k ? b.thighR : b.thighL, k ? b.shinR : b.shinL, k ? b.footR : b.footL, 0, hy - 0.03, -A * ss, 0.09 + Math.max(0, cc) * 0.09 * w, 0.42, 0.41, -Math.max(0, cc) * 0.25 * w);
    (k ? b.thighR : b.thighL).rotation.z = (k ? 1 : -1) * 0.02 + u.drop * 0.6;
  }
  // unnaturally still: no breathing, no sway; one shoulder sits low
  b.spine.rotation.set(-0.02 * w - hunch * 0.25, -s * 0.05 * w, u.drop * 0.5);
  b.chest.rotation.set(-hunch * 0.2, -s * 0.03 * w, u.drop * 0.6);
  b.armR.position.y = b.armR.userData.rest.y - u.drop;
  for (const [sd, sg] of [['L', -1], ['R', 1]]) {
    b['arm' + sd].rotation.set(-sg * s * 0.3 * w + hunch * 0.6, 0, sg * (0.05 + hunch * 0.15) - u.drop * 0.6);
    b['fore' + sd].rotation.set(0.12 + hunch * 0.7 + Math.max(0, sg * s) * 0.2 * w, 0, 0);
    b['hand' + sd].rotation.set(0.05, 0, 0);
  }
  u.look += (clamp(look, -1.3, 1.3) - u.look) * (1 - Math.exp(-2.2 * dt)); // the head turns slowly to follow you
  b.neck.rotation.set(hunch * 0.3, u.look * 0.4, u.tilt * 0.4 - u.drop * 0.6);
  b.head.rotation.set(hunch * 0.2 + 0.04, u.look * 0.6, u.tilt + Math.sin(t * 0.13 + u.seed) * 0.02 + hunch * 0.25);
}

// ======================================================================
// Smiler: in the dark, a grin far too wide and two flat white eyes. The face round them is
// black and barely there. Faces +Z (the group is turned with lookAt, like the old biter).
// ======================================================================
function* smilerGeo() {
  const kit = new Kit();
  const R = mrand(13);
  const grin = (x) => -0.06 + 1.6 * x * x;            // the curve of the mouth
  const gap = (x) => 0.034 * sstep(0.28, 0.0, Math.abs(x));
  // gums: a dark red band behind the teeth, faintly lit from inside
  kit.add(tube([[-0.29, grin(-0.29), 0.035], [-0.15, grin(-0.15), 0.06], [0, grin(0), 0.068], [0.15, grin(0.15), 0.06], [0.29, grin(0.29), 0.035]], (t, a) => sell(a, 0.03 * sstep(0, 0.12, t) * sstep(1, 0.88, t) + 0.004, 0.012), { n: 30, seg: 8, up: [0, 0, 1] }),
    { c: 0x2a0606, g: 1.5, sh: 1, e: 0.25, gr: 0.2 });
  yield;
  // teeth: two rows of human-ish teeth, too many, all the same size
  for (let row = 0; row < 2; row++) {
    yield;
    const N = 26;
    for (let i = 0; i < N; i++) {
      const x = -0.27 + (i + 0.5) / N * 0.54, up = row === 0;
      const y = grin(x) + (up ? gap(x) * 0.5 : -gap(x) * 0.5);
      const z = 0.07 * Math.sqrt(Math.max(0, 1 - (x / 0.32) ** 2)) + 0.012;
      const h = 0.036 * (0.55 + 0.45 * sstep(0.27, 0.05, Math.abs(x))) * (0.9 + R() * 0.2);
      kit.add(rbox(0.019, h, 0.012, 0.005, 2), { c: 0xfff6e0, g: 2, sh: 1, gr: 0, e: 3.4 }, T(x, y + (up ? h * 0.42 : -h * 0.42), z, 0, -x * 1.2, Math.atan(3.2 * x) * (up ? 1 : 1)));
    }
  }
  yield;
  // the eyes: flat, round, white, with a pinprick pupil
  for (const sx of [-1, 1]) {
    kit.add(blob(20, 14, (p) => { p.set(p.x * 0.05, p.y * 0.043, p.z * 0.014); p.add(new V3(sx * 0.13, 0.1, 0.07)); }), {
      c: 0xffffff, g: 2, sh: 1, gr: 0, e: 3.6,
      paint: (p, n, C, S) => { const d = Math.hypot(p.x - sx * 0.13, p.y - 0.1); if (d < 0.007) { C[0] = C[1] = C[2] = 0.0; S[3] = 0; } else { const k = 1 - 0.35 * d / 0.042; C[0] *= k; C[1] *= k; C[2] *= k * 0.96; } },
    });
  }
  yield;
  return kit.build();
}
export function makeSmiler(M) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  const mesh = meshOf(built('smiler'), M.dark);
  inner.add(mesh); g.add(inner);
  g.userData = { inner, mesh, t: Math.random() * 10, blink: 0, grin: 1 };
  return g;
}
// grin 0..1.4 (how wide), stare 0..1 (still and attentive)
export function animSmiler(g, dt, grin, stare) {
  const u = g.userData; u.t += dt; const t = u.t;
  u.grin += (grin - u.grin) * (1 - Math.exp(-3 * dt));
  u.blink -= dt; if (u.blink < -4 - (stare ? 6 : 0) * Math.random()) u.blink = 0.14;
  const bl = u.blink > 0 ? 0.15 : 1;
  const i = u.inner;
  i.scale.set(1 + (u.grin - 1) * 0.35, (1 + (u.grin - 1) * 0.1) * mix(1, bl, 0.25), 1);
  i.position.y = Math.sin(t * 0.8) * 0.03 * (1 - stare);
  i.rotation.z = Math.sin(t * 0.37) * 0.08 * (1 - stare) + (stare ? 0.12 * Math.sin(t * 0.11) : 0);
}

// ======================================================================
// The horde: the corridor packed wall to wall with dark people, four abreast, rank behind rank,
// arms reaching over the shoulders in front, the back ranks lost in black. Each rank is one
// merged mesh with its own phase, so the mass ripples as it comes. The front faces -Z.
// ======================================================================
const HORDE_ROWS = 8, HORDE_GAP = 0.42;
function* hordeRowGeo(seed) {
  const kit = new Kit();
  const R = mrand(seed);
  const C = { c: 0x070606, g: 0.45, sh: 0.3, gr: 0.6, paint: (p, n, Cc) => { const v = 0.5 + fbm3(p.x * 7, p.y * 7, p.z * 7) * 1.0; Cc[0] *= v; Cc[1] *= v; Cc[2] *= v; } };
  for (let k = 0; k < 4; k++) {
    yield;
    const x = -0.69 + k * 0.46 + (R() - 0.5) * 0.12, z = (R() - 0.5) * 0.22, s = 0.9 + R() * 0.17, lean = 0.12 + R() * 0.35, tw = (R() - 0.5) * 0.5;
    const m = T(x, 0, z, 0, tw, (R() - 0.5) * 0.1, s * (0.9 + R() * 0.1), s, s);
    const part = (g) => kit.add(g, C, m);
    const nk = [0, 1.47, -0.1 - lean * 0.32];
    part(tube([[0, 0.92, 0.02], [0, 1.2, -0.05 - lean * 0.15], [0, 1.45, -0.09 - lean * 0.3]], (t, a) => sell(a, mix(0.15, 0.185, t), mix(0.1, 0.115, t)), { n: 6, seg: 10, cap0: 0.04, cap1: 0.04 }));
    // the head: tilted every which way
    const ht = (R() - 0.5) * 0.9, hp = (R() - 0.5) * 0.6;
    part(blob(14, 11, (p) => { p.set(p.x * 0.085, p.y * 0.11, p.z * 0.095); p.applyAxisAngle(new V3(0, 0, 1), ht); p.applyAxisAngle(new V3(1, 0, 0), hp); p.add(new V3(Math.sin(ht) * -0.05, 1.62, -0.14 - lean * 0.38)); }));
    part(tube([nk, [Math.sin(ht) * -0.03, 1.55, -0.13 - lean * 0.36]], () => 0.045, { n: 3, seg: 6 }));
    for (const sx of [-1, 1]) {
      // arms: reaching, most of them forward and up over whoever is in front
      const up = R(), reachZ = -0.55 - R() * 0.45, reachY = 1.15 + up * 0.95;
      // keep the outside hands off the walls (the corridor is about 1.8 m wide)
      const lim = (ax) => clamp(x + ax * s, -0.78, 0.78) / s - x / s, mx = lim(sx * (0.22 + R() * 0.06)), hx = lim(sx * (0.12 + R() * 0.15));
      part(tube([[sx * 0.18, 1.42, -0.08 - lean * 0.3], [mx, (1.42 + reachY) / 2 + 0.05, reachZ * 0.5], [hx, reachY, reachZ]], (t) => mix(0.05, 0.03, t) + 0.008 * gauss(t - 0.5, 0.08), { n: 10, seg: 8, cap0: 0.02, cap1: 0.02 }));
      // a hand: palm and a spread of fingers
      part(blob(8, 6, (p) => { p.set(p.x * 0.035, p.y * 0.05, p.z * 0.022); p.add(new V3(hx, reachY + 0.02, reachZ - 0.03)); }));
      for (let f = 0; f < 4; f++) { const fa = (f - 1.5) * 0.3; part(tube([[hx + Math.sin(fa) * 0.02, reachY + 0.06, reachZ - 0.03], [hx + Math.sin(fa) * 0.05, reachY + 0.13, reachZ - 0.06]], () => 0.007, { n: 2, seg: 4 })); }
      part(tube([[sx * 0.09, 0.92, 0.02], [sx * 0.1, 0.5, -0.1 + (R() - 0.5) * 0.3], [sx * 0.1, 0.05, (R() - 0.5) * 0.4]], (t) => mix(0.07, 0.045, t), { n: 5, seg: 6, cap0: 0.03, cap1: 0.03 }));
    }
  }
  yield;
  return kit.build();
}
// behind the last rank: black, all the way to the walls and the ceiling
function* hordeBackGeo() {
  const kit = new Kit();
  kit.add(rbox(2.2, 3.8, 4.5, 0.3, 2), { c: 0x000000, g: 0, sh: 0, gr: 0 }, T(0, 1.9, HORDE_ROWS * HORDE_GAP + 2.0));
  yield;
  return kit.build();
}
// the ranks fade toward black the further back they stand (same program, darker tint)
const _hordeMats = new WeakMap();
function hordeMats(M) {
  let a = _hordeMats.get(M);
  if (!a) { a = [0xffffff, 0x8a8a8a, 0x464646, 0x1c1c1c].map((c) => M.obj(c, { vtx: true, atlas: propAtlas(), detail: M.detail, gloss: 0.35, bump: 0.0008, detScale: 5, sheen: 0.15, sss: 0.6, sssCol: 0x803020 })); _hordeMats.set(M, a); }
  return a;
}
export function makeHorde(M) {
  const g = new THREE.Group(), parts = [], mats = hordeMats(M);
  for (let k = 0; k < HORDE_ROWS; k++) {
    const m = meshOf(built('hordeRow' + (k % 4)), mats[Math.min(3, k >> 1)]);
    m.frustumCulled = false;
    const h = new THREE.Group(); h.add(m);
    // the ranks behind stand higher (climbing over each other), so the heads stack toward the ceiling
    const bx = ((k * 0.37) % 0.3) - 0.15, sc = 0.94 + ((k * 0.53) % 0.12) + k * 0.025, by = Math.max(0, k - 1) * 0.075;
    h.position.set(bx, by, k * HORDE_GAP); h.scale.set(1 + k * 0.02, sc, 1); h.userData = { bx, by, bz: k * HORDE_GAP };
    g.add(h); parts.push(h);
  }
  const back = meshOf(built('hordeBack'), M.dark); back.frustumCulled = false; g.add(back);
  g.userData = { parts, t: 0 };
  return g;
}
export function animHorde(g, dt, speed) {
  const u = g.userData; u.t += Math.min(dt, 0.05);
  // a ripple that runs back through the ranks: each one surges, bobs and sways out of step
  u.parts.forEach((h, k) => {
    const ph = u.t * (4.5 + speed * 1.4) - k * 0.75;
    h.position.y = h.userData.by + Math.abs(Math.sin(ph)) * 0.07;
    h.position.z = h.userData.bz + Math.sin(ph * 0.5) * 0.09;
    h.position.x = h.userData.bx + Math.sin(u.t * 1.1 + k * 1.7) * 0.06;
    h.rotation.x = -0.05 * Math.sin(ph);
    h.rotation.y = Math.sin(ph * 0.37 + k) * 0.03;
  });
}

// ======================================================================
// Skin-Stealer: a borrowed suit (makeSuit) with a name over it. These poses go on top of
// animSuit: a slow wave, and the moment it stops pretending.
// ======================================================================
function suitBones(g) {
  const u = g.userData;
  if (u.pk) { const b = u.pk.bones; return { head: b.head, armL: b.armL, armR: b.armR, torso: b.torso, pack: true }; }
  return { head: u.b.head, neck: u.b.neck, armL: u.b.armL, foreL: u.b.foreL, armR: u.b.armR, foreR: u.b.foreR, chest: u.b.chest, pack: false };
}
// wave 0..1, wrong 0..1, t seconds
export function poseStealer(g, wave, wrong, t) {
  const b = suitBones(g);
  if (wave > 0.01) {
    const w = Math.sin(t * 5.5) * 0.35;
    if (b.pack) { b.armL.rotation.set(mix(b.armL.rotation.x, -2.5, wave), 0, -0.35 * wave + w * wave); }
    else { b.armL.rotation.set(mix(b.armL.rotation.x, -2.7, wave), 0, mix(b.armL.rotation.z, -0.45 + w, wave)); b.foreL.rotation.set(mix(b.foreL.rotation.x, 0.5, wave), 0, 0); }
  }
  if (wrong > 0.01) {
    const j = Math.sin(t * 41) * 0.05 * wrong;
    b.head.rotation.z += 1.45 * wrong + j; b.head.rotation.x += 0.35 * wrong;
    if (b.neck) { b.neck.rotation.z += 0.4 * wrong; b.neck.scale.y = 1 + 1.4 * wrong; }
    for (const a of [b.armL, b.armR]) { a.scale.y = 1 + 0.55 * wrong; a.rotation.x = mix(a.rotation.x, 1.35 + j * 3, wrong); }
    if (b.foreL) { b.foreL.scale.y = b.foreR.scale.y = 1 + 0.6 * wrong; b.foreL.rotation.x = b.foreR.rotation.x = mix(b.foreL.rotation.x, 0.15, wrong); }
    if (b.chest) b.chest.rotation.x -= 0.25 * wrong;
    if (b.torso) b.torso.rotation.x -= 0.2 * wrong;
  } else {
    if (b.neck) b.neck.scale.y = 1;
    for (const a of [b.armL, b.armR]) a.scale.y = 1;
    if (b.foreL) b.foreL.scale.y = b.foreR.scale.y = 1;
  }
}
const GLYPH = '#%&@$?!*/\\|_=<>';
export function scrambleName(name, k) {
  let s = '';
  for (let i = 0; i < name.length; i++) s += Math.random() < k ? GLYPH[(Math.random() * GLYPH.length) | 0] : name[i];
  return s;
}
export { makeTag };

// Every heavy geometry, in the order to warm them (one per call to stay under a frame budget).
export const WARM = ['howler', 'hound', 'faceling0', 'faceling1', 'faceling2', 'smiler', 'hordeRow0', 'hordeRow1', 'hordeRow2', 'hordeRow3', 'hordeBack'];
// Geometry is built by generators that yield between parts, so the warm-up can spread the work over
// frames (warmSlice with a time budget); built() finishes whatever is left at once if it is needed now.
const BUILD = { howler: howlerGeo, hound: houndGeo, faceling0: () => facelingGeo(0), faceling1: () => facelingGeo(1), faceling2: () => facelingGeo(2), smiler: smilerGeo, hordeRow0: () => hordeRowGeo(101), hordeRow1: () => hordeRowGeo(118), hordeRow2: () => hordeRowGeo(135), hordeRow3: () => hordeRowGeo(152), hordeBack: hordeBackGeo };
const _gen = new Map(), _done = new Set();
function built(key) {
  return geo(key, () => { const p = _gen.get(key) || BUILD[key](); let r; while (!(r = p.next()).done); _gen.delete(key); _done.add(key); return r.value; });
}
export function warmSlice(key, ms = 10) {
  if (_done.has(key)) return true;
  let p = _gen.get(key); if (!p) { p = BUILD[key](); _gen.set(key, p); }
  const t0 = performance.now(); let r;
  do { r = p.next(); } while (!r.done && performance.now() - t0 < ms);
  if (!r.done) return false;
  const v = r.value; geo(key, () => v); _gen.delete(key); _done.add(key); return true;
}
