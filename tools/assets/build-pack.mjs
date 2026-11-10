// Rebuilds dist/assets/pack/ from the original Sketchfab GLBs (CC BY 4.0, see CREDITS.md).
// Read-only on the source files: it only parses glTF binaries and decodes their PNG/JPEG textures.
//
//   mkdir -p /tmp/l0-assets && cd /tmp/l0-assets && npm init -y && \
//     npm i @gltf-transform/core@4 @gltf-transform/extensions@4 @gltf-transform/functions@4 meshoptimizer sharp
//   node <repo>/tools/assets/build-pack.mjs <folder with the source .glb files> <repo>/dist/assets/pack
//
// Modules are resolved from the current working directory (the temp folder above), so nothing gets
// installed into the repository.
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path';

const req = createRequire(path.join(process.cwd(), 'noop.js'));
const imp = (m) => import(req.resolve(m));
const { Document: Doc0, NodeIO, Logger } = await imp('@gltf-transform/core');
const quiet = new Logger(Logger.Verbosity.WARN);
class Document extends Doc0 { constructor() { super(); this.setLogger(quiet); } }
const { ALL_EXTENSIONS, EXTTextureWebP, KHRMeshQuantization } = await imp('@gltf-transform/extensions');
const { weld, simplify, quantize, prune, dedup } = await imp('@gltf-transform/functions');
const { MeshoptSimplifier } = await imp('meshoptimizer');
const sharp = (await imp('sharp')).default;

const [SRC, OUT] = process.argv.slice(2);
if (!SRC || !OUT) { console.error('usage: node build-pack.mjs <srcDir> <outDir>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).setLogger(quiet);
// find a source file anywhere under SRC (the pack keeps hazmat_suit.glb in uploads/)
const srcPath = (name) => { const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { const r = walk(f); if (r) return r; } else if (e.name === name) return f; } return null; }; const f = walk(SRC); if (!f) throw new Error('missing source ' + name); return f; };
await MeshoptSimplifier.ready;

// ---------------------------------------------------------------- source geometry helpers
const mul = (m, v, w = 1) => [m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12]*w, m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13]*w, m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]*w];
const norm3 = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

// All primitives of a node, flattened to world-space triangle soup: { P, N, UV, mat, tex }
function soup(doc, nodeName) {
  const out = [];
  for (const scene of doc.getRoot().listScenes()) scene.traverse((n) => {
    if (n.getName() !== nodeName || !n.getMesh()) return;
    const M = n.getWorldMatrix();
    for (const p of n.getMesh().listPrimitives()) {
      const pos = p.getAttribute('POSITION'), nor = p.getAttribute('NORMAL'), uv = p.getAttribute('TEXCOORD_0');
      const I = p.getIndices() ? p.getIndices().getArray() : Uint32Array.from({ length: pos.getCount() }, (_, i) => i);
      const T = I.length / 3, P = new Float32Array(T * 9), N = new Float32Array(T * 9), UV = new Float32Array(T * 6);
      const e = [0, 0, 0];
      for (let k = 0; k < I.length; k++) {
        P.set(mul(M, pos.getElement(I[k], e)), k * 3);
        N.set(nor ? norm3(mul(M, nor.getElement(I[k], e), 0)) : [0, 1, 0], k * 3);
        if (uv) UV.set(uv.getElement(I[k], [0, 0]), k * 2);
      }
      const mat = p.getMaterial();
      out.push({ P, N, UV, T, mat, tex: mat?.getBaseColorTexture() || null, hasN: !!nor });
    }
  });
  if (!out.length) throw new Error('node not found: ' + nodeName);
  return out;
}

