// Sector generator. A sector is a 48x48 heightfield: every cell has a floor and a
// ceiling height (or is solid). That is enough for rooms, pillars, pits, stairs,
// mezzanines, crawl spaces, trenches and rooms under the floor.
//
// The layout is a function of WORLD position, not of the sector: a low-frequency,
// domain-warped noise field decides per 6-cell bay what kind of place it is (office
// partitions, warrens, pillar halls, empty halls, tunnels, dark zones), and every wall
// segment, pillar, corridor and height feature is decided by hashing its world
// coordinates. A sector just evaluates that world for its own 48x48 cells, so two
// neighbours agree about their shared edge without talking to each other.
// Only two things are local to a sector: the connectivity repair (it never touches the
// outermost ring of cells or a height feature) and what is placed inside (items, marks).
// Portals from `edgePortals` are still forced open on every sector edge, which keeps the
// whole world connected; with walls everywhere else on the same lattice they no longer show.
import { SEC, LAT, BAYS, CEIL, WORLD_SEED, hash3, mulberry32, clamp, smooth } from './util.js';

const N = SEC;
const I = (x, z) => x + z * N;
const inb = (x, z) => x >= 0 && z >= 0 && x < N && z < N;
const PADC = LAT;                 // padding in cells around the sector while painting
const PN = N + PADC * 2;          // painted grid side (60)
const BPAD = 2;                   // padding in bays for the style array
const BA = BAYS + BPAD * 2;       // style array side (12)
const md = (a, n) => ((a % n) + n) % n;

