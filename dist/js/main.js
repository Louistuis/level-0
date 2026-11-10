// LEVEL 0. Boot, game state and the frame loop.
import * as THREE from './three.module.min.js';
import { createUI } from './ui.js';
import { World } from './world.js';
import { genSector } from './worldgen.js';
import { makeTextures } from './textures.js';
import { makeMaterials } from './shaders.js';
import { Renderer } from './render.js';
import { Player } from './player.js';
import { AudioEngine } from './audio.js';
import { Entities, Anomalies } from './entities.js';
import { makeMats, SectorProps, Signs } from './props.js';
import { connect, LS } from './net.js';
import { Voice } from './voice.js';
import { createMap } from './map.js';
import { createHandheld } from './handheld.js';
import { CREDITS } from './assets.js';
import { S, SEC, SEC_M, MAPN, CEIL, ARTIFACTS, SIGNS, hash3, WORLD_SEED, clamp, damp, mod, sectorCode } from './util.js';

const VERSION = '0.2.0';
const REPO = 'https://github.com/Louistuis/level-0';
const DONATE = 'https://www.buymeacoffee.com/louis9987';
const Q = new URLSearchParams(location.search);
const edition = Q.get('edition') || ((window.WebsimSocket || /websim/.test(location.hostname)) ? 'websim' : 'lou15');
const ATTRACT = 1000; // the menu backdrop lives in a sector nobody can walk to

const ui = createUI({ version: VERSION, edition, repoUrl: REPO, donateUrl: DONATE, artifacts: ARTIFACTS, signs: SIGNS, credits: CREDITS });
const set = ui.settings;
const canvas = document.getElementById('view');
const R = new Renderer(canvas);
const audio = new AudioEngine();
const tex = makeTextures(R.maxAniso);
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(set.fov || 78, 1.6, 0.05, 90);

const G = {
  state: 'title', alive: true, safe: true, t: 0, frame: 0,
  health: 1, sanity: 1, battery: 1, flashK: 0, hurtT: 99, dmg: 0, dead: 0, fade: 1, blink: 0, exposure: 1.5,
  arts: [], taken: {}, visited: {}, stats: { sectors: 0, escapes: 0, deaths: 0, far: 0 }, playT: 0,
  secKey: '', wheel: false, talk: false, room: 0.5, net: null, voice: null, target: null, lamps: new Map(), hudT: 0, slowT: 0, saveT: 0,
  hurt(a, cause, sx, sz, quiet) {
    if (!G.alive || G.state !== 'play') return;
    G.health -= a; G.hurtT = 0; G.dmg = Math.min(1, G.dmg + (quiet ? a * 2 : 0.9));
    if (!quiet) { audio.play('hit'); ui.damage(clamp(a * 1.6, 0.3, 1)); pl.shake = 1; pl.kick = 0.5; if (sx !== undefined) { const dx = pl.x - sx, dz = pl.z - sz, d = Math.hypot(dx, dz) || 1; pl.vx += dx / d * 5; pl.vz += dz / d * 5; } }
    else ui.damage(0.15);
    if (G.health <= 0) die(cause);
  },
  drain(a) { G.sanity = Math.max(0, G.sanity - a); },
};

let net = null;
// The menu backdrop wants lit rooms, so skip seeds that roll a dark sector.
const attractSeeds = new Map();
function attractSeed(sx, sz) {
  const k = sx + ',' + sz; let v = attractSeeds.get(k);
  if (v === undefined) { v = hash3(sx, sz, WORLD_SEED ^ 0x77); attractSeeds.set(k, v); } // the layout no longer depends on the seed; worldgen keeps this far sector calm and lit
  return v;
}
const world = new World(scene, null, {
  seedFor: (sx, sz) => (sx > ATTRACT - 50 ? attractSeed(sx, sz) : (net ? net.seedFor(sx, sz) : null)),
  onLoad: (s) => { s.props = new SectorProps(scene, M, tex, s, (id) => G.taken[id]); },
  onUnload: (s) => { if (s.props) { s.props.dispose(scene); s.props = null; } },
});
const mats = makeMaterials(tex, world, 1);
world.material = mats.world;
const M = makeMats(mats, tex);
const U = mats.shared;
const pl = new Player(world, cam);
const ents = new Entities({ scene, world, M, tex, audio, shared: U });
const anom = new Anomalies({ scene, world, M, tex, audio, ents });
const signs = new Signs(scene, M);
const SIGN_IDS = SIGNS.map((s) => s.id);
R.onQuality = (q) => mats.setQuality(q);

