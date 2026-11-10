// Sector generator. A sector is a 48x48 heightfield: every cell has a floor and a
// ceiling height (or is solid). That is enough for rooms, pillars, pits, stairs,
// mezzanines, crawl spaces, trenches and rooms under the floor.
// The layout comes from the seed stored by whoever generated the sector first.
// Portals on the four edges depend only on the world seed, so neighbours always connect.
import { SEC, LAT, BAYS, CEIL, WORLD_SEED, hash3, mulberry32, clamp } from './util.js';

const N = SEC;
const I = (x, z) => x + z * N;
const inb = (x, z) => x >= 0 && z >= 0 && x < N && z < N;

export const TYPE_NAMES = {
  classic: 'Office floor', dense: 'Partition warren', pillars: 'Pillar hall', hall: 'The long dark',
  pit: 'Sunken court', mezz: 'Mezzanine', tunnels: 'Service tunnels', dark: 'Dead grid',
};

export function edgePortals(ex, ez, vertical) {
  const r = mulberry32(hash3(ex * 2 + (vertical ? 1 : 0), ez, WORLD_SEED ^ 0x51ed));
  const n = 2 + (r() < 0.45 ? 1 : 0);
  const bays = [];
  while (bays.length < n) { const b = r.int(BAYS); if (!bays.includes(b)) bays.push(b); }
  return bays;
}

export function sectorHasExit(sx, sz) {
  const d = Math.max(Math.abs(sx), Math.abs(sz));
  return d >= 3 && hash3(sx, sz, WORLD_SEED ^ 0xe417) % 17 === 0;
}

function pickType(rng, d) {
  if (d === 0) return 'classic';
  const far = Math.min(d, 10);
  const w = [
    ['classic', 36], ['dense', 12], ['pillars', 12], ['pit', 10], ['mezz', 8],
    ['dark', 4 + far], ['tunnels', 5 + far * 0.8], ['hall', 3 + far * 0.5],
  ];
  let tot = 0; for (const e of w) tot += e[1];
  let r = rng() * tot;
  for (const e of w) { r -= e[1]; if (r <= 0) return e[0]; }
  return 'classic';
}

class G {
  constructor(sx, sz, seed) {
    this.sx = sx; this.sz = sz; this.seed = seed >>> 0;
    this.floor = new Float32Array(N * N);
    this.ceil = new Float32Array(N * N).fill(CEIL);
    this.solid = new Uint8Array(N * N);
    this.lamp = new Uint8Array(N * N);   // 0 none, 1 steady, 2 flicker, 3 dying, 4 dead; +8 = second cell of the panel
    this.phase = new Uint8Array(N * N);
    this.reach = null;
    this.items = []; this.marks = []; this.exit = null; this.artifact = null;
    this.type = 'classic'; this.name = ''; this.danger = 0; this.special = [];
  }
  wall(x, z) { if (inb(x, z)) this.solid[I(x, z)] = 1; }
  open(x, z, f, c) {
    if (!inb(x, z)) return;
    const i = I(x, z); this.solid[i] = 0;
    if (f !== undefined) this.floor[i] = f;
    if (c !== undefined) this.ceil[i] = c;
  }
  rect(x0, z0, x1, z1, f, c) { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.open(x, z, f, c); }
  block(x0, z0, x1, z1) { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.wall(x, z); }
  isOpen(x, z) { return inb(x, z) && !this.solid[I(x, z)]; }
}