export const TYPE_NAMES = {
  classic: 'Office floor', dense: 'Partition warren', pillars: 'Pillar hall', hall: 'The long dark',
  pit: 'Sunken court', mezz: 'Mezzanine', tunnels: 'Service tunnels', dark: 'Dead grid',
};
const NAMES = {
  classic: ['Office floor', 'Open plan', 'Cubicle rows', 'Carpet acres', 'Partition field', 'Typing pool'],
  dense: ['Partition warren', 'The cramp', 'Narrow offices', 'Wall thicket', 'Box rooms'],
  pillars: ['Pillar hall', 'Column field', 'Pillar grove', 'Support grid'],
  hall: ['The long dark', 'Empty floor', 'Tall room', 'Unfinished hall'],
  pit: ['Sunken court', 'The dip', 'Lower floor', 'Drained pool'],
  mezz: ['Mezzanine', 'Raised deck', 'The gallery', 'Upper landing'],
  tunnels: ['Service tunnels', 'Crawlways', 'The ducts', 'Pipe runs'],
  dark: ['Dead grid', 'Blackout', 'No light', 'Lights out'],
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

// ---------------------------------------------------------------- world functions
// 32-bit integer hash for the world functions (util's hash3 multiplies in floating point past
// 2^53, so fields with nearby salts come out correlated).
function H(a, b, s) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) ^ 0x5bd1e995, 0x165667b1) ^ Math.imul((s ^ WORLD_SEED) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const H01 = (a, b, s) => H(a, b, s) / 4294967296;
function vn(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z);
  let u = x - xi, v = z - zi; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
  const a = H01(xi, zi, s), b = H01(xi + 1, zi, s), c = H01(xi, zi + 1, s), d = H01(xi + 1, zi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const stretch = (v, k) => clamp(0.5 + (v - 0.5) * k, 0, 1);

// Is this edge bay a portal? (memoised, pure)
const portalMemo = new Map();
function portalsOf(ex, ez, vertical) {
  const k = ex + ',' + ez + (vertical ? 'v' : 'h');
  let v = portalMemo.get(k);
  if (!v) { v = edgePortals(ex, ez, vertical); if (portalMemo.size > 4000) portalMemo.clear(); portalMemo.set(k, v); }
  return v;
}
// Cells kept clear around every portal: the doorway on the sector line and 4 cells either side.
function inPortalZone(gx, gz, m = 4) {
  const mx = md(gx, N), mz = md(gz, N);
  if (mx <= m || mx >= N - m) {
    const line = mx <= m ? gx - mx : gx + N - mx, k = Math.floor(mz / LAT), r = mz - k * LAT;
    if (r >= 1 && portalsOf(line / N, Math.floor(gz / N), true).includes(k)) return true;
  }
  if (mz <= m || mz >= N - m) {
    const line = mz <= m ? gz - mz : gz + N - mz, k = Math.floor(mx / LAT), r = mx - k * LAT;
    if (r >= 1 && portalsOf(Math.floor(gx / N), line / N, false).includes(k)) return true;
  }
  return false;
}
// Bay next to a portal on one of its sides.
function portalBay(bx, bz) {
  const kx = md(bz, BAYS), kz = md(bx, BAYS);
  if (md(bx, BAYS) === 0 && portalsOf(bx / BAYS, Math.floor(bz / BAYS), true).includes(kx)) return true;
  if (md(bx + 1, BAYS) === 0 && portalsOf((bx + 1) / BAYS, Math.floor(bz / BAYS), true).includes(kx)) return true;
  if (md(bz, BAYS) === 0 && portalsOf(Math.floor(bx / BAYS), bz / BAYS, false).includes(kz)) return true;
  if (md(bz + 1, BAYS) === 0 && portalsOf(Math.floor(bx / BAYS), (bz + 1) / BAYS, false).includes(kz)) return true;
  return false;
}
const SPAWN = 24; // spawn cell in sector 0,0 (world 14.7, 14.7)
// Distance in sectors (from a point given in sectors) to the nearest calm place: the spawn, and
// the title-screen backdrop that main.js builds around sector (1000, 1000). Both get lit office
// floor around them; the strange stuff grows with distance from the spawn only.
const BACKDROP = 1000;
const calm = (xs, zs) => Math.min(Math.hypot(xs - 0.5, zs - 0.5), Math.hypot(xs - BACKDROP - 0.5, zs - BACKDROP - 0.5));
const ARRIVE = [0, BACKDROP]; // sectors (k, k) with a clear 9x9 spot around cell 24,24
const inSpawn = (gx, gz, m = 0) => {
  for (const k of ARRIVE) { const o = k * N; if (gx >= o + 20 - m && gz >= o + 20 - m && gx <= o + 28 + m && gz <= o + 28 + m) return true; }
  return false;
};

// Long straight corridors: avenue cells of 16x16 bays, each may own one avenue 10-21 bays long.
function avenueAt(bx, bz) {
  let hz = false, vt = false;
  const AC = 16, cz = Math.floor(bz / AC), cx = Math.floor(bx / AC);
  for (let c = cx - 2; c <= cx; c++) {
    const h = H(c, cz, 0xa7e1);
    if ((h & 1023) / 1024 >= 0.3) continue;
    const row = cz * AC + ((h >>> 10) & 15), st = c * AC + ((h >>> 14) & 15), len = 10 + ((h >>> 18) % 12);
    if (bz === row && bx >= st && bx < st + len) hz = true;
  }
  for (let c = cz - 2; c <= cz; c++) {
    const h = H(cx, c, 0xa7e2);
    if ((h & 1023) / 1024 >= 0.3) continue;
    const col = cx * AC + ((h >>> 10) & 15), st = c * AC + ((h >>> 14) & 15), len = 10 + ((h >>> 18) % 12);
    if (bx === col && bz >= st && bz < st + len) vt = true;
  }
  return (hz ? 1 : 0) | (vt ? 2 : 0);
}
// Blocks of 5x5 bays (offset 2) that may hold a ring corridor or a room that repeats.
function blockAt(bx, bz) {
  const kx = Math.floor((bx - 2) / 5), kz = Math.floor((bz - 2) / 5);
  const r = H01(kx, kz, 0x61c);
  const cxs = (kx * 5 + 2 + 2.5) / BAYS, czs = (kz * 5 + 2 + 2.5) / BAYS;
  if (calm(cxs, czs) < 1.6) return null;
  const kind = r < 0.025 ? 1 : r < 0.055 ? 2 : 0; // 1 ring, 2 repeat
  if (!kind) return null;
  return { kind, kx, kz, lx: bx - 2 - kx * 5, lz: bz - 2 - kz * 5, key: H(kx, kz, 0x61d) };
}

// The style field, evaluated per bay (6x6 cells) in world bay coordinates.
function bayStyle(bx, bz) {
  const x = bx + 0.5, z = bz + 0.5;
  const wx = x + (vn(x / 9, z / 9, 0x11) - 0.5) * 14 + (vn(x / 3.2, z / 3.2, 0x12) - 0.5) * 3.5;
  const wz = z + (vn(x / 9, z / 9, 0x13) - 0.5) * 14 + (vn(x / 3.2, z / 3.2, 0x14) - 0.5) * 3.5;
  const dS = calm(x / BAYS, z / BAYS);                          // sectors from a calm place
  const tame = smooth(0.9, 2.3, dS), far = clamp((Math.hypot(x - 4, z - 4) / BAYS - 1) / 10, 0, 1);
  // raw value-noise quantiles: O and Dk have their 15th/85th percentiles near 0.32/0.70
  const O = stretch(0.74 * vn(wx / 11, wz / 11, 0x21) + 0.26 * vn(wx / 4.2, wz / 4.2, 0x22), tame);
  const K = vn(wx / 12, wz / 12, 0x23);
  const T = vn(wx / 10, wz / 10, 0x26);
  const Dk = stretch(0.75 * vn(wx / 8, wz / 8, 0x24) + 0.25 * vn(wx / 3.3, wz / 3.3, 0x25), tame);
  const wOpen = smooth(0.645, 0.71, O), wClosed = smooth(0.38, 0.33, O), wOff = 1 - wOpen - wClosed;
  const hallK = smooth(0.6 - far * 0.06, 0.67 - far * 0.06, K);
  const blk = blockAt(bx, bz);
  const av = blk ? 0 : avenueAt(bx, bz);
  const tunnel = !blk && !av && wClosed > 0.55 && T > 0.54 - far * 0.08;
  let lvl = 0;
  if (tunnel) lvl = T > 0.74 ? 2 : T > 0.63 ? 1 : 0;
  const dark = smooth(0.70 - far * 0.03, 0.76 - far * 0.03, Dk);
  const pill = wOpen * (1 - hallK), hall = wOpen * hallK;
  const st = {
    bx, bz, tunnel, lvl, av, blk, dark, hall, pill, wOpen, wClosed,
    wallP: wOff * (0.42 + 0.14 * vn(x / 5, z / 5, 0x34)) + wClosed * 0.8 + pill * 0.035,
    doorP: wOff * 0.4 + wClosed * 0.8 + wOpen * 0.6,
    nodeP: wOff * 0.22 + wClosed * 0.22 + pill * 0.92,
    big: pill > 0.5 && vn(x / 5, z / 5, 0x31) > 0.6,
    skip: pill > 0.5 && vn(x / 6, z / 6, 0x32) > 0.64,
    hallBig: hall * 0.45,
    bits: wOff + wClosed,
    ceil: CEIL, low: 0,
    pOn: 0, pFl: 0, label: 'classic', checker: false,
  };
  if (hall > 0.55) st.ceil = 5.4; else if (hall > 0.3) st.ceil = 3.9; else if (pill > 0.5 && vn(x / 7, z / 7, 0x33) > 0.42) st.ceil = 3.3;
  let pOn = wOff * 0.86 + wClosed * 0.76 + pill * 0.72 + hall * 0.2, pFl = 0.07 + wClosed * 0.03 + hall * 0.13;
  if (tunnel) { pOn = 0.42; pFl = 0.28; st.ceil = 2.4; }
  if (av) { pOn = Math.max(pOn, 0.8); st.ceil = CEIL; st.wallP = 0.5; }
  if (blk) { st.ceil = CEIL; if (blk.kind === 2) { pOn = 1; pFl = 0; } else pOn = Math.max(pOn, 0.8); }
  pOn = pOn + (0.09 - pOn) * dark; pFl = pFl + (0.55 - pFl) * dark;
  if (dS < 0.7) { pOn = 0.97; pFl = 0.03; }
  st.pOn = pOn; st.pFl = pFl;
  st.checker = wOff > 0.5 && vn(x / 6, z / 6, 0x41) > 0.7;
  st.label = tunnel ? 'tunnels' : hall > 0.5 ? 'hall' : pill > 0.5 ? 'pillars' : wClosed > 0.5 ? 'dense' : 'classic';
  if (dark > 0.5 && st.label !== 'tunnels') st.label = 'dark';
  // ceiling oddities, as bays in the world
  if (!tunnel && !av && !blk && dS > 0.8) {
    const r = H01(bx, bz, 0x10b);
    if (r < 0.028) st.low = 1.35; else if (r < 0.06 && st.ceil < 4) st.low = 7.5;
  }
  return st;
}

// ---------------------------------------------------------------- height features
// Placed on a grid of 32x32 cells offset by 16 (it does not line up with the 48-cell sectors),
// so they straddle sector lines as often as not.
// Each feature stays inside its own grid cell (1 cell margin), never touches a portal or the
// spawn, and is fully connected inside itself with stairs to floor-0 landings.
const FG = 32, FO = 16;
const featMemo = new Map();
function featureAt(fx, fz) {
  const key = fx + ',' + fz;
  if (featMemo.has(key)) return featMemo.get(key);
  let f = null;
  const h = H(fx, fz, 0xfea7), r = (h & 0xffff) / 65536;
  const x0 = FO + fx * FG + 1, z0 = FO + fz * FG + 1;
  const mid = (FG >> 1) - 1;
  const st = bayStyle(Math.floor((x0 + mid) / LAT), Math.floor((z0 + mid) / LAT));
  const dS = calm((x0 + mid) / N, (z0 + mid) / N);
  if (!st.tunnel && !st.blk && dS > 0.9) {
    const open = st.wOpen > 0.5;
    const pPit = 0.13 + (open ? 0.05 : 0), pDeck = open ? 0.17 : 0.04, pTrench = open ? 0.05 : 0.09, pNow = 0.1;
    let kind = null;
    if (r < pPit) kind = 'pit'; else if (r < pPit + pDeck) kind = 'deck'; else if (r < pPit + pDeck + pTrench) kind = 'trench'; else if (r < pPit + pDeck + pTrench + pNow) kind = 'nowhere';
    if (kind) {
      const rng = mulberry32(h ^ 0x9e3779b9);
      for (let a = 0; a < 4 && !f; a++) {
        const c = kind === 'pit' || kind === 'deck' ? blob(rng, x0, z0, kind, a) : run(rng, x0, z0, kind);
        if (c && validFeature(c)) f = c;
      }
    }
  }
  if (featMemo.size > 3000) featMemo.clear();
  featMemo.set(key, f);
  return f;
}
const FW = FG - 2; // raster side (30)
function newFeat(kind, x0, z0) {
  return { kind, x0, z0, m: new Uint8Array(FW * FW), fl: new Float32Array(FW * FW), sol: new Uint8Array(FW * FW), ce: new Float32Array(FW * FW).fill(NaN), spot: null };
}
function validFeature(f) {
  for (let z = 0; z < FW; z++) for (let x = 0; x < FW; x++) {
    if (!f.m[x + z * FW]) continue;
    const gx = f.x0 + x, gz = f.z0 + z;
    if (inPortalZone(gx, gz) || inSpawn(gx, gz, 6)) return false;
  }
  return true;
}
const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// Sunken court or raised deck: an organic blob, flights of stairs from its rim, pillars on the lattice.
function blob(rng, x0, z0, kind, attempt) {
  const f = newFeat(kind, x0, z0), W = FW, shrink = 1 - attempt * 0.18;
  const cx = (W >> 1) + rng.int(5) - 2, cz = (W >> 1) + rng.int(5) - 2;
  let rx, rz;
  if (kind === 'deck' && rng() < 0.6) { const lng = (8 + rng() * 4) * shrink, sh = (3.5 + rng() * 2) * shrink; if (rng() < 0.5) { rx = lng; rz = sh; } else { rx = sh; rz = lng; } }
  else { rx = (4.5 + rng() * 6) * shrink; rz = (4.5 + rng() * 6) * shrink; }
  const ell = [[cx + 0.5, cz + 0.5, rx, rz]];
  const lobes = 1 + rng.int(3);
  for (let k = 0; k < lobes; k++) ell.push([cx + 0.5 + (rng() - 0.5) * rx * 1.3, cz + 0.5 + (rng() - 0.5) * rz * 1.3, Math.max(2.2, rx * (0.4 + rng() * 0.4)), Math.max(2.2, rz * (0.4 + rng() * 0.4))]);
  const ins = new Uint8Array(W * W);
  for (let z = 3; z < W - 3; z++) for (let x = 3; x < W - 3; x++) {
    let dmin = 9;
    for (const e of ell) { const dx = (x + 0.5 - e[0]) / e[2], dz = (z + 0.5 - e[1]) / e[3]; const dd = dx * dx + dz * dz; if (dd < dmin) dmin = dd; }
    if (dmin > 1.28) continue;
    if (dmin <= 1 - (0.5 - vn((x0 + x) / 2.6, (z0 + z) / 2.6, 0x77)) * 0.55) ins[x + z * W] = 1;
  }
  if (!ins[cx + cz * W]) return null;
  // no one-cell notches or slots in the outline
  for (let pass = 0; pass < 2; pass++) for (let z = 3; z < W - 3; z++) for (let x = 3; x < W - 3; x++) {
    const i = x + z * W; if (ins[i]) continue;
    const a = ins[i - 1] + ins[i + 1], b = ins[i - W] + ins[i + W];
    if (a + b >= 3 || a === 2 || b === 2) ins[i] = 1;
  }
  // keep the part connected to the centre, then fill holes
  const keep = new Uint8Array(W * W), q = [cx + cz * W]; keep[q[0]] = 1;
  while (q.length) { const c = q.pop(), x = c % W, z = (c / W) | 0; for (const d of D4) { const nx = x + d[0], nz = z + d[1], n = nx + nz * W; if (nx >= 0 && nz >= 0 && nx < W && nz < W && ins[n] && !keep[n]) { keep[n] = 1; q.push(n); } } }
  const out = new Uint8Array(W * W), q2 = [];
  for (let k = 0; k < W; k++) for (const c of [k, k + (W - 1) * W, k * W, W - 1 + k * W]) if (!keep[c] && !out[c]) { out[c] = 1; q2.push(c); }
  while (q2.length) { const c = q2.pop(), x = c % W, z = (c / W) | 0; for (const d of D4) { const nx = x + d[0], nz = z + d[1], n = nx + nz * W; if (nx >= 0 && nz >= 0 && nx < W && nz < W && !keep[n] && !out[n]) { out[n] = 1; q2.push(n); } } }
  let cells = 0;
  for (let i = 0; i < W * W; i++) if (!out[i]) { f.m[i] = 1; cells++; }
  if (cells < 30) return null;
  // stairs: one or two flights from the rim inward
  const dirs = [0, 1, 2, 3];
  for (let k = 3; k > 0; k--) { const j = rng.int(k + 1), t = dirs[k]; dirs[k] = dirs[j]; dirs[j] = t; }
  const nF = kind === 'pit' ? 1 + (rng() < 0.6 ? 1 : 0) : 1 + (rng() < 0.35 ? 1 : 0);
  let level = kind === 'pit' ? rng.pick([1.5, 1.5, 2.1, 2.4]) : rng.pick([1.5, 1.5, 1.2]);
  const flights = [];
  for (const di of dirs) {
    if (flights.length >= nF) break;
    const d = D4[di];
    let x = cx, z = cz, len = 0;
    while (true) { const nx = x + d[0], nz = z + d[1]; if (nx < 0 || nz < 0 || nx >= W || nz >= W || !f.m[nx + nz * W]) break; x = nx; z = nz; len++; }
    // the landing (2 cells beyond the rim) must stay inside the raster
    const lx = x + d[0] * 2, lz = z + d[1] * 2;
    if (lx < 0 || lz < 0 || lx >= W || lz >= W) continue;
    const maxLevel = Math.floor(len - 1) * 0.3;
    if (maxLevel < 0.9) continue;
    level = Math.min(level, Math.round(maxLevel / 0.3) * 0.3);
    flights.push({ d, rx: x, rz: z, side: rng() < 0.5 ? 1 : -1 });
  }
  if (!flights.length) return null;
  level = Math.round(level / 0.3) * 0.3;
  const sg = kind === 'pit' ? -1 : 1, steps = Math.round(level / 0.3);
  for (let i = 0; i < W * W; i++) if (f.m[i]) f.fl[i] = sg * level;
  const stair = new Uint8Array(W * W);
  for (const fl of flights) {
    const px = fl.d[1] * fl.side, pz = fl.d[0] * fl.side; // perpendicular lane
    for (let w = 0; w < 2; w++) {
      const ox = px * w, oz = pz * w;
      for (let k = 0; k < steps; k++) {
        const x = fl.rx - fl.d[0] * k + ox, z = fl.rz - fl.d[1] * k + oz;
        if (x < 0 || z < 0 || x >= W || z >= W) return null;
        const i = x + z * W; f.m[i] = 1; f.fl[i] = sg * 0.3 * (k + 1); stair[i] = 1;
      }
      for (let k = 1; k <= 2; k++) {
        const x = fl.rx + fl.d[0] * k + ox, z = fl.rz + fl.d[1] * k + oz;
        if (x < 0 || z < 0 || x >= W || z >= W) return null;
        const i = x + z * W; f.m[i] = 2; f.fl[i] = 0; stair[i] = 2;
      }
    }
  }
  // pillars where the lattice nodes fall inside, away from the stairs
  for (let z = 1; z < W - 1; z++) for (let x = 1; x < W - 1; x++) {
    const i = x + z * W;
    if (f.m[i] !== 1 || stair[i] || md(x0 + x, LAT) || md(z0 + z, LAT)) continue;
    let near = false;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (stair[i + dx + dz * W] || f.m[i + dx + dz * W] !== 1) near = true;
    if (!near && rng() < (kind === 'pit' ? 0.7 : 0.5)) f.sol[i] = 1;
  }
  // everything must connect to a landing; anything that does not becomes solid
  const vis = new Uint8Array(W * W), q3 = [];
  for (let i = 0; i < W * W; i++) if (f.m[i] === 2) { vis[i] = 1; q3.push(i); }
  while (q3.length) {
    const c = q3.pop(), x = c % W, z = (c / W) | 0;
    for (const d of D4) {
      const nx = x + d[0], nz = z + d[1], n = nx + nz * W;
      if (nx < 0 || nz < 0 || nx >= W || nz >= W || vis[n] || !f.m[n] || f.sol[n]) continue;
      if (Math.abs(f.fl[n] - f.fl[c]) > 0.36) continue;
      vis[n] = 1; q3.push(n);
    }
  }
  for (let i = 0; i < W * W; i++) if (f.m[i] && !f.sol[i] && !vis[i]) f.sol[i] = 1;
  f.spot = [x0 + cx, z0 + cz];
  return f;
}
// Straight set pieces: a trench down to a cellar under the floor, or stairs into the ceiling.
function run(rng, x0, z0, kind) {
  const f = newFeat(kind, x0, z0), W = FW;
  const d = D4[rng.int(4)], p = [d[1], d[0]];
  const L = kind === 'trench' ? 16 : 12;
  // pick a start so that the whole piece fits (cellar needs -1..+3 across)
  const along0 = 1 + rng.int(W - L - 2), across0 = 2 + rng.int(W - 7);
  const at = (a, b) => {
    // a: along the run from its start, b: across
    let x, z;
    if (d[0]) { x = d[0] > 0 ? along0 + a : W - 1 - along0 - a; z = across0 + b; } else { z = d[1] > 0 ? along0 + a : W - 1 - along0 - a; x = across0 + b; }
    return x >= 0 && z >= 0 && x < W && z < W ? x + z * W : -1;
  };
  const set = (a, b, m, fl, sol, ce) => { const i = at(a, b); if (i < 0) return false; f.m[i] = m; f.fl[i] = fl; f.sol[i] = sol ? 1 : 0; if (ce !== undefined) f.ce[i] = ce; return true; };
  for (let w = 0; w < 2; w++) for (let a = 0; a < 2; a++) set(a, w, 2, 0, 0);
  if (kind === 'trench') {
    for (let k = 0; k < 9; k++) for (let w = 0; w < 2; w++) set(2 + k, w, 1, -0.3 * (k + 1), 0);
    for (let a = 11; a <= 15; a++) for (let b = -1; b <= 3; b++) set(a, b, 1, -2.7, 0, -0.3);
    const i = at(13, 1); f.spot = [x0 + (i % W), z0 + ((i / W) | 0)]; f.cellar = true;
  } else {
    for (let k = 0; k < 10; k++) for (let w = 0; w < 2; w++) { const fl = 0.3 * (k + 1); set(2 + k, w, 1, fl, fl >= CEIL - 0.01); }
    const i = at(2, 0); f.spot = [x0 + (i % W), z0 + ((i / W) | 0)];
  }
  return f;
}

// ---------------------------------------------------------------- sector
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
    this.mix = null; this.bays = null; this.rim = null;
  }
  isOpen(x, z) { return inb(x, z) && !this.solid[I(x, z)]; }
}

