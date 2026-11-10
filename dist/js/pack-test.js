// Dev page for the model pack (dist/pack-test.html). Not loaded by the game.
// Renders on demand (the page may be hidden): in the console, `await T.ready`, then T.view('props'|'ceiling'|'suits'|'posed'|'parts'),
// and T.shot(name, port) to POST a PNG to a local receiver.
import * as THREE from './three.module.min.js';
import { loadPack, CREDITS } from './assets.js';

const W = 1280, H = 720;
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
r.setSize(W, H); r.outputColorSpace = THREE.SRGBColorSpace; document.body.appendChild(r.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x2a2a30);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-3, 6, -5); scene.add(sun);
const cam = new THREE.PerspectiveCamera(50, W / H, 0.01, 200);
const log = (s) => { document.getElementById('log').textContent += s + '\n'; };

const groups = {};
const grp = (name) => { const g = new THREE.Group(); g.name = name; g.visible = false; scene.add(g); groups[name] = g; return g; };
const floorMat = new THREE.MeshStandardMaterial({ color: 0x6b6250 });
const refBox = () => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.8, 0.25), new THREE.MeshStandardMaterial({ color: 0xd03030 })); m.position.y = 0.9; return m; };
const mat = (p) => new THREE.MeshStandardMaterial({ map: p.map || null, color: p.color || 0xffffff, emissive: p.emissive ? 0xffffff : 0x000000, emissiveMap: p.emissive ? p.map : null, emissiveIntensity: p.emissive ? 0.6 : 0, roughness: 0.85 });
const propMesh = (prop) => { const g = new THREE.Group(); for (const p of prop.parts) g.add(new THREE.Mesh(p.geometry, mat(p))); return g; };

function build(pack) {
  // floor props + wall props on a back wall at z = 0 (front faces -z, camera on the -z side)
  const a = grp('props'); const fl = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), floorMat); fl.rotation.x = -Math.PI / 2; a.add(fl);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 4), new THREE.MeshStandardMaterial({ color: 0x8a8060, side: THREE.DoubleSide })); wall.position.set(5, 2, 0.001); a.add(wall);
  let x = 0; const b = refBox(); b.position.set(-0.6, 0.9, -1); a.add(b);
  const place = (key, y = 0, z = null) => { const p = pack.props[key]; if (!p) { log('missing ' + key); return; } const m = propMesh(p); m.position.set(x + p.size[0] / 2, y, z ?? (p.mount === 'wall' ? 0 : -1)); a.add(m); x += p.size[0] + 0.35; };
  place('armchair'); place('bookshelf', 0, -0.25); place('exitDoor');
  const door = pack.props.exitDoor; if (pack.props.exitSign && door) { const s = propMesh(pack.props.exitSign); s.position.set(x - 0.35 - door.size[0] / 2, door.size[1] + 0.05, 0); a.add(s); }
  place('window', 1.4); place('socket', 0.3);
  // ceiling group: ceiling plane at y = 2.6, fixtures hang from it
  const c = grp('ceiling'); const ceil = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ color: 0xbdb59a, side: THREE.DoubleSide })); ceil.rotation.x = Math.PI / 2; ceil.position.y = 2.6; c.add(ceil);
  const c2 = refBox(); c2.position.set(-0.5, 0.9, 0); c.add(c2); let cx = 0;
  for (const key of ['troffer', 'vent', 'ceilingLamp', 'smokeDetector']) { const p = pack.props[key]; if (!p) { log('missing ' + key); continue; } const m = propMesh(p); m.position.set(cx + p.size[0] / 2, 2.6 - 0.001, 0); c.add(m); cx += p.size[0] + 0.4; }
  // suits
  const s = grp('suits'); const fl2 = fl.clone(); s.add(fl2); const r2 = refBox(); r2.position.set(-0.6, 0.9, 0); s.add(r2);
  const p = grp('posed'); p.add(fl.clone()); const r3 = refBox(); r3.position.set(-0.6, 0.9, 0); p.add(r3);
  const q = grp('parts'); q.add(fl.clone());
  const COLS = { torso: 0x40d0d0, head: 0xe04040, armL: 0x40d040, armR: 0x4060e0, legL: 0xe0d040, legR: 0xd040d0 };
  let sx = 0;
  for (const key of ['hazmat', 'operator']) {
    const suit = pack.suits[key]; if (!suit) { log('missing suit ' + key); continue; }
    const whole = new THREE.Mesh(suit.geometry, new THREE.MeshStandardMaterial({ map: suit.map, roughness: 0.7 })); whole.position.x = sx; s.add(whole);
    // rig from parts: each part in a pivot group, so the game-style limb swing can be checked
    const rig = new THREE.Group(); rig.position.x = sx; p.add(rig); const pivots = {};
    const col = new THREE.Group(); col.position.x = sx; q.add(col);
    for (const [name, part] of Object.entries(suit.parts)) {
      const g = new THREE.Group(); g.position.copy(part.pivot); g.add(new THREE.Mesh(part.geometry, new THREE.MeshStandardMaterial({ map: suit.map, roughness: 0.7 }))); rig.add(g); pivots[name] = g;
      const g2 = g.clone(); g2.children[0].material = new THREE.MeshStandardMaterial({ color: COLS[name] }); col.add(g2);
    }
    if (pivots.armL) pivots.armL.rotation.x = -0.9; if (pivots.armR) pivots.armR.rotation.x = 0.6;
    if (pivots.legL) pivots.legL.rotation.x = 0.45; if (pivots.legR) pivots.legR.rotation.x = -0.45;
    if (pivots.head) { pivots.head.rotation.z = 0.45; pivots.head.rotation.y = 0.3; }
    if (pivots.torso) pivots.torso.rotation.x = 0.12;
    // same pose on the skinned variant
    if (suit.rig) {
      const k = groups.skinned || grp('skinned'); if (!k.children.length) { k.add(fl.clone()); const r4 = refBox(); r4.position.set(-0.6, 0.9, 0); k.add(r4); }
      const { root, bones, skeleton } = suit.rig(); const m = new THREE.SkinnedMesh(suit.skinned, new THREE.MeshStandardMaterial({ map: suit.map, roughness: 0.7 }));
      m.add(root); m.bind(skeleton); m.position.x = sx; k.add(m);
      bones.armL.rotation.x = -0.9; bones.armR.rotation.x = 0.6; bones.legL.rotation.x = 0.45; bones.legR.rotation.x = -0.45; bones.head.rotation.z = 0.45; bones.head.rotation.y = 0.3; bones.torso.rotation.x = 0.12;
    }
    sx += 1.1;
  }
}

