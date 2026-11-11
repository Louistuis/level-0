// World generation checks for LEVEL 0. Plain Node, no dependencies.
//   node tools/worldgen-test.mjs [path/to/worldgen.js] [out-prefix]
// Generates a 25x25 sector block in random order and checks: edge agreement between
// neighbours, connectivity across edges with the game's step rules, drops you cannot climb
// out of, spawn, items/exit/artifact placement, determinism, timing, style mix and how
// visible the sector grid is. Writes a top-down picture of a 12x12 block (<prefix>-12x12.ppm,
// plus .png when sips is available), coloured by place.
// 0.3.0 adds: exits (exactly where sectorHasExit says), decor validity, water depth, Level !
// corridors in the block (sealed, exit reachable from the entrance, entrance reachable from the
// level), and a survey of the place field (SURVEY=0 skips it): area shares at radius 12, 30, 60
// sectors, regions per level, nearest of each to the entry, exits, Level ! corridors, an overview
// picture (<prefix>-overview.png), a close-up per level and one of the nearest Level ! corridor.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const genPath = resolve(process.argv[2] || new URL('../dist/js/worldgen.js', import.meta.url).pathname);
const outPrefix = process.argv[3] || '/tmp/worldgen';
const util = await import(pathToFileURL(resolve(genPath, '../util.js')).href);
const { genSector, edgePortals, sectorHasExit, __wg } = await import(pathToFileURL(genPath).href);
const { BIOME, BIOMES, WATER_Y, WATER_MAX_DEPTH, DECOR } = await import(pathToFileURL(resolve(genPath, '../biomes.js')).href);
const { hash3, WORLD_SEED, SEC: N, CEIL } = util;
const seedFor = (sx, sz) => hash3(sx, sz, WORLD_SEED ^ 0x1234);

const R = 12, W = 2 * R + 1;           // sectors -R..R
const keys = [];
// CENTER=sx,sz moves the block (the spawn checks only apply to the default block)
const [CX, CZ] = (process.env.CENTER || '0,0').split(',').map(Number);
for (let sz = -R; sz <= R; sz++) for (let sx = -R; sx <= R; sx++) keys.push([sx + CX, sz + CZ]);
let rs = 12345; const rnd = () => ((rs = (rs * 1103515245 + 12345) >>> 0) / 4294967296);
for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }

const S = new Map(), K = (sx, sz) => sx + ',' + sz;
const t0 = performance.now(); let coldWorst = 0; const cold = [];
for (const [sx, sz] of keys) { const a = performance.now(); S.set(K(sx, sz), genSector(sx, sz, seedFor(sx, sz))); const d = performance.now() - a; cold.push(d); coldWorst = Math.max(coldWorst, d); }
cold.sort((a, b) => a - b);
const ms = (performance.now() - t0) / keys.length;
// worst case: time each one again, individually
let worst = 0; const tt = [];
for (const [sx, sz] of keys.slice(0, 400)) { const a = performance.now(); genSector(sx, sz, seedFor(sx, sz)); const d = performance.now() - a; tt.push(d); worst = Math.max(worst, d); }
tt.sort((a, b) => a - b);

// determinism: regenerate in another order and compare
let nondet = 0;
for (const [sx, sz] of keys.slice().reverse().slice(0, 120)) {
  const a = S.get(K(sx, sz)), b = genSector(sx, sz, seedFor(sx, sz));
  for (let i = 0; i < N * N; i++) if (a.solid[i] !== b.solid[i] || a.floor[i] !== b.floor[i] || a.ceil[i] !== b.ceil[i] || a.lamp[i] !== b.lamp[i]) { nondet++; break; }
}

// global grid
const GW = W * N, G = (gx, gz) => (gx - (CX - R) * N) + (gz - (CZ - R) * N) * GW;
const sol = new Uint8Array(GW * GW), fl = new Float32Array(GW * GW), ce = new Float32Array(GW * GW), lp = new Uint8Array(GW * GW), lrch = new Uint8Array(GW * GW);
for (const [k, g] of S) {
  const [sx, sz] = k.split(',').map(Number);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const i = x + z * N, o = G(sx * N + x, sz * N + z);
    sol[o] = g.solid[i]; fl[o] = g.floor[i]; ce[o] = g.ceil[i]; lp[o] = g.lamp[i]; lrch[o] = g.reach ? g.reach[i] : 0;
  }
}
const inG = (gx, gz) => gx >= (CX - R) * N && gz >= (CZ - R) * N && gx < (CX + R + 1) * N && gz < (CZ + R + 1) * N;
const both = (a, b) => !sol[a] && !sol[b] && Math.min(ce[a], ce[b]) - Math.max(fl[a], fl[b]) >= 1.0;
const sym = (a, b) => both(a, b) && Math.abs(fl[a] - fl[b]) <= 0.36;