// Spatial clusters of a soup (connected triangles, then boxes touching within gap).
function clusters(s, gap = 0.03) {
  const par = new Int32Array(s.T).map((_, i) => i); const f = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  const key = new Map();
  for (let t = 0; t < s.T; t++) for (let k = 0; k < 3; k++) {
    const i = (t * 3 + k) * 3; const kk = `${Math.round(s.P[i] * 500)},${Math.round(s.P[i+1] * 500)},${Math.round(s.P[i+2] * 500)}`;
    if (key.has(kk)) { const a = f(t), b = f(key.get(kk)); if (a !== b) par[a] = b; } else key.set(kk, t);
  }
  const map = new Map();
  for (let t = 0; t < s.T; t++) { const r = f(t); let c = map.get(r); if (!c) map.set(r, c = { tris: [], min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] }); c.tris.push(t); for (let k = 0; k < 9; k++) { const a = k % 3, v = s.P[t * 9 + k]; c.min[a] = Math.min(c.min[a], v); c.max[a] = Math.max(c.max[a], v); } }
  let list = [...map.values()], changed = true;
  while (changed) { changed = false; outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const A = list[i], B = list[j]; if ([0, 1, 2].every((a) => A.min[a] - gap <= B.max[a] && B.min[a] - gap <= A.max[a])) { for (let a = 0; a < 3; a++) { A.min[a] = Math.min(A.min[a], B.min[a]); A.max[a] = Math.max(A.max[a], B.max[a]); } A.tris.push(...B.tris); list.splice(j, 1); changed = true; break outer; } } }
  return list;
}
// pick the cluster whose min corner is nearest to `near`
function pick(s, near, gap) {
  const list = clusters(s, gap); list.sort((a, b) => Math.hypot(...a.min.map((x, i) => x - near[i])) - Math.hypot(...b.min.map((x, i) => x - near[i])));
  const c = list[0]; const d = Math.hypot(...c.min.map((x, i) => x - near[i])); if (d > 0.05) throw new Error('no cluster near ' + near + ' (closest ' + c.min + ')');
  return c.tris;
}
// sub-soup of selected triangles
function sub(s, tris) {
  const T = tris.length, P = new Float32Array(T * 9), N = new Float32Array(T * 9), UV = new Float32Array(T * 6);
  const SW = s.SW ? new Float32Array(T * 6) : null;
  tris.forEach((t, i) => { P.set(s.P.subarray(t * 9, t * 9 + 9), i * 9); N.set(s.N.subarray(t * 9, t * 9 + 9), i * 9); UV.set(s.UV.subarray(t * 6, t * 6 + 6), i * 6); if (SW) SW.set(s.SW.subarray(t * 6, t * 6 + 6), i * 6); });
  return { ...s, P, N, UV, T, SW };
}