// Paint the world into a padded grid around the sector. Everything here is a pure function
// of world coordinates.
function paint(sx, sz) {
  const ox = sx * N - PADC, oz = sz * N - PADC;           // world cell of pad (0,0)
  const bx0 = sx * BAYS - BPAD, bz0 = sz * BAYS - BPAD;   // world bay of style (0,0)
  const sol = new Uint8Array(PN * PN), fl = new Float32Array(PN * PN), ce = new Float32Array(PN * PN), fm = new Uint8Array(PN * PN), bc = new Float32Array(PN * PN);
  const P = (x, z) => x + z * PN;                          // x, z in pad coords
  const inP = (x, z) => x >= 0 && z >= 0 && x < PN && z < PN;
  const bays = new Array(BA * BA);
  for (let j = 0; j < BA; j++) for (let i = 0; i < BA; i++) bays[i + j * BA] = bayStyle(bx0 + i, bz0 + j);
  const extra = new Map();
  const bay = (bx, bz) => {
    const i = bx - bx0, j = bz - bz0;
    if (i >= 0 && j >= 0 && i < BA && j < BA) return bays[i + j * BA];
    const k = (i + 64) * 256 + (j + 64); let s = extra.get(k); if (!s) { s = bayStyle(bx, bz); extra.set(k, s); } return s;
  };
  // small memo tables over the bays this sector can ask about (bx0-2 .. bx0+13)
  const MW = 16, mIdx = (bx, bz) => { const i = bx - bx0 + 2, j = bz - bz0 + 2; return i >= 0 && j >= 0 && i < MW && j < MW ? i + j * MW : -1; };
  // tunnel depth: 0 next to anything that is not tunnel and next to portals
  // depth steps by at most one level between neighbouring bays
  const f0Memo = new Int8Array(MW * MW).fill(-1), lvlMemo = new Int8Array(MW * MW).fill(-1);
  const forced0 = (bx, bz) => {
    const k = mIdx(bx, bz); if (k >= 0 && f0Memo[k] >= 0) return f0Memo[k] === 1;
    const s = bay(bx, bz); let v = !s.tunnel || !s.lvl || portalBay(bx, bz);
    if (!v) for (const d of D4) if (!bay(bx + d[0], bz + d[1]).tunnel) v = true;
    if (k >= 0) f0Memo[k] = v ? 1 : 0; return v;
  };
  const level = (bx, bz) => {
    const k = mIdx(bx, bz); if (k >= 0 && lvlMemo[k] >= 0) return lvlMemo[k];
    let v = 0;
    if (!forced0(bx, bz)) {
      v = bay(bx, bz).lvl;
      if (v >= 2) for (const d of D4) if (forced0(bx + d[0], bz + d[1])) v = 1;
    }
    if (k >= 0) lvlMemo[k] = v; return v;
  };
  // every deep node keeps one corridor towards a shallower neighbour
  const downDir = (bx, bz) => {
    const L = level(bx, bz); if (!L) return -1;
    const o = H(bx, bz, 0x7be) & 3;
    for (let k = 0; k < 4; k++) { const di = (o + k) & 3, d = D4[di]; if (bay(bx + d[0], bz + d[1]).tunnel && level(bx + d[0], bz + d[1]) === L - 1) return di; }
    return -1;
  };
  // pad bays: world bays bx0+1 .. bx0+10 cover pad cells 0..59
  const pb0x = bx0 + 1, pb0z = bz0 + 1;
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) {
    const s = bay(pb0x + i, pb0z + j);
    for (let z = 0; z < LAT; z++) for (let x = 0; x < LAT; x++) {
      const p = P(i * LAT + x, j * LAT + z);
      bc[p] = s.ceil; ce[p] = s.tunnel ? 2.4 : s.ceil; sol[p] = s.tunnel ? 1 : 0;
    }
  }
  // --- lattice walls. Segment (i, j, v): v=1 the vertical wall on line x = i*6 next to bay row j,
  //     v=0 the horizontal wall on line z = j*6 next to bay column i. Returns 0 none, 1 wall,
  //     2 door (low lintel), 3 door, 4 gap at the end, 5/6 two-cell doorway (repeating rooms).
  const segMemo = new Int8Array(MW * MW * 2).fill(-1);
  const seg = (i, j, v) => {
    const mk = mIdx(i, j), key = mk >= 0 ? mk * 2 + v : -1;
    let c = key >= 0 ? segMemo[key] : -1; if (c >= 0) return c;
    const A = v ? bay(i - 1, j) : bay(i, j - 1), B = bay(i, j);
    let wallP = (A.wallP + B.wallP) * 0.5, doorP = (A.doorP + B.doorP) * 0.5;
    let rnd = mulberry32(H(i * 2 + v, j, 0x5e9));
    const along = v ? 2 : 1, across = v ? 1 : 2; // avenue bit running along this wall / across it
    if (A.blk && B.blk && A.blk.kx === B.blk.kx && A.blk.kz === B.blk.kz) {
      const b = A.blk;
      if (b.kind === 2) {
        // the room that repeats: every bay the same 5x5 room with the same two doorways
        c = v ? ((b.key & 1) ? 5 : 6) : ((b.key & 2) ? 6 : 5);
        if (key >= 0) segMemo[key] = c; return c;
      }
      else {
        const ringA = A.blk.lx % 4 === 0 || A.blk.lz % 4 === 0, ringB = B.blk.lx % 4 === 0 || B.blk.lz % 4 === 0;
        if (ringA && ringB) { wallP = 0; }
        else if (ringA !== ringB) { wallP = 1; doorP = (H(i * 2 + v, j, 0x5ea) % 12 === b.key % 12) ? 1 : 0.14; }
      }
    } else if ((A.blk && A.blk.kind === 1) || (B.blk && B.blk.kind === 1)) { wallP = 1; doorP = 0.3; }
    else if ((A.av & across) && (B.av & across)) { wallP = 0; }
    else if ((A.av | B.av) & along) { wallP = 1; doorP = (A.av && B.av) ? 1 : 0.22; }
    c = 0;
    if (rnd() < wallP) {
      const r = rnd();
      if (r < doorP) c = rnd() < 0.55 ? 2 : 3; else if (r < doorP + 0.12) c = 4; else c = 1;
    }
    if (key >= 0) segMemo[key] = c; return c;
  };
  // paint segments and nodes for every pad bay that is not tunnel
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) {
    const wbx = pb0x + i, wbz = pb0z + j, s = bay(wbx, wbz);
    if (s.tunnel) continue;
    const X = i * LAT, Z = j * LAT;
    const paintSeg = (c, vert) => {
      if (!c) return;
      for (let k = 1; k <= 5; k++) {
        const p = vert ? P(X, Z + k) : P(X + k, Z);
        const door = ((c === 2 || c === 3) && k >= 2 && k <= 4) || (c === 5 && (k === 3 || k === 4)) || (c === 6 && (k === 2 || k === 3));
        const gap = c === 4 && k >= 4;
        if (door) { sol[p] = 0; ce[p] = c === 3 ? CEIL : 2.1; } else if (!gap) sol[p] = 1;
      }
    };
    paintSeg(seg(wbx, wbz, 1), true);
    paintSeg(seg(wbx, wbz, 0), false);
    // node at the bay corner
    const any = seg(wbx, wbz, 1) || seg(wbx, wbz - 1, 1) || seg(wbx, wbz, 0) || seg(wbx - 1, wbz, 0);
    const rep = s.blk && s.blk.kind === 2;
    const nr = rep ? mulberry32(s.blk.key ^ 0x3131) : mulberry32(H(wbx, wbz, 0x40de));
    const ringB = s.blk && s.blk.kind === 1;
    if (any) sol[P(X, Z)] = 1;
    else if (!ringB && !s.av) {
      const r1 = nr(), r2 = nr();
      if (s.skip && (md(wbx, 2) || md(wbz, 2))) { /* every second node only */ }
      else if (r1 < s.nodeP) { sol[P(X, Z)] = 1; if (s.big) { sol[P(X + 1, Z)] = sol[P(X, Z + 1)] = sol[P(X + 1, Z + 1)] = 1; } }
      else if (!md(wbx, 2) && !md(wbz, 2) && r2 < s.hallBig) { sol[P(X, Z)] = sol[P(X + 1, Z)] = sol[P(X, Z + 1)] = sol[P(X + 1, Z + 1)] = 1; }
      else if (r2 > 1 - s.bits * 0.22) sol[P(X, Z)] = 1;
    }
    // odd free standing bits inside a bay
    if (!s.av && !ringB && s.bits > 0.5) {
      const r = (rep ? mulberry32(s.blk.key ^ 0xb175) : mulberry32(H(wbx, wbz, 0xb17)))();
      if (r < 0.05) { for (const [a, b] of [[4, 4], [5, 4], [4, 5], [5, 5]]) sol[P(X + a, Z + b)] = 1; }
      else if (r < 0.10) { for (let k = 1; k <= 3; k++) sol[P(X + 1 + k, Z + 1)] = 1; }
      else if (r < 0.14) { for (let k = 1; k <= 3; k++) sol[P(X + 5, Z + k)] = 1; }
    }
  }
  // --- tunnels: nodes at bay centres, corridors between them
  const tEdge = (a, b, horiz) => {
    // a, b: world bays, b = a + (1,0) or (0,1)
    const A = bay(a[0], a[1]), B = bay(b[0], b[1]);
    if (!A.tunnel && !B.tunnel) return false;
    // a portal between them is always open
    if (horiz && md(b[0], BAYS) === 0 && portalsOf(b[0] / BAYS, Math.floor(b[1] / BAYS), true).includes(md(b[1], BAYS))) return true;
    if (!horiz && md(b[1], BAYS) === 0 && portalsOf(Math.floor(b[0] / BAYS), b[1] / BAYS, false).includes(md(b[0], BAYS))) return true;
    if (Math.abs(level(a[0], a[1]) - level(b[0], b[1])) > 1) return false;
    if (downDir(a[0], a[1]) === (horiz ? 0 : 2) || downDir(b[0], b[1]) === (horiz ? 1 : 3)) return true;
    if (A.tunnel && B.tunnel) {
      if (((H(a[0], a[1], 0x7b7) & 1) === (horiz ? 1 : 0))) return true; // binary tree: each node opens east or south
      return H01(a[0], a[1], horiz ? 0x7b8 : 0x7b9) < 0.3;
    }
    return H01(a[0], a[1], horiz ? 0x7ba : 0x7bb) < 0.55;
  };
  const tFloor = (bx, bz) => -0.9 * level(bx, bz);
  for (let j = -1; j < 10; j++) for (let i = -1; i < 10; i++) {
    const wbx = pb0x + i, wbz = pb0z + j, s = bay(wbx, wbz);
    const nx = i * LAT + 3, nz = j * LAT + 3;
    if (s.tunnel && i >= 0 && j >= 0) {
      const f = tFloor(wbx, wbz);
      let room = H01(wbx, wbz, 0x7bc) < 0.16;
      for (const d of D4) if (bay(wbx + d[0], wbz + d[1]).tunnel && level(wbx + d[0], wbz + d[1]) !== level(wbx, wbz)) room = false;
      for (let z = (room ? -2 : 0); z <= (room ? 2 : 1); z++) for (let x = (room ? -2 : 0); x <= (room ? 2 : 1); x++) {
        const p = P(nx + x, nz + z); sol[p] = 0; fl[p] = f; ce[p] = f + (room ? CEIL : 2.1);
      }
    }
    for (const horiz of [true, false]) {
      const b = horiz ? [wbx + 1, wbz] : [wbx, wbz + 1];
      if (!tEdge([wbx, wbz], b, horiz)) continue;
      const B = bay(b[0], b[1]);
      const ha = s.tunnel ? tFloor(wbx, wbz) : 0, hb = B.tunnel ? tFloor(b[0], b[1]) : 0;
      const dh = hb - ha, sg = Math.sign(dh), nst = Math.round(Math.abs(dh) / 0.3);
      const er = mulberry32(H(wbx * 2 + (horiz ? 1 : 0), wbz, 0x7bd));
      const wide = dh !== 0 ? 2 : er() < 0.2 ? 1 : 2;
      const crawl = dh === 0 && s.tunnel && B.tunnel && er() < 0.14;
      for (let t = 0; t <= 6; t++) {
        const f = ha + sg * 0.3 * clamp(t - 1, 0, nst);
        const c = f + (crawl && t >= 2 && t <= 4 ? 1.25 : 2.1);
        const own = t < 3 ? s : B;            // which bay this cell lies in
        for (let w = 0; w < wide; w++) {
          const x = horiz ? nx + t : nx + w, z = horiz ? nz + w : nz + t;
          if (!inP(x, z)) continue;
          const p = P(x, z);
          if (own.tunnel) { if (sol[p] || fl[p] === f) { sol[p] = 0; fl[p] = f; ce[p] = c; } }
          else if (sol[p]) { sol[p] = 0; fl[p] = 0; ce[p] = Math.max(2.1, Math.min(bc[p], CEIL)); }
        }
      }
    }
  }
  // --- low and tall bays
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) {
    const s = bay(pb0x + i, pb0z + j);
    if (!s.low) continue;
    for (let z = 1; z <= 5; z++) for (let x = 1; x <= 5; x++) { const p = P(i * LAT + x, j * LAT + z); if (!sol[p] && fl[p] === 0) ce[p] = s.low; }
  }
  // --- height features
  const fx0 = Math.floor((ox - FO) / FG), fx1 = Math.floor((ox + PN - 1 - FO) / FG);
  const fz0 = Math.floor((oz - FO) / FG), fz1 = Math.floor((oz + PN - 1 - FO) / FG);
  const feats = [];
  for (let fz = fz0; fz <= fz1; fz++) for (let fx = fx0; fx <= fx1; fx++) {
    const f = featureAt(fx, fz); if (!f) continue;
    feats.push(f);
    for (let z = 0; z < FW; z++) for (let x = 0; x < FW; x++) {
      const k = x + z * FW; if (!f.m[k]) continue;
      const px = f.x0 + x - ox, pz = f.z0 + z - oz; if (!inP(px, pz)) continue;
      const p = P(px, pz), b = Math.max(bc[p], CEIL), fv = f.fl[k];
      fm[p] = f.m[k]; sol[p] = f.sol[k]; fl[p] = fv;
      ce[p] = !Number.isNaN(f.ce[k]) ? f.ce[k] : f.m[k] === 2 ? b : f.kind === 'deck' ? Math.max(b, fv + CEIL) : b;
    }
  }
  // --- portals: a doorway on the sector line, 3 cells into each side
  const line = (vertical, ex, ez) => {
    for (const k of portalsOf(ex, ez, vertical)) for (let a = -3; a <= 3; a++) for (let r = 2; r <= 4; r++) {
      const gx = vertical ? ex * N + a : ex * N + k * LAT + r, gz = vertical ? ez * N + k * LAT + r : ez * N + a;
      const px = gx - ox, pz = gz - oz; if (!inP(px, pz)) continue;
      const p = P(px, pz);
      if (sol[p]) { sol[p] = 0; ce[p] = ce[p] < 2.1 ? 2.1 : Math.min(ce[p], bc[p]); }
      fl[p] = 0; if (ce[p] < 2.1) ce[p] = 2.1;
    }
  };
  for (const ex of [sx, sx + 1]) for (const ez of [sz - 1, sz, sz + 1]) line(true, ex, ez);
  for (const ez of [sz, sz + 1]) for (const ex of [sx - 1, sx, sx + 1]) line(false, ex, ez);
  // --- the arrival spot
  for (const k of ARRIVE) for (let z = k * N + 20; z <= k * N + 28; z++) for (let x = k * N + 20; x <= k * N + 28; x++) {
    const px = x - ox, pz = z - oz; if (!inP(px, pz)) continue;
    const p = P(px, pz); sol[p] = 0; fl[p] = 0; ce[p] = CEIL;
  }
  return { sol, fl, ce, fm, bay, feats, ox, oz, pb0x, pb0z, level };
}