// edge agreement: what each sector believed its neighbour's border cells to be vs what the neighbour built
let rimChecked = 0, rimBad = 0, crossOpen = 0, crossCliff = 0, edgesNoOpening = 0;
for (const [k, g] of S) {
  const [sx, sz] = k.split(',').map(Number);
  if (g.rim) {
    const sides = { w: [-1, 0, 0, 1], e: [N, 0, 0, 1], n: [0, -1, 1, 0], s: [0, N, 1, 0] };
    for (const side in sides) {
      const [x0, z0, dx, dz] = sides[side], arr = g.rim[side];
      for (let t = 0; t < N; t++) {
        const gx = sx * N + x0 + dx * t, gz = sz * N + z0 + dz * t;
        if (!inG(gx, gz)) continue;
        const o = G(gx, gz); rimChecked++;
        const s0 = arr[t * 3], f0 = arr[t * 3 + 1], c0 = arr[t * 3 + 2];
        if (s0 !== sol[o] || (!s0 && (Math.abs(f0 - fl[o]) > 1e-6 || Math.abs(c0 - ce[o]) > 1e-6))) rimBad++;
      }
    }
  }
  // openings across the east and south edges
  for (const [dx, dz] of [[1, 0], [0, 1]]) {
    if (!S.has(K(sx + dx, sz + dz))) continue;
    let open = 0;
    for (let t = 0; t < N; t++) {
      const ax = dx ? sx * N + N - 1 : sx * N + t, az = dz ? sz * N + N - 1 : sz * N + t;
      const a = G(ax, az), b = G(ax + dx, az + dz);
      if (sym(a, b)) { open++; crossOpen++; } else if (both(a, b)) crossCliff++;
    }
    if (!open) edgesNoOpening++;
  }
}

// global flood from the spawn with the symmetric step rule
const reach = new Uint8Array(GW * GW);
// flood from the spawn, or for another block from the first portal of its centre sector
const sp = CX || CZ ? G(CX * N + 1, CZ * N + edgePortals(CX, CZ, true)[0] * 6 + 3) : G(24, 24); const st = [sp]; reach[sp] = 1;
const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
while (st.length) {
  const c = st.pop(), cx = (c % GW) + (CX - R) * N, cz = Math.floor(c / GW) + (CZ - R) * N;
  for (const [dx, dz] of D4) {
    const nx = cx + dx, nz = cz + dz; if (!inG(nx, nz)) continue;
    const n = G(nx, nz); if (!reach[n] && sym(c, n)) { reach[n] = 1; st.push(n); }
  }
}
// traps: you can drop from a reachable cell into a cell you cannot walk out of
let traps = 0, trapEdge = 0;
const interior = (gx, gz) => gx >= (CX - R + 1) * N && gz >= (CZ - R + 1) * N && gx < (CX + R) * N && gz < (CZ + R) * N;
for (let gz = (CZ - R) * N; gz < (CZ + R + 1) * N; gz++) for (let gx = (CX - R) * N; gx < (CX + R + 1) * N; gx++) {
  const c = G(gx, gz); if (!reach[c]) continue;
  for (const [dx, dz] of D4) {
    const nx = gx + dx, nz = gz + dz; if (!inG(nx, nz)) continue;
    const n = G(nx, nz);
    if (reach[n] || sol[n]) continue;
    const drop = fl[c] - fl[n];
    if (drop > 0.36 && drop <= 3.2 && Math.min(ce[c], ce[n]) - Math.max(fl[c], fl[n]) >= 1.0) {
      if (interior(nx, nz)) { traps++; if (process.env.TRAPS && traps <= +process.env.TRAPS) dumpTrap(gx, gz, nx, nz); } else trapEdge++;
    }
  }
}
function dumpTrap(gx, gz, nx, nz) {
  const sx = Math.floor(nx / N), sz = Math.floor(nz / N);
  console.log(`trap from ${gx},${gz} into ${nx},${nz} (sector ${sx},${sz} local ${nx - sx * N},${nz - sz * N}) floor ${fl[G(gx, gz)].toFixed(2)} -> ${fl[G(nx, nz)].toFixed(2)}`);
  for (let z = nz - 6; z <= nz + 6; z++) {
    let r = '';
    for (let x = nx - 12; x <= nx + 12; x++) {
      if (!inG(x, z)) { r += '   '; continue; }
      const o = G(x, z);
      r += (x === nx && z === nz ? '*' : reach[o] ? ' ' : '.') + (sol[o] ? '##' : ce[o] - fl[o] < 1 ? '__' : (fl[o] >= 0 ? '+' : '-') + Math.round(Math.abs(fl[o]) / 0.3).toString(36));
    }
    console.log(r);
  }
}
// per sector: reached at all, and placed things in reachable cells
let unreachedSectors = 0, badItems = 0, badExit = 0, badArt = 0, items = 0, exits = 0, arts = 0, localReachOpen = 0, globalReachOpen = 0, walk = 0;
const typeCount = {}, nameCount = {};
for (const [k, g] of S) {
  const [sx, sz] = k.split(',').map(Number);
  typeCount[g.type] = (typeCount[g.type] || 0) + 1; nameCount[g.name] = (nameCount[g.name] || 0) + 1;
  let any = false;
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const o = G(sx * N + x, sz * N + z);
    if (reach[o]) any = true;
    if (!sol[o] && ce[o] - fl[o] >= 1.0) { walk++; if (reach[o]) globalReachOpen++; if (lrch[o]) localReachOpen++; }
  }
  if (!any) unreachedSectors++;
  // inside a Level ! corridor whose vestibule lies outside the block nothing is reachable: skip those
  const cut = (p) => { const r = g.run && g.run.spec; if (!r) return false; const b = r.box; if (inG(b.x0 - 2, b.z0 - 2) && inG(b.x1 + 2, b.z1 + 2)) return false; const k = __wg.runCls(r, sx * N + p.x, sz * N + p.z); return k === 1 || k === 5; };
  const chk = (p) => { const o = G(sx * N + p.x, sz * N + p.z); return cut(p) || (!sol[o] && reach[o]); };
  for (const it of g.items) { items++; if (!chk(it)) { badItems++; if (process.env.BADS) console.log('bad item', sx, sz, it.x, it.z); } }
  if (g.exit) { exits++; if (!chk(g.exit) || g.exit.dir < 0) { badExit++; if (process.env.BADS) console.log('bad exit', sx, sz, JSON.stringify(g.exit)); } }
  if (g.artifact) { arts++; if (!chk(g.artifact)) badArt++; }
}
// spawn
const spawnOK = (() => {
  const g = S.get('0,0'); if (!g) return false;
  for (let z = 22; z <= 26; z++) for (let x = 22; x <= 26; x++) { const i = x + z * N; if (g.solid[i] || g.floor[i] !== 0 || g.ceil[i] < 2.1) return false; }
  return !!reach[G(24, 24)];
})();