// ---------- settings ----------
let autoQ = 'medium', ftAvg = 16, ftN = 0;
function applyQuality() { R.setQuality(set.quality === 'auto' ? autoQ : set.quality); }
function applySetting(k) {
  if (k === 'quality') applyQuality();
  else if (k === 'fov') { cam.fov = set.fov; cam.updateProjectionMatrix(); }
  else if (k === 'volume') audio.setMaster(set.volume);
  else if (k === 'voice') { if (!set.voice && G.voice) G.voice.disable(); }
}
const coarse = matchMedia('(pointer: coarse)').matches;
autoQ = coarse ? 'low' : 'medium';
applyQuality();
function resize() { R.resize(); cam.aspect = R.w / R.h; cam.fov = set.fov || 78; cam.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ---------- save ----------
const saveKey = () => 'level0.save.' + (net ? net.kind : edition);
function loadSave() { return LS.get(saveKey(), null); }
function writeSave(keepPos = true) {
  if (!net) return;
  try { LS.set('level0.mapcache', [...net.claims].slice(-3000).map(([k, c]) => [k, c.seed, c.by, c.mine ? 1 : 0])); } catch (e) { /* storage full */ }
  LS.set(saveKey(), { v: 1, pos: keepPos && G.alive ? [pl.x, pl.y, pl.z, pl.yaw] : null, health: G.health, sanity: G.sanity, battery: G.battery, arts: G.arts, taken: G.taken, visited: G.visited, stats: G.stats, playT: G.playT });
}

// ---------- input ----------
const keys = pl.keys;
const locked = () => document.pointerLockElement === canvas;
function lock() { if (ui.touch.enabled) return; try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed here */ } }
addEventListener('keydown', (e) => {
  if (e.code === 'Tab') { e.preventDefault(); if (G.state === 'play' && !e.repeat) ui.showRoster(true); }
  if (e.code === 'KeyM' && !e.repeat && !map.isOpen && !G.wheel && (G.state === 'play' || G.state === 'title') && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName || ''))) { e.preventDefault(); map.open(); return; }
  if (map.isOpen) return;
  if (G.state !== 'play' || e.repeat) return;
  if (ui.menuOpen && !G.wheel) return;
  keys.add(e.code);
  if (e.code === 'KeyF') toggleFlash();
  else if (e.code === 'KeyE') interact();
  else if (e.code === 'KeyR') hand.toggle();
  else if (e.code === 'KeyQ' && !G.wheel && G.alive) openWheel();
  else if (e.code === 'KeyV') talk(true);
});
addEventListener('keyup', (e) => { keys.delete(e.code); if (e.code === 'Tab') ui.showRoster(false); if (e.code === 'KeyV') talk(false); });
addEventListener('blur', () => { keys.clear(); talk(false); });
let dragging = false;
canvas.addEventListener('mousedown', () => { dragging = true; if (G.state === 'play' && !ui.menuOpen && !locked()) lock(); });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => { if (G.state !== 'play' || ui.menuOpen) return; if (locked() || dragging) { pl.lookX += e.movementX; pl.lookY += e.movementY; } });
document.addEventListener('pointerlockchange', () => {
  if (!locked() && G.state === 'play' && G.alive && !G.wheel && !ui.touch.enabled && !ui.menuOpen && !map.isOpen) pause(true);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function pause(on) { ui.showPause(on); audio.setPaused(on); if (on) { keys.clear(); refreshLists(); } }
function toggleFlash() {
  if (!G.alive) return;
  if (!pl.flashOn && G.battery <= 0) { audio.play('flashOff'); ui.toast({ title: 'CELL EMPTY', sub: 'Find a battery.', kind: 'danger' }); return; }
  pl.flashOn = !pl.flashOn; audio.play(pl.flashOn ? 'flashOn' : 'flashOff');
}
function openWheel() { G.wheel = true; keys.clear(); if (locked()) document.exitPointerLock(); ui.openSigns(); }
async function talk(on) {
  if (!net || net.kind === 'offline') return;
  if (on && !set.voice) { ui.toast({ title: 'VOICE IS OFF', sub: 'Turn it on in Settings.', kind: 'info' }); return; }
  if (on && G.voice && !G.voice.enabled) { const ok = await G.voice.enable(); ui.toast(ok ? { title: 'VOICE READY', sub: 'Hold V to talk to people nearby.', kind: 'info' } : { title: 'NO VOICE', sub: G.voice.error || 'Microphone unavailable.', kind: 'danger' }); return; }
  G.talk = !!on; if (G.voice) G.voice.setTalking(on); if (on) audio.play('radio', { vol: 0.5 });
}

// ---------- ui events ----------
ui.on('ui', (n) => audio.play(n === 'hover' ? 'uiHover' : n === 'back' ? 'uiBack' : 'uiClick'));
ui.on('setting', (k) => applySetting(k));
// Before we are connected (the title screen) the map shows what it knew last time.
let claimCache = null;
function cachedClaims() { if (!claimCache) { claimCache = new Map(); for (const r of LS.get('level0.mapcache', []) || []) claimCache.set(r[0], { seed: r[1], by: r[2], mine: !!r[3] }); } return claimCache; }
// The survey sheet: everything anyone has mapped, drawn by hand. M, or Map in the menus.
const map = createMap({
  genSector,
  getClaims: () => (net ? net.claims : cachedClaims()),
  getVisited: () => G.visited,
  getSigns: () => (net ? net.signs || [] : []),
  getPlayer: () => (G.state === 'play' ? { x: pl.x, z: pl.z, yaw: pl.yaw } : null),
  getPeers: () => (net ? [...net.peers().values()].filter((p) => p.s && p.s.a).map((p) => ({ x: p.s.x, z: p.s.z, name: p.username })) : []),
  sound: (n) => { if (audio.ready) audio.play(n === 'back' ? 'uiBack' : 'uiClick'); },
  onOpen: () => { keys.clear(); talk(false); if (document.pointerLockElement) document.exitPointerLock(); },
  onClose: () => { if (G.state === 'play' && G.alive && !ui.menuOpen) lock(); },
});
ui.on('map', () => map.toggle());
// The handheld unit: radar and a scrap of the map, readable while walking. R, or the touch button.
const nearby = () => (net ? [...net.peers().values()].filter((p) => p.s && p.s.a).map((p) => ({ x: p.s.x, z: p.s.z, name: p.username })) : []);
const hand = createHandheld({
  map, hint: 'R', isTouch: () => ui.touch.enabled,
  getPlayer: () => (G.state === 'play' ? { x: pl.x, z: pl.z, yaw: pl.yaw } : null),
  getPeers: nearby,
  getThings: () => [...ents.mine, ...ents.remote.values()],
  sound: (n, o) => { if (audio.ready) audio.play(n, o); },
});
// The menu has its own quiet ambience: wake the audio on the first touch of the title screen.
const wakeAudio = () => { if (G.state === 'title') audio.start().then(() => audio.setMaster(set.volume)); };
addEventListener('pointerdown', wakeAudio, true); addEventListener('keydown', wakeAudio, true);
ui.on('play', (p) => { audio.start().then(() => audio.setMaster(set.volume)); lock(); begin(p && p.name); });
ui.on('resume', () => { audio.start(); pause(false); lock(); });
ui.on('respawn', () => { audio.start(); lock(); respawn(); });
ui.on('quit', () => { writeSave(); location.reload(); });
ui.on('sign', (id) => {
  G.wheel = false; ui.closeSigns(); lock();
  if (!net || !G.alive || !pl.onGround) return;
  net.placeSign(id, pl.x - Math.sin(pl.yaw) * 0.7, pl.y, pl.z - Math.cos(pl.yaw) * 0.7, pl.yaw);
  audio.play('sign'); ui.toast({ title: 'SIGN LEFT', sub: 'Everyone who comes here will see it.', kind: 'info' });
});
ui.on('action', (n) => {
  if (n === 'flashlight') toggleFlash(); else if (n === 'interact') interact(); else if (n === 'sign') openWheel();
  else if (n === 'crouch') G.tCrouch = !G.tCrouch; else if (n === 'pause') pause(true); else if (n === 'voice') talk(!G.talk); else if (n === 'map') map.toggle(); else if (n === 'radar') hand.toggle(); else if (n === 'roster') { G.rosterOn = !G.rosterOn; ui.showRoster(G.rosterOn); }
});
// closing the wheel without picking
addEventListener('keyup', () => { if (G.wheel && !ui.menuOpen) { G.wheel = false; lock(); } });
addEventListener('click', () => { if (G.wheel && !ui.menuOpen) { G.wheel = false; lock(); } });

// ---------- flow ----------
function titleInfo() {
  const sv = LS.get('level0.save.' + (edition === 'websim' ? 'websim' : 'nord'), null) || LS.get('level0.save.offline', null);
  const st = (sv && sv.stats) || G.stats;
  return { username: net ? net.username : '', avatarUrl: net ? net.tr.avatarUrl : '', online: net ? net.online : 0, hasSave: !!(sv && sv.pos), stats: { sectors: st.sectors || 0, artifacts: sv && sv.arts ? sv.arts.length : 0, escapes: st.escapes || 0, deaths: st.deaths || 0, farthest: st.far || 0 } };
}
function hookNet() {
  net.onClaimChange = (sx, sz, seed) => world.reseed(sx, sz, seed);
  net.on('scream', (from, d) => { if (Math.hypot(d.x - pl.x, d.z - pl.z) < 60) audio.whisper(d.x, d.y, d.z, 'cry'); });
  G.voice = new Voice(net, audio);
  net.start();
}
async function boot() {
  ui.showTitle(titleInfo());
  ui.setCatalog([]);
  pl.place((ATTRACT * SEC + 24.5) * S, 0, (ATTRACT * SEC + 24.5) * S, 0.5);
  if (edition === 'websim') {
    ui.setTitleStatus('Finding the others', 0.3);
    net = await connect({ edition }); hookNet();
    const sv = loadSave(); if (sv) ui.setCatalog((sv.arts || []).map((k) => ARTIFACTS[k].id));
    ui.showTitle(titleInfo());
    ui.setTitleStatus(net.kind === 'offline' ? 'No link. You are alone in here.' : 'Connected to the shared level', 1);
  } else {
    ui.setTitleStatus('Ready', 1);
    fetch('/ws/health').then((r) => r.json()).then((j) => ui.setOnline(j.online || 0)).catch(() => {});
    const sv = LS.get('level0.save.nord', null); if (sv) ui.setCatalog((sv.arts || []).map((k) => ARTIFACTS[k].id));
  }
}
async function begin(name) {
  if (G.state !== 'title') return;
  G.state = 'loading'; G.fade = 1;
  ui.setTitleStatus('Descending', 0.2);
  if (!net) { net = await connect({ edition, name }); hookNet(); }
  if (net.kind === 'offline' && edition !== 'websim') ui.toast({ title: 'NO LINK', sub: 'Server unreachable. You are alone in here.', kind: 'danger' });
  const sv = loadSave();
  if (sv) { G.health = sv.health > 0 ? sv.health : 1; G.sanity = sv.sanity ?? 1; G.battery = sv.battery ?? 1; G.arts = sv.arts || []; G.taken = sv.taken || {}; G.visited = sv.visited || {}; G.stats = { sectors: 0, escapes: 0, deaths: 0, far: 0, ...(sv.stats || {}) }; G.playT = sv.playT || 0; }
  const cut = Date.now() - 30 * 60000; for (const k in G.taken) if (G.taken[k] < cut) delete G.taken[k];
  ui.setCatalog(G.arts.map((k) => ARTIFACTS[k].id));
  world.reset();
  G.spawnAt = sv && sv.pos ? sv.pos : null;
  const sp = G.spawnAt || [14.7, 0, 14.7, 0];
  pl.place(sp[0], sp[1], sp[2], sp[3]);
  net.setState(stateMsg());
  G.loadT = 0;
}
function finishLoad() {
  let sp = G.spawnAt;
  const bad = (p) => !p || world.solidAt(p[0], p[2]) || pl.fits(p[0], p[2], world.floorAt(p[0], p[2]), 1.75) === null;
  if (bad(sp)) { sp = null; for (let k = 0; k < 40 && !sp; k++) { const c = [14.7 + (Math.random() - 0.5) * 4, 0, 14.7 + (Math.random() - 0.5) * 4, Math.random() * 6.28]; if (!bad(c)) sp = c; } if (!sp) sp = [14.7, 0, 14.7, 0]; }
  pl.place(sp[0], world.floorAt(sp[0], sp[2]), sp[2], sp[3]);
  G.state = 'play'; G.alive = true; G.dead = 0; G.blink = 1; G.secKey = '';
  ui.enterGame(); audio.play('respawn'); pl.kick = 0.6;
  if (!G.playT) setTimeout(() => ui.subtitle('You are not supposed to be here.', 5000), 2600);
}
function die(cause) { if (map.isOpen) map.close();
  if (!G.alive) return;
  G.alive = false; G.health = 0; G.stats.deaths++; pl.frozen = true; pl.flashOn = false;
  audio.play('death'); if (net) net.send('scream', { x: pl.x, y: pl.y + 1.5, z: pl.z });
  if (locked()) document.exitPointerLock();
  writeSave(false); net && net.saveStats(statsOut());
  setTimeout(() => ui.showDeath({ cause: cause || 'Unknown', sectors: G.stats.sectors, time: G.playT, artifacts: G.arts.length }), 1400);
}
function respawn() {
  ui.hideOverlays(); ents.clear(); anom.clear();
  G.health = 1; G.sanity = 1; G.battery = Math.max(G.battery, 0.6); G.dmg = 0; G.escaping = 0; G.fade = 1; G.dead = 0; pl.frozen = false; G.wheel = false;
  world.reset(); G.spawnAt = null; pl.place(14.7, 0, 14.7, Math.random() * 6.28); G.state = 'loading'; G.loadT = 0;
}
function escape() { if (map.isOpen) map.close();
  G.stats.escapes++; G.alive = false; pl.frozen = true; audio.play('exit');
  if (locked()) document.exitPointerLock();
  writeSave(false); net.saveStats(statsOut()); G.escaping = 1;
  setTimeout(() => ui.showEscape({ sectors: G.stats.sectors, time: G.playT, escapes: G.stats.escapes }), 1800);
}
const statsOut = () => ({ sectors: G.stats.sectors, artifacts: G.arts.length, escapes: G.stats.escapes, deaths: G.stats.deaths, far: G.stats.far });

// ---------- interaction ----------
function findTarget() {
  let best = null, bd = 1.9;
  const fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
  const psx = Math.floor(pl.x / SEC_M), psz = Math.floor(pl.z / SEC_M);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const s = world.sec(psx + dx, psz + dz); if (!s || !s.props) continue;
    for (const it of s.props.items) {
      const ex = it.x - pl.x, ez = it.z - pl.z, d = Math.hypot(ex, ez);
      if (d > bd || Math.abs(it.y - (pl.y + 1)) > 1.6) continue;
      if (d > 0.5 && (ex * fx + ez * fz) / d < 0.35) continue;
      bd = d; best = { it, props: s.props };
    }
  }
  return best;
}
function interact() {
  const t = G.target; if (!t || !G.alive) return;
  const it = t.it;
  if (it.kind === 'exit') return escape();
  G.taken[it.id] = Date.now(); t.props.remove(it); G.target = null;
  if (it.kind === 'water') { G.sanity = Math.min(1, G.sanity + 0.4); G.health = Math.min(1, G.health + 0.15); audio.play('drink'); ui.toast({ title: 'ALMOND WATER', sub: 'Your head clears a little.', kind: 'info' }); }
  else if (it.kind === 'battery') { G.battery = Math.min(1, G.battery + 0.55); audio.play('battery'); ui.toast({ title: 'CELL REPLACED', sub: 'Flashlight charge restored.', kind: 'info' }); }
  else if (it.kind === 'artifact') {
    G.taken[it.id] = Date.now() + 1e12; // artifacts do not come back
    const a = ARTIFACTS[it.art];
    audio.play('artifact');
    if (!G.arts.includes(it.art)) { G.arts.push(it.art); ui.toast({ title: a.name.toUpperCase(), sub: a.desc, kind: 'artifact' }); ui.setCatalog(G.arts.map((k) => ARTIFACTS[k].id)); net.saveStats(statsOut()); }
    else ui.toast({ title: a.name.toUpperCase(), sub: 'You already carry one. It is gone when you look again.', kind: 'info' });
  }
  writeSave();
}

// ---------- per frame helpers ----------
const fr = Math.fround, fract = (v) => v - Math.floor(v);
const h11 = (p) => { p = fr(fract(fr(p * 0.1031))); p = fr(p * fr(p + 33.33)); p = fr(p * fr(p + p)); return fract(p); };
function lampOn(type, ph, t) {
  if (type === 2) { const tt = t * (7 + ph * 6) + ph * 91; return h11(Math.floor(tt * 0.17) + ph * 13) < 0.55 ? 1 : (h11(Math.floor(tt)) >= 0.45 ? 1 : 0); }
  if (type === 3) { const tt = t * 11 + ph * 91; return h11(Math.floor(tt * 0.08) + ph * 7) > 0.7 ? (h11(Math.floor(tt)) >= 0.5 ? 1 : 0) : 0; }
  return 1;
}
function lampTicks(t) {
  const bx = Math.floor((pl.x / S - 3.5) / 6 + 0.5), bz = Math.floor((pl.z / S - 3.5) / 6 + 0.5);
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = (bx + i) * 6 + 3, cz = (bz + j) * 6 + 3, ty = world.lampAt(cx, cz);
    if (ty !== 2 && ty !== 3) continue;
    const ti = (mod(cx, MAPN) + mod(cz, MAPN) * MAPN) * 4, on = lampOn(ty, world.cell[ti + 2], t), key = cx + ',' + cz, was = G.lamps.get(key);
    if (was !== undefined && was !== on) audio.lampTick((cx + 0.5) * S, world.cell[ti + 1], (cz + 1) * S, on ? 1 : 0.5);
    G.lamps.set(key, on);
  }
  if (G.lamps.size > 60) G.lamps.clear();
}
function roomSize() {
  let sum = 0;
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; let d = 0; while (d < 9 && !world.solidAt(pl.x + Math.sin(a) * (d + 0.6), pl.z + Math.cos(a) * (d + 0.6))) d += 0.6; sum += d; }
  const h = world.ceilAt(pl.x, pl.z) - pl.y;
  return clamp(sum / 72 * 0.75 + clamp((h - 2) / 5, 0, 0.35), 0, 1);
}
function stateMsg() {
  const r2 = (v) => Math.round(v * 100) / 100;
  return { x: r2(pl.x), y: r2(pl.y), z: r2(pl.z), w: r2(pl.yaw), p: r2(pl.pitch), f: pl.flashOn ? 1 : 0, c: pl.crouch ? 1 : 0, a: G.alive && G.state === 'play' ? 1 : 0, n: r2(pl.noise), v: G.voice && G.voice.enabled ? 1 : 0, e: ents.serialize() };
}
function refreshLists() {
  if (!net) return;
  ui.setLeaderboard(net.board);
  const rows = [{ username: net.username, distance: 0, you: true }];
  for (const [, r] of ents.players) rows.push({ username: r.name || 'someone', distance: Math.round(r.d || 0) });
  rows.sort((a, b) => a.distance - b.distance); ui.setPlayers(rows);
}
function enterSector(sx, sz) {
  const s = world.sec(sx, sz); if (!s || !s.data) return false;
  const k = sx + ',' + sz, c = net.claim(sx, sz);
  G.safe = sx === 0 && sz === 0;
  G.sector = { code: sectorCode(sx, sz), name: s.data.name, by: c ? c.by : null };
  if (!G.visited[k]) {
    G.visited[k] = 1;
    if (c && c.mine && net.kind !== 'offline') { G.stats.sectors++; audio.play('discover'); ui.toast({ title: 'NEW SECTOR ' + G.sector.code, sub: 'You are the first one here. It will stay the way you found it.', kind: 'discover' }); }
    else if (net.kind === 'offline') { G.stats.sectors++; ui.toast({ title: G.sector.code, sub: s.data.name, kind: 'info' }); }
    else ui.toast({ title: G.sector.code, sub: 'First entered by ' + (c ? c.by : 'someone') + '.', kind: 'info' });
    if (s.data.exit) setTimeout(() => ui.subtitle('There is a draught in here.', 4000), 3000);
    net.saveStats(statsOut()); writeSave();
  }
  return true;
}