// Walls on the 6-cell lattice with doorways. This is the classic look.
function lattice(g, rng, p, doorP, halls) {
  const inHall = (i, j) => { for (const h of halls) if (i >= h[0] && j >= h[1] && i <= h[2] && j <= h[3]) return true; return false; };
  const V = new Uint8Array(BAYS * BAYS), H = new Uint8Array(BAYS * BAYS);
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    const hv = inHall(i, j) && (i === 0 || inHall(i - 1, j));
    const hh = inHall(i, j) && (j === 0 || inHall(i, j - 1));
    if (rng() < (hv ? p * 0.08 : p)) {
      V[i + j * BAYS] = 1;
      const x = i * LAT, z0 = j * LAT;
      for (let k = 1; k <= 5; k++) g.wall(x, z0 + k);
      const r = rng();
      if (r < doorP) { const c = rng() < 0.55 ? 2.1 : CEIL; for (let k = 2; k <= 4; k++) g.open(x, z0 + k, 0, c); }
      else if (r < doorP + 0.12) { for (let k = 4; k <= 5; k++) g.open(x, z0 + k, 0, CEIL); }
    }
    if (rng() < (hh ? p * 0.08 : p)) {
      H[i + j * BAYS] = 1;
      const z = j * LAT, x0 = i * LAT;
      for (let k = 1; k <= 5; k++) g.wall(x0 + k, z);
      const r = rng();
      if (r < doorP) { const c = rng() < 0.55 ? 2.1 : CEIL; for (let k = 2; k <= 4; k++) g.open(x0 + k, z, 0, c); }
      else if (r < doorP + 0.12) { for (let k = 4; k <= 5; k++) g.open(x0 + k, z, 0, CEIL); }
    }
  }
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    const any = V[i + j * BAYS] || (j > 0 && V[i + (j - 1) * BAYS]) || H[i + j * BAYS] || (i > 0 && H[i - 1 + j * BAYS]);
    if (any || (!inHall(i, j) && rng() < 0.22)) g.wall(i * LAT, j * LAT);
    // odd free standing bits inside a bay
    if (!inHall(i, j)) {
      const r = rng();
      if (r < 0.05) g.block(i * LAT + 4, j * LAT + 4, i * LAT + 5, j * LAT + 5);
      else if (r < 0.10) { for (let k = 1; k <= 3; k++) g.wall(i * LAT + 1 + k, j * LAT + 1); }
      else if (r < 0.14) { for (let k = 1; k <= 3; k++) g.wall(i * LAT + 5, j * LAT + k); }
    }
  }
}

function randHalls(rng, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const w = 2 + rng.int(3), h = 2 + rng.int(3);
    const i = rng.int(BAYS - w + 1), j = rng.int(BAYS - h + 1);
    out.push([i, j, i + w - 1, j + h - 1]);
  }
  return out;
}

function bayRegion(rng) {
  const bw = 2 + rng.int(2), bh = 2 + rng.int(2);
  const bi = 1 + rng.int(7 - bw), bj = 1 + rng.int(7 - bh);
  return { bi, bj, bw, bh, x0: bi * LAT + 1, z0: bj * LAT + 1, x1: (bi + bw) * LAT - 1, z1: (bj + bh) * LAT - 1 };
}

function buildPit(g, rng) {
  lattice(g, rng, 0.3, 0.45, []);
  const R = bayRegion(rng);
  const depth = rng.pick([1.5, 1.5, 2.1, 2.4]);
  const steps = Math.round(depth / 0.3);
  g.rect(R.x0, R.z0, R.x1, R.z1, -depth, CEIL);
  for (let j = R.bj + 1; j < R.bj + R.bh; j++) for (let i = R.bi + 1; i < R.bi + R.bw; i++) if (rng() < 0.7) g.wall(i * LAT, j * LAT);
  for (let k = 0; k < steps; k++) { g.open(R.x0 + k, R.z0, -0.3 * (k + 1), CEIL); g.open(R.x0 + k, R.z0 + 1, -0.3 * (k + 1), CEIL); }
  g.rect(R.x0 - 2, R.z0, R.x0 - 1, R.z0 + 1, 0, CEIL);
  if (rng() < 0.7) {
    for (let k = 0; k < steps; k++) { g.open(R.x1 - k, R.z1, -0.3 * (k + 1), CEIL); g.open(R.x1 - k, R.z1 - 1, -0.3 * (k + 1), CEIL); }
    g.rect(R.x1 + 1, R.z1 - 1, R.x1 + 2, R.z1, 0, CEIL);
  }
  g.special.push({ kind: 'pit', x: (R.x0 + R.x1) >> 1, z: (R.z0 + R.z1) >> 1 });
}

