// World: sector streaming, meshing, the toroidal map textures the shaders read,
// a diffusion pass for bounced light, and grid queries (collision, sight, paths).
import * as THREE from './three.module.min.js';
import { S, SEC, MAPN, CEIL, SEC_M, mod } from './util.js';
import { genSector } from './worldgen.js';

const K = (sx, sz) => (sx + 32768) * 65536 + (sz + 32768);
const MESH_R = 47;      // build meshes for sectors closer than this (meters, to the sector box)
const DROP_R = 64;      // dispose meshes beyond this
const WIN = 2;          // map textures hold a (2*WIN+1)^2 block of sectors around the player

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
    this.texCell = new THREE.DataTexture(this.cell, MAPN, MAPN, THREE.RGBAFormat, THREE.FloatType);
    this.texCell.wrapS = this.texCell.wrapT = THREE.RepeatWrapping; this.texCell.magFilter = this.texCell.minFilter = THREE.NearestFilter; this.texCell.needsUpdate = true;
    this.psx = 1e9; this.psz = 1e9;
    this._last = null;
    this.ready = false;
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
    }
    this.sectors.clear(); this.written.clear(); this._last = null;
    this.occ.fill(255); this.cell.fill(0); this.inj.fill(0); this.L.fill(0); this.ind.fill(0);
    this.texOcc.needsUpdate = this.texCell.needsUpdate = this.texInd.needsUpdate = true;
    this.psx = 1e9; this.ready = false; this.sweepsLeft = 0;
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
      if (dist > MESH_R) continue;
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
      if (s.mesh && dist > DROP_R) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh = null; s.dirty = true; if (s.live) { this.onUnload(s); s.live = false; } }
      if (dist > SEC_M * 5) { this.sectors.delete(k); if (this._last === s.data) this._last = null; }
    }
    if (this.sweepsLeft > 0) { this._sweep(2); this.sweepsLeft -= 2; }
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
    if (changed) {
      this.texOcc.needsUpdate = true; this.texCell.needsUpdate = true;
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
        const lt = d.lamp[i], base = lt & 7;
        this.cell[t * 4] = lt; this.cell[t * 4 + 1] = d.ceil[i]; this.cell[t * 4 + 2] = d.phase[i] / 255; this.cell[t * 4 + 3] = d.floor[i];
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

  _mesh(s) {
    const d = s.data, sx = s.sx, sz = s.sz, ox = sx * SEC, oz = sz * SEC;
    const P = [], Nn = [], M = [], X = [];
    let nv = 0;
    const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, mat, base) => {
      P.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      Nn.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
      M.push(mat, base, mat, base, mat, base, mat, base);
      X.push(nv, nv + 1, nv + 2, nv, nv + 2, nv + 3); nv += 4;
    };
    const vq = (ax, az, bx, bz, y0, y1, nx, nz, mat, base) => { if (y1 - y0 > 0.001) quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, nx, 0, nz, mat, base); };
    const nb = [this.data(sx + 1, sz), this.data(sx - 1, sz), this.data(sx, sz + 1), this.data(sx, sz - 1)];
    let nS = 0, nF = 0, nC = 0;
    const look = (x, z) => {
      let src = d;
      if (x >= SEC) { src = nb[0]; x -= SEC; } else if (x < 0) { src = nb[1]; x += SEC; } else if (z >= SEC) { src = nb[2]; z -= SEC; } else if (z < 0) { src = nb[3]; z += SEC; }
      if (!src) { nS = 1; return; }
      const i = x + z * SEC; nS = src.solid[i]; nF = src.floor[i]; nC = src.ceil[i];
    };
    for (let z = 0; z < SEC; z++) for (let x = 0; x < SEC; x++) {
      const i = x + z * SEC;
      if (d.solid[i]) continue;
      const f = d.floor[i], c = d.ceil[i];
      const X0 = (ox + x) * S, X1 = X0 + S, Z0 = (oz + z) * S, Z1 = Z0 + S;
      quad(X0, f, Z0, X0, f, Z1, X1, f, Z1, X1, f, Z0, 0, 1, 0, 0, f);
      quad(X0, c, Z0, X1, c, Z0, X1, c, Z1, X0, c, Z1, 0, -1, 0, 1, f);
      for (let k = 0; k < 4; k++) {
        let ax, az, bx, bz, nx, nz;
        if (k === 0) { look(x + 1, z); ax = X1; az = Z0; bx = X1; bz = Z1; nx = -1; nz = 0; }
        else if (k === 1) { look(x - 1, z); ax = X0; az = Z1; bx = X0; bz = Z0; nx = 1; nz = 0; }
        else if (k === 2) { look(x, z + 1); ax = X1; az = Z1; bx = X0; bz = Z1; nx = 0; nz = -1; }
        else { look(x, z - 1); ax = X0; az = Z0; bx = X1; bz = Z0; nx = 0; nz = 1; }
        if (nS) { vq(ax, az, bx, bz, f, c, nx, nz, 2, f); continue; }
        if (nF > f) { const top = Math.min(nF, c); vq(ax, az, bx, bz, f, top, nx, nz, nF - f < 0.5 ? 3 : 2, f); }
        if (nC < c) { const bot = Math.max(nC, f); vq(ax, az, bx, bz, bot, c, nx, nz, 2, nC <= f ? f : -999); }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(Nn), 3, true));
    geo.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(M), 2));
    geo.setIndex(nv > 65535 ? new THREE.BufferAttribute(new Uint32Array(X), 1) : new THREE.BufferAttribute(new Uint16Array(X), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3((ox + SEC / 2) * S, 1, (oz + SEC / 2) * S), SEC_M * 0.75 + 9);
    if (s.mesh) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); }
    s.mesh = new THREE.Mesh(geo, this.material);
    s.mesh.matrixAutoUpdate = false;
    this.scene.add(s.mesh);
    s.dirty = false;
    if (s.live) this.onUnload(s);
    s.live = true; this.onLoad(s);
  }
}