// style mix by area (bays). New generator exposes g.mix, the old one is one type per sector.
const mix = {};
for (const g of S.values()) {
  if (g.mix) for (const k in g.mix) mix[k] = (mix[k] || 0) + g.mix[k];
  else mix[g.type] = (mix[g.type] || 0) + 64;
}
const mixTot = Object.values(mix).reduce((a, b) => a + b, 0);
const mixPct = Object.fromEntries(Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, (100 * v / mixTot).toFixed(1) + '%']));

// how visible are the sector lines? compare cell statistics on sector lines with the same
// lattice phase elsewhere (solid fraction of lattice-line cells, of the cells next to them,
// of the floor-level changes, and of lamps)
const seam = (() => {
  const acc = { on: [0, 0], off: [0, 0], nOn: [0, 0], nOff: [0, 0], hOn: [0, 0], hOff: [0, 0], lOn: [0, 0], lOff: [0, 0] };
  const add = (a, v) => { a[0] += v; a[1]++; };
  for (let gz = (CZ - R) * N; gz < (CZ + R + 1) * N; gz++) for (let gx = (CX - R) * N + 1; gx < (CX + R + 1) * N; gx++) {
    const m = ((gx % N) + N) % N, o = G(gx, gz), w = G(gx - 1, gz);
    if (m % 6 === 0) add(m === 0 ? acc.on : acc.off, sol[o]);
    if (m % 6 === 5) add(m === N - 1 ? acc.nOn : acc.nOff, sol[o]);
    if (m % 6 === 0) add(m === 0 ? acc.hOn : acc.hOff, !sol[o] && !sol[w] && fl[o] !== fl[w] ? 1 : 0);
    if (m % 6 === 3) add(m === 3 ? acc.lOn : acc.lOff, lp[o] && lp[o] < 8 ? (lp[o] <= 3 ? 1 : 0) : 0);
  }
  const r = (a) => +(a[0] / a[1]).toFixed(3);
  return { wallLineSolid: [r(acc.on), r(acc.off)], nextToLineSolid: [r(acc.nOn), r(acc.nOff)], floorChangeAcross: [r(acc.hOn), r(acc.hOff)], litLamps: [r(acc.lOn), r(acc.lOff)] };
})();
// bay-style changes across sector lines vs inside sectors (needs g.bays)
const styleSeam = (() => {
  let on = [0, 0], off = [0, 0];
  const bl = (sx, sz, i, j) => { const g = S.get(K(sx, sz)); return g && g.bays ? g.bays[i + j * 8] : g ? g.type : null; };
  for (const [k] of S) {
    const [sx, sz] = k.split(',').map(Number);
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const a = bl(sx, sz, i, j);
      const b = i < 7 ? bl(sx, sz, i + 1, j) : bl(sx + 1, sz, 0, j); if (b === null) continue;
      const t = i < 7 ? off : on; t[0] += a !== b ? 1 : 0; t[1]++;
    }
  }
  return [+(on[0] / on[1]).toFixed(3), +(off[0] / off[1]).toFixed(3)];
})();