function buildMezz(g, rng) {
  lattice(g, rng, 0.3, 0.45, []);
  const R = bayRegion(rng);
  const h = 1.5, c = CEIL + h;
  g.rect(R.x0, R.z0, R.x1, R.z1, h, c);
  for (let j = R.bj + 1; j < R.bj + R.bh; j++) for (let i = R.bi + 1; i < R.bi + R.bw; i++) if (rng() < 0.5) g.wall(i * LAT, j * LAT);
  for (let k = 0; k < 5; k++) { g.open(R.x0 + k, R.z0, 0.3 * (k + 1), c); g.open(R.x0 + k, R.z0 + 1, 0.3 * (k + 1), c); }
  g.rect(R.x0 - 2, R.z0, R.x0 - 1, R.z0 + 1, 0, CEIL);
  if (rng() < 0.6) {
    for (let k = 0; k < 5; k++) { g.open(R.x1, R.z1 - k, 0.3 * (k + 1), c); g.open(R.x1 - 1, R.z1 - k, 0.3 * (k + 1), c); }
    g.rect(R.x1 - 1, R.z1 + 1, R.x1, R.z1 + 2, 0, CEIL);
  }
  g.special.push({ kind: 'mezz', x: (R.x0 + R.x1) >> 1, z: (R.z0 + R.z1) >> 1 });
}

function buildPillars(g, rng) {
  const c = rng.pick([CEIL, 3.3, 3.3]);
  g.ceil.fill(c);
  const big = rng() < 0.3, skip = rng() < 0.35 ? 2 : 1;
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    if ((i % skip) || (j % skip)) continue;
    if (rng() < 0.92) { if (big) g.block(i * LAT, j * LAT, i * LAT + 1, j * LAT + 1); else g.wall(i * LAT, j * LAT); }
  }
}

function buildHall(g, rng) {
  g.ceil.fill(5.4);
  for (let j = 0; j < BAYS; j += 2) for (let i = 0; i < BAYS; i += 2) if (rng() < 0.45) g.block(i * LAT, j * LAT, i * LAT + 1, j * LAT + 1);
}

function buildTunnels(g, rng) {
  g.solid.fill(1);
  const B = BAYS, used = new Uint8Array(B * B), hgt = new Float32Array(B * B);
  const E = new Uint8Array(B * B * 2); // edge to +x (0) and +z (1)
  const stack = [rng.int(B) + rng.int(B) * B]; used[stack[0]] = 1;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const ring = (i, j) => i === 0 || j === 0 || i === B - 1 || j === B - 1;
  while (stack.length) {
    const cur = stack[stack.length - 1], ci = cur % B, cj = (cur / B) | 0;
    const opts = [];
    for (const d of dirs) { const ni = ci + d[0], nj = cj + d[1]; if (ni >= 0 && nj >= 0 && ni < B && nj < B && !used[ni + nj * B]) opts.push(d); }
    if (!opts.length) { stack.pop(); continue; }
    const d = rng.pick(opts), ni = ci + d[0], nj = cj + d[1], n = ni + nj * B;
    used[n] = 1;
    hgt[n] = ring(ni, nj) ? 0 : clamp(hgt[cur] + rng.pick([0, 0, 0, -0.9, -0.9, 0.9]), -1.8, 0);
    if (d[0] === 1) E[cur * 2] = 1; else if (d[0] === -1) E[n * 2] = 1; else if (d[1] === 1) E[cur * 2 + 1] = 1; else E[n * 2 + 1] = 1;
    stack.push(n);
  }
  for (let k = 0; k < 6; k++) { const i = rng.int(B - 1), j = rng.int(B - 1); E[(i + j * B) * 2 + rng.int(2)] = 1; }
  const node = (i, j) => [i * LAT + 3, j * LAT + 3];
  const corridor = (i, j, horiz) => {
    const a = i + j * B, b = horiz ? a + 1 : a + B;
    const ha = hgt[a], hb = hgt[b], dh = hb - ha, sgn = Math.sign(dh), nst = Math.round(Math.abs(dh) / 0.3);
    const wide = rng() < 0.15 ? 3 : (rng() < 0.2 ? 1 : 2);
    const crawl = dh === 0 && rng() < 0.14;
    const [x, z] = node(i, j);
    for (let t = 0; t <= 6; t++) {
      const f = ha + sgn * 0.3 * Math.min(t, nst);
      const c = f + (crawl && t >= 2 && t <= 4 ? 1.25 : 2.1);
      for (let w = 0; w < wide; w++) { if (horiz) g.open(x + t, z + w, f, c); else g.open(x + w, z + t, f, c); }
    }
  };
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
    const a = i + j * B, [x, z] = node(i, j), f = hgt[a];
    if (rng() < 0.16) g.rect(x - 2, z - 2, x + 2, z + 2, f, f + CEIL);
    else g.rect(x, z, x + 1, z + 1, f, f + 2.1);
  }
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
    if (i < B - 1 && E[(i + j * B) * 2]) corridor(i, j, true);
    if (j < B - 1 && E[(i + j * B) * 2 + 1]) corridor(i, j, false);
  }
}

