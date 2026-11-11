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
//
// 0.3.0: a second field on top of that, the place field. Level 0 is everywhere by default; rare
// domain-warped regions of other levels (1, 2, 5, 37) sit far from the entry, each with its own
// per-bay painter (placeBay), and a 1 to 2 bay band around them where the Level 0 layout bends
// toward theirs. Very rarely a Level ! corridor runs dead straight across many sectors (runSpec);
// it is sealed, so the repair accepts that a sector it cuts in two connects through its neighbours.
import { SEC, LAT, BAYS, CEIL, WORLD_SEED, hash3, mulberry32, clamp, smooth } from './util.js';
import { BIOME, BIOMES } from './biomes.js';

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
  level1: 'Habitable Zone', level2: 'Pipe Dreams', level5: 'Terror Hotel', level37: 'Sublimity', levelrun: 'Run For Your Life!',
};
const NAMES = {
  level1: ['Habitable Zone', 'Concrete acres', 'Loading floor', 'The depot', 'Grey halls', 'Puddle hall', 'Cold storage'],
  level2: ['Pipe Dreams', 'Boiler run', 'The steam line', 'Valve rooms', 'Maintenance crawl', 'Hot ducts'],
  level5: ['Terror Hotel', 'Guest wing', 'The long carpet', 'Vacancy', 'Room service', 'Third floor east'],
  level37: ['Sublimity', 'Still water', 'The baths', 'Tiled quiet', 'Warm pools', 'Lane four'],
  levelrun: ['Run For Your Life!', 'The red mile', 'No way back', 'Alarm corridor'],
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

// True exactly when genSector(sx, sz).exit is set: the end room of a Level ! corridor, or (rarely,
// never within 9 sectors of the entry) an ordinary exit door.
export function sectorHasExit(sx, sz) {
  const r = runSpec(Math.floor(sx / RR), Math.floor(sz / RR));
  if (r && r.esx === sx && r.esz === sz) return true;
  const d = Math.max(Math.abs(sx), Math.abs(sz));
  return d >= 10 && Math.max(Math.abs(sx - BACKDROP), Math.abs(sz - BACKDROP)) > 3 && H(sx, sz, 0xe418) % 90 === 0;
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

// ---------------------------------------------------------------- the place field
// Regions of other levels: one candidate per region cell of 7x7 sectors, a blob 1 to 3 sectors
// across (Level 1 up to 4), domain warped so it never reads as a circle. e = signed distance in
// bays from the region's edge (positive inside). Bays with e >= CORE are painted by the place
// itself; 0 <= e < CORE is the transition band (Level 0 layout bending toward the place).
const CORE = 1.5;
const RC = 7 * BAYS;
const bkey = (bx, bz) => bx * 131072 + bz;
const NOPLACE = { id: 0, e: -99, r: null };
const regMemo = new Map(), plMemo = new Map();
function regionOf(cx, cz) {
  const k = bkey(cx, cz);
  let r = regMemo.get(k);
  if (r !== undefined) return r;
  r = null;
  const h = H(cx, cz, 0x2e61), h2 = H(cx, cz, 0x2e62), h3 = H(cx, cz, 0x2e63);
  const ccx = cx * RC + 6 + (h2 % (RC - 12)) + 0.5, ccz = cz * RC + 6 + ((h2 >>> 16) % (RC - 12)) + 0.5;
  const dS = calm(ccx / BAYS, ccz / BAYS);
  const far = clamp((dS - 18) / 30, 0, 1);
  const u = (h & 0xffff) / 65536;
  const id = u < 0.3 ? BIOME.L1 : u < 0.54 ? BIOME.L2 : u < 0.77 ? BIOME.L5 : BIOME.L37;
  const v = ((h3 >>> 8) & 0xffff) / 65536;
  const rb = (id === BIOME.L1 ? 5.2 + v * 10.8 : 5 + v * 7.5) * (1 + 0.16 * far);
  if (H01(cx, cz, 0x2e64) < 0.9 + 0.1 * far && dS - (rb * 1.5 + 2) / BAYS >= 5) {
    const ang = ((h >>> 16) & 1023) / 1024 * Math.PI;
    r = { id, cx: ccx, cz: ccz, rb, ca: Math.cos(ang), sa: Math.sin(ang), asp: 0.8 + ((h3 & 255) / 255) * 0.45, s: 0x3100 + (h3 % 997) * 3, key: h3 };
  }
  if (regMemo.size > 4000) regMemo.clear();
  regMemo.set(k, r);
  return r;
}
function regionE(r, x, z) {
  const dx = x - r.cx, dz = z - r.cz, lim = r.rb * 1.75 + 3;
  if (dx > lim || dx < -lim || dz > lim || dz < -lim) return -99;
  const A = r.rb * 0.38 + 0.8;
  const wx = dx + (vn(x / 5.5, z / 5.5, r.s) - 0.5) * 2 * A, wz = dz + (vn(x / 5.5, z / 5.5, r.s + 1) - 0.5) * 2 * A;
  const u = wx * r.ca + wz * r.sa, v = -wx * r.sa + wz * r.ca;
  return r.rb * (0.82 + 0.36 * vn(x / 3.2, z / 3.2, r.s + 2)) - Math.hypot(u * r.asp, v / r.asp);
}
// The place of a bay: { id, e, r } (id 0 and e < 0 outside every region; e still says how close one is).
function placeAt(bx, bz) {
  const k = bkey(bx, bz);
  let p = plMemo.get(k);
  if (p) return p;
  const x = bx + 0.5, z = bz + 0.5, cx = Math.floor(bx / RC), cz = Math.floor(bz / RC);
  let best = -99, br = null;
  for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
    const r = regionOf(i, j); if (!r) continue;
    const e = regionE(r, x, z);
    if (e > best) { best = e; br = r; }
  }
  p = best < -20 ? NOPLACE : { id: best >= 0 ? br.id : 0, e: best, r: br };
  if (plMemo.size > 60000) plMemo.clear();
  plMemo.set(k, p);
  return p;
}
const own = (id, bx, bz) => { const p = placeAt(bx, bz); return p.id === id && p.e >= CORE; };

// ---------------------------------------------------------------- Level ! (Run For Your Life!)
// One candidate per run cell of 13x13 sectors. A dead straight corridor, 3 cells wide, 384 to 504
// cells long, on the centre row of a bay row (so the lamp lattice runs down its middle and portal
// doorways on the sector lines it crosses fall inside it, never through its walls). It stays one
// sector clear of its run cell's edges, so two never meet. Along t (0 at the entrance end):
//   t -7..-1  vestibule, open to the level through three doorways
//   t 0..L-1  the corridor, sealed (walls cannot be carved)
//   t L..L+7  the end room with the exit on its far wall
// runCls: 0 none, 1 corridor, 2 sealed wall, 3 vestibule, 4 vestibule wall, 5 end room, 6 sealed wall.
const RR = 13, RRC = RR * N;
const runMemo = new Map();
function runSpec(cx, cz) {
  const k = bkey(cx, cz);
  let r = runMemo.get(k);
  if (r !== undefined) return r;
  r = null;
  const h = H(cx, cz, 0x52a1), h2 = H(cx, cz, 0x52a2), h3 = H(cx, cz, 0x52a3);
  if (h / 4294967296 < 0.95) {
    const axis = h2 & 1, sgn = h2 & 2 ? 1 : -1, L = 6 * (64 + (h3 % 21));
    const along = axis ? cz : cx, across = axis ? cx : cz;
    const lo = along * RRC + N + 7, room = RRC - 2 * N - (L + 16);
    const st = lo + (H(cx, cz, 0x52a4) % (room + 1));          // first cell of the whole piece
    const c0 = sgn > 0 ? st + 7 : st + 9, c1 = c0 + L - 1;
    const sr = 1 + ((h3 >>> 8) % (RR - 2)), kb = 2 + ((h3 >>> 16) % 4);
    const bc = (across * RR + sr) * N + kb * LAT + 3;
    const aLo = sgn > 0 ? c0 - 7 : c0 - 9, aHi = sgn > 0 ? c1 + 9 : c1 + 7;
    const box = axis ? { x0: bc - 6, x1: bc + 6, z0: aLo, z1: aHi } : { x0: aLo, x1: aHi, z0: bc - 6, z1: bc + 6 };
    // nearest point of the piece to each calm place, in sectors
    const nearCalm = (ox, oz) => Math.hypot(clamp(ox, box.x0, box.x1) - ox, clamp(oz, box.z0, box.z1) - oz) / N;
    const c = Math.min(nearCalm(0.5 * N, 0.5 * N), nearCalm((BACKDROP + 0.5) * N, (BACKDROP + 0.5) * N));
    if (c >= 8) {
      const aS = sgn > 0 ? c0 : c1, aE = sgn > 0 ? c1 + 8 : c0 - 8;
      const dir = axis ? (sgn > 0 ? 2 : 3) : (sgn > 0 ? 0 : 1);
      const x0 = axis ? bc : aS, z0 = axis ? aS : bc, x1 = axis ? bc : aE, z1 = axis ? aE : bc;
      r = { axis, sgn, L, c0, c1, bc, box, dir, x0, z0, x1, z1, esx: Math.floor(x1 / N), esz: Math.floor(z1 / N), key: h3 };
    }
  }
  if (runMemo.size > 2000) runMemo.clear();
  runMemo.set(k, r);
  return r;
}
const runAtCell = (gx, gz) => runSpec(Math.floor(gx / RRC), Math.floor(gz / RRC));
function runCls(r, gx, gz) {
  const a = r.axis ? gz : gx, adb = Math.abs((r.axis ? gx : gz) - r.bc);
  if (adb > 6) return 0;
  const t = r.sgn > 0 ? a - r.c0 : r.c1 - a, L = r.L;
  if (t < -7 || t > L + 8) return 0;
  if (t >= L && t <= L + 7 && adb <= 5) return 5;
  if (t >= L - 1 && (adb === 6 || t === L + 8 || (t === L - 1 && adb >= 3))) return 6;
  if (t >= 0 && t < L) { if (adb <= 1) return 1; if (adb === 2) return 2; }
  if (t <= 0 && adb <= 5) {
    if (t === 0) return adb >= 3 ? 4 : 0;
    if (t === -7) return adb <= 1 ? 3 : 4;
    if (adb === 5) return t >= -5 && t <= -3 ? 3 : 4;
    return 3;
  }
  return 0;
}
// Bays near the piece (within one bay of it) get no height features, tunnels, pools or platforms;
// strip bays are the ones on its centre row.
const NORUN = { near: false, strip: false };
function runBay(bx, bz) {
  const x0 = bx * LAT, z0 = bz * LAT, r = runAtCell(x0, z0);
  if (!r) return NORUN;
  const b = r.box;
  if (x0 + 11 < b.x0 || x0 - 6 > b.x1 || z0 + 11 < b.z0 || z0 - 6 > b.z1) return NORUN;
  const inside = !(x0 + 5 < b.x0 || x0 > b.x1 || z0 + 5 < b.z0 || z0 > b.z1);
  const strip = inside && (r.axis ? bx * LAT + 3 === r.bc : bz * LAT + 3 === r.bc);
  return { near: true, strip, r };
}
// bays whose layout may not change floor height: portals and the Level ! piece
const fixedBay = (bx, bz) => portalBay(bx, bz) || runBay(bx, bz).near;

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
// Blocks of 5x5 bays (offset 2) that may hold a set piece of Level 0:
//   1 ring corridor, 2 the room that repeats, and (from 3 sectors out)
//   3 atrium (tall inner 3x3 with a colonnade), 4 room within a room, 5 zig-zag partition field,
//   6 great room (one vast low room), 7 bright stretch (every lamp on and steady).
// None near another level or a Level ! corridor.
const blkMemo = new Map();
function blockSpec(kx, kz) {
  const r = H01(kx, kz, 0x61c);
  const cxs = (kx * 5 + 2 + 2.5) / BAYS, czs = (kz * 5 + 2 + 2.5) / BAYS, dC = calm(cxs, czs);
  if (dC < 1.6) return null;
  let kind = r < 0.025 ? 1 : r < 0.055 ? 2 : 0;
  if (!kind && dC >= 3) kind = r < 0.073 ? 3 : r < 0.087 ? 4 : r < 0.101 ? 5 : r < 0.115 ? 6 : r < 0.13 ? 7 : 0;
  if (!kind) return null;
  for (let j = 0; j <= 4; j += 2) for (let i = 0; i <= 4; i += 2) {
    const bx = kx * 5 + 2 + i, bz = kz * 5 + 2 + j;
    if (placeAt(bx, bz).e > -1.5 || runBay(bx, bz).near) return null;
  }
  return { kind, key: H(kx, kz, 0x61d) };
}
function blockAt(bx, bz) {
  const kx = Math.floor((bx - 2) / 5), kz = Math.floor((bz - 2) / 5), k = bkey(kx, kz);
  let b = blkMemo.get(k);
  if (b === undefined) { b = blockSpec(kx, kz); if (blkMemo.size > 4000) blkMemo.clear(); blkMemo.set(k, b); }
  if (!b) return null;
  const lx = bx - 2 - kx * 5, lz = bz - 2 - kz * 5;
  return { kind: b.kind, kx, kz, lx, lz, key: b.key, inner: lx >= 1 && lx <= 3 && lz >= 1 && lz <= 3, centre: lx === 2 && lz === 2 };
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
  const pl = placeAt(bx, bz), rn = runBay(bx, bz);
  const core = pl.id !== 0 && pl.e >= CORE, band = pl.id !== 0 && !core;
  const blk = core ? null : blockAt(bx, bz);
  const av = blk || pl.e > -1 ? 0 : avenueAt(bx, bz);
  const tunnel = !blk && !av && pl.e < -2.5 && !rn.near && wClosed > 0.55 && T > 0.54 - far * 0.08;
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
  if (blk) {
    st.ceil = CEIL;
    if (blk.kind === 2) { pOn = 1; pFl = 0; } else pOn = Math.max(pOn, 0.8);
    if (blk.kind === 3 && blk.inner) { st.ceil = 5.4; pOn = 0.9; }
    if (blk.kind === 6 && blk.inner) { st.ceil = 3.3; pOn = 0.9; }
  }
  pOn = pOn + (0.09 - pOn) * dark; pFl = pFl + (0.55 - pFl) * dark;
  if (blk && blk.kind === 7) { pOn = 1; pFl = 0; }
  if (dS < 0.7) { pOn = 0.97; pFl = 0.03; }
  st.pOn = pOn; st.pFl = pFl;
  st.checker = wOff > 0.5 && vn(x / 6, z / 6, 0x41) > 0.7 && !(blk && blk.kind === 7);
  st.label = tunnel ? 'tunnels' : hall > 0.5 ? 'hall' : pill > 0.5 ? 'pillars' : wClosed > 0.5 ? 'dense' : 'classic';
  if (dark > 0.5 && st.label !== 'tunnels') st.label = 'dark';
  if (blk && blk.kind === 3 && blk.inner) st.label = 'pillars';
  if (blk && blk.kind === 7) st.label = 'classic';
  // ceiling oddities, as bays in the world
  if (!tunnel && !av && !blk && dS > 0.8 && pl.e < -1) {
    const r = H01(bx, bz, 0x10b);
    if (r < 0.028) st.low = 1.35; else if (r < 0.06 && st.ceil < 4) st.low = 7.5;
  }
  st.pl = pl.id; st.pe = pl.e; st.reg = pl.r; st.core = core; st.band = band;
  if (core) placeStyle(st, pl.id);
  else if (band) bandStyle(st, pl);
  if (rn.strip) { st.label = 'levelrun'; st.pOn = 0.96; st.pFl = 0.22; st.checker = false; }
  return st;
}
// Lamps and labels of a bay inside another level (the layout comes from placeBay).
function placeStyle(st, id) {
  st.tunnel = false; st.lvl = 0; st.av = 0; st.blk = null; st.low = 0; st.dark = 0; st.checker = false;
  st.label = BIOMES[id].key;
  if (id === BIOME.L1) { st.ceil = 4.5; st.pOn = 0.58; st.pFl = 0.42; }
  else if (id === BIOME.L2) { st.ceil = 2.4; st.pOn = 0.4; st.pFl = 0.2; }
  else if (id === BIOME.L5) { st.ceil = 2.9; st.pOn = 0.66; st.pFl = 0.12; }
  else { st.ceil = 4.2; st.pOn = 0.97; st.pFl = 0; }
}
// The transition band: still the Level 0 lattice, bending toward the place next door.
function bandStyle(st, pl) {
  const t = clamp(pl.e / CORE, 0, 1), id = pl.id;
  if (id === BIOME.L1 || id === BIOME.L37) {
    st.wallP *= 1 - 0.55 * t; st.bits *= 1 - 0.6 * t; st.nodeP = st.nodeP * (1 - t) + 0.5 * t;
    if (t > 0.4) st.ceil = id === BIOME.L1 ? 3.6 : 3.3;
  } else if (id === BIOME.L2) {
    st.wallP += (0.85 - st.wallP) * 0.7 * t; st.doorP += (0.7 - st.doorP) * t; st.bits = Math.max(st.bits, 0.8 * t);
    if (t > 0.4) st.ceil = 2.4;
  } else {
    st.wallP += (0.7 - st.wallP) * 0.6 * t; st.doorP += (0.85 - st.doorP) * t;
  }
  const B = BIOMES[id];
  if (id === BIOME.L37) { st.pOn += (0.97 - st.pOn) * t; st.pFl *= 1 - t; }
  else if (id === BIOME.L1) st.pFl += (0.35 - st.pFl) * t;
  else st.pOn += (0.5 - st.pOn) * t * 0.6;
  st.dark *= 1 - t; st.checker = st.checker && t < 0.5;
  if (pl.e >= 0.75) st.label = B.key;
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
  // not in or near another level, not near a Level ! corridor
  const b0x = Math.floor((f.x0 - 1) / LAT), b1x = Math.floor((f.x0 + FW) / LAT), b0z = Math.floor((f.z0 - 1) / LAT), b1z = Math.floor((f.z0 + FW) / LAT);
  for (let bz = b0z; bz <= b1z; bz++) for (let bx = b0x; bx <= b1x; bx++) if (placeAt(bx, bz).e > -1.5 || runBay(bx, bz).near) return false;
  for (let z = 0; z < FW; z++) for (let x = 0; x < FW; x++) {
    if (!f.m[x + z * FW]) continue;
    const gx = f.x0 + x, gz = f.z0 + z;
    if (inPortalZone(gx, gz) || inSpawn(gx, gz, 6)) return false;
    // a landing next to a sector line could open into a pocket only the outer ring could free
    if (f.m[x + z * FW] === 2) { const mx = md(gx, N), mz = md(gz, N); if (mx <= 2 || mz <= 2 || mx >= N - 3 || mz >= N - 3) return false; }
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
  // and no notches up to 3 cells wide either: next to a wall on a sector line they become pockets
  // the repair cannot open (it never carves the outer ring of a sector)
  for (let pass = 0; pass < 2; pass++) for (let z = 3; z < W - 3; z++) for (let x = 3; x < W - 3; x++) {
    const i = x + z * W; if (!ins[i]) continue;
    for (const [st, lim] of [[1, W - 4 - x], [W, W - 4 - z]]) {
      if (ins[i + st]) continue;
      for (let k = 2; k <= 4 && k <= lim; k++) if (ins[i + st * k]) { for (let q = 1; q < k; q++) ins[i + st * q] = 1; break; }
    }
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

// ---------------------------------------------------------------- the other levels, bay by bay
// placeBay(bx, bz) paints one 6x6 bay of a place core as a pure function of world position. A core
// bay owns all 36 of its cells, its lattice lines included; the Level 0 lattice next to it leaves
// the shared line open (seg returns 0), so the place decides its own border.
const pbMemo = new Map();
function placeBay(bx, bz) {
  const k = bkey(bx, bz);
  let o = pbMemo.get(k);
  if (o) return o;
  const pl = placeAt(bx, bz);
  o = { sol: new Uint8Array(36), fl: new Float32Array(36), ce: new Float32Array(36) };
  if (pl.id === BIOME.L1) paintL1(o, bx, bz, pl);
  else if (pl.id === BIOME.L2) paintL2(o, bx, bz);
  else if (pl.id === BIOME.L5) paintL5(o, bx, bz, pl);
  else paintL37(o, bx, bz);
  if (pbMemo.size > 6000) pbMemo.clear();
  pbMemo.set(k, o);
  return o;
}
const r1 = (v) => Math.round(v * 10) / 10;
// 2x2 bay blocks (even aligned) wholly inside one place and away from Level !. With deep = true
// the inner 8x8 cells (where a platform or a pool goes) must also stay clear of every portal zone.
const quadMemo = new Map();
function quad(id, qx, qz, deep) {
  const k = (bkey(qx, qz) * 8 + id) * 2 + (deep ? 1 : 0);
  let v = quadMemo.get(k);
  if (v === undefined) {
    v = true;
    for (let j = 0; j < 2 && v; j++) for (let i = 0; i < 2; i++) { const bx = qx * 2 + i, bz = qz * 2 + j; if (!own(id, bx, bz) || runBay(bx, bz).near) { v = false; break; } }
    if (v && deep) for (let z = 2; z <= 9 && v; z++) for (let x = 2; x <= 9; x++) if (inPortalZone(qx * 12 + x, qz * 12 + z, 3)) { v = false; break; }
    if (quadMemo.size > 8000) quadMemo.clear();
    quadMemo.set(k, v);
  }
  return v;
}
// A raised block in a 12x12 area: platform on [2..9]^2 at height h, a 2 wide stair lane cut into it.
function platF(qlx, qlz, h, rot) {
  let x = qlx, z = qlz;
  if (rot === 1) { x = qlz; z = 11 - qlx; } else if (rot === 2) { x = 11 - qlx; z = 11 - qlz; } else if (rot === 3) { x = 11 - qlz; z = qlx; }
  if (x < 2 || x > 9 || z < 2 || z > 9) return 0;
  if ((z === 5 || z === 6) && x - 2 < Math.round(h / 0.3)) return r1(0.3 * (x - 1));
  return h;
}
// A wall along one side of a core bay facing something else: solid with one wide opening.
function borderOpen(i, j, v, salt) { const h = H(i * 2 + v, j, salt), s = 1 + (h % 2), w = 3 + ((h >>> 1) % 2); return [s, s + w - 1]; }
function borderWalls(o, id, bx, bz, salt, f0) {
  const set = (lx, lz, open) => { const c = lx + lz * 6; if (open) { o.sol[c] = 0; o.fl[c] = f0; } else o.sol[c] = 1; };
  if (!own(id, bx - 1, bz)) { const [a, b] = borderOpen(bx, bz, 1, salt); for (let z = 0; z < 6; z++) set(0, z, z >= a && z <= b); }
  if (!own(id, bx + 1, bz)) { const [a, b] = borderOpen(bx + 1, bz, 1, salt); for (let z = 0; z < 6; z++) set(5, z, z >= a && z <= b); }
  if (!own(id, bx, bz - 1)) { const [a, b] = borderOpen(bx, bz, 0, salt); for (let x = 0; x < 6; x++) set(x, 0, x >= a && x <= b); }
  if (!own(id, bx, bz + 1)) { const [a, b] = borderOpen(bx, bz + 1, 0, salt); for (let x = 0; x < 6; x++) set(x, 5, x >= a && x <= b); }
}

// Level 1: bare concrete halls on the lattice, square pillars, walled storage rooms, loading docks.
const l1Memo = new Map();
function l1Block(qx, qz) {
  const k = bkey(qx, qz);
  let b = l1Memo.get(k);
  if (b) return b;
  b = { k: 0, side: 0 };
  const r = H01(qx, qz, 0x1101), h = H(qx, qz, 0x1102);
  if (r < 0.2 && quad(BIOME.L1, qx, qz)) b = { k: 1, side: h & 3 };
  else if (r >= 0.2 && r < 0.34 && quad(BIOME.L1, qx, qz, true)) b = { k: 2, side: h & 3 };
  if (l1Memo.size > 4000) l1Memo.clear();
  l1Memo.set(k, b);
  return b;
}
function paintL1(o, bx, bz, pl) {
  const qx = Math.floor(bx / 2), qz = Math.floor(bz / 2), bk = l1Block(qx, qz), qx0 = (bx - qx * 2) * 6, qz0 = (bz - qz * 2) * 6;
  const sparse = (pl.r.key >>> 5) & 1, pill = !sparse || (md(bx, 2) === 0 && md(bz, 2) === 0);
  const ce0 = vn(bx / 4, bz / 4, 0x1103) > 0.62 ? 3.6 : 4.5;
  for (let lz = 0; lz < 6; lz++) for (let lx = 0; lx < 6; lx++) {
    const c = lx + lz * 6, qlx = qx0 + lx, qlz = qz0 + lz;
    let s = 0, f = 0, ce = ce0;
    if (bk.k === 1) {
      ce = 3.0;
      const edge = qlx === 0 ? 0 : qlx === 11 ? 1 : qlz === 0 ? 2 : qlz === 11 ? 3 : -1;
      if (edge >= 0) { const along = edge < 2 ? qlz : qlx; s = edge === bk.side && (along === 5 || along === 6) ? 0 : 1; }
    } else if (bk.k === 2) { f = platF(qlx, qlz, 0.9, bk.side); ce = Math.max(ce0, f + 2.7); }
    else if (pill && lx < 2 && lz < 2) s = 1;
    o.sol[c] = s; o.fl[c] = f; o.ce[c] = ce;
  }
  borderWalls(o, BIOME.L1, bx, bz, 0x1104, 0);
}

// Level 2: service tunnels between bay centres. Long straight runs (per row and column), a binary
// tree underneath so a whole region stays joined, dead ends, machine rooms, one level down by ramps.
const l2lMemo = new Map();
function lev2(bx, bz) {
  const k = bkey(bx, bz);
  let v = l2lMemo.get(k);
  if (v !== undefined) return v;
  v = 0;
  if (own(BIOME.L2, bx, bz) && !fixedBay(bx, bz) && own(BIOME.L2, bx + 1, bz) && own(BIOME.L2, bx - 1, bz) && own(BIOME.L2, bx, bz + 1) && own(BIOME.L2, bx, bz - 1))
    v = vn(bx / 4.5, bz / 4.5, 0x2201) > 0.56 ? -0.9 : 0;
  if (l2lMemo.size > 8000) l2lMemo.clear();
  l2lMemo.set(k, v);
  return v;
}
// Width (0 closed, 2 or 3) of the tunnel between bay (bx, bz) and the next one east (h) or south.
function edge2(bx, bz, horiz) {
  const nx = horiz ? bx + 1 : bx, nz = horiz ? bz : bz + 1;
  const a = own(BIOME.L2, bx, bz), b = own(BIOME.L2, nx, nz);
  if (!a && !b) return 0;
  if (a !== b) return H01(bx, bz, horiz ? 0x2214 : 0x2215) < 0.45 ? 2 : 0;
  const line = horiz ? bz : bx, pos = horiz ? bx : bz, salt = horiz ? 0x2210 : 0x2220;
  const len = 2 + (H(line, 0, salt) % 5), seg = Math.floor((pos + (H(line, 1, salt) % len)) / len);
  const hs = H(seg, line, salt + 2);
  if ((hs & 1023) / 1024 < 0.36) return hs & 1024 ? 3 : 2;
  const east = H(bx, bz, 0x2213) & 1;
  if (horiz ? east : !east) return 2;
  return H01(bx, bz, salt + 3) < 0.12 ? 2 : 0;
}
function paintL2(o, bx, bz) {
  const L = lev2(bx, bz);
  o.sol.fill(1); o.fl.fill(L); o.ce.fill(L + 2.4);
  const open = (lx, lz, f, ce) => { const c = lx + lz * 6; o.sol[c] = 0; o.fl[c] = f; o.ce[c] = ce === undefined ? f + 2.4 : ce; };
  const room = !fixedBay(bx, bz) && H01(bx, bz, 0x2216) < 0.11;
  if (room) { for (let z = 1; z <= 5; z++) for (let x = 1; x <= 5; x++) open(x, z, L, L + 3.0); }
  else for (let z = 2; z <= 4; z++) for (let x = 2; x <= 4; x++) open(x, z, L);
  let w = edge2(bx, bz, true);
  if (w) { const f = r1(L + (lev2(bx + 1, bz) - L) / 3); for (let z = 2; z < 2 + w; z++) open(5, z, f); }
  w = edge2(bx - 1, bz, true);
  if (w) { const Lw = lev2(bx - 1, bz), f = r1(Lw + 2 * (L - Lw) / 3); for (let z = 2; z < 2 + w; z++) { open(0, z, f); open(1, z, L); } }
  w = edge2(bx, bz, false);
  if (w) { const f = r1(L + (lev2(bx, bz + 1) - L) / 3); for (let x = 2; x < 2 + w; x++) open(x, 5, f); }
  w = edge2(bx, bz - 1, false);
  if (w) { const Ln = lev2(bx, bz - 1), f = r1(Ln + 2 * (L - Ln) / 3); for (let x = 2; x < 2 + w; x++) { open(x, 0, f); open(x, 1, L); } }
}

// Level 5: hotel corridors on a grid (every 2nd bay row, every 3rd bay column), solid rooms between
// them, now and then a lobby or ballroom (3x4 bays, tall) and a stair hall.
const lobMemo = new Map();
function lobbyAt(bx, bz) {
  const gx = Math.floor(bx / 6), gz = Math.floor(bz / 6), k = bkey(gx, gz);
  let L = lobMemo.get(k);
  if (L === undefined) {
    L = null;
    const h = H(gx, gz, 0x5503);
    if ((h & 1023) / 1024 < 0.45) {
      const wide = (h >>> 10) & 1, w = wide ? 4 : 3, d = wide ? 3 : 4;
      const ox = gx * 6 + ((h >>> 12) % (7 - w)), oz = gz * 6 + ((h >>> 16) % (7 - d));
      let ok = true;
      for (let j = 0; j < d && ok; j++) for (let i = 0; i < w; i++) if (!own(BIOME.L5, ox + i, oz + j) || runBay(ox + i, oz + j).near) { ok = false; break; }
      if (ok) L = { ox, oz, w, d };
    }
    if (lobMemo.size > 4000) lobMemo.clear();
    lobMemo.set(k, L);
  }
  return L && bx >= L.ox && bz >= L.oz && bx < L.ox + L.w && bz < L.oz + L.d ? L : null;
}
const stairMemo = new Map();
function l5Stair(qx, qz) {
  const k = bkey(qx, qz);
  let v = stairMemo.get(k);
  if (v === undefined) {
    v = -1;
    if (H01(qx, qz, 0x5504) < 0.12 && quad(BIOME.L5, qx, qz, true)) {
      let lob = false;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) if (lobbyAt(qx * 2 + i, qz * 2 + j)) lob = true;
      if (!lob) v = H(qx, qz, 0x5505) & 3;
    }
    if (stairMemo.size > 4000) stairMemo.clear();
    stairMemo.set(k, v);
  }
  return v;
}
function paintL5(o, bx, bz, pl) {
  const key = pl.r.key, lob = lobbyAt(bx, bz);
  if (lob) {
    o.fl.fill(0); o.ce.fill(4.2);
    if (bx > lob.ox && bz > lob.oz) o.sol[0] = 1; // columns inside the ballroom
    return;
  }
  const qx = Math.floor(bx / 2), qz = Math.floor(bz / 2), rot = l5Stair(qx, qz);
  if (rot >= 0) {
    const qx0 = (bx - qx * 2) * 6, qz0 = (bz - qz * 2) * 6;
    for (let lz = 0; lz < 6; lz++) for (let lx = 0; lx < 6; lx++) { const c = lx + lz * 6, f = platF(qx0 + lx, qz0 + lz, 1.2, rot); o.fl[c] = f; o.ce[c] = Math.max(4.2, f + 2.7); }
    return;
  }
  const hRow = md(bz + (key >>> 3) % 2, 2) === 0, vCol = md(bx + key % 3, 3) === 0;
  const wH = H(bz, key & 0xfff, 0x5501) & 1 ? 3 : 2, wV = H(bx, key & 0xfff, 0x5502) & 1 ? 3 : 2;
  for (let lz = 0; lz < 6; lz++) for (let lx = 0; lx < 6; lx++) {
    const c = lx + lz * 6, open = (hRow && lz >= 2 && lz < 2 + wH) || (vCol && lx >= 2 && lx < 2 + wV);
    o.sol[c] = open ? 0 : 1; o.fl[c] = 0; o.ce[c] = 2.9;
  }
}

// Level 37: tiled rooms joined by wide openings and arches, pools in 2x2 bay blocks (terraced,
// sheer with a step flight, crossed by a walkway, or with columns), shin-deep flooded rooms.
const poolMemo = new Map();
function l37Pool(qx, qz) {
  const k = bkey(qx, qz);
  let p = poolMemo.get(k);
  if (p === undefined) {
    p = 0;
    if (H01(qx, qz, 0x3706) < 0.6 && quad(BIOME.L37, qx, qz, true)) p = 1 + (H(qx, qz, 0x3707) & 15);
    if (poolMemo.size > 4000) poolMemo.clear();
    poolMemo.set(k, p);
  }
  return p;
}
// Wall on lattice line (i, j, v) of Level 37: null, or { a, b, arch } with the opening a..b.
function l37wall(i, j, v) {
  const ax = v ? i - 1 : i, az = v ? j : j - 1;
  const oa = own(BIOME.L37, ax, az), ob = own(BIOME.L37, i, j);
  if (!oa && !ob) return null;
  if (oa && ob) {
    if (Math.floor(ax / 2) === Math.floor(i / 2) && Math.floor(az / 2) === Math.floor(j / 2) && l37Pool(Math.floor(i / 2), Math.floor(j / 2))) return null;
    if (H01(i * 2 + v, j, 0x3703) >= 0.62) return null;
    const h = H(i * 2 + v, j, 0x3704), w = 2 + ((h >>> 3) % 2), a = 1 + (h % (6 - w));
    return { a, b: a + w - 1, arch: (H(i * 2 + v, j, 0x3705) & 1) === 1 };
  }
  const [a, b] = borderOpen(i, j, v, 0x3704);
  return { a, b, arch: false };
}
function paintL37(o, bx, bz) {
  const qx = Math.floor(bx / 2), qz = Math.floor(bz / 2), pool = l37Pool(qx, qz), qx0 = (bx - qx * 2) * 6, qz0 = (bz - qz * 2) * 6;
  const fld = !pool && vn(bx / 3.1, bz / 3.1, 0x3701) > 0.64, f0 = fld ? -0.3 : 0;
  const cv = vn(qx / 2.3, qz / 2.3, 0x3702);
  let ce0 = cv < 0.38 ? 3.3 : cv < 0.68 ? 4.2 : 5.4;
  if (pool) ce0 = Math.max(ce0, 4.2);
  o.fl.fill(f0); o.ce.fill(ce0);
  if (pool) {
    const type = (pool - 1) & 3, rot = ((pool - 1) >> 2) & 3;
    for (let lz = 0; lz < 6; lz++) for (let lx = 0; lx < 6; lx++) {
      const c = lx + lz * 6, x = qx0 + lx, z = qz0 + lz, ring = Math.min(x - 2, 9 - x, z - 2, 9 - z);
      if (ring < 0) continue;
      let f = ring === 0 ? -0.3 : ring === 1 ? -0.6 : -0.9;
      if (type === 0 && x >= 5 && x <= 6 && z >= 5 && z <= 6) o.sol[c] = 1;
      if (type === 1) {
        f = -0.6;
        const along = rot & 1 ? x : z, side = rot & 2 ? (rot & 1 ? z === 9 : x === 9) : (rot & 1 ? z === 2 : x === 2);
        if (side && along >= 4 && along <= 7) f = -0.3;
      }
      if (type === 2 && ((rot & 1 ? x : z) === 5 || (rot & 1 ? x : z) === 6)) f = 0;
      if (type === 3 && (x === 4 || x === 7) && (z === 4 || z === 7)) o.sol[c] = 1;
      o.fl[c] = f;
    }
  }
  const paintLine = (w, vert, fixedAt) => {
    if (!w) return;
    for (let k = 0; k < 6; k++) {
      if (k === 0 && fixedAt === 0) continue;
      const c = vert ? fixedAt + k * 6 : k + fixedAt * 6;
      if (k >= w.a && k <= w.b) { o.sol[c] = 0; o.fl[c] = f0; if (w.arch) o.ce[c] = Math.min(o.ce[c], 2.7); }
      else o.sol[c] = 1;
    }
  };
  const W = l37wall(bx, bz, 1), Nn = l37wall(bx, bz, 0);
  paintLine(W, true, 0); paintLine(Nn, false, 0);
  if (!own(BIOME.L37, bx + 1, bz)) paintLine(l37wall(bx + 1, bz, 1), true, 5);
  if (!own(BIOME.L37, bx, bz + 1)) paintLine(l37wall(bx, bz + 1, 0), false, 5);
  const node = W || Nn || (own(BIOME.L37, bx, bz - 1) && l37wall(bx, bz - 1, 1)) || (own(BIOME.L37, bx - 1, bz) && l37wall(bx - 1, bz, 0));
  o.sol[0] = node || H01(bx, bz, 0x3708) < 0.28 ? 1 : 0;
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
    this.bio = new Uint8Array(N * N); this.biome = 0; this.decor = []; this.run = null;
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
    // a place core owns its border: no Level 0 wall on a line it shares
    if (A.core || B.core) { if (key >= 0) segMemo[key] = 0; return 0; }
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
      else if (b.kind === 1) {
        const ringA = A.blk.lx % 4 === 0 || A.blk.lz % 4 === 0, ringB = B.blk.lx % 4 === 0 || B.blk.lz % 4 === 0;
        if (ringA && ringB) { wallP = 0; }
        else if (ringA !== ringB) { wallP = 1; doorP = (H(i * 2 + v, j, 0x5ea) % 12 === b.key % 12) ? 1 : 0.14; }
      }
      else if (b.kind === 3 || b.kind === 6) {
        // atrium / great room: one open inner room, many doors in its walls
        if (A.blk.inner && B.blk.inner) wallP = 0;
        else if (A.blk.inner !== B.blk.inner) { wallP = 1; doorP = b.kind === 3 ? 0.75 : 0.6; }
      }
      else if (b.kind === 4) {
        // room within a room: a closed 3x3 box with one door, and inside it the centre bay with one door
        const outer = A.blk.inner !== B.blk.inner, inner = A.blk.inner && B.blk.inner && A.blk.centre !== B.blk.centre;
        if (outer || inner) {
          const inA = outer ? A.blk.inner : A.blk.centre, side = v ? (inA ? 3 : 2) : (inA ? 1 : 0);
          const pos = (v ? (inA ? A.blk.lz : B.blk.lz) : (inA ? A.blk.lx : B.blk.lx)) - 1;
          c = outer ? (side === (b.key & 3) && pos === ((b.key >>> 2) % 3) ? 3 : 1) : (side === ((b.key >>> 4) & 3) ? 3 : 1);
          if (key >= 0) segMemo[key] = c; return c;
        }
        if (A.blk.inner && B.blk.inner) { if (key >= 0) segMemo[key] = 0; return 0; }
      }
      else if (b.kind === 5) { wallP = 0; }
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
    if (s.tunnel || s.core) continue;
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
    const openB = s.blk && ((s.blk.kind === 3 || s.blk.kind === 6) && s.blk.inner || s.blk.kind === 5);
    if (any) sol[P(X, Z)] = 1;
    else if (openB) {
      // the atrium's colonnade: square columns on the nodes inside it
      if (s.blk.kind === 3 && s.blk.lx >= 2 && s.blk.lz >= 2) sol[P(X, Z)] = sol[P(X + 1, Z)] = sol[P(X, Z + 1)] = sol[P(X + 1, Z + 1)] = 1;
    }
    else if (!ringB && !s.av) {
      const r1 = nr(), r2 = nr();
      if (s.skip && (md(wbx, 2) || md(wbz, 2))) { /* every second node only */ }
      else if (r1 < s.nodeP) { sol[P(X, Z)] = 1; if (s.big) { sol[P(X + 1, Z)] = sol[P(X, Z + 1)] = sol[P(X + 1, Z + 1)] = 1; } }
      else if (!md(wbx, 2) && !md(wbz, 2) && r2 < s.hallBig) { sol[P(X, Z)] = sol[P(X + 1, Z)] = sol[P(X, Z + 1)] = sol[P(X + 1, Z + 1)] = 1; }
      else if (r2 > 1 - s.bits * 0.22) sol[P(X, Z)] = 1;
    }
    // zig-zag partitions: a two cell thick diagonal staircase of wall through every bay, mirrored bay to bay
    if (s.blk && s.blk.kind === 5) {
      const m = md(wbx + wbz, 2);
      for (let k = 0; k < 4; k++) { const a = m ? 4 - k : k + 1; sol[P(X + a, Z + k + 1)] = sol[P(X + a + 1, Z + k + 1)] = 1; }
    }
    // odd free standing bits inside a bay
    if (!s.av && !ringB && !openB && s.bits > 0.5) {
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
  // --- the other levels: every core bay paints its own 36 cells
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) {
    const wbx = pb0x + i, wbz = pb0z + j, s = bay(wbx, wbz);
    if (!s.core) continue;
    const o = placeBay(wbx, wbz);
    for (let z = 0; z < LAT; z++) for (let x = 0; x < LAT; x++) {
      const p = P(i * LAT + x, j * LAT + z), c = x + z * LAT;
      sol[p] = o.sol[c]; fl[p] = o.fl[c]; ce[p] = o.ce[c];
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
  // --- Level !: drawn over everything (its walls are marked 3 in fm: the repair may not carve them)
  const run = runAtCell(sx * N + 24, sz * N + 24);
  let rc = null;
  if (run && !(ox + PN <= run.box.x0 || ox > run.box.x1 || oz + PN <= run.box.z0 || oz > run.box.z1)) {
    rc = new Uint8Array(PN * PN);
    for (let z = Math.max(0, run.box.z0 - oz); z < Math.min(PN, run.box.z1 - oz + 1); z++) for (let x = Math.max(0, run.box.x0 - ox); x < Math.min(PN, run.box.x1 - ox + 1); x++) {
      const k = runCls(run, ox + x, oz + z); if (!k) continue;
      const p = P(x, z); rc[p] = k;
      if (k === 1 || k === 3 || k === 5) { sol[p] = 0; fl[p] = 0; ce[p] = k === 1 ? 3.0 : k === 3 ? 2.7 : 3.3; fm[p] = 0; }
      else { sol[p] = 1; fl[p] = 0; ce[p] = 2.7; fm[p] = k === 4 ? 0 : 3; }
    }
  }
  // --- the arrival spot
  for (const k of ARRIVE) for (let z = k * N + 20; z <= k * N + 28; z++) for (let x = k * N + 20; x <= k * N + 28; x++) {
    const px = x - ox, pz = z - oz; if (!inP(px, pz)) continue;
    const p = P(px, pz); sol[p] = 0; fl[p] = 0; ce[p] = CEIL;
  }
  return { sol, fl, ce, fm, bay, feats, ox, oz, pb0x, pb0z, level, run: rc ? run : null, rc };
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
// With split = true (a sealed Level ! corridor crosses the sector) a target that cannot reach the
// joined part starts a part of its own, and later targets may join either: the two sides of the
// corridor each connect to the world through their own sector edges.
function connect(g, fm, targets, split) {
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
    if (hit < 0) { g.failed++; if (split) flood(g, t, vis); continue; }
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

// Things placed by the seed of the claim (items, artifact, marks) and the exit. busy: cells taken by
// decor that stands on the floor. share: fraction of open cells per place.
function populate(g, rng, d, darkish, share, busy) {
  const byWall = [], openAir = [];
  const rs = g.run && g.run.spec, run = rs && rs.esx === g.sx && rs.esz === g.sz ? rs : null;
  const ex = run ? run.x1 - g.sx * N : -9, ez = run ? run.z1 - g.sz * N : -9;
  for (let z = 2; z < N - 2; z++) for (let x = 2; x < N - 2; x++) {
    const i = I(x, z);
    if (!g.reach[i] || g.lamp[i] || busy.has(i) || !flat(g, x, z) || g.ceil[i] - g.floor[i] < 1.9) continue;
    if (Math.abs(x - ex) <= 3 && Math.abs(z - ez) <= 3) continue;
    if (wallDir(g, x, z) >= 0) byWall.push(i); else openAir.push(i);
  }
  const take = (arr) => (arr.length ? arr.splice(rng.int(arr.length), 1)[0] : -1);
  // Level 1 is where the supplies are; the pools of Level 37 have little to give
  let nItems = 2 + rng.int(3);
  nItems += Math.round(share[BIOME.L1] * (4 + rng.int(4)));
  if (share[BIOME.L37] > 0.5) nItems = Math.min(nItems, 1 + rng.int(2));
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
  if (run) g.exit = { x: ex, z: ez, y: g.floor[I(ex, ez)], dir: run.dir };
  else if (sectorHasExit(g.sx, g.sz)) {
    let c = take(byWall);
    if (c < 0) for (let i = 0; i < N * N && c < 0; i++) { const x = i % N, z = (i / N) | 0; if (x >= 1 && z >= 1 && x < N - 1 && z < N - 1 && g.reach[i] && !g.solid[i] && wallDir(g, x, z) >= 0) c = i; }
    if (c >= 0) { const x = c % N, z = (c / N) | 0; g.exit = { x, z, y: g.floor[c], dir: wallDir(g, x, z) }; }
  }
  const nMarks = rng.int(3) + (darkish ? 2 : 0);
  for (let k = 0; k < nMarks; k++) {
    const c = take(byWall); if (c < 0) break;
    const x = c % N, z = (c / N) | 0;
    g.marks.push({ x, z, dir: wallDir(g, x, z), glyph: rng.int(16), y: g.floor[c] + 1.15 + rng() * 0.45, late: rng() < 0.35 });
  }
}

// Place id per cell: the core of a place is all its own, the band is split along a smooth line
// (bilinear between bay centres), Level ! cells are Level !.
function placeBio(g, W, sx, sz) {
  const bio = g.bio;
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    const wbx = sx * BAYS + i, wbz = sz * BAYS + j, s = W.bay(wbx, wbz);
    if (!s.pl) continue;
    if (s.core) { for (let z = 0; z < LAT; z++) for (let x = 0; x < LAT; x++) bio[I(i * LAT + x, j * LAT + z)] = s.pl; continue; }
    const id = s.pl, val = (bx, bz) => { const p = placeAt(bx, bz); return p.id === id ? p.e : -1.5; };
    for (let z = 0; z < LAT; z++) for (let x = 0; x < LAT; x++) {
      const u = (x + 0.5) / LAT - 0.5, v = (z + 0.5) / LAT - 0.5;
      const ix = u < 0 ? -1 : 0, iz = v < 0 ? -1 : 0, fu = u - ix, fv = v - iz;
      const a = val(wbx + ix, wbz + iz), b = val(wbx + ix + 1, wbz + iz), c = val(wbx + ix, wbz + iz + 1), e = val(wbx + ix + 1, wbz + iz + 1);
      const m = (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv;
      if (m > 0.75) bio[I(i * LAT + x, j * LAT + z)] = id;
    }
  }
  if (W.rc) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (W.rc[(x + PADC) + (z + PADC) * PN]) bio[I(x, z)] = BIOME.LRUN;
}

// Dressing, from the finished cells: every piece hangs on a real wall (or stands by a pool edge).
// Positions follow world coordinates, so the same wall gets the same door number for everybody.
// pipe: dir points at the wall it runs along, the run goes v cells in +z (dir 0, 1) or +x (dir 2, 3).
const DECOR_MAX = 120;
function makeDecor(g) {
  const out = [], ox = g.sx * N, oz = g.sz * N, S_ = g.solid, B = g.bio;
  const wall = (x, z, d) => S_[I(x + D4[d][0], z + D4[d][1])] === 1;
  const open = (x, z) => inb(x, z) && !S_[I(x, z)];
  const add = (k, x, z, d, v) => out.push({ k, x, z, y: g.floor[I(x, z)], dir: d, v: v || 0 });
  // straight wall: the cell and both its neighbours along the wall have wall behind them
  const flatWall = (x, z, d) => { const px = D4[d][1], pz = D4[d][0]; return open(x + px, z + pz) && open(x - px, z - pz) && wall(x + px, z + pz, d) && wall(x - px, z - pz, d); };
  const runLen = (x, z, d, max) => { const px = D4[d][0] ? 0 : 1, pz = D4[d][0] ? 1 : 0; let k = 0; while (k < max && x + px * k < N - 1 && z + pz * k < N - 1 && open(x + px * k, z + pz * k) && wall(x + px * k, z + pz * k, d)) k++; return k; };
  for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
    const i = I(x, z), b = B[i];
    if (!b || S_[i]) continue;
    const gx = ox + x, gz = oz + z, f = g.floor[i], hr = g.ceil[i] - f, h = H(gx, gz, 0xdec0);
    if (b === BIOME.L5) {
      for (let d = 0; d < 4; d++) {
        if (!wall(x, z, d) || !flatWall(x, z, d)) continue;
        const a = d < 2 ? gz : gx, ac = d < 2 ? gx : gz;
        if (hr < 3.5) {
          if (md(a, 6) === 2) { add('hdoor', x, z, d, 100 * (1 + md(Math.floor(ac / 12), 9)) + 1 + md(Math.floor(a / 6) * 2 + (d & 1), 60)); break; }
          if (md(a, 12) === 5) { add('sconce', x, z, d); break; }
        } else if (md(a, 6) === 3) { add('sconce', x, z, d); break; }
      }
    } else if (b === BIOME.L2) {
      for (let d = 0; d < 4; d++) {
        if (!wall(x, z, d)) continue;
        if (h % 43 === 0) { add('valve', x, z, d); break; }
        if (md(d < 2 ? gz : gx, 8) === 0) { const n = runLen(x, z, d, 6); if (n >= 3) { add('pipe', x, z, d, n); break; } }
      }
    } else if (b === BIOME.L1) {
      let dw = -1;
      for (let d = 0; d < 4; d++) if (wall(x, z, d)) { dw = d; break; }
      if (dw >= 0) {
        if (h % (g.ceil[i] - f < 3.05 ? 5 : 23) === 0) add('crate', x, z, dw);
        else if (h % 241 === 1) add('cooler', x, z, dw);
        else if ((dw === 0 || dw === 2) && md(dw === 0 ? gz : gx, 12) === 0) { const n = runLen(x, z, dw, 6); if (n >= 4) add('pipe', x, z, dw, n); }
      } else if (h % 97 === 0 && Math.abs(f) < 0.01) add('puddle', x, z, 0);
    } else if (b === BIOME.L37) {
      let done = false;
      if (f > -0.02 && h % 3 === 0) for (let d = 0; d < 4 && !done; d++) {
        const nx = x + D4[d][0], nz = z + D4[d][1];
        if (open(nx, nz) && g.floor[I(nx, nz)] <= f - 0.45 && md(d < 2 ? gz : gx, 4) === 1) { add('ladder', x, z, d); done = true; }
      }
      if (!done && h % 53 === 0 && flat(g, x, z) && wallDir(g, x, z) < 0) add('drain', x, z, 0);
      else if (!done && h % 211 === 7) { const d = wallDir(g, x, z); if (d >= 0) add('cooler', x, z, d); }
    } else if (b === BIOME.LRUN) {
      for (let d = 0; d < 4; d++) if (wall(x, z, d) && hr > 2.9 && hr < 3.1 && md((d < 2 ? gz : gx) + 6, 12) === 0) { add('strobe', x, z, d); break; }
    }
  }
  // Level !: a warning on the wall of the vestibule, beside the corridor mouth
  const r = g.run;
  if (r) {
    const t = -1, adb = 3, a = r.sgn > 0 ? r.c0 + t : r.c1 - t;
    const wx = r.axis ? r.bc + adb : a, wz = r.axis ? a : r.bc + adb, x = wx - ox, z = wz - oz;
    if (x >= 1 && z >= 1 && x < N - 1 && z < N - 1 && !S_[I(x, z)]) {
      const d = r.dir;
      if (wall(x, z, d)) add('sign', x, z, d, 3);
    }
  }
  if (out.length <= DECOR_MAX) return out;
  // too much: keep the doors, ladders and alarms first, thin the rest evenly
  const pri = out.filter((o) => o.k === 'hdoor' || o.k === 'strobe' || o.k === 'ladder' || o.k === 'sign'), rest = out.filter((o) => !pri.includes(o));
  const thin = (arr, n) => (arr.length <= n ? arr : arr.filter((_, k) => Math.floor((k + 1) * n / arr.length) !== Math.floor(k * n / arr.length)));
  const p2 = thin(pri, DECOR_MAX);
  return p2.concat(thin(rest, DECOR_MAX - p2.length));
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
  if (W.run) { const r = W.run; g.run = { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, dir: r.dir }; Object.defineProperty(g.run, 'spec', { value: r, enumerable: false }); }
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
    const c = I(i * LAT + 3, j * LAT + 3), s = W.bay(sx * BAYS + i, sz * BAYS + j);
    // tunnel nodes, the middle of every bay of another level, the Level ! rooms and corridor
    if ((s.tunnel || s.core || (W.rc && W.rc[(i * LAT + 3 + PADC) + (j * LAT + 3 + PADC) * PN])) && !g.solid[c]) targets.push(c);
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
  connect(g, fm, targets, !!W.run);
  // features that belong here
  for (const f of W.feats) {
    if (!f.spot) continue;
    const x = f.spot[0] - sx * N, z = f.spot[1] - sz * N;
    if (!inb(x, z)) continue;
    g.special.push({ kind: f.kind === 'trench' ? 'cellar' : f.kind === 'deck' ? 'mezz' : f.kind, x, z });
  }
  placeLamps(g, W.bay, sx, sz);
  placeBio(g, W, sx, sz);
  // style mix of this sector, by bay, and the dominant type
  const mix = {}, bays = new Array(BAYS * BAYS), blkN = [0, 0, 0, 0, 0, 0, 0, 0];
  let rough = 0, avN = 0;
  for (let j = 0; j < BAYS; j++) for (let i = 0; i < BAYS; i++) {
    const s = W.bay(sx * BAYS + i, sz * BAYS + j);
    bays[i + j * BAYS] = s.label; mix[s.label] = (mix[s.label] || 0) + 1;
    if (s.label === 'dark' || s.label === 'tunnels' || s.label === 'hall') rough++;
    if (s.av) avN++; if (s.blk) blkN[s.blk.kind]++;
  }
  let pitC = 0, deckC = 0;
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const i = I(x, z); if (fm[i] !== 1 && fm[i] !== 2) continue;
    if (g.floor[i] < -0.05) pitC++; else if (g.floor[i] > 0.05) deckC++;
  }
  // places by open cell
  const cnt = [0, 0, 0, 0, 0, 0];
  let open = 0;
  for (let i = 0; i < N * N; i++) if (!g.solid[i]) { cnt[g.bio[i]]++; open++; }
  const share = cnt.map((c) => (open ? c / open : 0));
  let dom = 0;
  for (let k = 1; k < cnt.length; k++) if (cnt[k] > cnt[dom]) dom = k;
  if (dom === 0 && cnt[BIOME.LRUN] >= 0.06 * open) dom = BIOME.LRUN;  // the corridor is narrow: a slice of it is enough
  g.biome = dom;
  let type = 'classic', best = -1;
  for (const k in mix) if (!k.startsWith('level') && mix[k] > best) { best = mix[k]; type = k; }
  if (type === 'classic' || type === 'dense' || type === 'pillars' || type === 'hall') {
    if (pitC >= 110 && pitC >= deckC) type = 'pit'; else if (deckC >= 110) type = 'mezz';
  }
  if (d === 0) type = 'classic';
  if (dom) type = BIOMES[dom].key;
  g.type = type; g.mix = mix; g.bays = bays;
  const nh = H(sx, sz, 0x9a3e);
  let name = NAMES[type][nh % NAMES[type].length];
  if (type === 'classic' || type === 'dense') {
    if (blkN[2] >= 6) name = 'The same room'; else if (blkN[1] >= 8) name = 'The loop';
    else if (blkN[4] >= 5) name = 'Room within a room'; else if (blkN[3] >= 5) name = 'The atrium';
    else if (blkN[5] >= 5) name = 'Zig-zag field'; else if (blkN[6] >= 5) name = 'Great room';
    else if (blkN[7] >= 8) name = 'Bright stretch'; else if (avN >= 5) name = 'Long corridor';
  }
  if (d === 0) name = 'Office floor';
  g.name = name;
  g.decor = makeDecor(g);
  const busy = new Set();
  for (const o of g.decor) if (o.k === 'crate' || o.k === 'cooler' || o.k === 'ladder' || o.k === 'hdoor') busy.add(I(Math.floor(o.x), Math.floor(o.z)));
  populate(g, rng, d, (mix.dark || 0) + (mix.tunnels || 0) > 24, share, busy);
  // danger: none near the entry, rising to about full by 12 sectors out, coloured by the place
  const dC = calm(sx + 0.5, sz + 0.5), far = clamp((dC - 3) / 9, 0, 1);
  let pd = 0;
  for (let k = 0; k < cnt.length; k++) if (share[k]) pd += share[k] * (k === 0 ? 0.8 + 0.2 * clamp(rough / 40, 0, 1) : k === BIOME.L37 ? BIOMES[k].danger + 0.05 : Math.min(1, BIOMES[k].danger + 0.15));
  if (!open) pd = 0.8;
  g.danger = +(far * pd).toFixed(3);
  return g;
}

// For tools/worldgen-test.mjs: the place field and Level ! specs, read only.
export const __wg = { placeAt, regionOf, runSpec, runCls, CORE, RC, RR };