// ---------------------------------------------------------------- textures
// The source textures are whole-scene bake atlases shared by every copy of an object, so a single prop
// only uses scattered islands of them. Re-pack just those islands (pixel rects, padded) into a new tight
// atlas, remap the UVs, flood the gaps with the mean colour (no black bleeding into mips) and scale to a
// power of two no larger than maxSize.
async function bakeTexture(tex, parts, maxSize) {
  const { data: src, info } = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, pad = 4;
  // islands: triangles sharing a UV coordinate
  const rects = []; const triRect = [];
  for (const [si, s] of parts.entries()) {
    const par = new Int32Array(s.T).map((_, i) => i); const f = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    const seen = new Map();
    for (let t = 0; t < s.T; t++) for (let k = 0; k < 3; k++) { const key = Math.round(s.UV[t * 6 + k * 2] * 1e5) + ',' + Math.round(s.UV[t * 6 + k * 2 + 1] * 1e5); if (seen.has(key)) { const a = f(t), b = f(seen.get(key)); if (a !== b) par[a] = b; } else seen.set(key, t); }
    const isl = new Map();
    for (let t = 0; t < s.T; t++) { const r = f(t); let q = isl.get(r); if (!q) isl.set(r, q = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9, tris: [] }); q.tris.push([si, t]); for (let k = 0; k < 3; k++) { const u = Math.min(1, Math.max(0, s.UV[t * 6 + k * 2])) * W, v = Math.min(1, Math.max(0, s.UV[t * 6 + k * 2 + 1])) * H; q.x0 = Math.min(q.x0, u); q.x1 = Math.max(q.x1, u); q.y0 = Math.min(q.y0, v); q.y1 = Math.max(q.y1, v); } }
    rects.push(...isl.values());
  }
  for (const r of rects) { r.x0 = Math.max(0, Math.floor(r.x0) - pad); r.y0 = Math.max(0, Math.floor(r.y0) - pad); r.x1 = Math.min(W, Math.ceil(r.x1) + pad); r.y1 = Math.min(H, Math.ceil(r.y1) + pad); }
  // merge overlapping rects
  let changed = true;
  while (changed) { changed = false; outer: for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const A = rects[i], B = rects[j]; if (A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1) { A.x0 = Math.min(A.x0, B.x0); A.y0 = Math.min(A.y0, B.y0); A.x1 = Math.max(A.x1, B.x1); A.y1 = Math.max(A.y1, B.y1); A.tris.push(...B.tris); rects.splice(j, 1); changed = true; break outer; } } }
  // shelf pack
  const area = rects.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  const PW = Math.max(Math.ceil(Math.sqrt(area) * 1.12), ...rects.map((r) => r.x1 - r.x0));
  rects.sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));
  let x = 0, y = 0, rowH = 0;
  for (const r of rects) { const w = r.x1 - r.x0, h = r.y1 - r.y0; if (x + w > PW) { x = 0; y += rowH; rowH = 0; } r.px = x; r.py = y; x += w; rowH = Math.max(rowH, h); }
  const PH = y + rowH;
  // copy
  let sum = [0, 0, 0], n = 0;
  for (const r of rects) for (let yy = r.y0; yy < r.y1; yy++) for (let xx = r.x0; xx < r.x1; xx++) { const i = (yy * W + xx) * 3; sum[0] += src[i]; sum[1] += src[i + 1]; sum[2] += src[i + 2]; n++; }
  const mean = sum.map((v) => Math.round(v / Math.max(1, n)));
  const out = Buffer.alloc(PW * PH * 3); for (let i = 0; i < PW * PH; i++) { out[i * 3] = mean[0]; out[i * 3 + 1] = mean[1]; out[i * 3 + 2] = mean[2]; }
  for (const r of rects) for (let yy = r.y0; yy < r.y1; yy++) src.copy(out, ((r.py + yy - r.y0) * PW + r.px) * 3, (yy * W + r.x0) * 3, (yy * W + r.x1) * 3);
  // remap UVs
  for (const r of rects) for (const [si, t] of r.tris) { const s = parts[si]; for (let k = 0; k < 3; k++) { const i = t * 6 + k * 2; const u = Math.min(1, Math.max(0, s.UV[i])) * W, v = Math.min(1, Math.max(0, s.UV[i + 1])) * H; s.UV[i] = (u - r.x0 + r.px) / PW; s.UV[i + 1] = (v - r.y0 + r.py) / PH; } }
  const p2 = (v) => Math.min(maxSize, 2 ** Math.ceil(Math.log2(Math.max(16, v)) - 0.15));
  const ow = p2(PW), oh = p2(PH);
  const webp = await sharp(out, { raw: { width: PW, height: PH, channels: 3 } }).resize(ow, oh, { fit: 'fill', kernel: 'lanczos3' }).webp({ quality: 82, effort: 6 }).toBuffer();
  return { webp, size: [ow, oh], packed: [PW, PH], islands: rects.length, texelScale: +(Math.min(ow / PW, oh / PH)).toFixed(2) };
}

// ---------------------------------------------------------------- output
// parts: [{ name, soup, texture: {webp}|null, color, emissive }]; place: transform applied to all
async function writeProp(file, parts, opt) {
  const doc = new Document(); const buf = doc.createBuffer();
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const webpExt = doc.createExtension(EXTTextureWebP).setRequired(true);
  const scene = doc.createScene(opt.name); const root = doc.createNode(opt.name); scene.addChild(root);
  const extras = { mount: opt.mount, source: opt.source, size: opt.size };
  root.setExtras(extras);
  const texCache = new Map();
  for (const part of parts) {
    const s = part.soup; const nV = s.T * 3;
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(s.P).setBuffer(buf))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(s.N).setBuffer(buf))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(s.UV).setBuffer(buf))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from({ length: nV }, (_, i) => i)).setBuffer(buf));
    const mat = doc.createMaterial(part.name).setRoughnessFactor(0.85).setMetallicFactor(0);
    if (part.texture) {
      let t = texCache.get(part.texture); if (!t) { t = doc.createTexture(part.name).setImage(part.texture.webp).setMimeType('image/webp'); texCache.set(part.texture, t); }
      mat.setBaseColorTexture(t);
    }
    if (part.color) mat.setBaseColorFactor([...part.color, 1]);
    if (part.emissive) { mat.setEmissiveFactor(part.color || [1, 1, 1]); if (part.texture) mat.setEmissiveTexture(mat.getBaseColorTexture()); }
    mat.setExtras({ emissive: !!part.emissive });
    prim.setMaterial(mat);
    const node = doc.createNode(part.name).setMesh(doc.createMesh(part.name).addPrimitive(prim));
    root.addChild(node);
  }
  if (!texCache.size) webpExt.dispose();
  // weld identical vertices (keeps UV seams), simplify to the budget, quantize
  await doc.transform(weld());
  const tris = () => doc.getRoot().listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + p.getIndices().getCount() / 3, 0), 0);
  const before = tris();
  if (opt.maxTris && before > opt.maxTris) {
    let ratio = opt.maxTris / before;
    for (let i = 0; i < 6 && tris() > opt.maxTris; i++) {
      await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: opt.error ?? 0.004, lockBorder: false }));
      ratio = Math.min(ratio, opt.maxTris / tris()) * 0.97; if (tris() > opt.maxTris) opt.error = (opt.error ?? 0.004) * 1.8;
    }
  }
  await doc.transform(prune(), dedup(), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  const after = tris();
  fs.writeFileSync(path.join(OUT, file), await io.writeBinary(doc));
  return { before, after };
}