// ---------------------------------------------------------------- connectivity
const passH = (fa, ca, fb, cb) => Math.abs(fa - fb) <= 0.36 && Math.min(ca, cb) - Math.max(fa, fb) >= 1.0;
function passable(g, a, b) {
  if (g.solid[a] || g.solid[b]) return false;
  return passH(g.floor[a], g.ceil[a], g.floor[b], g.ceil[b]);
}
function flood(g, s, vis) {
  if (vis[s] || g.solid[s]) return;
  const q = [s]; vis[s] = 1;
  while (q.length) {
    const c = q.pop(), cx = c % N, cz = (c / N) | 0;
    for (const d of D4) {
      const nx = cx + d[0], nz = cz + d[1];
      if (!inb(nx, nz)) continue;
      const n = I(nx, nz);
      if (!vis[n] && passable(g, c, n)) { vis[n] = 1; q.push(n); }
    }
  }
}
// Join every target (border openings, feature landings, the spawn) into one component by
// carving the fewest wall cells. Carving never touches the outer ring or a feature cell, so
// the result along the sector edge is exactly the world function.
function connect(g, fm, targets) {
  const vis = new Uint8Array(N * N);
  g.reach = vis; g.carved = 0;
  if (!targets.length) return;
  flood(g, targets[0], vis);
  const cost = new Int32Array(N * N), prev = new Int32Array(N * N), stamp = new Int32Array(N * N), dq = new Int32Array(N * N * 4);
  let gen = 0; g.failed = 0;
  const ef = new Float32Array(N * N); // floor a carved cell would get on the current path
  const carveC = (n, f) => (f !== 0 ? f + 2.1 : g.ceil[n] >= 2.1 && g.ceil[n] <= 9 ? g.ceil[n] : 2.4);
  const toward0 = (f) => (f > 0.15 ? f - 0.3 : f < -0.15 ? f + 0.3 : 0);
  const carvable = (n) => { const x = n % N, z = (n / N) | 0; return x >= 1 && z >= 1 && x < N - 1 && z < N - 1 && !fm[n]; };
  for (const t of targets) {
    if (vis[t] || g.solid[t]) continue;
    gen++;
    let h = N * N * 2, tl = h; dq[tl++] = t; cost[t] = 0; prev[t] = t; stamp[t] = gen;
    let hit = -1;
    while (h < tl) {
      const c = dq[h++];
      if (vis[c]) { hit = c; break; }
      const cx = c % N, cz = (c / N) | 0, cs = g.solid[c];
      const fc = cs ? ef[c] : g.floor[c], cc = cs ? carveC(c, ef[c]) : g.ceil[c];
      for (const d of D4) {
        const nx = cx + d[0], nz = cz + d[1];
        if (!inb(nx, nz)) continue;
        const n = I(nx, nz);
        let w;
        if (!g.solid[n]) { if (!passH(fc, cc, g.floor[n], g.ceil[n])) continue; w = 0; }
        else { if (!carvable(n) || fc > 0.15) continue; const nf = Math.round(toward0(fc) * 10) / 10; if (!passH(fc, cc, nf, carveC(n, nf))) continue; w = 1; if (stamp[n] !== gen || cost[c] + 1 < cost[n]) ef[n] = nf; }
        const nc = cost[c] + w;
        if (stamp[n] !== gen || nc < cost[n]) { stamp[n] = gen; cost[n] = nc; prev[n] = c; if (w) dq[tl++] = n; else dq[--h] = n; }
      }
    }
    if (hit < 0) { g.failed++; continue; }
    for (let c = hit; ; c = prev[c]) {
      if (g.solid[c]) { g.solid[c] = 0; g.floor[c] = ef[c]; g.ceil[c] = carveC(c, ef[c]); g.carved++; }
      if (prev[c] === c) break;
    }
    flood(g, t, vis);
  }
}