// ---------------------------------------------------------------- 0.3.0 checks on the block
const bioG = new Uint8Array(GW * GW);
for (const [k, g] of S) {
  const [sx, sz] = k.split(',').map(Number);
  if (g.bio) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) bioG[G(sx * N + x, sz * N + z)] = g.bio[x + z * N];
}
const D4k = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const WALLED = new Set(['hdoor', 'sconce', 'valve', 'sign', 'strobe', 'crate', 'cooler', 'pipe']);
let exitMismatch = 0, decorN = 0, decorBad = 0, decorMax = 0, decorUnknown = 0, water = 0, waterTooDeep = 0, waterUnreached = 0, waterMaxDepth = 0, dangerNear = 0, noBio = 0;
const decorKinds = {}, blockShare = [0, 0, 0, 0, 0, 0];
for (const [k, g] of S) {
  const [sx, sz] = k.split(',').map(Number);
  if (!!g.exit !== sectorHasExit(sx, sz)) exitMismatch++;
  if (!g.bio || !Array.isArray(g.decor)) noBio++;
  if (Math.hypot(sx - CX, sz - CZ) < 0 || (!CX && !CZ && Math.hypot(sx, sz) <= 3 && g.danger > 0.001)) dangerNear++;
  decorMax = Math.max(decorMax, g.decor.length);
  for (const o of g.decor) {
    decorN++; decorKinds[o.k] = (decorKinds[o.k] || 0) + 1;
    if (!DECOR.includes(o.k)) decorUnknown++;
    const x = Math.floor(o.x), z = Math.floor(o.z);
    let bad = x < 0 || z < 0 || x >= N || z >= N || g.solid[x + z * N] || !(o.dir >= 0 && o.dir < 4) || Math.abs(o.y - g.floor[x + z * N]) > 1e-6;
    if (!bad && WALLED.has(o.k)) { const nx = x + D4k[o.dir][0], nz = z + D4k[o.dir][1]; bad = !(nx >= 0 && nz >= 0 && nx < N && nz < N && g.solid[nx + nz * N]); }
    if (!bad && o.k === 'ladder') { const nx = x + D4k[o.dir][0], nz = z + D4k[o.dir][1]; bad = !(nx >= 0 && nz >= 0 && nx < N && nz < N && !g.solid[nx + nz * N] && g.floor[nx + nz * N] < g.floor[x + z * N] - 0.4); }
    if (bad) decorBad++;
  }
  for (let i = 0; i < N * N; i++) {
    blockShare[g.bio[i]]++;
    if (g.solid[i] || g.bio[i] !== BIOME.L37 || !(g.floor[i] < WATER_Y - 0.02)) continue;
    water++; const dep = WATER_Y - g.floor[i]; waterMaxDepth = Math.max(waterMaxDepth, dep);
    if (dep > WATER_MAX_DEPTH + 1e-4) waterTooDeep++;
    if (!reach[G(sx * N + (i % N), sz * N + ((i / N) | 0))]) waterUnreached++;
  }
}
// Level ! corridors inside the block
const runsSeen = new Map();
for (const g of S.values()) if (g.run) { const r = g.run.spec || g.run; runsSeen.set([g.run.x0, g.run.z0, g.run.x1, g.run.z1].join(','), r); }
const runReport = [];
for (const [key, r] of runsSeen) {
  const b = r.box, inside = inG(b.x0 - 2, b.z0 - 2) && inG(b.x1 + 2, b.z1 + 2);
  const rep = { key, dir: r.dir, length: r.L, entrance: [r.x0, r.z0], exit: [r.x1, r.z1], inBlock: inside };
  if (inside) {
    // sealed: every wall cell of the corridor and the end room is solid
    let walls = 0, holes = 0, inner = 0, innerOpen = 0;
    for (let gz = b.z0; gz <= b.z1; gz++) for (let gx = b.x0; gx <= b.x1; gx++) {
      const c = __wg.runCls(r, gx, gz), o = G(gx, gz);
      if (c === 2 || c === 6) { walls++; if (!sol[o]) holes++; }
      if (c === 1 || c === 5) { inner++; if (!sol[o]) innerOpen++; }
    }
    // walk from the entrance (no carving, game step rule) and see whether the exit is reached
    const fromEnt = new Uint8Array(GW * GW), st2 = [G(r.x0, r.z0)]; fromEnt[st2[0]] = 1;
    while (st2.length) { const c = st2.pop(), cx = (c % GW) + (CX - R) * N, cz = Math.floor(c / GW) + (CZ - R) * N; for (const [dx, dz] of D4k) { const nx = cx + dx, nz = cz + dz; if (!inG(nx, nz)) continue; const n = G(nx, nz); if (!fromEnt[n] && sym(c, n)) { fromEnt[n] = 1; st2.push(n); } } }
    // the corridor can only be entered through the vestibule: flood the level with the vestibule shut
    const shut = new Uint8Array(GW * GW), st3 = [];
    const isRun = (gx, gz) => __wg.runCls(r, gx, gz) !== 0;
    // start from a reached cell well outside the piece
    for (let gz = (CZ - R) * N; gz < (CZ + R + 1) * N && !st3.length; gz += 7) for (let gx = (CX - R) * N; gx < (CX + R + 1) * N; gx += 7) { const o = G(gx, gz); if (reach[o] && !isRun(gx, gz)) { st3.push(o); shut[o] = 1; break; } }
    while (st3.length) { const c = st3.pop(), cx = (c % GW) + (CX - R) * N, cz = Math.floor(c / GW) + (CZ - R) * N; for (const [dx, dz] of D4k) { const nx = cx + dx, nz = cz + dz; if (!inG(nx, nz)) continue; const n = G(nx, nz); if (shut[n] || !sym(c, n)) continue; const k2 = __wg.runCls(r, nx, nz); if (k2 === 3) continue; shut[n] = 1; st3.push(n); } }
    let leaks = 0;
    for (let gz = b.z0; gz <= b.z1; gz++) for (let gx = b.x0; gx <= b.x1; gx++) { const k2 = __wg.runCls(r, gx, gz); if ((k2 === 1 || k2 === 5) && shut[G(gx, gz)]) leaks++; }
    let ex = null; for (const [k3, g] of S) { const [ssx, ssz] = k3.split(',').map(Number); if (g.exit && ssx * N + g.exit.x === r.x1 && ssz * N + g.exit.z === r.z1) ex = g.exit; }
    Object.assign(rep, { wallCells: walls, wallHoles: holes, innerCells: inner, innerOpen, sealedLeaks: leaks, exitPlaced: !!ex, exitReachableFromEntrance: !!fromEnt[G(r.x1, r.z1)], entranceReachedFromLevel: !!reach[G(r.x0, r.z0)], exitReachedFromLevel: !!reach[G(r.x1, r.z1)] });
  }
  runReport.push(rep);
}
const extra = {
  exits: { mismatchWithSectorHasExit: exitMismatch },
  decor: { total: decorN, bad: decorBad, unknownKinds: decorUnknown, maxPerSector: decorMax, kinds: decorKinds },
  water: { cells: water, tooDeep: waterTooDeep, unreached: waterUnreached, maxDepth: +waterMaxDepth.toFixed(3) },
  sectorsWithoutBioOrDecor: noBio,
  dangerWithin3OfEntry: dangerNear,
  placeShareInBlock: Object.fromEntries(BIOMES.map((b, k) => [b.key, +(100 * blockShare[k] / (S.size * N * N)).toFixed(2) + '%'])),
  levelRun: runReport,
};