// put a list of soups in place: rotate about Y by yaw (radians), then centre X/Z and set the mount plane
function place(soups, yaw, mount) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const rot = (A) => { for (let i = 0; i < A.length; i += 3) { const x = A[i], z = A[i + 2]; A[i] = x * c + z * s; A[i + 2] = -x * s + z * c; } };
  for (const q of soups) { rot(q.P); rot(q.N); }
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const q of soups) for (let i = 0; i < q.P.length; i++) { const a = i % 3; min[a] = Math.min(min[a], q.P[i]); max[a] = Math.max(max[a], q.P[i]); }
  const off = [-(min[0] + max[0]) / 2, mount === 'ceiling' ? -max[1] : -min[1], mount === 'wall' ? -max[2] : -(min[2] + max[2]) / 2];
  for (const q of soups) for (let i = 0; i < q.P.length; i++) q.P[i] += off[i % 3];
  return max.map((x, i) => +(x - min[i]).toFixed(3));
}
// yaw that turns `front` (world xz) to -Z, refined to the angle with the tightest XZ box (+-25 deg)
function fitYaw(soups, front) {
  const base = Math.PI - Math.atan2(front[0], front[1]); // rotation mapping front -> -Z
  let best = base, bestA = Infinity;
  for (let d = -25; d <= 25; d += 0.25) {
    const a = base + d * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const q of soups) for (let i = 0; i < q.P.length; i += 3) { const x = q.P[i] * c + q.P[i + 2] * s, z = -q.P[i] * s + q.P[i + 2] * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const A = (x1 - x0) * (z1 - z0); if (A < bestA - 1e-6) { bestA = A; best = a; }
  }
  return best;
}
// area-weighted mean facing of a soup in xz (for wall items)
function facing(s) { let x = 0, z = 0; for (let t = 0; t < s.T; t++) { const i = t * 9; const a = [s.P[i+3]-s.P[i], s.P[i+4]-s.P[i+1], s.P[i+5]-s.P[i+2]], b = [s.P[i+6]-s.P[i], s.P[i+7]-s.P[i+1], s.P[i+8]-s.P[i+2]]; const n = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; x += n[0]; z += n[2]; } return [x, z]; }