// ---------------------------------------------------------------- lamps and things
function placeLamps(g, bay, sx, sz) {
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    const x = i * LAT + 3, z = j * LAT + 3, c = I(x, z);
    const wbx = sx * BAYS + i, wbz = sz * BAYS + j, s = bay(wbx, wbz);
    const r0 = mulberry32(H(wbx, wbz, 0x1a4));
    const r = r0(), r2 = r0(), ph = Math.floor(r0() * 256);
    if (g.solid[c] || g.ceil[c] - g.floor[c] < 1.9) continue;
    let t = 0;
    if (r < s.pOn && !(s.checker && md(wbx + wbz, 2))) t = r2 < s.pFl ? 2 : (r2 < s.pFl * 1.4 ? 3 : 1);
    else if (r < s.pOn + 0.5) t = r2 < 0.12 ? 3 : 4;
    if (!t) continue;
    g.lamp[c] = t; g.phase[c] = ph;
    const c2 = I(x, z + 1);
    if (!g.solid[c2] && g.ceil[c2] === g.ceil[c]) { g.lamp[c2] = t + 8; g.phase[c2] = ph; }
  }
}

function flat(g, x, z) {
  const f = g.floor[I(x, z)];
  for (const d of D4) { const nx = x + d[0], nz = z + d[1]; if (inb(nx, nz) && !g.solid[I(nx, nz)] && g.floor[I(nx, nz)] !== f) return false; }
  return true;
}
function wallDir(g, x, z) {
  for (let k = 0; k < 4; k++) { const nx = x + D4[k][0], nz = z + D4[k][1]; if (inb(nx, nz) && g.solid[I(nx, nz)]) return k; }
  return -1;
}

