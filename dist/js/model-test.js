// Dev helper for looking at models inside the running game (not loaded by the game itself).
// In the console of http://localhost:8790/?offline=1, after entering play:
//   const T = await import('/js/model-test.js'); T.init();
//   T.lineup(); T.shot('name', { from: [x, y, z], at: [x, y, z], flash: true, dark: true });
import * as THREE from './three.module.min.js';
import * as P from './props.js';

const g = () => window.__g;
let ctx = null;

export async function enter() {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Continue' || x.textContent.trim() === 'Enter');
  if (b) b.click();
  await new Promise((r) => setTimeout(r, 1200));
  g().manual(true);
  for (let i = 0; i < 60 && g().G.state !== 'play'; i++) { g().sim(5); await new Promise((r) => setTimeout(r, 50)); }
  return g().G.state;
}
// put the camera at eye height looking along the player's yaw; returns helpers in that frame
export function frame() {
  const pl = g().pl, fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw), rx = Math.cos(pl.yaw), rz = -Math.sin(pl.yaw);
  return { pl, at: (f, r, y = 0) => [pl.x + fx * f + rx * r, pl.y + y, pl.z + fz * f + rz * r], yaw: pl.yaw };
}
export function init() {
  const G = g();
  G.manual(true);
  const scene = G.ents.scene, M = G.ents.M, U = G.ents.shared;
  const grp = new THREE.Group(); scene.add(grp);
  ctx = { scene, M, U, grp, items: [] };
  return ctx;
}
export function clear() { if (!ctx) return; for (const o of [...ctx.grp.children]) ctx.grp.remove(o); ctx.items.length = 0; }
export function add(obj, x, y, z, yaw = 0, anim = null) { obj.position.set(x, y, z); obj.rotation.y = yaw; ctx.grp.add(obj); ctx.items.push({ obj, anim }); return obj; }

// a spot near the player with a floor, by light level
export function spot(minR = 3, maxR = 8, lit = 0.5) {
  const G = g(); return G.ents.findSpot(G.pl.x, G.pl.y, G.pl.z, minR, maxR, { lit });
}

export function animate(n = 30, dt = 1 / 60, t0 = 0) {
  let t = t0;
  for (let i = 0; i < n; i++) { t += dt; for (const it of ctx.items) if (it.anim) it.anim(it.obj, dt, t); }
}

// Render one frame from an arbitrary camera and post it to the local receiver.
export async function shot(name, o = {}) {
  const G = g(), cam = G.cam, U = ctx.U, F = G.R.fx;
  G.sim(1);
  cam.position.set(...o.from); cam.lookAt(new THREE.Vector3(...o.at)); cam.updateMatrixWorld();
  if (o.fov) { cam.fov = o.fov; cam.updateProjectionMatrix(); }
  const dir = new THREE.Vector3(...o.at).sub(cam.position).normalize();
  U.uFlashPos.value.copy(cam.position).addScaledVector(new THREE.Vector3(0, -1, 0), 0.15);
  U.uFlashDir.value.copy(dir);
  U.uFlash.value = o.flash ? 1 : 0;
  U.uPulse.value = o.dark ? (o.pulse ?? 0.015) : 1;
  F.uExposure.value = o.exposure ?? (o.dark ? 2.6 : 1.5);
  F.uVisor.value = o.visor ? 1 : 0; F.uFade.value = 0; F.uBlink.value = 0; F.uDamage.value = 0; F.uSanity.value = 1; F.uBreath.value = 0.1; F.uCrack.value = 0;
  G.R.render(G.ents.scene, cam);
  const c = G.R.r.domElement;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  if (name) await fetch('http://127.0.0.1:8799/' + name + '.jpg', { method: 'POST', body: blob });
  return name;
}

// frame time with a GPU sync per frame
export function bench(n = 120) {
  const G = g(), gl = G.R.r.getContext(), px = new Uint8Array(4);
  G.sim(5); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) { G.sim(1); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  const ms = (performance.now() - t0) / n;
  const r = G.R.r; r.info.autoReset = false; r.info.reset(); G.sim(1); r.info.autoReset = true;
  const info = r.info.render;
  return { ms: +ms.toFixed(2), calls: info.calls, tris: info.triangles };
}

export function count(obj) {
  let tris = 0, calls = 0;
  obj.traverse((o) => { if (o.isMesh && o.visible !== false) { calls++; const gg = o.geometry; tris += (gg.index ? gg.index.count : gg.attributes.position.count) / 3; } });
  return { tris: Math.round(tris), calls };
}

export { P, THREE };

// standard set: everything in a row in front of the player
export function lineup() {
  clear();
  const F = frame(), M = ctx.M, G = g();
  const L = P.makeLongarm(M); add(L, ...F.at(3.0, -0.5), F.yaw + Math.PI, (o, dt, t) => P.animLongarm(o, dt, 0, 0, t));
  add(P.makeSuit(M, false), ...F.at(3.0, 0.5), F.yaw + Math.PI, (o, dt) => P.animSuit(o, dt, 0, false, 0));
  add(P.makeSuit(M, true), ...F.at(3.4, 1.3), F.yaw + Math.PI);
  add(P.makeChair(M), ...F.at(2.6, -1.4), F.yaw + Math.PI);
  return F;
}
export function props() {
  clear();
  const F = frame(), M = ctx.M, G = g();
  add(P.makeDoor(M, G.ents.tex, true), ...F.at(3.2, 0.7), F.yaw);
  add(P.makeChair(M), ...F.at(2.4, -0.9), F.yaw + 2.6);
  for (let k = 0; k < 12; k++) { const r = (k % 6 - 2.5) * 0.3, f = 1.5 + Math.floor(k / 6) * 0.35; add(P.makeArtifact(M, k), ...F.at(f, r, 1.15 - Math.floor(k / 6) * 0.3), F.yaw + Math.PI + 0.3); }
  return F;
}