// Set pieces dropped into ordinary sectors.
function stairsToNowhere(g, rng) {
  const i = 1 + rng.int(6), j = 1 + rng.int(5);
  const x = i * LAT + 1, z = j * LAT + 1;
  for (let k = 0; k < 10; k++) for (let w = 0; w < 2; w++) {
    const f = 0.3 * (k + 1);
    if (f >= CEIL - 0.01) g.wall(x + w, z + k); else g.open(x + w, z + k, f, CEIL);
  }
  g.rect(x, z - 2, x + 1, z - 1, 0, CEIL);
  g.special.push({ kind: 'nowhere', x, z });
}
function trenchRoom(g, rng) {
  const i = 1 + rng.int(6), j = 1 + rng.int(4);
  const x = i * LAT + 1, z = j * LAT + 1;
  for (let k = 0; k < 9; k++) for (let w = 0; w < 2; w++) g.open(x + w, z + k, -0.3 * (k + 1), CEIL);
  g.rect(x, z - 2, x + 1, z - 1, 0, CEIL);
  g.rect(x - 1, z + 9, x + 3, z + 13, -2.7, -0.3);
  g.special.push({ kind: 'cellar', x: x + 1, z: z + 11 });
}
function lowBay(g, rng) {
  const i = rng.int(BAYS), j = rng.int(BAYS);
  for (let z = j * LAT + 1; z <= j * LAT + 5; z++) for (let x = i * LAT + 1; x <= i * LAT + 5; x++) if (g.isOpen(x, z) && g.floor[I(x, z)] === 0) g.ceil[I(x, z)] = 1.35;
}
function tallBay(g, rng) {
  const i = rng.int(BAYS), j = rng.int(BAYS);
  for (let z = j * LAT + 1; z <= j * LAT + 5; z++) for (let x = i * LAT + 1; x <= i * LAT + 5; x++) if (g.isOpen(x, z) && g.floor[I(x, z)] === 0) g.ceil[I(x, z)] = 7.5;
}

function carvePortals(g) {
  const { sx, sz } = g;
  const cc = (x, z) => {
    if (!inb(x, z)) return;
    const i = I(x, z);
    if (g.solid[i]) { g.solid[i] = 0; g.ceil[i] = g.type === 'tunnels' ? 2.1 : CEIL; }
    g.floor[i] = 0; if (g.ceil[i] < 2.1) g.ceil[i] = 2.1;
  };
  const cells = [];
  for (const k of edgePortals(sx, sz, true)) { for (let x = 0; x <= 3; x++) for (let z = k * LAT + 2; z <= k * LAT + 4; z++) cc(x, z); cells.push([1, k * LAT + 3]); }
  for (const k of edgePortals(sx + 1, sz, true)) { for (let x = N - 4; x < N; x++) for (let z = k * LAT + 2; z <= k * LAT + 4; z++) cc(x, z); cells.push([N - 2, k * LAT + 3]); }
  for (const k of edgePortals(sx, sz, false)) { for (let z = 0; z <= 3; z++) for (let x = k * LAT + 2; x <= k * LAT + 4; x++) cc(x, z); cells.push([k * LAT + 3, 1]); }
  for (const k of edgePortals(sx, sz + 1, false)) { for (let z = N - 4; z < N; z++) for (let x = k * LAT + 2; x <= k * LAT + 4; x++) cc(x, z); cells.push([k * LAT + 3, N - 2]); }
  return cells;
}

