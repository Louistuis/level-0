// World: sector streaming, meshing, the toroidal map textures the shaders read,
// a diffusion pass for bounced light, and grid queries (collision, sight, paths).
import * as THREE from './three.module.min.js';
import { S, SEC, MAPN, CEIL, SEC_M, mod, hash01 } from './util.js';
import { genSector } from './worldgen.js';
import { BIOME, BIOME_KEYS, WATER_Y } from './biomes.js';

// Dev switch: ?place=level1 (any BIOMES key) renders every cell as that place, and bioAt reports it.
export const PLACE = (() => { try { return BIOME_KEYS.indexOf(new URLSearchParams(location.search).get('place')); } catch (e) { return -1; } })();
// place id of cell i of sector data d (0 = Level 0 when the generator has not set one)
const bioOf = (d, i) => (PLACE >= 0 ? PLACE : d && d.bio ? d.bio[i] : 0);
const anyBio = (d) => { if (PLACE > 0) return true; if (!d || !d.bio) return false; if (d._bioAny === undefined) d._bioAny = d.bio.some((v) => v > 0); return d._bioAny; };
// Places whose lamps sit in a ceiling recess (the troffer); the others get hanging or surface fittings
const RECESS = [true, false, false, false, true, true];

// One reusable, growable vertex buffer for sector meshing (no per-vertex array pushes).
const MB = {
  cap: 0, nv: 0, ni: 0, P: null, N: null, M: null, X: null,
  reserve(v, i) {
    if (this.nv + v > this.cap || this.ni + i > this.cap * 1.5) {
      const cap = Math.max(65536, (this.cap || 0) * 2);
      const grow = (a, n, T) => { const b = new T(n); if (a) b.set(a); return b; };
      this.P = grow(this.P, cap * 3, Float32Array); this.N = grow(this.N, cap * 3, Int8Array);
      this.M = grow(this.M, cap * 4, Float32Array); this.X = grow(this.X, cap * 1.5, Uint32Array);
      this.cap = cap;
    }
    const at = this.nv; this.nv += v; this.ni += i; return at;
  },
};

const K = (sx, sz) => (sx + 32768) * 65536 + (sz + 32768);
// Draw range per quality tier (metres, to the sector box). The lighting textures hold the 5 x 5
// sectors round the player's sector, which is valid at least 57.6 m out in every direction, and the
// mesh loop also covers +-2 sectors; so 57 m is the ceiling without a cell-centred texture window.
// The fog goes fully opaque a few metres before the range, and a fog-coloured backdrop fills
// whatever has no geometry, so the streaming edge never shows.
const RANGE = [46, 57, 57];
const WIN = 2;          // map textures hold a (2*WIN+1)^2 block of sectors around the player
export const HZ = 12;   // lamps that light the haze