// ---------- the frame ----------
function step(dt) {
  G.t += dt; G.frame++;
  const t = G.t, playing = G.state === 'play';
  // input
  const tc = ui.touch, blocked = !playing || (ui.menuOpen && !0) || !G.alive;
  const inp = { mx: 0, my: 0, sprint: false, crouch: false };
  if (!blocked) {
    if (tc.enabled) { inp.mx = tc.mx; inp.my = tc.my; inp.sprint = tc.sprint; inp.crouch = !!G.tCrouch; const lk = tc.takeLook(); pl.lookX += lk[0] * 2.2; pl.lookY += lk[1] * 2.2; }
    else {
      inp.mx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      inp.my = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      inp.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight'); inp.crouch = keys.has('KeyC') || keys.has('ControlLeft');
    }
  } else { pl.lookX = pl.lookY = 0; }
  if (G.state === 'title') { pl.yaw += dt * 0.035; pl.pitch = Math.sin(t * 0.21) * 0.05; }
  pl.frozen = !playing || !G.alive;
  pl.shake = damp(pl.shake, (1 - G.sanity) * 0.25 * (playing ? 1 : 0), 4, dt);
  pl.update(dt, inp, set);
  const missing = world.update(pl.x, pl.z);

  if (G.state === 'loading') {
    G.loadT += dt;
    ui.setTitleStatus(net && net.claimsReady ? 'Descending' : 'Reading the level', clamp(0.2 + G.loadT * 0.25, 0, 0.95));
    if (world.ready && missing === 0 && net && net.claimsReady && G.loadT > 0.6) finishLoad();
  }

  let L = world.light(pl.x, pl.z);
  if (playing) {
    const peers = net.peers();
    ents.myId = net.id || 'me';
    ents.syncPlayers(peers, dt, cam); ents.syncRemote(peers, dt);
    ents.update(dt, t, pl, G);
    const pr = []; for (const s of world.sectors.values()) if (s.props) pr.push(s.props);
    anom.update(dt, t, pl, G, pr);
    for (const p of pr) for (const it of p.items) if (it.float) { it.obj.rotation.y += dt * 0.6; it.obj.position.y = it.base + Math.sin(t * 1.3 + it.x) * 0.05; }
    if (G.alive) {
      G.playT += dt;
      const sx = Math.floor(pl.x / SEC_M), sz = Math.floor(pl.z / SEC_M), key = sx + ',' + sz;
      if (key !== G.secKey && enterSector(sx, sz)) G.secKey = key;
      G.stats.far = Math.max(G.stats.far, Math.round(Math.hypot(pl.x - 14.4, pl.z - 14.4)));
      // battery and flashlight
      if (pl.flashOn) { G.battery = Math.max(0, G.battery - dt / 380 * (ents.inDark > 0.2 ? 2.5 : 1)); if (G.battery <= 0) { pl.flashOn = false; audio.play('flashOff'); ui.toast({ title: 'CELL EMPTY', sub: 'The light is gone.', kind: 'danger' }); } }
      // sanity
      const lit = L > 0.3 && !anom.blackout;
      if (!lit && !pl.flashOn) G.drain(dt * 0.009);
      if (anom.blackout) G.drain(dt * 0.015);
      if (ents.watching) G.drain(dt * 0.005);
      if (ents.fear > 0.5) G.drain(dt * 0.012 * ents.fear);
      if (lit && ents.fear < 0.2 && G.sanity < 0.7) G.sanity = Math.min(0.7, G.sanity + dt * 0.004);
      if (G.sanity <= 0) G.hurt(dt * 0.03, 'You stopped being sure which one was you', undefined, undefined, true);
      G.hurtT += dt; if (G.hurtT > 14 && G.health < 1) G.health = Math.min(1, G.health + dt * 0.02);
      const tg = findTarget(); G.target = tg;
      if (tg) { const k = tg.it.kind; ui.prompt('E', k === 'water' ? 'Take almond water' : k === 'battery' ? 'Take battery' : k === 'exit' ? 'Leave through the door' : 'Take the object'); } else ui.prompt(null);
    } else ui.prompt(null);
    lampTicks(t);
  }

  // uniforms
  const flick = G.battery < 0.12 && pl.flashOn ? (Math.random() < 0.12 ? 0.25 : 1) * (0.55 + G.battery * 3) : 1;
  G.flashK = damp(G.flashK, pl.flashOn ? flick : 0, 30, dt);
  U.uTime.value = t; U.uFrame.value = G.frame % 64; U.uPulse.value = anom.pulse;
  U.uFlashPos.value.copy(pl.flashPos); U.uFlashDir.value.copy(pl.flashDir); U.uFlash.value = G.flashK;
  const F = R.fx, ex = Math.max(pl.sprinting ? 0.65 : 0, 1 - pl.stamina);
  G.exertion = damp(G.exertion || 0, ex, 1.2, dt);
  G.exposure = damp(G.exposure, 1.2 * (1 + 1.1 * (1 - clamp(L / 0.9, 0, 1)) * (pl.flashOn ? 0.2 : 1)), 0.8, dt);
  G.dmg = damp(G.dmg, 0, 1.6, dt);
  G.dead = damp(G.dead, G.alive ? 0 : 1, 1.2, dt);
  G.blink = damp(G.blink, 0, 1.6, dt); if (G.blink < 0.01) G.blink = 0;
  const wantFade = G.state === 'title' ? 0.12 : G.state === 'loading' ? 1 : (G.alive ? 0 : (G.escaping ? 1 : 0.55));
  G.fade = damp(G.fade, wantFade, wantFade > G.fade ? 3 : 1.4, dt);
  F.uTime.value = t; F.uExposure.value = G.exposure; F.uGrain.value = set.grain ?? 1; F.uVisor.value = playing && set.visor !== false ? 1 : 0;
  F.uBreath.value = clamp(0.1 + G.exertion * 0.55 + ents.fear * 0.25, 0, 1); F.uCrack.value = G.health < 0.8 ? clamp((1 - G.health) * 1.15, 0, 1) : 0;
  F.uSanity.value = playing ? clamp(G.sanity * 1.6, 0, 1) : 1; F.uDamage.value = G.dmg; F.uDead.value = G.dead; F.uFade.value = G.fade; F.uBlink.value = G.blink;
  R.render(scene, cam);

  // audio
  if (audio.ready) {
    G.slowT -= dt; if (G.slowT <= 0) { G.slowT = 0.25; G.room = roomSize(); }
    const f = pl.flashDir;
    audio.setListener(cam.position.x, cam.position.y, cam.position.z, -Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
    audio.update(dt, { hum: clamp(L / 1.1, 0, 1) * anom.pulse * (1 - ents.inDark), room: G.room, exertion: G.exertion, fear: playing ? ents.fear : 0, sanity: playing ? G.sanity : 1, dark: 1 - clamp(L / 0.4, 0, 1), blackout: Math.max(anom.blackout, ents.inDark), dead: playing && !G.alive, menu: G.state === 'title' });
  }
  hand.update(dt, { show: playing && G.alive && !ui.menuOpen && !map.isOpen, sanity: G.sanity, fear: ents.fear, speed: pl.speed });
  // network + hud
  if (net && (playing || G.state === 'loading')) { net.setState(stateMsg()); net.tick(); }
  G.hudT -= dt;
  if (playing && G.hudT <= 0) {
    G.hudT = 0.1;
    const s = G.sector || {};
    ui.setHud({ health: clamp(G.health, 0, 1), sanity: G.sanity, stamina: pl.stamina, battery: G.battery, flashlight: pl.flashOn, crouch: pl.crouch, mic: G.talk, sector: s.code || '', sectorName: s.name || '', discoverer: s.by || null, depth: Math.round(Math.hypot(pl.x - 14.4, pl.z - 14.4)), players: net.online, detector: detector(), heading: -pl.yaw });
    ui.setSanityFx(clamp(1 - G.sanity * 1.5, 0, 1));
    if (set.showFps) ui.setFps(Math.round(1000 / ftAvg));
  }
  G.saveT -= dt;
  if (playing && G.saveT <= 0) {
    G.saveT = 2;
    if (G.alive) writeSave();
    signs.sync(net.signs.filter((r) => Math.hypot(r.x - pl.x, r.z - pl.z) < 70 && !world.solidAt(r.x, r.z) && Math.abs(world.floorAt(r.x, r.z) - (r.y || 0)) < 0.5), SIGN_IDS); // marks from before a layout change may sit in a wall or over a pit: not drawn
    if (G.voice && G.voice.enabled) { const near = []; for (const [id, r] of ents.players) near.push({ id, d: r.d, x: r.x, y: r.y, z: r.z, v: (net.peers().get(id) || {}).s && net.peers().get(id).s.v }); G.voice.update(near); }
    refreshLists();
  }
}
// Something anomalous is close: artifacts, exits, the things that hunt.
function detector() {
  let best = 0;
  const psx = Math.floor(pl.x / SEC_M), psz = Math.floor(pl.z / SEC_M);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const s = world.sec(psx + dx, psz + dz); if (!s || !s.props) continue;
    for (const it of s.props.items) if (it.kind === 'artifact' || it.kind === 'exit') best = Math.max(best, 1 - Math.hypot(it.x - pl.x, it.z - pl.z) / 22);
  }
  for (const m of ents.mine) best = Math.max(best, 1 - Math.hypot(m.x - pl.x, m.z - pl.z) / 20);
  for (const m of ents.remote.values()) best = Math.max(best, 1 - Math.hypot(m.x - pl.x, m.z - pl.z) / 20);
  best = clamp(best, 0, 1);
  if (best > 0.15 && Math.random() < best * best * 0.5) audio.play('geiger', { vol: 0.35 });
  return best;
}
pl.onStep = (kind, loud) => audio.footstep(kind, loud);