const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function passable(g, a, b) {
  if (g.solid[a] || g.solid[b]) return false;
  const fa = g.floor[a], fb = g.floor[b];
  if (Math.abs(fa - fb) > 0.36) return false;
  return Math.min(g.ceil[a], g.ceil[b]) - Math.max(fa, fb) >= 1.0;
}
function flood(g, x, z, vis) {
  const q = [I(x, z)]; vis[q[0]] = 1;
  while (q.length) {
    const c = q.pop(), cx = c % N, cz = (c / N) | 0;
    for (const d of NB) {
      const nx = cx + d[0], nz = cz + d[1];
      if (!inb(nx, nz)) continue;
      const n = I(nx, nz);
      if (!vis[n] && passable(g, c, n)) { vis[n] = 1; q.push(n); }
    }
  }
}
function connect(g, portals) {
  let vis = new Uint8Array(N * N);
  for (let pass = 0; pass < 5; pass++) {
    vis.fill(0);
    flood(g, portals[0][0], portals[0][1], vis);
    const miss = portals.find((p) => !vis[I(p[0], p[1])]);
    if (!miss) break;
    // breadth first from the cut-off portal through anything until we touch the main area
    const prev = new Int32Array(N * N).fill(-1), q = [I(miss[0], miss[1])];
    prev[q[0]] = q[0];
    let hit = -1;
    for (let h = 0; h < q.length && hit < 0; h++) {
      const c = q[h], cx = c % N, cz = (c / N) | 0;
      for (const d of NB) {
        const nx = cx + d[0], nz = cz + d[1];
        if (nx < 1 || nz < 1 || nx >= N - 1 || nz >= N - 1) continue;
        const n = I(nx, nz);
        if (prev[n] >= 0) continue;
        prev[n] = c;
        if (vis[n] && g.floor[n] === 0) { hit = n; break; }
        q.push(n);
      }
    }
    if (hit < 0) break;
    for (let c = prev[hit]; ; c = prev[c]) {
      g.solid[c] = 0; g.floor[c] = 0; if (g.ceil[c] < 2.1 || g.ceil[c] > 9) g.ceil[c] = 2.4;
      if (prev[c] === c) break;
    }
  }
  g.reach = vis;
}

function placeLamps(g, rng, pOn, pFlick) {
  const checker = (g.type === 'classic' || g.type === 'dense') && rng() < 0.25;
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    const x = i * LAT + 3, z = j * LAT + 3, c = I(x, z);
    const r = rng(), r2 = rng(), ph = rng.int(256);
    if (g.solid[c] || g.ceil[c] - g.floor[c] < 1.9) continue;
    let t = 0;
    if (r < pOn && !(checker && ((i + j) & 1))) t = r2 < pFlick ? 2 : (r2 < pFlick * 1.4 ? 3 : 1);
    else if (r < pOn + 0.5) t = r2 < 0.12 ? 3 : 4;
    if (!t) continue;
    g.lamp[c] = t; g.phase[c] = ph;
    const c2 = I(x, z + 1);
    if (!g.solid[c2] && g.ceil[c2] === g.ceil[c]) { g.lamp[c2] = t + 8; g.phase[c2] = ph; }
  }
}

function flat(g, x, z) {
  const f = g.floor[I(x, z)];
  for (const d of NB) { const nx = x + d[0], nz = z + d[1]; if (inb(nx, nz) && !g.solid[I(nx, nz)] && g.floor[I(nx, nz)] !== f) return false; }
  return true;
}
function wallDir(g, x, z) {
  for (let k = 0; k < 4; k++) { const nx = x + NB[k][0], nz = z + NB[k][1]; if (inb(nx, nz) && g.solid[I(nx, nz)]) return k; }
  return -1;
}

