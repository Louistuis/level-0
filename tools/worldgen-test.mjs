// World generation checks for LEVEL 0. Plain Node, no dependencies.
//   node tools/worldgen-test.mjs [path/to/worldgen.js] [out-prefix]
// Generates a 25x25 sector block in random order and checks: edge agreement between
// neighbours, connectivity across edges with the game's step rules, drops you cannot climb
// out of, spawn, items/exit/artifact placement, determinism, timing, style mix and how
// visible the sector grid is. Writes a top-down picture of a 12x12 block (<prefix>-12x12.ppm,
// plus .png when sips is available).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const genPath = resolve(process.argv[2] || new URL('../dist/js/worldgen.js', import.meta.url).pathname);
const outPrefix = process.argv[3] || '/tmp/worldgen';
const util = await import(pathToFileURL(resolve(genPath, '../util.js')).href);
const { genSector, edgePortals } = await import(pathToFileURL(genPath).href);
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
for (const [sx, sz] of keys.slice(0, 200)) { const a = performance.now(); genSector(sx, sz, seedFor(sx, sz)); const d = performance.now() - a; tt.push(d); worst = Math.max(worst, d); }
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
  const chk = (p) => { const o = G(sx * N + p.x, sz * N + p.z); return !sol[o] && reach[o]; };
  for (const it of g.items) { items++; if (!chk(it)) badItems++; }
  if (g.exit) { exits++; if (!chk(g.exit) || g.exit.dir < 0) badExit++; }
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

console.log(JSON.stringify({
  generator: genPath,
  sectors: keys.length,
  msPerSector: +ms.toFixed(3), medianMs: +tt[tt.length >> 1].toFixed(3), p95Ms: +tt[Math.floor(tt.length * 0.95)].toFixed(3), worstMs: +worst.toFixed(3), coldP95Ms: +cold[Math.floor(cold.length * 0.95)].toFixed(3), coldWorstMs: +coldWorst.toFixed(3),
  nondeterministic: nondet,
  edge: { rimCellsChecked: rimChecked, rimMismatches: rimBad, openCrossings: crossOpen, cliffCrossings: crossCliff, edgesWithoutOpening: edgesNoOpening },
  connectivity: { unreachedSectors, walkableCells: walk, globallyReached: +(globalReachOpen / walk).toFixed(4), locallyReached: +(localReachOpen / walk).toFixed(4), trapsInterior: traps, trapsAtBlockEdge: trapEdge },
  spawnOK: CX || CZ ? 'n/a (block not at origin)' : spawnOK,
  placed: { items, badItems, exits, badExit, artifacts: arts, badArt },
  styleMixByArea: mixPct,
  types: typeCount,
  names: Object.keys(nameCount).length,
  seam: { ...seam, bayStyleChange: styleSeam, note: '[on sector lines, elsewhere at same lattice phase]' },
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
const img = Buffer.alloc(IW * IW * 3);
const put = (x, y, c) => { const o = (x + y * IW) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
for (let cz = 0; cz < BN * N; cz++) for (let cx = 0; cx < BN * N; cx++) {
  const gx = BX * N + cx, gz = BZ * N + cz, o = G(gx, gz);
  let c;
  if (sol[o]) c = [52, 46, 36];
  else {
    const f = fl[o], h = ce[o] - f;
    if (f < -0.05) { const t = Math.min(1, -f / 2.7); c = [190 - 120 * t, 200 - 90 * t, 215 - 30 * t]; }
    else if (f > 0.05) { const t = Math.min(1, f / 2.7); c = [235, 190 - 70 * t, 120 - 60 * t]; }
    else c = [226, 214, 160];
    if (h < 1.0) c = [120, 110, 90];
    else if (h < 2.0) c = c.map((v) => v * 0.8);
    else if (ce[o] > 4.5) c = [c[0] * 0.86, c[1] * 0.9, c[2] * 1.0];
    if (!lit[o]) c = c.map((v) => v * 0.62);
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