const VIEWS = {
  props: { from: [4.2, 1.6, -6.4], at: [4.2, 1.0, 0] },
  ceiling: { from: [1.7, 1.2, -2.4], at: [1.7, 2.5, 0] },
  suits: { from: [0.4, 1.3, -3.6], at: [0.4, 0.95, 0] },
  posed: { from: [2.4, 1.4, -3.2], at: [0.5, 0.95, 0] },
  parts: { from: [0.55, 1.2, -3.2], at: [0.55, 0.95, 0] },
  skinned: { from: [2.4, 1.4, -3.2], at: [0.5, 0.95, 0] },
};
function view(name, o = {}) {
  for (const g of Object.values(groups)) g.visible = false; groups[name].visible = true;
  const v = { ...VIEWS[name], ...o }; cam.position.set(...v.from); cam.lookAt(...v.at); cam.updateProjectionMatrix(); r.render(scene, cam);
  return name;
}
const shot = (name, port) => new Promise((res) => { r.render(scene, cam); r.domElement.toBlob((b) => fetch(`http://127.0.0.1:${port}/${name}`, { method: 'POST', body: b }).then(() => res(name), (e) => res('post failed: ' + e))); });

const t0 = performance.now(); const progress = [];
const ready = loadPack({ onProgress: (p) => progress.push(p) }).then((pack) => {
  build(pack);
  const summary = { ms: Math.round(performance.now() - t0), errors: pack.errors, textures: Object.fromEntries(Object.entries(pack.textures).map(([k, v]) => [k, !!v])), props: {}, suits: {} };
  for (const [k, p] of Object.entries(pack.props)) summary.props[k] = p && { size: p.size, mount: p.mount, tris: p.parts.reduce((a, q) => a + (q.geometry.index ? q.geometry.index.count : q.geometry.attributes.position.count) / 3, 0), parts: p.parts.map((q) => q.name + (q.emissive ? '*' : '')), map: p.map && [p.map.image.width, p.map.image.height], bbox: p.parts.reduce((b, q) => b.union(q.geometry.boundingBox), new THREE.Box3()).getSize(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3)) };
  for (const [k, s] of Object.entries(pack.suits)) summary.suits[k] = s && { size: s.size, tris: s.geometry.index.count / 3, map: [s.map.image.width, s.map.image.height], bbox: s.geometry.boundingBox.getSize(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3)), minY: +s.geometry.boundingBox.min.y.toFixed(3), parts: Object.fromEntries(Object.entries(s.parts).map(([n, q]) => [n, { tris: q.geometry.index.count / 3, pivot: q.pivot.toArray().map((x) => +x.toFixed(3)) }])) };
  log(JSON.stringify(summary, null, 1)); log(CREDITS.map((c) => `"${c.title}" by ${c.author} (${c.license}) ${c.url}`).join('\n'));
  view('props');
  return summary;
});
window.T = { ready, view, shot, progress, scene, cam, render: () => r.render(scene, cam) };