const report = [];
// ---------------------------------------------------------------- props from "Backrooms VR" (carlcapu9)
{
  const src = await io.read(srcPath('backrooms_vr.glb'));
  const S = {}; const get = (node) => (S[node] ||= soup(src, node)[0]);
  // name, parts: [node, near-min-corner, partName, {emissive,color}], front (world xz) or 'auto', mount, budget, tex size
  const PROPS = [
    { name: 'armchair', parts: [['Object_28', [-2.54, -0.12, -1.76], 'body']], front: [0.59, 0.81], mount: 'floor', maxTris: 3000, tex: 1024 },
    { name: 'bookshelf', parts: [['Object_10', [-46.29, -0.11, 5.75], 'body']], front: [0, 1], mount: 'floor', maxTris: 1200, tex: 512 },
    { name: 'exit-door', parts: [['Object_29', [-50.72, -0.12, -4.58], 'body'], ['Object_30', [-50.65, -0.12, -4.65], 'body']], front: [0, 1], mount: 'wall', maxTris: 6000, tex: 1024 },
    { name: 'exit-sign', parts: [['Object_8', [-49.78, 2.23, -4.38], 'body', { emissive: true }], ['Object_9', [-49.76, 2.24, -4.33], 'glass', { emissive: true }]], front: [0, 1], mount: 'wall', maxTris: 400, tex: 512 },
    { name: 'ceiling-lamp', parts: [['Object_11', [-0.85, 2.64, -0.72], 'body'], ['Object_17', [-0.77, 2.53, -0.65], 'dome', { emissive: true }]], front: [0, 1], mount: 'ceiling', maxTris: 1500, tex: 512 },
    { name: 'troffer', parts: [['Object_4', [-35.60, 2.54, -1.07], 'frame'], ['Object_26', [-35.59, 2.54, -1.06], 'diffuser', { emissive: true }]], front: [0, 1], mount: 'ceiling', maxTris: 200, tex: 256 },
    { name: 'vent', parts: [['Object_22', [-28.98, 2.54, 1.94], 'body']], front: [0, 1], mount: 'ceiling', maxTris: 300, tex: 256 },
    { name: 'smoke-detector', parts: [['Object_13', [-30.39, 2.51, 1.21], 'body'], ['Object_7', [-30.28, 2.53, 1.27], 'led', { emissive: true, color: [1, 0, 0] }]], front: [0, 1], mount: 'ceiling', maxTris: 300, tex: 256 },
    { name: 'socket', parts: [['Object_12', [-42.08, 0.14, 8.57], 'body']], front: 'auto', mount: 'wall', maxTris: 300, tex: 256 },
    { name: 'window', parts: [['Object_15', [-2.98, 2.00, -0.85], 'body']], front: [1, 0], mount: 'wall', maxTris: 1200, tex: 1024 },
  ];
  for (const pr of PROPS) {
    const soups = pr.parts.map(([node, near, pname, o = {}]) => {
      const s = get(node); const q = sub(s, pick(s, near, 0.03)); q.pname = pname; q.o = o; return q;
    });
    const front = pr.front === 'auto' ? facing(soups[0]) : pr.front;
    const yaw = fitYaw(soups, front);
    const size = place(soups, yaw, pr.mount);
    // textures: one per source texture, shared by the parts that use it
    const byTex = new Map(); for (const q of soups) if (q.tex) { if (!byTex.has(q.tex)) byTex.set(q.tex, []); byTex.get(q.tex).push(q); }
    const baked = new Map(); const texInfo = [];
    for (const [tex, qs] of byTex) { const b = await bakeTexture(tex, qs, pr.tex); baked.set(tex, b); texInfo.push(`${b.size.join('x')} (${b.islands} rects packed ${b.packed.join('x')}, x${b.texelScale} of source texels)`); }
    // merge soups of the same part name
    const parts = []; for (const q of soups) { const o = q.o; if (o.color) q.tex = null; parts.push({ name: q.pname, soup: q, texture: q.tex ? baked.get(q.tex) : null, color: o.color, emissive: o.emissive }); }
    const merged = []; for (const p of parts) { const m = merged.find((x) => x.name === p.name && x.texture === p.texture); if (!m) { merged.push(p); continue; } const a = m.soup, b = p.soup; const cat = (x, y) => { const r = new Float32Array(x.length + y.length); r.set(x); r.set(y, x.length); return r; }; m.soup = { ...a, P: cat(a.P, b.P), N: cat(a.N, b.N), UV: cat(a.UV, b.UV), T: a.T + b.T }; }
    const file = pr.name + '.glb';
    const { before, after } = await writeProp(file, merged, { name: pr.name, mount: pr.mount, size, maxTris: pr.maxTris, source: 'backrooms_vr' });
    const bytes = fs.statSync(path.join(OUT, file)).size;
    report.push({ file, tris: `${before} -> ${after}`, size: size.join(' x '), mount: pr.mount, tex: texInfo.join(', '), kb: (bytes / 1024).toFixed(1), yawDeg: +(yaw * 180 / Math.PI).toFixed(1) });
  }
}