function populate(g, rng, d, darkish) {
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
  let cellar = g.special.find((s) => s.kind === 'cellar');
  if (cellar && !g.reach[I(cellar.x, cellar.z)]) cellar = null;
  if (d >= 1 && (cellar || rng() < 0.3)) {
    const c = cellar ? I(cellar.x, cellar.z) : take(openAir);
    if (c >= 0) g.artifact = { id: g.sx + ',' + g.sz + ':a', kind: rng.int(12), x: c % N, z: (c / N) | 0, y: g.floor[c] };
  } else { rng(); }
  if (sectorHasExit(g.sx, g.sz)) {
    const c = take(byWall);
    if (c >= 0) { const x = c % N, z = (c / N) | 0; g.exit = { x, z, y: g.floor[c], dir: wallDir(g, x, z) }; }
  }
  const nMarks = rng.int(3) + (darkish ? 2 : 0);
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
  const W = paint(sx, sz);
  const fm = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const p = (x + PADC) + (z + PADC) * PN, i = I(x, z);
    g.solid[i] = W.sol[p]; g.floor[i] = W.fl[p]; g.ceil[i] = W.ce[p]; fm[i] = W.fm[p];
  }
  // what this sector sees of its neighbours' border cells (exported for the edge test)
  const rimOf = (x0, z0, dx, dz) => {
    const a = new Float32Array(N * 3);
    for (let t = 0; t < N; t++) { const p = (x0 + dx * t + PADC) + (z0 + dz * t + PADC) * PN; a[t * 3] = W.sol[p]; a[t * 3 + 1] = W.fl[p]; a[t * 3 + 2] = W.ce[p]; }
    return a;
  };
  g.rim = { w: rimOf(-1, 0, 0, 1), e: rimOf(N, 0, 0, 1), n: rimOf(0, -1, 1, 0), s: rimOf(0, N, 1, 0) };
  // targets: every border cell that opens onto the neighbour, every feature landing, the spawn
  const targets = [];
  if (sx === sz && ARRIVE.includes(sx)) targets.push(I(SPAWN, SPAWN));
  for (const k of portalsOf(sx, sz, true)) targets.push(I(1, k * LAT + 3));
  for (const k of portalsOf(sx + 1, sz, true)) targets.push(I(N - 2, k * LAT + 3));
  for (const k of portalsOf(sx, sz, false)) targets.push(I(k * LAT + 3, 1));
  for (const k of portalsOf(sx, sz + 1, false)) targets.push(I(k * LAT + 3, N - 2));
  for (const [side, x0, z0, dx, dz] of [['w', 0, 0, 0, 1], ['e', N - 1, 0, 0, 1], ['n', 0, 0, 1, 0], ['s', 0, N - 1, 1, 0]]) {
    const rim = g.rim[side];
    for (let t = 0; t < N; t++) {
      const x = x0 + dx * t, z = z0 + dz * t, i = I(x, z);
      if (g.solid[i] || rim[t * 3]) continue;
      if (passH(g.floor[i], g.ceil[i], rim[t * 3 + 1], rim[t * 3 + 2])) targets.push(i);
    }
  }
  for (let i = 0; i < N * N; i++) if (fm[i] === 2 && !g.solid[i]) targets.push(i);
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    const c = I(i * LAT + 3, j * LAT + 3);
    if (W.bay(sx * BAYS + i, sz * BAYS + j).tunnel && !g.solid[c]) targets.push(c);
  }
  // any plain cell you can drop into from a ledge must lead somewhere
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const i = I(x, z); if (g.solid[i] || fm[i]) continue;
    const p = (x + PADC) + (z + PADC) * PN, f = g.floor[i];
    for (const q of [p - 1, p + 1, p - PN, p + PN]) {
      const dh = W.fl[q] - f;
      if (!W.sol[q] && dh > 0.36 && dh <= 3.2 && Math.min(W.ce[q], g.ceil[i]) - W.fl[q] >= 1.0) { targets.push(i); break; }
    }
  }
  connect(g, fm, targets);
  // features that belong here
  for (const f of W.feats) {
    if (!f.spot) continue;
    const x = f.spot[0] - sx * N, z = f.spot[1] - sz * N;
    if (!inb(x, z)) continue;
    g.special.push({ kind: f.kind === 'trench' ? 'cellar' : f.kind === 'deck' ? 'mezz' : f.kind, x, z });
  }
  placeLamps(g, W.bay, sx, sz);
  // style mix of this sector, by bay, and the dominant type
  const mix = {}, bays = new Array(BAYS * BAYS);
  let rough = 0, avN = 0, ringN = 0, repN = 0;
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    const s = W.bay(sx * BAYS + i, sz * BAYS + j);
    bays[i + j * BAYS] = s.label; mix[s.label] = (mix[s.label] || 0) + 1;
    if (s.label === 'dark' || s.label === 'tunnels' || s.label === 'hall') rough++;
    if (s.av) avN++; if (s.blk) { if (s.blk.kind === 1) ringN++; else repN++; }
  }
  let pitC = 0, deckC = 0;
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const i = I(x, z); if (!fm[i]) continue;
    if (g.floor[i] < -0.05) pitC++; else if (g.floor[i] > 0.05) deckC++;
  }
  let type = 'classic', best = -1;
  for (const k in mix) if (mix[k] > best) { best = mix[k]; type = k; }
  if (type === 'classic' || type === 'dense' || type === 'pillars' || type === 'hall') {
    if (pitC >= 110 && pitC >= deckC) type = 'pit'; else if (deckC >= 110) type = 'mezz';
  }
  if (d === 0) type = 'classic';
  g.type = type; g.mix = mix; g.bays = bays;
  const nh = H(sx, sz, 0x9a3e);
  let name = NAMES[type][nh % NAMES[type].length];
  if (type === 'classic' || type === 'dense') {
    if (repN >= 6) name = 'The same room'; else if (ringN >= 8) name = 'The loop'; else if (avN >= 5) name = 'Long corridor';
  }
  if (d === 0) name = 'Office floor';
  g.name = name;
  populate(g, rng, d, (mix.dark || 0) + (mix.tunnels || 0) > 24);
  g.danger = clamp(d / 9, 0, 1) * 0.7 + 0.35 * clamp(rough / 40, 0, 1);
  return g;
}