export class World {
  constructor(scene, material, opts = {}) {
    this.scene = scene; this.material = material;
    this.seedFor = opts.seedFor || (() => null);
    this.onLoad = opts.onLoad || (() => {});
    this.onUnload = opts.onUnload || (() => {});
    this.sectors = new Map();   // K -> { sx, sz, data, mesh, dirty, live }
    this.occ = new Uint8Array(MAPN * MAPN).fill(255);
    this.cell = new Float32Array(MAPN * MAPN * 4);
    this.inj = new Float32Array(MAPN * MAPN);
    this.L = new Float32Array(MAPN * MAPN);
    this.ind = new Uint8Array(MAPN * MAPN);
    this.written = new Map();   // K -> seed written into the textures
    this.sweepsLeft = 0;
    this.texOcc = new THREE.DataTexture(this.occ, MAPN, MAPN, THREE.RedFormat, THREE.UnsignedByteType);
    this.texInd = new THREE.DataTexture(this.ind, MAPN, MAPN, THREE.RedFormat, THREE.UnsignedByteType);
    for (const t of [this.texOcc, this.texInd]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.unpackAlignment = 1; t.needsUpdate = true; }
    // place id per cell for the shaders (255 = solid), and whether any place but Level 0 is in the window
    this.bio = new Uint8Array(MAPN * MAPN);
    this.texBio = new THREE.DataTexture(this.bio, MAPN, MAPN, THREE.RedFormat, THREE.UnsignedByteType);
    this.texBio.magFilter = this.texBio.minFilter = THREE.NearestFilter; this.texBio.unpackAlignment = 1; this.texBio.needsUpdate = true;
    this.bioAny = { value: PLACE > 0 ? 1 : 0 };
    this.waterMaterial = null;
    this.materialP = null;   // world shader with the places compiled in (set by makeMaterials)
    this.texCell = new THREE.DataTexture(this.cell, MAPN, MAPN, THREE.RGBAFormat, THREE.FloatType);
    this.texCell.wrapS = this.texCell.wrapT = THREE.RepeatWrapping; this.texCell.magFilter = this.texCell.minFilter = THREE.NearestFilter; this.texCell.needsUpdate = true;
    this.psx = 1e9; this.psz = 1e9;
    this._last = null;
    this.ready = false;
    // lamps near the player that light the air (read by the haze term in shaders.js):
    // xyz = lamp centre, w = type + phase * 0.999. Only lamps in plan view line of sight.
    this.hz = new Float32Array(HZ * 4); this.hzN = { value: 0 }; this._hzKey = '';
    this.meshMs = 0;
    // fog: x = distance where it starts closing in hard, y = fully opaque (shared uniform uFogEnd)
    this.fogEnd = { value: new THREE.Vector2(36, 44) };
    this.backdrop = null;
    this.setRange(1);
  }
  // Draw distance for a quality tier (0 low, 1 medium, 2 high). makeMaterials' setQuality calls this.
  setRange(q) {
    const r = RANGE[Math.max(0, Math.min(2, q | 0))];
    this.meshR = r;
    this.fogEnd.value.set(r - 13, r - 3);
  }
  // A camera-centred shell drawn before everything else, in the colour the fogged air has in each
  // direction: anything not (yet) meshed dissolves into haze instead of showing black.
  setBackdrop(material) {
    if (this.backdrop) this.scene.remove(this.backdrop);
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
    m.frustumCulled = false; m.renderOrder = -1e6; m.matrixAutoUpdate = false;
    m.onBeforeRender = (r, sc, cam) => { m.matrixWorld.makeTranslation(cam.position.x, cam.position.y, cam.position.z); };
    this.backdrop = m; this.scene.add(m);
  }
  _haze(px, pz) {
    const cx = Math.floor(px / S), cz = Math.floor(pz / S), key = cx + ',' + cz + ',' + this.written.size + ',' + this.sectors.size;
    if (key === this._hzKey) return;
    this._hzKey = key;
    const bx = Math.floor((px / S - 3.5) / 6 + 0.5), bz = Math.floor((pz / S - 3.5) / 6 + 0.5), list = [];
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      const lx = (bx + i) * 6 + 3, lz = (bz + j) * 6 + 3, ty = this.lampAt(lx, lz);
      if (ty < 1 || ty > 3) continue;
      const x = (lx + 0.5) * S, z = (lz + 1) * S, dd = (x - px) ** 2 + (z - pz) ** 2;
      if (dd > 13 * 13) continue;
      if (!this.los(px, pz, x, (lz + 0.5) * S) && !this.los(px, pz, x, (lz + 1.5) * S)) continue;
      const t = mod(lx, MAPN) + mod(lz, MAPN) * MAPN;
      // w = place * 4 + type + phase (the haze colours each lamp by its place)
      const bi = this.bio[t] === 255 ? 0 : this.bio[t];
      list.push([dd, x, this.cell[t * 4 + 1] - 0.05, z, bi * 4 + ty + this.cell[t * 4 + 2] * 0.999]);
    }
    list.sort((a, b) => a[0] - b[0]);
    const n = Math.min(HZ, list.length);
    for (let k = 0; k < n; k++) { const L = list[k]; this.hz[k * 4] = L[1]; this.hz[k * 4 + 1] = L[2]; this.hz[k * 4 + 2] = L[3]; this.hz[k * 4 + 3] = L[4]; }
    this.hzN.value = n;
  }

  sec(sx, sz) { return this.sectors.get(K(sx, sz)); }
  data(sx, sz, create) {
    let s = this.sectors.get(K(sx, sz));
    if (s && s.data) return s.data;
    if (!create) return null;
    const seed = this.seedFor(sx, sz);
    if (seed === null || seed === undefined) return null;
    if (!s) { s = { sx, sz, data: null, mesh: null, dirty: true, live: false }; this.sectors.set(K(sx, sz), s); }
    s.data = genSector(sx, sz, seed);
    return s.data;
  }
  // A claim arrived that disagrees with what we generated: rebuild that sector and its neighbours.
  reseed(sx, sz, seed) {
    const s = this.sec(sx, sz);
    if (!s || !s.data || s.data.seed === (seed >>> 0)) return;
    if (s.live) { this.onUnload(s); s.live = false; }
    s.data = null; s.dirty = true;
    this.written.delete(K(sx, sz));
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = this.sec(sx + d[0], sz + d[1]); if (n) n.dirty = true; }
    this.psx = 1e9;
  }

  // Throw everything away (used when switching from the menu backdrop to the real world).
  reset() {
    for (const s of this.sectors.values()) {
      if (s.live) this.onUnload(s);
      if (s.mesh) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); }
      this._dropWater(s);
    }
    this.sectors.clear(); this.written.clear(); this._last = null;
    this.occ.fill(255); this.cell.fill(0); this.inj.fill(0); this.L.fill(0); this.ind.fill(0); this.bio.fill(0);
    this.texOcc.needsUpdate = this.texCell.needsUpdate = this.texInd.needsUpdate = this.texBio.needsUpdate = true;
    this.bioAny.value = PLACE > 0 ? 1 : 0;
    this.psx = 1e9; this.ready = false; this.sweepsLeft = 0; this._hzKey = ''; this.hzN.value = 0;
  }

  // ---- cell queries (global cell coordinates) ----
  _d(gx, gz) {
    const sx = Math.floor(gx / SEC), sz = Math.floor(gz / SEC);
    const l = this._last;
    if (l && l.sx === sx && l.sz === sz) return l;
    const s = this.sectors.get(K(sx, sz));
    if (s && s.data) { this._last = s.data; return s.data; }
    return null;
  }
  solid(gx, gz) { const d = this._d(gx, gz); return d ? d.solid[mod(gx, SEC) + mod(gz, SEC) * SEC] === 1 : true; }
  floorC(gx, gz) { const d = this._d(gx, gz); return d ? d.floor[mod(gx, SEC) + mod(gz, SEC) * SEC] : 0; }
  ceilC(gx, gz) { const d = this._d(gx, gz); return d ? d.ceil[mod(gx, SEC) + mod(gz, SEC) * SEC] : 0; }
  solidAt(x, z) { return this.solid(Math.floor(x / S), Math.floor(z / S)); }
  floorAt(x, z) { return this.floorC(Math.floor(x / S), Math.floor(z / S)); }
  ceilAt(x, z) { return this.ceilC(Math.floor(x / S), Math.floor(z / S)); }
  light(x, z) { return this.L[mod(Math.floor(x / S), MAPN) + mod(Math.floor(z / S), MAPN) * MAPN]; }
  lampAt(gx, gz) { const d = this._d(gx, gz); return d ? d.lamp[mod(gx, SEC) + mod(gz, SEC) * SEC] : 0; }
  sectorOf(x, z) { return this.sec(Math.floor(x / SEC_M), Math.floor(z / SEC_M)); }
  // Place id (BIOME) at a world position; 0 where nothing is loaded.
  bioAt(x, z) {
    const gx = Math.floor(x / S), gz = Math.floor(z / S), d = this._d(gx, gz);
    if (!d) return PLACE >= 0 ? PLACE : 0;
    return bioOf(d, mod(gx, SEC) + mod(gz, SEC) * SEC);
  }
  // Depth of standing water (Level 37 pools) at a world position, metres; 0 when dry.
  waterAt(x, z) {
    const gx = Math.floor(x / S), gz = Math.floor(z / S), d = this._d(gx, gz);
    if (!d) return 0;
    const i = mod(gx, SEC) + mod(gz, SEC) * SEC;
    if (d.solid[i] || bioOf(d, i) !== BIOME.L37 || !(d.floor[i] < WATER_Y - 0.02)) return 0;
    return WATER_Y - d.floor[i];
  }
  // Level 0 sectors far from any other place keep the plain (cheaper) world shader
  _matFor(s) {
    if (!this.materialP) return this.material;
    if (PLACE > 0) return this.materialP;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const n = dx || dz ? this.sec(s.sx + dx, s.sz + dz) : s;
      if (n && anyBio(n.data)) return this.materialP;
    }
    return this.material;
  }
  _dropWater(s) { if (s.water) { this.scene.remove(s.water); s.water.geometry.dispose(); s.water = null; } }

  // Can something standing in cell a walk into cell b (stairs yes, ledges only downward).
  step(ax, az, bx, bz, h = 1.0) {
    const da = this._d(ax, az); if (!da) return false;
    const ia = mod(ax, SEC) + mod(az, SEC) * SEC; if (da.solid[ia]) return false;
    const db = this._d(bx, bz); if (!db) return false;
    const ib = mod(bx, SEC) + mod(bz, SEC) * SEC; if (db.solid[ib]) return false;
    const fa = da.floor[ia], fb = db.floor[ib];
    if (fb - fa > 0.36 || fa - fb > 3.2) return false;
    return Math.min(da.ceil[ia], db.ceil[ib]) - Math.max(fa, fb) >= h;
  }
  // Line of sight in the plan view (walls only). Good enough for monsters and voices.
  los(x0, z0, x1, z1) {
    let cx = Math.floor(x0 / S), cz = Math.floor(z0 / S);
    const ex = Math.floor(x1 / S), ez = Math.floor(z1 / S);
    const dx = x1 - x0, dz = z1 - z0;
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(S / dx) : 1e9, tdz = dz !== 0 ? Math.abs(S / dz) : 1e9;
    let tx = dx !== 0 ? ((dx > 0 ? (cx + 1) * S - x0 : x0 - cx * S) / Math.abs(dx)) : 1e9;
    let tz = dz !== 0 ? ((dz > 0 ? (cz + 1) * S - z0 : z0 - cz * S) / Math.abs(dz)) : 1e9;
    for (let n = 0; n < 400; n++) {
      if (cx === ex && cz === ez) return true;
      if (tx < tz) { cx += sx; tx += tdx; } else { cz += sz; tz += tdz; }
      if (this.solid(cx, cz)) return false;
    }
    return false;
  }
  // A* over cells. Returns a list of [x, z] world points or null.
  path(x0, z0, x1, z1, maxNodes = 2600, h = 1.0) {
    const sx = Math.floor(x0 / S), sz = Math.floor(z0 / S), ex = Math.floor(x1 / S), ez = Math.floor(z1 / S);
    if (this.solid(ex, ez) || this.solid(sx, sz)) return null;
    const W = 160, ox = Math.floor((sx + ex) / 2) - W / 2, oz = Math.floor((sz + ez) / 2) - W / 2;
    const id = (x, z) => (x - ox) + (z - oz) * W;
    const inw = (x, z) => x >= ox && z >= oz && x < ox + W && z < oz + W;
    if (!inw(sx, sz) || !inw(ex, ez)) return null;
    const gs = this._g || (this._g = new Float32Array(W * W)), from = this._f || (this._f = new Int32Array(W * W)), st = this._s || (this._s = new Uint8Array(W * W));
    gs.fill(1e9); st.fill(0);
    const heap = []; // [f, id]
    const push = (f, i) => { heap.push([f, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; const t = heap[p]; heap[p] = heap[c]; heap[c] = t; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { let l = c * 2 + 1, r = l + 1, m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; const t = heap[m]; heap[m] = heap[c]; heap[c] = t; c = m; } } return top; };
    const s0 = id(sx, sz), e0 = id(ex, ez);
    gs[s0] = 0; from[s0] = -1; push(0, s0);
    let nodes = 0, found = false;
    const D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (heap.length && nodes++ < maxNodes) {
      const cur = pop()[1];
      if (st[cur]) continue; st[cur] = 1;
      if (cur === e0) { found = true; break; }
      const cx = (cur % W) + ox, cz = ((cur / W) | 0) + oz;
      for (const d of D) {
        const nx = cx + d[0], nz = cz + d[1];
        if (!inw(nx, nz)) continue;
        const ni = id(nx, nz);
        if (st[ni] || !this.step(cx, cz, nx, nz, h)) continue;
        // keep a little distance from walls where possible
        let cost = 1;
        if (this.solid(nx + 1, nz) || this.solid(nx - 1, nz) || this.solid(nx, nz + 1) || this.solid(nx, nz - 1)) cost = 1.6;
        const ng = gs[cur] + cost;
        if (ng < gs[ni]) { gs[ni] = ng; from[ni] = cur; push(ng + Math.abs(nx - ex) + Math.abs(nz - ez), ni); }
      }
    }
    if (!found) return null;
    const out = [];
    for (let c = e0; c !== -1; c = from[c]) out.push([((c % W) + ox + 0.5) * S, (((c / W) | 0) + oz + 0.5) * S]);
    out.reverse();
    return out;
  }

  // ---- streaming ----
  update(px, pz) {
    const psx = Math.floor(px / SEC_M), psz = Math.floor(pz / SEC_M);
    let work = 0, missing = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const sx = psx + dx, sz = psz + dz;
      const x0 = sx * SEC_M, z0 = sz * SEC_M;
      const ddx = Math.max(x0 - px, 0, px - (x0 + SEC_M)), ddz = Math.max(z0 - pz, 0, pz - (z0 + SEC_M));
      const dist = Math.hypot(ddx, ddz);
      if (dist > this.meshR) continue;
      const d = this.data(sx, sz, true);
      if (!d) { missing++; continue; }
      const s = this.sec(sx, sz);
      if (s.mesh && !s.dirty) continue;
      // neighbours are needed for the border faces
      let ok = true;
      for (const n of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!this.data(sx + n[0], sz + n[1], true)) ok = false;
      if (!ok) { missing++; continue; }
      if (work >= (this.ready ? 1 : 3)) { missing++; continue; }
      this._mesh(s); work++;
    }
    if (psx !== this.psx || psz !== this.psz || work) { this.psx = psx; this.psz = psz; this._window(); }
    // drop far meshes and stale data
    for (const [k, s] of this.sectors) {
      const x0 = s.sx * SEC_M, z0 = s.sz * SEC_M;
      const dist = Math.hypot(Math.max(x0 - px, 0, px - (x0 + SEC_M)), Math.max(z0 - pz, 0, pz - (z0 + SEC_M)));
      if (s.mesh && dist > this.meshR + 14) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh = null; this._dropWater(s); s.dirty = true; if (s.live) { this.onUnload(s); s.live = false; } }
      if (dist > SEC_M * 5) { this.sectors.delete(k); if (this._last === s.data) this._last = null; }
    }
    if (this.sweepsLeft > 0) { this._sweep(2); this.sweepsLeft -= 2; }
    this._haze(px, pz);
    this.ready = missing === 0;
    return missing;
  }

  _window() {
    let changed = false;
    const keep = new Set();
    for (let dz = -WIN; dz <= WIN; dz++) for (let dx = -WIN; dx <= WIN; dx++) {
      const sx = this.psx + dx, sz = this.psz + dz, k = K(sx, sz);
      keep.add(k);
      const s = this.sectors.get(k);
      if (!s || !s.data) continue;
      if (this.written.get(k) === s.data.seed) continue;
      this._write(s.data); this.written.set(k, s.data.seed); changed = true;
    }
    for (const k of this.written.keys()) if (!keep.has(k)) this.written.delete(k);
    let any = PLACE > 0;
    if (!any) for (const k of keep) { const s = this.sectors.get(k); if (s && anyBio(s.data)) { any = true; break; } }
    this.bioAny.value = any ? 1 : 0;
    for (const s of this.sectors.values()) if (s.mesh) { const m = this._matFor(s); if (s.mesh.material !== m) s.mesh.material = m; }
    if (changed) {
      this.texOcc.needsUpdate = true; this.texCell.needsUpdate = true; this.texBio.needsUpdate = true;
      this._sweep(this.ready ? 6 : 14); this.sweepsLeft = 40;
    }
  }
  _write(d) {
    const ox = d.sx * SEC, oz = d.sz * SEC;
    for (let z = 0; z < SEC; z++) {
      const tz = mod(oz + z, MAPN) * MAPN;
      for (let x = 0; x < SEC; x++) {
        const i = x + z * SEC, t = mod(ox + x, MAPN) + tz;
        this.occ[t] = d.solid[i] ? 255 : 0;
        this.bio[t] = d.solid[i] ? 255 : bioOf(d, i);
        const lt = d.lamp[i], base = lt & 7;
        // solid cells get ceiling -50 / floor 50 so the shaders' contact shadow test treats them as walls
        this.cell[t * 4] = lt; this.cell[t * 4 + 1] = d.solid[i] ? -50 : d.ceil[i]; this.cell[t * 4 + 2] = d.phase[i] / 255; this.cell[t * 4 + 3] = d.solid[i] ? 50 : d.floor[i];
        this.inj[t] = lt && lt < 8 ? (base === 1 ? 1 : base === 2 ? 0.45 : base === 3 ? 0.06 : 0) : 0;
        this.L[t] = 0;
      }
    }
  }
  _sweep(n) {
    const L = this.L, occ = this.occ, inj = this.inj, N = MAPN, a = 0.2462, M = N - 1;
    for (let it = 0; it < n; it++) {
      const fwd = (it & 1) === 0;
      for (let zz = 0; zz < N; zz++) {
        const z = fwd ? zz : M - zz, zr = z * N, zu = ((z + M) & M) * N, zd = ((z + 1) & M) * N;
        for (let xx = 0; xx < N; xx++) {
          const x = fwd ? xx : M - xx, i = zr + x;
          if (occ[i]) { L[i] = 0; continue; }
          L[i] = inj[i] + a * (L[zr + ((x + 1) & M)] + L[zr + ((x + M) & M)] + L[zu + x] + L[zd + x]);
        }
      }
    }
    const ind = this.ind;
    for (let i = 0; i < N * N; i++) { const v = L[i] * 0.4; ind[i] = v >= 1 ? 255 : Math.sqrt(v) * 255; }
    this.texInd.needsUpdate = true;
  }

  // Sector mesh. Purely cosmetic detail (skirting, ceiling grid, troffer recesses, plates,
  // door casings, odd ceiling tiles) is decided from a hash of the sector seed and the cell,
  // so every player sees the same room. Nothing here feeds collision or gameplay.
  // aMat = (material, extra, u, v): 0 carpet, 1 ceiling tile (extra = variant), 2 wall (extra = floor
  // under it or -999), 3 carpeted riser, 4 skirting (extra = floor), 5 grid / wall angle metal,
  // 6 void above a missing tile, 7 troffer housing, 8 plate (extra = 0 outlet, 1 switch, 2 vent),
  // 9 door casing (extra = floor). u, v = 0..1 across the quad.
  _mesh(s) {
    const t0 = performance.now();
    const d = s.data, sx = s.sx, sz = s.sz, ox = sx * SEC, oz = sz * SEC, seed = d.seed >>> 0;
    const B = MB; B.nv = 0; B.ni = 0;
    const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, mat, base) => {
      // winding follows the normal, whatever order the corners came in
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const flip = (e1y * e2z - e1z * e2y) * nx + (e1z * e2x - e1x * e2z) * ny + (e1x * e2y - e1y * e2x) * nz < 0;
      const v = B.reserve(4, 6), P = B.P, N = B.N, M = B.M, X = B.X;
      let p = v * 3, m = v * 4;
      P[p] = ax; P[p + 1] = ay; P[p + 2] = az; P[p + 3] = bx; P[p + 4] = by; P[p + 5] = bz;
      P[p + 6] = cx; P[p + 7] = cy; P[p + 8] = cz; P[p + 9] = dx; P[p + 10] = dy; P[p + 11] = dz;
      const qx = Math.round(nx * 127), qy = Math.round(ny * 127), qz = Math.round(nz * 127);
      for (let k = 0; k < 4; k++) { N[p + k * 3] = qx; N[p + k * 3 + 1] = qy; N[p + k * 3 + 2] = qz; }
      M[m] = mat; M[m + 1] = base; M[m + 2] = 0; M[m + 3] = 0; M[m + 4] = mat; M[m + 5] = base; M[m + 6] = 1; M[m + 7] = 0;
      M[m + 8] = mat; M[m + 9] = base; M[m + 10] = 1; M[m + 11] = 1; M[m + 12] = mat; M[m + 13] = base; M[m + 14] = 0; M[m + 15] = 1;
      const i = B.ni - 6;
      if (flip) { X[i] = v; X[i + 1] = v + 2; X[i + 2] = v + 1; X[i + 3] = v; X[i + 4] = v + 3; X[i + 5] = v + 2; }
      else { X[i] = v; X[i + 1] = v + 1; X[i + 2] = v + 2; X[i + 3] = v; X[i + 4] = v + 2; X[i + 5] = v + 3; }
    };
    const tri = (ax, ay, az, bx, by, bz, cx, cy, cz, mat, base) => {
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      if (ny > 0) { nx = -nx; ny = -ny; nz = -nz; }   // only used for ceiling tiles: face down
      const l = Math.hypot(nx, ny, nz) || 1;
      quad(ax, ay, az, bx, by, bz, cx, cy, cz, cx, cy, cz, nx / l, ny / l, nz / l, mat, base);
    };
    const vq = (ax, az, bx, bz, y0, y1, nx, nz, mat, base) => { if (y1 - y0 > 0.001) quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, nx, 0, nz, mat, base); };
    // axis box, faces picked by mask: 1 +x, 2 -x, 4 +y, 8 -y, 16 +z, 32 -z (normals point out)
    const box = (x0, y0, z0, x1, y1, z1, mask, mat, base) => {
      if (mask & 1) quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0, 1, 0, 0, mat, base);
      if (mask & 2) quad(x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1, -1, 0, 0, mat, base);
      if (mask & 4) quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, 0, 1, 0, mat, base);
      if (mask & 8) quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, mat, base);
      if (mask & 16) quad(x1, y0, z1, x0, y0, z1, x0, y1, z1, x1, y1, z1, 0, 0, 1, mat, base);
      if (mask & 32) quad(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, 0, 0, -1, mat, base);
    };
    const nb = [this.data(sx + 1, sz), this.data(sx - 1, sz), this.data(sx, sz + 1), this.data(sx, sz - 1)];
    let nS = 0, nF = 0, nC = 0, nL = 0, nB = 0;
    const look = (x, z) => {
      let src = d;
      if (x >= SEC) { src = nb[0]; x -= SEC; } else if (x < 0) { src = nb[1]; x += SEC; } else if (z >= SEC) { src = nb[2]; z -= SEC; } else if (z < 0) { src = nb[3]; z += SEC; }
      if (!src || x < 0 || z < 0 || x >= SEC || z >= SEC) { nS = 1; nF = 0; nC = 0; nL = 0; nB = 0; return; }
      const i = x + z * SEC; nS = src.solid[i]; nF = src.floor[i]; nC = src.ceil[i]; nL = src.lamp[i]; nB = bioOf(src, i);
    };
    // water surfaces of Level 37 pools, one quad per flooded cell
    const WP = [];
    const solidL = (x, z) => (x >= 0 && z >= 0 && x < SEC && z < SEC ? d.solid[x + z * SEC] === 1 : this.solid(ox + x, oz + z));
    const ceilL = (x, z) => (x >= 0 && z >= 0 && x < SEC && z < SEC ? d.ceil[x + z * SEC] : this.ceilC(ox + x, oz + z));
    const doorCeil = (cc) => cc > 1.85 && cc < 2.35;
    const SK = 0.1, ST = 0.014, AW = 0.022, AH = 0.012, CW = 0.075, CT = 0.016, TB = 0.012, TW = 0.012, LR = 0.03;
    const TX = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let z = 0; z < SEC; z++) for (let x = 0; x < SEC; x++) {
      const i = x + z * SEC;
      if (d.solid[i]) continue;
      const f = d.floor[i], c = d.ceil[i], gx = ox + x, gz = oz + z;
      const X0 = gx * S, X1 = X0 + S, Z0 = gz * S, Z1 = Z0 + S;
      const bi = bioOf(d, i);
      // which trim this place has: the dropped-ceiling grid (Level 0, Level !), skirting, door casings
      const grid = bi === 0 || bi === BIOME.LRUN, skirt = bi === 0 || bi === BIOME.L5 || bi === BIOME.LRUN, cased = skirt;
      quad(X0, f, Z0, X0, f, Z1, X1, f, Z1, X1, f, Z0, 0, 1, 0, 0, f);
      if (bi === BIOME.L37 && f < WATER_Y - 0.02) WP.push(X0, Z0, X1, Z1);
      // ---- ceiling ----
      const lt = d.lamp[i];
      if (!RECESS[bi]) {
        // bare slab or plaster: flat, the fitting hangs from it (extra 7 = never a lens)
        quad(X0, c, Z0, X1, c, Z0, X1, c, Z1, X0, c, Z1, 0, -1, 0, 1, lt ? 7 : 0);
        if (lt && lt < 8) {
          const cx = X0 + S / 2, cz = Z1;
          if (bi === BIOME.L1) {
            // twin-tube batten on two short hangers
            const z0 = Z0 + 0.1, z1 = Z1 + S - 0.1, y0 = c - 0.13, y1 = c - 0.05;
            box(cx - 0.075, y0, z0, cx + 0.075, y1, z1, 63, 10, 0);
            box(cx - 0.004, y1, z0 + 0.1, cx + 0.004, c, z0 + 0.108, 63, 5, 0); box(cx - 0.004, y1, z1 - 0.108, cx + 0.004, c, z1 - 0.1, 63, 5, 0);
          } else if (bi === BIOME.L2) {
            // a bare bulb in a little steel shade on its cord
            box(cx - 0.035, c - 0.23, cz - 0.035, cx + 0.035, c - 0.15, cz + 0.035, 63, 10, 1);
            box(cx - 0.11, c - 0.15, cz - 0.11, cx + 0.11, c - 0.12, cz + 0.11, 1 | 2 | 4 | 16 | 32, 5, 0);
            box(cx - 0.004, c - 0.12, cz - 0.004, cx + 0.004, c, cz + 0.004, 63, 5, 0);
          } else {
            // frosted dome on a brass rim
            box(cx - 0.21, c - 0.075, cz - 0.21, cx + 0.21, c, cz + 0.21, 1 | 2 | 8 | 16 | 32, 10, 2);
          }
        }
      } else if (lt && lt < 8) {
        // troffer: diffuser sits LR above the grid inside a white sheet-metal housing
        const two = z + 1 < SEC && d.lamp[i + SEC] === lt + 8 && !d.solid[i + SEC];
        const ZE = two ? Z1 + S : Z1, cr = c + LR;
        quad(X0, cr, Z0, X1, cr, Z0, X1, cr, ZE, X0, cr, ZE, 0, -1, 0, 1, 0);
        vq(X0, Z0, X1, Z0, c, cr, 0, 1, 7, 0); vq(X1, ZE, X0, ZE, c, cr, 0, -1, 7, 0);
        vq(X0, ZE, X0, Z0, c, cr, 1, 0, 7, 0); vq(X1, Z0, X1, ZE, c, cr, -1, 0, 7, 0);
      } else if (!lt && bi === BIOME.L37) {
        quad(X0, c, Z0, X1, c, Z0, X1, c, Z1, X0, c, Z1, 0, -1, 0, 1, 0);
      } else if (!lt) {
        const h = hash01(gx, gz, seed ^ 0x51e7);
        if (h < 0.006) {
          // a missing tile: the dark plenum above
          const top = c + 0.42;
          quad(X0, top, Z0, X1, top, Z0, X1, top, Z1, X0, top, Z1, 0, -1, 0, 6, 0);
          vq(X0, Z0, X1, Z0, c, top, 0, 1, 6, 0); vq(X1, Z1, X0, Z1, c, top, 0, -1, 6, 0);
          vq(X0, Z1, X0, Z0, c, top, 1, 0, 6, 0); vq(X1, Z0, X1, Z1, c, top, -1, 0, 6, 0);
        } else if (h < 0.022) {
          // a waterlogged tile sagging between the bars
          const mx = X0 + S * (0.4 + 0.2 * hash01(gx, gz, 7)), mz = Z0 + S * (0.4 + 0.2 * hash01(gx, gz, 9)), my = c - 0.028 - 0.03 * hash01(gx, gz, 11);
          tri(X0, c, Z0, X1, c, Z0, mx, my, mz, 1, 1); tri(X1, c, Z0, X1, c, Z1, mx, my, mz, 1, 1);
          tri(X1, c, Z1, X0, c, Z1, mx, my, mz, 1, 1); tri(X0, c, Z1, X0, c, Z0, mx, my, mz, 1, 1);
        } else {
          const v = h < 0.075 ? 1 : h < 0.087 ? 2 : 0;   // 1 stained, 2 return-air grille
          quad(X0, c, Z0, X1, c, Z0, X1, c, Z1, X0, c, Z1, 0, -1, 0, 1, v);
        }
      }
      // ---- ceiling grid: T-bars on the +x and +z edges of this cell (merged into runs below) ----
      // ---- walls ----
      for (let k = 0; k < 4; k++) {
        let ax, az, bx, bz, nx, nz;
        if (k === 0) { look(x + 1, z); ax = X1; az = Z0; bx = X1; bz = Z1; nx = -1; nz = 0; }
        else if (k === 1) { look(x - 1, z); ax = X0; az = Z1; bx = X0; bz = Z0; nx = 1; nz = 0; }
        else if (k === 2) { look(x, z + 1); ax = X1; az = Z1; bx = X0; bz = Z1; nx = 0; nz = -1; }
        else { look(x, z - 1); ax = X0; az = Z0; bx = X1; bz = Z0; nx = 0; nz = 1; }
        let wb = 0, wt = 0, full = false, header = false;
        if (nS) { vq(ax, az, bx, bz, f, c, nx, nz, 2, f); wb = f; wt = c; full = true; }
        else {
          const nf = nF, nc = nC;
          if (nf > f) { const top = Math.min(nf, c); vq(ax, az, bx, bz, f, top, nx, nz, nf - f < 0.5 ? 3 : 2, f); if (nf - f >= 0.5) { wb = f; wt = top; full = top >= c; } }
          if (nc < c) { const bot = Math.max(nc, f); vq(ax, az, bx, bz, bot, c, nx, nz, 2, nc <= f ? f : -999); if (nc <= f) { wb = f; wt = c; full = true; } else { if (!wt) wb = bot; wt = c; header = doorCeil(nc) && nf === f && c - nc > 0.3; } }
        }
        if (!wt) continue;
        // geometry helpers in the wall's frame: tangent runs a -> b, the wall plane is at (ax, az)
        const tx = bx - ax > 0 ? 1 : bx - ax < 0 ? -1 : 0, tz = bz - az > 0 ? 1 : bz - az < 0 ? -1 : 0;
        // strip on the wall face: from tangent offset s0 to s1 (metres from a), y0..y1, sticking out t
        const strip = (s0, s1, y0, y1, t, mask, mat, base) => {
          const p0x = ax + tx * s0, p0z = az + tz * s0, p1x = ax + tx * s1, p1z = az + tz * s1;
          const qx0 = Math.min(p0x, p1x, p0x + nx * t), qx1 = Math.max(p0x, p1x, p0x + nx * t);
          const qz0 = Math.min(p0z, p1z, p0z + nz * t), qz1 = Math.max(p0z, p1z, p0z + nz * t);
          box(qx0, y0, qz0, qx1, y1, qz1, mask, mat, base);
        };
        // face bits in the wall frame: front = along n, ends = along -t (at a) and +t (at b)
        const bit = (vx, vz) => (vx > 0 ? 1 : vx < 0 ? 2 : vz > 0 ? 16 : vz < 0 ? 32 : 0);
        const FRONT = bit(nx, nz), END_A = bit(-tx, -tz), END_B = bit(tx, tz);
        // what is next to this face along the wall (cell coords of this cell +/- t)
        const outer = (sgn) => { const cx = x + tx * sgn, cz = z + tz * sgn; return !solidL(cx, cz) && !solidL(cx - nx, cz - nz); };
        const jamb = (sgn) => { const cx = x + tx * sgn, cz = z + tz * sgn; return !solidL(cx, cz) && !solidL(cx - nx, cz - nz) && doorCeil(ceilL(cx - nx, cz - nz)) && Math.abs(ceilL(cx, cz) - c) < 0.01; };
        const oA = full && outer(-1), oB = full && outer(1);
        const jA = oA && wb === f && jamb(-1), jB = oB && wb === f && jamb(1);
        if (skirt && wb === f && wt - wb > 0.5) {
          // skirting board, wrapped round outer corners, stopping at a door casing
          const wA = oA && !jA, wB = oB && !jB, hotel = bi === BIOME.L5, sk = hotel ? 0.17 : SK, st = hotel ? 0.02 : ST;
          strip(wA ? -st : 0, wB ? S + st : S, f, f + sk, st, FRONT | 4 | (wA ? END_A : 0) | (wB ? END_B : 0), 4, f);
          // the hotel's chair rail, on top of the wainscot
          if (hotel && full && wt - wb > 1.2) strip(wA ? -0.024 : 0, wB ? S + 0.024 : S, f + 0.9, f + 0.95, 0.024, FRONT | 4 | 8 | (wA ? END_A : 0) | (wB ? END_B : 0), 4, f);
        }
        if (wt >= c - 0.001 && (grid || (bi === BIOME.L5 && full))) {
          // wall angle where the grid meets the wall (a deeper plaster cornice in the hotel)
          const aw = grid ? AW : 0.07, ah = grid ? AH : 0.09;
          strip(oA ? -aw : 0, oB ? S + aw : S, c - ah, c, aw, FRONT | 8 | (oA ? END_A : 0) | (oB ? END_B : 0), 5, 0);
        }
        if (cased && full && wb === f) {
          const hdr = (sgn) => ceilL(x + tx * sgn - nx, z + tz * sgn - nz);
          // door casing up each jamb (the head casing is added on the head face below)
          if (jA) strip(0, CW, f, hdr(-1) + CW, CT, FRONT | END_A | END_B | 4, 9, f);
          if (jB) strip(S - CW, S, f, hdr(1) + CW, CT, FRONT | END_A | END_B | 4, 9, f);
          const hp = hash01(gx * 4 + k, gz, seed ^ 0x9a7e);
          if ((jA || jB) && hp < 0.45 && f + 1.3 < c) {
            // light switch beside the door
            const sc = jB ? S - CW - 0.09 : CW + 0.09;
            strip(sc - 0.036, sc + 0.036, f + 1.12, f + 1.24, 0.008, FRONT | 1 | 2 | 4 | 8 | 16 | 32, 8, 1);
          } else if (hp > 0.968 && !oA && !oB) {
            // duplex outlet low on the wall
            strip(S / 2 - 0.036, S / 2 + 0.036, f + 0.27, f + 0.388, 0.008, 63, 8, 0);
          } else if (hp > 0.955 && hp <= 0.968 && c - f > 2.45 && !oA && !oB) {
            // return-air grille high on the wall
            strip(0.12, S - 0.12, c - 0.42, c - 0.24, 0.006, 63, 8, 2);
          }
        }
        if (header && cased) {
          // casing under a door head; the opening is the neighbour cell (x - n). Past the
          // opening's ends it runs on over the jamb casings.
          const nc = wb;
          const ext = (sgn) => solidL(x + tx * sgn - nx, z + tz * sgn - nz);
          const eA = ext(-1), eB = ext(1);
          strip(eA ? -CW : 0, eB ? S + CW : S, nc, nc + CW, CT, FRONT | 8 | 4 | (eA ? END_A : 0) | (eB ? END_B : 0), 9, f);
        }
      }
    }
    // ---- T-bars, merged into runs. Lines between cells with the same ceiling, not through a troffer. ----
    const cellCeil = (x, z) => { look(x, z); return nS ? NaN : nC; };
    for (let axis = 0; axis < 2; axis++) {
      for (let line = 1; line <= SEC; line++) {
        let run = -1, rc = 0;
        for (let t = 0; t <= SEC; t++) {
          let ok = false, cc = 0;
          if (t < SEC) {
            const xa = axis ? line - 1 : t, za = axis ? t : line - 1, xb = axis ? line : t, zb = axis ? t : line;
            const ca = cellCeil(xa, za), la = nL, ba = nB, cb = cellCeil(xb, zb), lb = nL, bb = nB;
            if (ca === ca && cb === cb && Math.abs(ca - cb) < 0.001 && (ba === 0 || ba === BIOME.LRUN) && (bb === 0 || bb === BIOME.LRUN)) {
              ok = !(axis === 0 && la > 0 && la < 8 && lb === la + 8);
              cc = ca;
            }
          }
          if (run >= 0 && (!ok || Math.abs(cc - rc) > 0.001)) {
            const p = line * S, a = run * S, b = t * S, y0 = rc - TB;
            if (axis === 0) box((ox * S) + a, y0, (oz * S) + p - TW, (ox * S) + b, rc, (oz * S) + p + TW, 8 | 16 | 32, 5, 0);
            else box((ox * S) + p - TW, y0, (oz * S) + a, (ox * S) + p + TW, rc, (oz * S) + b, 8 | 1 | 2, 5, 0);
            run = -1;
          }
          if (ok && run < 0) { run = t; rc = cc; }
        }
      }
    }
    const nv = B.nv, ni = B.ni;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(B.P.slice(0, nv * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(B.N.slice(0, nv * 3), 3, true));
    geo.setAttribute('aMat', new THREE.BufferAttribute(B.M.slice(0, nv * 4), 4));
    geo.setIndex(nv > 65535 ? new THREE.BufferAttribute(B.X.slice(0, ni), 1) : new THREE.BufferAttribute(Uint16Array.from(B.X.subarray(0, ni)), 1));
    this.meshMs = performance.now() - t0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3((ox + SEC / 2) * S, 1, (oz + SEC / 2) * S), SEC_M * 0.75 + 9);
    if (s.mesh) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); }
    s.mesh = new THREE.Mesh(geo, this._matFor(s));
    s.mesh.matrixAutoUpdate = false;
    this.scene.add(s.mesh);
    this._dropWater(s);
    if (WP.length && this.waterMaterial) {
      const n = WP.length / 4, pos = new Float32Array(n * 12), idx = new Uint32Array(n * 6);
      for (let k = 0; k < n; k++) {
        const a = WP[k * 4], b = WP[k * 4 + 1], c2 = WP[k * 4 + 2], e = WP[k * 4 + 3], o = k * 12, v = k * 4;
        pos.set([a, WATER_Y, b, a, WATER_Y, e, c2, WATER_Y, e, c2, WATER_Y, b], o);
        idx.set([v, v + 1, v + 2, v, v + 2, v + 3], k * 6);
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      wg.setIndex(new THREE.BufferAttribute(idx, 1));
      wg.boundingSphere = geo.boundingSphere.clone();
      s.water = new THREE.Mesh(wg, this.waterMaterial);
      s.water.matrixAutoUpdate = false; s.water.renderOrder = 2;
      this.scene.add(s.water);
    }
    s.dirty = false;
    if (s.live) this.onUnload(s);
    s.live = true; this.onLoad(s);
  }
}