console.log(JSON.stringify({
  generator: genPath,
  sectors: keys.length,
  msPerSector: +ms.toFixed(3), medianMs: +tt[tt.length >> 1].toFixed(3), p95Ms: +tt[Math.floor(tt.length * 0.95)].toFixed(3), p99Ms: +tt[Math.floor(tt.length * 0.99)].toFixed(3), worstMs: +worst.toFixed(3), coldP95Ms: +cold[Math.floor(cold.length * 0.95)].toFixed(3), coldWorstMs: +coldWorst.toFixed(3),
  nondeterministic: nondet,
  edge: { rimCellsChecked: rimChecked, rimMismatches: rimBad, openCrossings: crossOpen, cliffCrossings: crossCliff, edgesWithoutOpening: edgesNoOpening },
  connectivity: { unreachedSectors, walkableCells: walk, globallyReached: +(globalReachOpen / walk).toFixed(4), locallyReached: +(localReachOpen / walk).toFixed(4), trapsInterior: traps, trapsAtBlockEdge: trapEdge },
  spawnOK: CX || CZ ? 'n/a (block not at origin)' : spawnOK,
  placed: { items, badItems, exits, badExit, artifacts: arts, badArt },
  styleMixByArea: mixPct,
  types: typeCount,
  names: Object.keys(nameCount).length,
  seam: { ...seam, bayStyleChange: styleSeam, note: '[on sector lines, elsewhere at same lattice phase]' },
  ...extra,
}, null, 1));