// ---------------------------------------------------------------- suits
// One fused mesh each. Decimated, scaled to `height`, feet at y=0, facing -Z, then cut into limb parts by
// simple regions (head / torso / arms / legs) so the game can swing them; each part keeps its pivot.
async function suit({ file, srcFile, height, maxTris, tex, cuts, front }) {
  const src = await io.read(srcPath(srcFile));
  // merge all primitives into one soup
  const names = new Set(); for (const scene of src.getRoot().listScenes()) scene.traverse((n) => { if (n.getMesh()) names.add(n.getName()); });
  const uniq = [...names].flatMap((nm) => soup(src, nm));
  const cat = (k) => { const L = uniq.reduce((a, s) => a + s[k].length, 0), r = new Float32Array(L); let o = 0; for (const s of uniq) { r.set(s[k], o); o += s[k].length; } return r; };
  const S = { P: cat('P'), N: cat('N'), UV: cat('UV'), T: uniq.reduce((a, s) => a + s.T, 0), tex: uniq[0].tex };
  const yaw = fitYaw([S], front);
  place([S], yaw, 'floor');
  let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9]; for (let i = 0; i < S.P.length; i++) { const a = i % 3; min[a] = Math.min(min[a], S.P[i]); max[a] = Math.max(max[a], S.P[i]); }
  const k = height / (max[1] - min[1]); for (let i = 0; i < S.P.length; i++) S.P[i] *= k;
  // decimate the whole body first (one primitive) so the cuts follow the simplified surface
  const tmp = new Document(); const b = tmp.createBuffer(); const nV = S.T * 3;
  const prim = tmp.createPrimitive().setAttribute('POSITION', tmp.createAccessor().setType('VEC3').setArray(S.P).setBuffer(b)).setAttribute('NORMAL', tmp.createAccessor().setType('VEC3').setArray(S.N).setBuffer(b)).setAttribute('TEXCOORD_0', tmp.createAccessor().setType('VEC2').setArray(S.UV).setBuffer(b)).setIndices(tmp.createAccessor().setType('SCALAR').setArray(Uint32Array.from({ length: nV }, (_, i) => i)).setBuffer(b));
  tmp.createScene().addChild(tmp.createNode().setMesh(tmp.createMesh().addPrimitive(prim)));
  await tmp.transform(weld());
  const before = prim.getIndices().getCount() / 3;
  let ratio = maxTris / before, err = 0.002;
  for (let i = 0; i < 8 && prim.getIndices().getCount() / 3 > maxTris; i++) { await tmp.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: err, lockBorder: false })); err *= 1.7; ratio *= 0.95; }
  // back to soup
  const pos = prim.getAttribute('POSITION'), nor = prim.getAttribute('NORMAL'), uv = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices().getArray();
  const D = { T: I.length / 3, P: new Float32Array(I.length * 3), N: new Float32Array(I.length * 3), UV: new Float32Array(I.length * 2), tex: S.tex };
  for (let j = 0; j < I.length; j++) { D.P.set(pos.getElement(I[j], [0, 0, 0]), j * 3); D.N.set(nor.getElement(I[j], [0, 0, 0]), j * 3); D.UV.set(uv.getElement(I[j], [0, 0]), j * 2); }
  const { groups, skirts, pivots, weight } = segment(D, height, cuts);
  D.SW = new Float32Array(D.T * 6); for (let v = 0; v < D.T * 3; v++) D.SW.set(weight([D.P[v * 3], D.P[v * 3 + 1], D.P[v * 3 + 2]]), v * 2);
  const texB = await bakeTexture(S.tex, [D], tex);
  const local = (ts, piv) => { const q = sub(D, ts); for (let i = 0; i < q.P.length; i++) q.P[i] -= piv[i % 3]; return q; };
  const parts = PART_NAMES.map((name) => ({ name, soup: local(groups[name], pivots[name]), skirt: local(skirts[name], pivots[name]), pivot: pivots[name] }));
  // write with each part as a node translated to its pivot
  const doc = new Document(); const buf = doc.createBuffer(); doc.createExtension(KHRMeshQuantization).setRequired(true); doc.createExtension(EXTTextureWebP).setRequired(true);
  const scene = doc.createScene(file); const root = doc.createNode(file.replace('.glb', '')); scene.addChild(root);
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((x) => +(x * k).toFixed(3));
  root.setExtras({ mount: 'floor', size, source: srcFile });
  const t = doc.createTexture('suit').setImage(texB.webp).setMimeType('image/webp');
  const mat = doc.createMaterial('suit').setBaseColorTexture(t).setRoughnessFactor(0.7).setMetallicFactor(0);
  // each part: primitive 0 = its own triangles (material "suit"), primitive 1 = overlap skirt ("suit-skirt")
  const skirtMat = doc.createMaterial('suit-skirt').setBaseColorTexture(t).setRoughnessFactor(0.7).setMetallicFactor(0).setExtras({ skirt: true });
  // _SKINW (custom attribute, vec2 uint8): [bone index, weight to that bone * 255]; the rest goes to the torso
  const mkPrim = (s, m) => doc.createPrimitive().setMaterial(m)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(s.P).setBuffer(buf)).setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(s.N).setBuffer(buf)).setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(s.UV).setBuffer(buf))
    .setAttribute('_SKINW', doc.createAccessor().setType('VEC2').setArray(Uint8Array.from(s.SW, (v, i) => (i % 2 ? Math.round(v * 255) : v))).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from({ length: s.T * 3 }, (_, i) => i)).setBuffer(buf));
  for (const p of parts) {
    const mesh = doc.createMesh(p.name).addPrimitive(mkPrim(p.soup, mat)); if (p.skirt.T) mesh.addPrimitive(mkPrim(p.skirt, skirtMat));
    const node = doc.createNode(p.name).setTranslation(p.pivot).setMesh(mesh); node.setExtras({ pivot: p.pivot }); root.addChild(node);
  }
  await doc.transform(weld(), prune(), dedup(), quantize({ pattern: /^(POSITION|NORMAL|TEXCOORD_0)$/, quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  fs.writeFileSync(path.join(OUT, file), await io.writeBinary(doc));
  const tris = parts.map((p) => `${p.name} ${p.soup.T}+${p.skirt.T}`).join(', ');
  report.push({ file, tris: `${before} -> ${D.T} (${tris})`, size: size.join(' x '), mount: 'floor', tex: `${texB.size.join('x')} (packed ${texB.packed.join('x')}, x${texB.texelScale})`, kb: (fs.statSync(path.join(OUT, file)).size / 1024).toFixed(1), yawDeg: +(yaw * 180 / Math.PI).toFixed(1) });
}
// Limb segmentation, in the final space (metres, feet at y=0, facing -Z, so the suit's own left is +X).
// Both suits are single fused meshes (sleeves touch the body), so this is a geometric cut by triangle
// centroid, tuned per model from |x| histograms of horizontal slices (run with SEGDEBUG=1 to print them):
// head above `neck`; above `armpit` the arm is outside the shoulder plane |x| > shoulderCut; between
// `handLow` and `armpit` the arm is outside the piecewise-linear line armCut [[y, x], ...]; the rest
// below `crotch` is a leg by side, everything else is torso. All values in metres.
const PART_NAMES = ['torso', 'head', 'armL', 'armR', 'legL', 'legR'];
function segment(D, H, o) {
  const cen = (t) => [0, 1, 2].map((a) => (D.P[t * 9 + a] + D.P[t * 9 + 3 + a] + D.P[t * 9 + 6 + a]) / 3);
  const C = Array.from({ length: D.T }, (_, t) => cen(t));
  const lerpCut = (y) => { const L = o.armCut; if (y <= L[0][0]) return L[0][1]; for (let i = 1; i < L.length; i++) if (y <= L[i][0]) { const k = (y - L[i - 1][0]) / (L[i][0] - L[i - 1][0]); return L[i - 1][1] + k * (L[i][1] - L[i - 1][1]); } return L.at(-1)[1]; };
  if (process.env.SEGDEBUG) for (let yy = 0.6; yy < 1.6; yy += 0.05) { const h = new Array(42).fill(0); for (const c of C) if (Math.abs(c[1] - yy) < 0.025) h[Math.min(41, Math.floor(Math.abs(c[0]) * 100))]++; console.log('|x| cm 0..41 at y', yy.toFixed(2), h.map((v) => v > 9 ? '#' : v > 4 ? '+' : v > 0 ? '.' : ' ').join('')); }
  // primary part of a centroid; `m` widens every limb region by that margin (for the overlap skirts)
  const part = ([x, y], m = 0) => {
    const side = x >= 0 ? 'R' : 'L'; // facing -Z, the suit's own right hand is at +X
    if (y > o.neck - m) return 'head';
    if (y > o.armpit) return Math.abs(x) > o.shoulderCut - m ? 'arm' + side : 'torso';
    if (y >= o.handLow && Math.abs(x) > lerpCut(y) - m) return 'arm' + side;
    return y < o.crotch + m ? 'leg' + side : 'torso';
  };
  const label = C.map((c) => part(c));
  const groups = Object.fromEntries(PART_NAMES.map((n) => [n, []])); label.forEach((l, t) => groups[l].push(t));
  // skirts: torso triangles just inside a cut also go to the limb, and limb triangles just past it go to
  // the torso, so swinging a limb a little does not open a see-through gap at the joint
  const SK = o.skirt ?? 0.035; const skirts = Object.fromEntries(PART_NAMES.map((n) => [n, []]));
  C.forEach((c, t) => {
    const l = label[t];
    if (l === 'torso') { const w = part(c, SK); if (w !== 'torso') skirts[w].push(t); }
    else { const back = part(c, -SK); if (back === 'torso' || (l.startsWith('leg') && c[1] > o.crotch - SK) || (l === 'head' && c[1] < o.neck + SK)) skirts.torso.push(t); }
  });
  // pivots: shoulder = top of the arm, hip = top of the leg, neck = bottom of the head, torso = hips
  const avg = (ts, pred) => { const s = [0, 0, 0]; let n = 0; for (const t of ts) if (pred(C[t])) { for (let a = 0; a < 3; a++) s[a] += C[t][a]; n++; } return n ? s.map((v) => v / n) : null; };
  const yTop = (ts) => ts.reduce((m, t) => Math.max(m, C[t][1]), -1), yBot = (ts) => ts.reduce((m, t) => Math.min(m, C[t][1]), 9);
  const r3 = (v) => v.map((x) => +x.toFixed(3));
  const pivots = {};
  for (const n of ['armL', 'armR']) { const top = yTop(groups[n]); const c = avg(groups[n], (p) => p[1] > top - 0.11); pivots[n] = r3([c[0], top - 0.065, c[2]]); }
  for (const n of ['legL', 'legR']) { const c = avg(groups[n], (p) => p[1] > o.crotch - 0.1); pivots[n] = r3([c[0], o.crotch + 0.04, c[2]]); }
  { const b = yBot(groups.head); const c = avg(groups.head, (p) => p[1] < b + 0.06); pivots.head = r3([0, b, c[2]]); }
  { const c = avg(groups.torso, (p) => p[1] < o.crotch + 0.15); pivots.torso = r3([0, o.crotch + 0.06, c ? c[2] : 0]); }
  // smooth skin weights by position only (so the copies of a vertex on both sides of a cut agree):
  // [bone index in PART_NAMES, weight]; the rest of the weight goes to the torso (bone 0).
  // The bone is the position's own part (or, for torso positions, the nearest limb); the weight blends
  // over `blend` metres across the joint cut, but only over `blendArm` along the inner side of a hanging
  // arm, where arm and body are separate surfaces and a wide blend would drag the sleeve.
  const B = o.blend ?? 0.07, Bn = o.blendArm ?? 0.015;
  const ss = (e0, e1, v) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const armDist = ([x, y]) => {
    if (y > o.armpit) return [Math.abs(x) - o.shoulderCut, B];
    if (y < o.handLow) return [-1, B];
    const f = ss(o.armpit, o.armpit - B, y); // 0 at the armpit line, 1 lower down
    return [Math.abs(x) - (o.shoulderCut + f * (lerpCut(y) - o.shoulderCut)), B + f * (Bn - B)];
  };
  const dist = (name, c) => name === 'head' ? [c[1] - o.neck, B] : name.startsWith('leg') ? [o.crotch - c[1], B] : armDist(c);
  const weight = (c) => {
    const side = c[0] >= 0 ? 'R' : 'L'; const own = part(c);
    if (own !== 'torso') { const [d, b] = dist(own, c); return [PART_NAMES.indexOf(own), 0.5 + 0.5 * (d >= 0 ? ss(0, b, d) : -ss(0, b, -d))]; }
    let best = null; for (const n of ['head', 'leg' + side, 'arm' + side]) { const [d, b] = dist(n, c); const w = 0.5 - 0.5 * ss(0, b, -d); if (!best || w > best[1]) best = [PART_NAMES.indexOf(n), w]; }
    return best;
  };
  return { groups, skirts, pivots, weight };
}
const SUIT_CUTS = JSON.parse(fs.readFileSync(new URL('./suit-cuts.json', import.meta.url)));
for (const s of SUIT_CUTS) await suit(s);

fs.writeFileSync(new URL('./last-build.json', import.meta.url), JSON.stringify(report, null, 1));
console.table(report);