let last = performance.now(), manual = false;
function loop(now) {
  requestAnimationFrame(loop);
  if (manual) return;
  const ms = now - last; last = now;
  const dt = clamp(ms / 1000, 0.001, 0.066);
  step(dt);
  // adaptive quality
  if (G.state === 'play' && document.visibilityState === 'visible' && ms < 250) {
    ftAvg += (ms - ftAvg) * 0.05; ftN++;
    if (set.quality === 'auto' && ftN > 150) {
      const order = ['low', 'medium', 'high'], i = order.indexOf(autoQ);
      if (ftAvg > 27 && i > 0) { autoQ = order[i - 1]; applyQuality(); ftN = 0; ftAvg = 16; }
      else if (ftAvg < 12.5 && i < 2 && !G.downgraded && !coarse) { autoQ = order[i + 1]; applyQuality(); ftN = -200; ftAvg = 16; G.upT = (G.upT || 0) + 1; if (G.upT > 2) G.downgraded = true; }
    }
  }
}
addEventListener('beforeunload', () => { if (G.state === 'play') writeSave(); });
document.addEventListener('visibilitychange', () => { last = performance.now(); if (document.hidden && G.state === 'play') writeSave(); });

window.__g = { G, R, world, pl, ents, anom, ui, audio, mats, cam, step, map, hand, get net() { return net; }, manual(v) { manual = v; }, sim(n, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt); return [G.state, +pl.x.toFixed(2), +pl.y.toFixed(2), +pl.z.toFixed(2), world.ready]; } };
boot().catch((e) => { console.error(e); ui.setTitleStatus('Something went wrong while starting. Reload to try again.', null); });
requestAnimationFrame(loop);