function populate(g, rng, d) {
  const byWall = [], openAir = [];
  for (let z = 2; z < N - 2; z++) for (let x = 2; x < N - 2; x++) {
    const i = I(x, z);
    if (!g.reach[i] || g.lamp[i] || !flat(g, x, z) || g.ceil[i] - g.floor[i] < 1.9) continue;
    if (wallDir(g, x, z) >= 0) byWall.push(i); else openAir.push(i);
  }
  const take = (arr) => (arr.length ? arr.splice(rng.int(arr.length), 1)[0] : -1);
  const nItems = 2 + rng.int(3);
  for (let k = 0; k < nItems; k++) {
    const c = take(byWall); if (c < 0) break;
    g.items.push({ id: g.sx + ',' + g.sz + ':' + k, kind: rng() < 0.58 ? 'water' : 'battery', x: c % N, z: (c / N) | 0, y: g.floor[c] });
  }
  const cellar = g.special.find((s) => s.kind === 'cellar');
  if (d >= 1 && (cellar || rng() < 0.3)) {
    let c = cellar ? I(cellar.x, cellar.z) : take(openAir);
    if (c >= 0) g.artifact = { id: g.sx + ',' + g.sz + ':a', kind: rng.int(12), x: c % N, z: (c / N) | 0, y: g.floor[c] };
  } else { rng(); }
  if (sectorHasExit(g.sx, g.sz)) {
    const c = take(byWall);
    if (c >= 0) { const x = c % N, z = (c / N) | 0; g.exit = { x, z, y: g.floor[c], dir: wallDir(g, x, z) }; }
  }
  const nMarks = rng.int(3) + (g.type === 'dark' || g.type === 'tunnels' ? 2 : 0);
  for (let k = 0; k < nMarks; k++) {
    const c = take(byWall); if (c < 0) break;
    const x = c % N, z = (c / N) | 0;
    g.marks.push({ x, z, dir: wallDir(g, x, z), glyph: rng.int(16), y: g.floor[c] + 1.15 + rng() * 0.45, late: rng() < 0.35 });
  }
}

export function genSector(sx, sz, seed) {
  const g = new G(sx, sz, seed);
  const rng = mulberry32((seed ^ hash3(sx, sz, WORLD_SEED)) >>> 0);
  const d = Math.max(Math.abs(sx), Math.abs(sz));
  const type = pickType(rng, d);
  g.type = type; g.name = TYPE_NAMES[type];
  let pOn = 0.86, pFl = 0.07;
  if (type === 'classic') lattice(g, rng, 0.42 + rng() * 0.12, 0.4, randHalls(rng, 1 + rng.int(3)));
  else if (type === 'dense') { lattice(g, rng, 0.78, 0.82, randHalls(rng, rng.int(2))); pOn = 0.75; pFl = 0.1; }
  else if (type === 'dark') { lattice(g, rng, 0.5, 0.5, randHalls(rng, 1 + rng.int(2))); pOn = 0.09; pFl = 0.55; }
  else if (type === 'pillars') { buildPillars(g, rng); pOn = 0.7; }
  else if (type === 'hall') { buildHall(g, rng); pOn = 0.2; pFl = 0.2; }
  else if (type === 'pit') buildPit(g, rng);
  else if (type === 'mezz') buildMezz(g, rng);
  else if (type === 'tunnels') { buildTunnels(g, rng); pOn = 0.42; pFl = 0.28; }
  if (d === 0) { pOn = 0.97; pFl = 0.03; }
  if (type === 'classic' || type === 'dense' || type === 'dark' || type === 'pillars') {
    if (d > 0 && rng() < 0.33) stairsToNowhere(g, rng);
    if (d > 0 && rng() < 0.24) trenchRoom(g, rng);
    if (rng() < 0.2) lowBay(g, rng);
    if (rng() < 0.25) tallBay(g, rng);
  }
  if (d === 0) g.rect(20, 20, 28, 28, 0, CEIL); // a clear spot to arrive in
  const portals = carvePortals(g);
  connect(g, portals);
  placeLamps(g, rng, pOn, pFl);
  populate(g, rng, d);
  g.danger = clamp(d / 9, 0, 1) * 0.7 + (type === 'dark' || type === 'tunnels' || type === 'hall' ? 0.35 : 0);
  return g;
}
