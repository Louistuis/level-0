// Optional model pack (CC BY 4.0 models, see CREDITS / CREDITS.md). Nothing loads until loadPack() is called.
// Everything comes back as plain BufferGeometry (float position / normal / uv, real-world metres, -Z forward)
// plus Textures, so the game can draw it with its own shader materials. Any file that fails comes back as
// null and the game keeps its procedural version.
import * as THREE from './three.module.min.js';

export const PACK_BASE = new URL('../assets/pack/', import.meta.url).href;

// Every source model that is shipped (exact title, author and link from the files' embedded metadata).
export const CREDITS = [
  { what: 'armchair, bookshelf, exit door, exit sign, ceiling lamp, troffer, vent, smoke detector, socket, window', title: 'Backrooms VR', author: 'carlcapu9', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/backrooms-vr-d9b98eca8d064d0eafcd7f5484bb61ed' },
  { what: 'yellow hazmat suit (players, the Hollow)', title: 'Hazmat Suit', author: 'Cj.savage', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/hazmat-suit-2819a9b345fb44958fc025fb52610526' },
  { what: 'dark operator suit (players)', title: 'Elite Hazmat Operator', author: 'SKP_GAMES', license: 'CC BY 4.0', url: 'https://sketchfab.com/3d-models/elite-hazmat-operator-4d722398711c474cbbc393b117d4e668' },
];

// key -> file. mount: 'floor' (base at y=0), 'ceiling' (mounting face at y=0, hangs into -y),
// 'wall' (base at y=0, back face at z=0, sticks out towards -z).
export const PROP_FILES = {
  armchair: 'armchair.glb', bookshelf: 'bookshelf.glb', exitDoor: 'exit-door.glb', exitSign: 'exit-sign.glb',
  ceilingLamp: 'ceiling-lamp.glb', troffer: 'troffer.glb', vent: 'vent.glb', smokeDetector: 'smoke-detector.glb',
  socket: 'socket.glb', window: 'window.glb',
};
export const SUIT_FILES = { hazmat: 'hazmat-suit.glb', operator: 'operator-suit.glb' };
export const SUIT_PARTS = ['torso', 'head', 'armL', 'armR', 'legL', 'legR'];

// float copy of a (possibly quantized / normalized) attribute
function floatAttr(a) {
  const n = a.count, k = a.itemSize, out = new Float32Array(n * k);
  const get = [a.getX, a.getY, a.getZ, a.getW];
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) out[i * k + j] = get[j].call(a, i);
  return new THREE.BufferAttribute(out, k);
}
// world-space (relative to the file's scene root) float geometry of one mesh
function bake(mesh) {
  const src = mesh.geometry, g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) if (src.attributes[name]) g.setAttribute(name, floatAttr(src.attributes[name]));
  if (src.attributes._skinw) g.setAttribute('_skinw', floatAttr(src.attributes._skinw)); // suits: [bone, weight*255]
  if (src.index) g.setIndex(new THREE.BufferAttribute(src.index.array.slice(), 1));
  g.applyMatrix4(mesh.matrixWorld);
  if (!g.attributes.normal) g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
function prepMap(t, o) {
  if (!t) return null;
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = o.anisotropy ?? 4; t.needsUpdate = true;
  return t;
}
const meshes = (root) => { const out = []; root.updateMatrixWorld(true); root.traverse((n) => { if (n.isMesh) out.push(n); }); return out; };
const rootInfo = (gltf) => gltf.scene.children[0]?.userData || {};

function toProp(gltf, o) {
  const info = rootInfo(gltf);
  const parts = meshes(gltf.scene).map((m) => ({
    name: m.material.name || m.name, geometry: bake(m), map: prepMap(m.material.map, o),
    emissive: !!m.material.userData?.emissive, color: m.material.map ? null : m.material.color.clone(),
  }));
  parts.sort((a, b) => (b.name === 'body' || b.name === 'frame') - (a.name === 'body' || a.name === 'frame'));
  const size = info.size || new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3()).toArray();
  return { geometry: parts[0].geometry, map: parts[0].map, size, mount: info.mount || 'floor', parts };
}
// Suits: one node per body part (userData.pivot = joint), each with its own triangles plus an optional
// "skirt" primitive (material userData.skirt) that overlaps the neighbouring part, so a swung limb does not
// open a gap at the joint. The whole-body geometry is built from the parts without the skirts.
function toSuit(gltf, o, merge) {
  const info = rootInfo(gltf); const byPart = {}; const whole = []; let map = null;
  for (const m of meshes(gltf.scene)) {
    let n = m; while (n && !n.userData?.pivot) n = n.parent;
    if (!n || !SUIT_PARTS.includes(n.name)) continue;
    const g = bake(m); const skirt = !!m.material.userData?.skirt;
    if (!skirt) whole.push(g);
    (byPart[n.name] ||= { pivot: new THREE.Vector3().fromArray(n.userData.pivot), geos: [] }).geos.push(g);
    map ||= prepMap(m.material.map, o);
  }
  const parts = {};
  for (const [name, { pivot, geos }] of Object.entries(byPart)) {
    const local = geos.length > 1 ? merge(geos, false) : geos[0].clone();
    local.deleteAttribute('_skinw');
    local.translate(-pivot.x, -pivot.y, -pivot.z); local.computeBoundingBox(); local.computeBoundingSphere();
    parts[name] = { geometry: local, pivot };
  }
  const geometry = merge(whole, false); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  // skinned variant of the whole body: 2 influences (limb + torso), weights blend over ~7 cm at each cut
  let skinned = null; const sw = geometry.attributes._skinw;
  if (sw && SUIT_PARTS.every((n) => parts[n])) {
    skinned = geometry.clone(); skinned.deleteAttribute('_skinw');
    const n = sw.count, si = new Uint16Array(n * 4), sk = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const w = sw.getY(i) / 255; si[i * 4] = sw.getX(i); sk[i * 4] = w; sk[i * 4 + 1] = 1 - w; }
    skinned.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); skinned.setAttribute('skinWeight', new THREE.BufferAttribute(sk, 4));
  }
  geometry.deleteAttribute('_skinw');
  const pivots = Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, p.pivot]));
  // rig(): fresh bones for one SkinnedMesh of `skinned` (torso is the root at the hips, the rest are its children):
  //   const { root, bones, skeleton } = suit.rig(); const m = new THREE.SkinnedMesh(suit.skinned, material);
  //   m.add(root); m.bind(skeleton); bones.armL.rotation.x = -0.6;
  const rig = () => {
    const bones = {}; for (const k of SUIT_PARTS) { bones[k] = new THREE.Bone(); bones[k].name = k; }
    bones.torso.position.copy(pivots.torso);
    for (const k of SUIT_PARTS) if (k !== 'torso') { bones[k].position.copy(pivots[k]).sub(pivots.torso); bones.torso.add(bones[k]); }
    bones.torso.updateMatrixWorld(true);
    return { root: bones.torso, bones, skeleton: new THREE.Skeleton(SUIT_PARTS.map((k) => bones[k])) };
  };
  return { geometry, skinned, map, size: info.size || [0.75, 1.9, 0.46], parts, pivots, rig: skinned ? rig : null };
}