// picture of a 12x12 block, sectors -6..5, 2 px per cell
const B0 = -6, BN = 12, BX = CX + B0, BZ = CZ + B0, PX = 2, IW = BN * N * PX;
// rough light: open cells within 5 cells of a working lamp
const lit = new Uint8Array(GW * GW);
for (let gz = (BZ - 1) * N; gz < (BZ + BN + 1) * N; gz++) for (let gx = (BX - 1) * N; gx < (BX + BN + 1) * N; gx++) {
  if (!inG(gx, gz)) continue;
  const l = lp[G(gx, gz)]; if (!l || l >= 4) continue;
  for (let dz = -5; dz <= 6; dz++) for (let dx = -5; dx <= 5; dx++) if (inG(gx + dx, gz + dz) && dx * dx + (dz - 0.5) * (dz - 0.5) < 30) lit[G(gx + dx, gz + dz)] = 1;
}
// place colours: Level 0 keeps its yellow, then 1 grey, 2 rust, 5 wine, 37 aqua, ! red
const TINT = [null, [168, 172, 170], [196, 112, 60], [160, 62, 78], [110, 200, 214], [250, 30, 30]];
const img = Buffer.alloc(IW * IW * 3);
const put = (x, y, c) => { const o = (x + y * IW) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
for (let cz = 0; cz < BN * N; cz++) for (let cx = 0; cx < BN * N; cx++) {
  const gx = BX * N + cx, gz = BZ * N + cz, o = G(gx, gz);
  let c;
  const bi = bioG[o];
  if (sol[o]) c = bi ? TINT[bi].map((v) => v * 0.3) : [52, 46, 36];
  else {
    const f = fl[o], h = ce[o] - f;
    if (f < -0.05) { const t = Math.min(1, -f / 2.7); c = [190 - 120 * t, 200 - 90 * t, 215 - 30 * t]; }
    else if (f > 0.05) { const t = Math.min(1, f / 2.7); c = [235, 190 - 70 * t, 120 - 60 * t]; }
    else c = [226, 214, 160];
    if (h < 1.0) c = [120, 110, 90];
    else if (h < 2.0) c = c.map((v) => v * 0.8);
    else if (ce[o] > 4.5) c = [c[0] * 0.86, c[1] * 0.9, c[2] * 1.0];
    if (!lit[o]) c = c.map((v) => v * 0.62);
    if (bi) { const t = TINT[bi], k = fl[o] < WATER_Y - 0.02 && bi === BIOME.L37 ? 0.55 : 1; c = [t[0] * k * (lit[o] ? 1 : 0.7), t[1] * k * (lit[o] ? 1 : 0.7), t[2] * (lit[o] ? 1 : 0.7)]; if (fl[o] > 0.05) c = c.map((v) => v * 1.12); }
    if (!reach[o]) c = [c[0] * 0.75 + 50, c[1] * 0.55, c[2] * 0.55];
  }
  const l = lp[o];
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
    let cc = c;
    if (l && !sol[o]) cc = (l & 7) <= 3 ? [255, 255, 255] : [150, 140, 120];
    put(cx * PX + x, cz * PX + y, cc.map((v) => Math.max(0, Math.min(255, v | 0))));
  }
}
const ppm = outPrefix + '-12x12.ppm';
writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${IW} ${IW}\n255\n`), img]));
try { execFileSync('sips', ['-s', 'format', 'png', ppm, '--out', outPrefix + '-12x12.png'], { stdio: 'ignore' }); console.log('picture', outPrefix + '-12x12.png'); } catch { console.log('picture', ppm); }

// ---------------------------------------------------------------- survey of the place field
if (process.env.SURVEY !== '0') await survey();

async function survey() {
  const T0 = performance.now();
  const cache = new Map();
  const getS = (sx, sz) => { const k = K(sx, sz); let g = cache.get(k) || S.get(k); if (!g) { g = genSector(sx, sz, seedFor(sx, sz)); cache.set(k, g); } return g; };
  const BAYS = N / 6, RCb = __wg.RC, RRs = __wg.RR;
  // 1. regions within 60 sectors of the entry
  const regs = [], c0 = Math.floor(-61 * BAYS / RCb) - 1, c1 = Math.floor(61 * BAYS / RCb) + 1;
  for (let cz = c0; cz <= c1; cz++) for (let cx = c0; cx <= c1; cx++) {
    const r = __wg.regionOf(cx, cz); if (!r) continue;
    const lim = Math.ceil(r.rb * 1.75 + 3);
    let area = 0, core = 0, near = 1e9;
    for (let bz = Math.floor(r.cz) - lim; bz <= Math.floor(r.cz) + lim; bz++) for (let bx = Math.floor(r.cx) - lim; bx <= Math.floor(r.cx) + lim; bx++) {
      const p = __wg.placeAt(bx, bz); if (p.r !== r || p.e < 0) continue;
      area++; if (p.e >= __wg.CORE) core++;
      near = Math.min(near, Math.hypot((bx + 0.5) / BAYS - 0.5, (bz + 0.5) / BAYS - 0.5));
    }
    if (!area) continue;
    if (near > 60) continue;
    regs.push({ id: r.id, key: BIOMES[r.id].key, area, core, near, sx: Math.floor(r.cx / BAYS), sz: Math.floor(r.cz / BAYS), diam: 2 * Math.sqrt(area / Math.PI) / BAYS });
  }
  const byLevel = {};
  for (const b of BIOMES.slice(1, 5)) {
    const L = regs.filter((r) => r.id === b.id).sort((a, c) => a.near - c.near);
    byLevel[b.key] = L.length ? { regions: L.length, meanDiameterSectors: +(L.reduce((a, r) => a + r.diam, 0) / L.length).toFixed(2), minDiam: +Math.min(...L.map((r) => r.diam)).toFixed(2), maxDiam: +Math.max(...L.map((r) => r.diam)).toFixed(2), coreShareOfRegion: +(L.reduce((a, r) => a + r.core, 0) / L.reduce((a, r) => a + r.area, 0)).toFixed(2), nearestSectors: +L[0].near.toFixed(1), nearestCentre: [L[0].sx, L[0].sz] } : { regions: 0 };
  }
  const regDensity = +(regs.filter((r) => r.near <= 60).length / (Math.PI * 60 * 60) * 49).toFixed(2);
  // 2. area shares: exact from generated sectors out to 30, bay sampling out to 60
  const shareR = (rad) => { const c = [0, 0, 0, 0, 0, 0]; let n = 0; for (let sz = -rad; sz <= rad; sz++) for (let sx = -rad; sx <= rad; sx++) { if (Math.hypot(sx, sz) > rad) continue; const g = getS(sx, sz); for (let i = 0; i < N * N; i++) c[g.bio[i]]++; n += N * N; } return Object.fromEntries(BIOMES.map((b, k) => [b.key, +(100 * c[k] / n).toFixed(2)])); };
  const share12 = shareR(12), share30 = shareR(30);
  const tGen = performance.now() - T0;
  const share60 = (() => {
    const c = [0, 0, 0, 0, 0, 0]; let n = 0;
    for (let bz = -60 * BAYS; bz <= 60 * BAYS; bz += 2) for (let bx = -60 * BAYS; bx <= 60 * BAYS; bx += 2) {
      if (Math.hypot(bx / BAYS, bz / BAYS) > 60) continue;
      n++;
      const run = __wg.runSpec(Math.floor(bx * 6 / (RRs * N)), Math.floor(bz * 6 / (RRs * N)));
      let k = 0;
      if (run) { let m = 0; for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) if (__wg.runCls(run, bx * 6 + x, bz * 6 + z)) m++; if (m) { c[5] += m / 36; c[0] += 0; } if (m >= 18) k = -1; }
      if (k < 0) { c[0] += 0; continue; }
      const p = __wg.placeAt(bx, bz); c[p.id && p.e >= 0.75 ? p.id : 0]++;
    }
    const tot = c.reduce((a, b) => a + b, 0);
    return Object.fromEntries(BIOMES.map((b, k) => [b.key, +(100 * c[k] / tot).toFixed(2)]));
  })();
  // 3. exits
  let ex30 = 0, ex60 = 0, exNear = 1e9, exNearAt = null, exactBad = 0;
  for (let sz = -60; sz <= 60; sz++) for (let sx = -60; sx <= 60; sx++) {
    const d = Math.hypot(sx, sz); if (d > 60 || !sectorHasExit(sx, sz)) continue;
    ex60++; if (d <= 30) ex30++; if (d < exNear) { exNear = d; exNearAt = [sx, sz]; }
  }
  for (const [k, g] of cache) { const [sx, sz] = k.split(',').map(Number); if (!!g.exit !== sectorHasExit(sx, sz)) exactBad++; }
  // 4. Level ! corridors
  const runs = [], rr0 = Math.floor(-61 / RRs) - 1, rr1 = Math.floor(61 / RRs) + 1;
  for (let cz = rr0; cz <= rr1; cz++) for (let cx = rr0; cx <= rr1; cx++) {
    const r = __wg.runSpec(cx, cz); if (!r) continue;
    const b = r.box, d = Math.hypot(Math.max(b.x0 - 24, 0, 24 - b.x1), Math.max(b.z0 - 24, 0, 24 - b.z1)) / N;
    if (d > 60) continue;
    runs.push({ near: +d.toFixed(1), length: r.L, dir: r.dir, entrance: [r.x0, r.z0], exit: [r.x1, r.z1], centreSector: [Math.floor((b.x0 + b.x1) / 2 / N), Math.floor((b.z0 + b.z1) / 2 / N)], r });
  }
  runs.sort((a, b) => a.near - b.near);
  console.log(JSON.stringify({
    survey: {
      seconds: +((performance.now() - T0) / 1000).toFixed(1), genSeconds: +(tGen / 1000).toFixed(1), sectorsGenerated: cache.size,
      placeSharePercent: { r12: share12, r30: share30, r60_baySampled: share60 },
      regionsPer49Sectors: regDensity, regionsWithin60: regs.length, perLevel: byLevel,
      exits: { within30: ex30, within60: ex60, nearestSectors: +exNear.toFixed(1), nearestAt: exNearAt, exactMismatchInSurvey: exactBad },
      levelRun: { within60: runs.length, list: runs.slice(0, 6).map(({ r, ...o }) => o) },
    },
  }, null, 1));
  // 5. pictures
  const colourAt = (g, i) => {
    const b = g.bio[i];
    if (g.solid[i]) return b ? TINT[b].map((v) => v * 0.3) : [52, 46, 36];
    const f = g.floor[i];
    let c = b ? TINT[b].slice() : f < -0.05 ? [150, 160, 190] : f > 0.05 ? [235, 170, 100] : [226, 214, 160];
    if (b === BIOME.L37 && f < WATER_Y - 0.02) c = f < -0.5 ? [40, 110, 170] : [70, 150, 190];
    else if (b && f > 0.05) c = c.map((v) => v * 1.15);
    else if (b && f < -0.05) c = c.map((v) => v * 0.75);
    return c;
  };
  const writePic = (file, w, h, px) => { const p = file + '.ppm'; writeFileSync(p, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), px])); try { execFileSync('sips', ['-s', 'format', 'png', p, '--out', file + '.png'], { stdio: 'ignore' }); return file + '.png'; } catch { return p; } };
  const pics = {};
  // overview: radius 30, one pixel per 4x4 cells, grid every 5 sectors, entry and exits marked
  {
    const R2 = 30, ns = 2 * R2 + 1, PXS = N / 4, w = ns * PXS, px = Buffer.alloc(w * w * 3);
    for (let sz = -R2; sz <= R2; sz++) for (let sx = -R2; sx <= R2; sx++) {
      const g = getS(sx, sz);
      for (let j = 0; j < PXS; j++) for (let i = 0; i < PXS; i++) {
        let a = [0, 0, 0];
        for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) { const c = colourAt(g, (i * 4 + x) + (j * 4 + z) * N); a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; }
        const X = (sx + R2) * PXS + i, Z = (sz + R2) * PXS + j, o = (X + Z * w) * 3;
        let c = a.map((v) => v / 16);
        if ((md5(sx) === 0 && i === 0) || (md5(sz) === 0 && j === 0)) c = c.map((v) => v * 0.8);
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
      }
      if (g.exit) mark(px, w, (sx + R2) * PXS + (g.exit.x >> 2), (sz + R2) * PXS + (g.exit.z >> 2), [40, 255, 90], 3);
    }
    mark(px, w, R2 * PXS + 6, R2 * PXS + 6, [0, 0, 0], 4); mark(px, w, R2 * PXS + 6, R2 * PXS + 6, [255, 255, 255], 2);
    pics.overview = writePic(outPrefix + '-overview', w, w, px);
  }
  // close-ups: 4x4 sectors around the nearest region of each level, 3 px per cell
  const area = (file, sx0, sz0, nx, nz, P) => {
    const w = nx * N * P, h = nz * N * P, px = Buffer.alloc(w * h * 3);
    for (let sz = sz0; sz < sz0 + nz; sz++) for (let sx = sx0; sx < sx0 + nx; sx++) {
      const g = getS(sx, sz);
      for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
        const i = x + z * N; let c = colourAt(g, i);
        const l = g.lamp[i]; if (l && !g.solid[i] && (l & 7) <= 3) c = [255, 255, 240];
        for (let y = 0; y < P; y++) for (let q = 0; q < P; q++) { const o = (((sx - sx0) * N + x) * P + q + (((sz - sz0) * N + z) * P + y) * w) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; }
      }
      for (const d of g.decor) mark(px, w, ((sx - sx0) * N + d.x) * P + 1, ((sz - sz0) * N + d.z) * P + 1, d.k === 'hdoor' ? [250, 220, 120] : d.k === 'strobe' ? [255, 255, 0] : d.k === 'ladder' ? [255, 255, 255] : [20, 20, 20], 1);
      if (g.exit) mark(px, w, ((sx - sx0) * N + g.exit.x) * P + 1, ((sz - sz0) * N + g.exit.z) * P + 1, [40, 255, 90], 4);
    }
    return writePic(file, w, h, px);
  };
  for (const key of ['level1', 'level2', 'level5', 'level37']) {
    const L = byLevel[key]; if (!L.regions) continue;
    pics[key] = area(outPrefix + '-' + key, L.nearestCentre[0] - 2, L.nearestCentre[1] - 2, 4, 4, 3);
  }
  if (runs.length) {
    const b = runs[0].r.box, sx0 = Math.floor((b.x0 - 30) / N), sx1 = Math.floor((b.x1 + 30) / N), sz0 = Math.floor((b.z0 - 30) / N), sz1 = Math.floor((b.z1 + 30) / N);
    pics.levelrun = area(outPrefix + '-levelrun', sx0, sz0, sx1 - sx0 + 1, sz1 - sz0 + 1, 2);
  }
  console.log(JSON.stringify({ pictures: pics }, null, 1));
}
function md5(v) { return ((v % 5) + 5) % 5; }
function mark(px, w, x, z, c, r) {
  const h = px.length / 3 / w;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= w || Z >= h) continue; const o = (X + Z * w) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; }
}