let cache = null;
// loadPack({ onProgress({ loaded, total, file, ok }), base, anisotropy }) -> Promise<{
//   textures: { wallpaper, carpet, ceiling }   (always null for now: the pack has no clean tiling surfaces)
//   props: { armchair, bookshelf, exitDoor, exitSign, ceilingLamp, troffer, vent, smokeDetector, socket, window }
//          each { geometry, map, size: [x, y, z] metres, mount, parts: [{ name, geometry, map, emissive, color }] } or null
//   suits: { hazmat, operator } each { geometry (whole body), map, size, pivots,
//          parts: { torso, head, armL, armR, legL, legR: { geometry relative to its pivot, pivot: Vector3 (joint) } },
//          skinned (whole body with skinIndex / skinWeight for 6 bones in SUIT_PARTS order), rig() } or null
//   suit: suits.hazmat, credits: CREDITS, errors: { file: message } }>
// Never rejects. Called again it returns the same promise.
export function loadPack(o = {}) {
  if (cache) return cache;
  cache = (async () => {
    const base = o.base || PACK_BASE;
    const out = { textures: { wallpaper: null, carpet: null, ceiling: null }, props: {}, suits: {}, suit: null, credits: CREDITS, errors: {} };
    let GLTFLoader, merge;
    try {
      ({ GLTFLoader } = await import('./vendor/GLTFLoader.js'));
      ({ mergeGeometries: merge } = await import('./vendor/BufferGeometryUtils.js'));
    } catch (e) {
      out.errors.loader = String(e?.message || e);
      for (const k in PROP_FILES) out.props[k] = null; for (const k in SUIT_FILES) out.suits[k] = null;
      return out;
    }
    const loader = new GLTFLoader();
    const jobs = [...Object.entries(PROP_FILES).map(([k, f]) => ['props', k, f]), ...Object.entries(SUIT_FILES).map(([k, f]) => ['suits', k, f])];
    let loaded = 0;
    await Promise.all(jobs.map(async ([kind, key, file]) => {
      let ok = false;
      try {
        const gltf = await loader.loadAsync(base + file);
        out[kind][key] = kind === 'props' ? toProp(gltf, o) : toSuit(gltf, o, merge);
        ok = true;
      } catch (e) {
        out[kind][key] = null; out.errors[file] = String(e?.message || e);
      }
      loaded++;
      try { o.onProgress?.({ loaded, total: jobs.length, file, ok }); } catch { /* the caller's problem */ }
    }));
    out.suit = out.suits.hazmat || out.suits.operator || null;
    return out;
  })();
  return cache;
}
