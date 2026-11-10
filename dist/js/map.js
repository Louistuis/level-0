// The survey sheet: a hand-drawn overhead map of every sector anyone has entered.
// One endless sheet of drafting paper, pan and zoom freely. Your own sectors are inked,
// other people's are pencilled in. Canvas 2D only, drawn on demand.
import { S, SEC, SEC_M, hash3, mulberry32, clamp, sectorCode } from './util.js';

const INK = '#1b2230', PENCIL = '#6a655a', RED = '#a8281c', BLUE = '#2f5f8a', PAPER = '#e7dfc6';
const LODS = [5, 14];              // pixels per cell for the cached sector drawings
const PAD = 8;                     // room for pen overshoot around a sector drawing
const FONT = '"Troffer Sign", "Helvetica Neue", Helvetica, Arial, sans-serif';
const TUBE = '"Troffer Tube", ' + FONT;

function loadFonts() {
  if (typeof FontFace !== 'function' || !document.fonts) return;
  for (const [fam, file, weight] of [['Troffer Sign', 'troffer-sign.woff2', '400'], ['Troffer Sign', 'troffer-sign-bold.woff2', '700'], ['Troffer Tube', 'troffer-tube.woff2', '400']]) {
    try { const f = new FontFace(fam, `url(assets/${file})`, { weight }); f.load().then((x) => document.fonts.add(x)).catch(() => {}); } catch (e) { /* fall back to the system face */ }
  }
}

// A line the way a hand draws it: slightly bowed, a little wobble, ends overshoot.
function hand(ctx, x1, y1, x2, y2, rnd, amp = 0.7, over = 1.5) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const o1 = rnd() * over, o2 = rnd() * over, n = Math.max(1, Math.round(len / 26));
  const bow = (rnd() - 0.5) * amp * 1.6;
  ctx.moveTo(x1 - ux * o1, y1 - uy * o1);
  for (let i = 1; i <= n; i++) {
    const t = i / n, w = (rnd() - 0.5) * amp + Math.sin(t * Math.PI) * bow;
    const px = x1 + dx * t - uy * w + (i === n ? ux * o2 : 0), py = y1 + dy * t + ux * w + (i === n ? uy * o2 : 0);
    const mt = (i - 0.5) / n, mw = (rnd() - 0.5) * amp + Math.sin(mt * Math.PI) * bow;
    ctx.quadraticCurveTo(x1 + dx * mt - uy * mw, y1 + dy * mt + ux * mw, px, py);
  }
}

// Draw one sector plan into its own canvas.
function drawSector(g, px, mine) {
  const N = SEC, cv = document.createElement('canvas');
  cv.width = cv.height = N * px + PAD * 2;
  const ctx = cv.getContext('2d'), rnd = mulberry32(hash3(g.sx, g.sz, 0x51ce7));
  ctx.translate(PAD, PAD); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // cells one step outside the sector come from the generator's rim record, so walls and level
  // lines carry on across the sector line instead of stopping short of it
  const R = g.rim;
  const rimAt = (x, z, k) => {
    if (!R) return null;
    if (z >= 0 && z < N) { if (x === -1) return R.w[z * 3 + k]; if (x === N) return R.e[z * 3 + k]; }
    if (x >= 0 && x < N) { if (z === -1) return R.n[x * 3 + k]; if (z === N) return R.s[x * 3 + k]; }
    return null;
  };
  const sol = (x, z) => { if (x >= 0 && z >= 0 && x < N && z < N) return g.solid[x + z * N] ? 1 : 0; const v = rimAt(x, z, 0); return v === null || v === undefined ? -1 : v ? 1 : 0; };
  const big = px > 8;

  // wall mass: pencil hatching, clipped to the solid cells
  ctx.save(); ctx.beginPath();
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    if (!g.solid[x + z * N]) continue;
    let x1 = x; while (x1 + 1 < N && g.solid[x1 + 1 + z * N]) x1++;
    ctx.rect(x * px, z * px, (x1 - x + 1) * px, px); x = x1;
  }
  ctx.clip();
  ctx.fillStyle = mine ? 'rgba(27,34,48,.07)' : 'rgba(90,86,76,.06)'; ctx.fillRect(0, 0, N * px, N * px);
  ctx.strokeStyle = mine ? 'rgba(27,34,48,.42)' : 'rgba(90,86,76,.4)'; ctx.lineWidth = big ? 0.9 : 0.6;
  const step = big ? 5.5 : 3.2, span = N * px;
  ctx.beginPath();
  for (let d = -span; d < span; d += step * (0.8 + rnd() * 0.4)) hand(ctx, d, 0, d + span, span, rnd, big ? 1.2 : 0.5, 0);
  ctx.stroke(); ctx.restore();

  // collect unit edges into long runs, then draw each run as one pen stroke
  const runs = (test, horizontal) => {
    const out = [];
    for (let a = 0; a <= N; a++) {
      let start = -1;
      for (let b = 0; b <= N; b++) {
        const on = b < N && test(horizontal ? b : a, horizontal ? a : b);
        if (on && start < 0) start = b;
        if (!on && start >= 0) { out.push(horizontal ? [start, a, b, a] : [a, start, a, b]); start = -1; }
      }
    }
    return out;
  };
  // floor level changes (steps, pits, platforms): thin lines
  const fl = (x, z) => (x >= 0 && z >= 0 && x < N && z < N ? g.floor[x + z * N] : rimAt(x, z, 1));
  const lv = (x, z, ox, oz) => sol(x, z) === 0 && sol(x - ox, z - oz) === 0 && Math.abs(fl(x, z) - fl(x - ox, z - oz)) > 0.12;
  ctx.strokeStyle = mine ? 'rgba(27,34,48,.5)' : 'rgba(90,86,76,.5)'; ctx.lineWidth = big ? 0.8 : 0.5; ctx.beginPath();
  for (const [a, b, c, d] of runs((x, z) => lv(x, z, 0, 1), true)) hand(ctx, a * px, b * px, c * px, d * px, rnd, 0.4, 0.5);
  for (const [a, b, c, d] of runs((x, z) => lv(x, z, 1, 0), false)) hand(ctx, a * px, b * px, c * px, d * px, rnd, 0.4, 0.5);
  ctx.stroke();
  // walls: two passes so the stroke looks gone over, like a real drawing
  const wallH = runs((x, z) => { const p = sol(x, z), q = sol(x, z - 1); return p >= 0 && q >= 0 && p !== q; }, true);
  const wallV = runs((x, z) => { const p = sol(x, z), q = sol(x - 1, z); return p >= 0 && q >= 0 && p !== q; }, false);
  for (const [w, al, amp] of mine ? [[big ? 2.1 : 1.25, 0.9, 0.55], [big ? 1 : 0.6, 0.55, 1.3]] : [[big ? 1.5 : 0.9, 0.75, 0.7], [big ? 0.8 : 0.5, 0.4, 1.4]]) {
    ctx.strokeStyle = mine ? INK : PENCIL; ctx.globalAlpha = al; ctx.lineWidth = w; ctx.beginPath();
    for (const [a, b, c, d] of wallH) hand(ctx, a * px, b * px, c * px, d * px, rnd, amp * (big ? 1 : 0.5), big ? 3 : 1.4);
    for (const [a, b, c, d] of wallV) hand(ctx, a * px, b * px, c * px, d * px, rnd, amp * (big ? 1 : 0.5), big ? 3 : 1.4);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // unlit ground: a soft graphite wash over the bays with no power, not over the whole square
  if (g.bays) {
    const B = Math.round(Math.sqrt(g.bays.length)), bp = (N / B) * px;
    ctx.fillStyle = 'rgba(40,38,34,.15)';
    for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) if (g.bays[i + j * B] === 'dark') ctx.fillRect(i * bp, j * bp, bp, bp);
  } else if (g.type === 'dark') { ctx.fillStyle = 'rgba(40,38,34,.16)'; ctx.fillRect(0, 0, N * px, N * px); }
  return cv;
}

function paperTile() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), r = mulberry32(77);
  x.fillStyle = PAPER; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) { x.fillStyle = `rgba(${r() < 0.5 ? '70,58,30' : '255,250,235'},${0.02 + r() * 0.05})`; x.fillRect(r() * 256, r() * 256, 1 + r() * 2.5, 1); }
  for (let i = 0; i < 26; i++) { x.strokeStyle = `rgba(90,74,40,${0.03 + r() * 0.04})`; x.lineWidth = 0.5; x.beginPath(); const px = r() * 256, py = r() * 256; x.moveTo(px, py); x.lineTo(px + (r() - 0.5) * 60, py + (r() - 0.5) * 12); x.stroke(); }
  return c;
}

export function createMap(o) {
  loadFonts();
  const el = document.createElement('div');
  el.id = 'survey'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Survey map'); el.setAttribute('aria-modal', 'true'); el.hidden = true;
  el.innerHTML = `<style>
    #survey{position:fixed;inset:0;z-index:40;background:rgba(6,5,3,.72);display:grid;place-items:center;touch-action:none;user-select:none;-webkit-user-select:none}
    #survey[hidden]{display:none}
    #survey .sheet-wrap{position:relative;width:min(96vw,calc(100vw - 2*max(12px,env(safe-area-inset-left))));height:min(92vh,calc(100vh - 2*max(12px,env(safe-area-inset-top))));box-shadow:0 18px 50px rgba(0,0,0,.6),0 2px 6px rgba(0,0,0,.5);transform-origin:50% 60%;animation:survey-in .38s cubic-bezier(.16,1,.3,1)}
    @keyframes survey-in{from{transform:translateY(26px) rotate(-1.4deg);opacity:0}}
    @media (prefers-reduced-motion:reduce){#survey .sheet-wrap{animation:none}}
    #survey canvas{display:block;width:100%;height:100%;cursor:grab;border-radius:2px}
    #survey canvas:active{cursor:grabbing}
    #survey .tools{position:absolute;right:14px;top:14px;display:flex;gap:8px}
    #survey button{font:700 12px/1 ${FONT};letter-spacing:.06em;color:${INK};background:rgba(231,223,198,.9);border:1.5px solid ${INK};border-radius:3px;min-width:44px;height:44px;padding:0 12px;cursor:pointer}
    #survey button:hover,#survey button:focus-visible{background:${INK};color:${PAPER};outline:none}
    #survey button:focus-visible{box-shadow:0 0 0 3px rgba(168,40,28,.55)}
  </style>
  <div class="sheet-wrap"><canvas tabindex="0"></canvas>
    <div class="tools"><button type="button" data-m="out" aria-label="Zoom out">-</button><button type="button" data-m="in" aria-label="Zoom in">+</button><button type="button" data-m="me">FIND ME</button><button type="button" data-m="close">CLOSE</button></div>
  </div>`;
  document.body.appendChild(el);
  const cv = el.querySelector('canvas'), ctx = cv.getContext('2d');
  const tile = paperTile(); let pattern = null;
  const cache = new Map(), queue = [];     // sector drawings and the ones still to draw
  const plans = new Map();                 // generated sector data we still need
  const meta = new Map();                  // sector key -> name, type, exit
  const V = { x: 14.4, z: 14.4, ppm: 9, w: 800, h: 600, dpr: 1 };
  let open = false, raf = 0, dirty = true, cursor = null, lastData = 0;

  const sx2 = (x) => V.w / 2 + (x - V.x) * V.ppm, sz2 = (z) => V.h / 2 + (z - V.z) * V.ppm;
  const fit = () => {
    const r = cv.getBoundingClientRect(); V.dpr = Math.min(devicePixelRatio || 1, 2);
    V.w = Math.max(200, r.width); V.h = Math.max(200, r.height);
    cv.width = Math.round(V.w * V.dpr); cv.height = Math.round(V.h * V.dpr); pattern = null; dirty = true;
  };
  const zoomAt = (f, mx = V.w / 2, my = V.h / 2) => {
    const wx = V.x + (mx - V.w / 2) / V.ppm, wz = V.z + (my - V.h / 2) / V.ppm;
    V.ppm = clamp(V.ppm * f, 1.6, 42);
    V.x = wx - (mx - V.w / 2) / V.ppm; V.z = wz - (my - V.h / 2) / V.ppm; dirty = true;
  };
  const centre = () => { const p = o.getPlayer && o.getPlayer(); if (p) { V.x = p.x; V.z = p.z; } else { V.x = 14.4; V.z = 14.4; } dirty = true; };

  function sectorImage(sx, sz, claim, lod) {
    const key = sx + ',' + sz + ':' + lod + ':' + (claim.mine ? 1 : 0) + ':' + claim.seed;
    let c = cache.get(key);
    if (c) { c.t = performance.now(); return c.cv; }
    if (!queue.some((q) => q.key === key)) queue.push({ key, sx, sz, claim, lod });
    // show the other level of detail meanwhile, if we have it
    const alt = cache.get(sx + ',' + sz + ':' + (1 - lod) + ':' + (claim.mine ? 1 : 0) + ':' + claim.seed);
    return alt ? alt.cv : null;
  }
  function pump() {
    const t0 = performance.now(); let n = 0;
    while (queue.length && performance.now() - t0 < 7) {
      const q = queue.shift(), pk = q.sx + ',' + q.sz + ':' + q.claim.seed;
      let g = plans.get(pk); if (!g) { g = o.genSector(q.sx, q.sz, q.claim.seed); plans.set(pk, g); if (plans.size > 80) plans.delete(plans.keys().next().value); }
      cache.set(q.key, { cv: drawSector(g, LODS[q.lod], q.claim.mine), t: performance.now() }); meta.set(q.sx + ',' + q.sz, { type: g.type, name: g.name, exit: g.exit }); n++;
    }
    if (cache.size > 220) { const old = [...cache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 60); for (const [k] of old) cache.delete(k); }
    if (n) dirty = true;
  }

  const label = (text, x, y, size, color, opt = {}) => {
    ctx.save(); ctx.translate(x, y); if (opt.rot) ctx.rotate(opt.rot);
    ctx.font = `${opt.bold ? 700 : 400} ${size}px ${opt.tube ? TUBE : FONT}`; ctx.fillStyle = color; ctx.globalAlpha = opt.alpha ?? 1;
    ctx.textAlign = opt.align || 'left'; ctx.textBaseline = opt.base || 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = (opt.track ?? 0.04) * size + 'px';
    if (opt.bg) {   // rubbed-out patch of clean paper so lettering stays readable over linework
      const tw = ctx.measureText(text).width, x0 = ctx.textAlign === 'center' ? -tw / 2 : ctx.textAlign === 'right' ? -tw : 0, a = ctx.globalAlpha;
      ctx.globalAlpha = 0.84; ctx.fillStyle = PAPER; ctx.fillRect(x0 - 4, -size * 0.92, tw + 8, size * 1.28); ctx.globalAlpha = a; ctx.fillStyle = color;
    }
    ctx.fillText(text, 0, 0); ctx.restore();
  };
  const pen = (color, w, a = 1) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.globalAlpha = a; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; };
  const ring = (x, y, r, rnd, turns = 1.15) => { ctx.beginPath(); const a0 = rnd() * 6.28, p1 = rnd() * 6.28, p2 = rnd() * 6.28, n = 64; for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * 6.283 * turns, rr = r * (1 + 0.035 * Math.sin(a * 2 + p1) + 0.02 * Math.sin(a * 3 + p2) + (i / n) * 0.06); const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.stroke(); };

  function draw() {
    const { w, h, dpr, ppm } = V;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // paper, moving with the sheet
    if (!pattern) pattern = ctx.createPattern(tile, 'repeat');
    ctx.save(); ctx.translate(-((V.x * ppm) % 256), -((V.z * ppm) % 256)); ctx.fillStyle = pattern; ctx.fillRect(-256, -256, w + 768, h + 768); ctx.restore();
    const claims = o.getClaims ? o.getClaims() : new Map(), visited = (o.getVisited && o.getVisited()) || {};
    const secPx = SEC_M * ppm;
    const x0 = Math.floor((V.x - w / 2 / ppm) / SEC_M), x1 = Math.floor((V.x + w / 2 / ppm) / SEC_M);
    const z0 = Math.floor((V.z - h / 2 / ppm) / SEC_M), z1 = Math.floor((V.z + h / 2 / ppm) / SEC_M);

    // drafting grid: bay lines when close, sector lines always
    const bay = S * 6;
    if (bay * ppm > 14) {
      pen('#6f9bb5', 0.5, 0.22); ctx.beginPath();
      for (let gx = Math.floor((V.x - w / 2 / ppm) / bay) * bay; sx2(gx) < w; gx += bay) { ctx.moveTo(sx2(gx), 0); ctx.lineTo(sx2(gx), h); }
      for (let gz = Math.floor((V.z - h / 2 / ppm) / bay) * bay; sz2(gz) < h; gz += bay) { ctx.moveTo(0, sz2(gz)); ctx.lineTo(w, sz2(gz)); }
      ctx.stroke();
    }
    pen('#4f86a8', 0.9, 0.42); ctx.setLineDash([10, 4, 2, 4]); ctx.beginPath();
    for (let i = x0; i <= x1 + 1; i++) { ctx.moveTo(sx2(i * SEC_M), 0); ctx.lineTo(sx2(i * SEC_M), h); }
    for (let j = z0; j <= z1 + 1; j++) { ctx.moveTo(0, sz2(j * SEC_M)); ctx.lineTo(w, sz2(j * SEC_M)); }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;

    // a ring where someone put a cup down
    const rc = mulberry32(9);
    for (const [cx, cz, r] of [[-9, 37, 5.2], [52, -18, 4.4]]) { pen('#7a5a2a', Math.max(1, ppm * 0.22), 0.1); ring(sx2(cx), sz2(cz), r * ppm, rc); pen('#7a5a2a', Math.max(0.6, ppm * 0.07), 0.14); ring(sx2(cx) + 1, sz2(cz) + 1, r * ppm * 0.97, rc); }
    ctx.globalAlpha = 1;

    // sectors
    const lod = ppm * S > 8.5 ? 1 : 0;
    let mapped = 0, mineN = 0; const who = new Set();
    for (const c of claims.values()) { mapped++; if (c.mine) mineN++; if (c.by) who.add(c.by); }
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) {
      const c = claims.get(i + ',' + j), X = sx2(i * SEC_M), Z = sz2(j * SEC_M);
      if (!c) {
        // the edge of what is known
        if (secPx > 60 && (claims.has(i + 1 + ',' + j) || claims.has(i - 1 + ',' + j) || claims.has(i + ',' + (j + 1)) || claims.has(i + ',' + (j - 1)))) {
          const r = mulberry32(hash3(i, j, 5));
          label('UNSURVEYED', X + secPx / 2, Z + secPx / 2, clamp(secPx * 0.07, 9, 22), PENCIL, { align: 'center', base: 'middle', alpha: 0.5, rot: (r() - 0.5) * 0.16, track: 0.12 });
          pen(PENCIL, 0.8, 0.35); ctx.beginPath(); for (let k = 0; k < 3; k++) hand(ctx, X + secPx * (0.36 + k * 0.1), Z + secPx * 0.58, X + secPx * (0.4 + k * 0.1), Z + secPx * 0.58, r, 1, 0); ctx.stroke(); ctx.globalAlpha = 1;
        }
        continue;
      }
      const img = sectorImage(i, j, c, lod);
      if (img) { const k = secPx / (img.width - PAD * 2); ctx.drawImage(img, X - PAD * k, Z - PAD * k, img.width * k, img.height * k); }
      const g = meta.get(i + ',' + j) || null;
      if (secPx > 84) {
        const fs = clamp(secPx * 0.045, 9, 15);
        label(sectorCode(i, j).replace(/ /g, ''), X + fs * 0.7, Z + fs * 1.5, fs, c.mine ? INK : PENCIL, { bold: true, track: 0.06, bg: true });
        if (secPx > 190 && g) {
          label(String(g.name || '').toUpperCase(), X + fs * 0.7, Z + fs * 2.75, fs * 0.82, c.mine ? INK : PENCIL, { alpha: 0.85, bg: true });
          label(c.by ? 'surveyed by ' + (String(c.by).startsWith('@') ? c.by : '@' + c.by) : 'surveyor unknown', X + fs * 0.7, Z + fs * 3.9, fs * 0.8, PENCIL, { alpha: 0.9, rot: -0.012, bg: true });
          if (g.type === 'dark') label('NO LIGHT', X + secPx / 2, Z + secPx / 2, fs * 1.5, RED, { align: 'center', bold: true, rot: -0.07, alpha: 0.8 });
        }
      }
      // the way out, once you have stood in that sector yourself
      if (g && g.exit && g.exit.dir >= 0 && visited[i + ',' + j] && secPx > 60) {
        const ex = sx2((i * SEC + g.exit.x + 0.5) * S), ez = sz2((j * SEC + g.exit.z + 0.5) * S), r = mulberry32(hash3(i, j, 9));
        pen(RED, 1.6, 0.9); ring(ex, ez, Math.max(7, ppm * 1.1), r, 1.3); ctx.globalAlpha = 1;
        label('EXIT?', ex + Math.max(10, ppm * 1.4), ez + 4, clamp(ppm * 1.1, 10, 16), RED, { bold: true, rot: -0.05, bg: true });
      }
    }

    // chalk signs people left
    const SIGN = { fwd: 'THIS WAY', back: 'TURN BACK', safe: 'SAFE', danger: 'DANGER', dead: 'DEAD END', exit: 'EXIT?', eye: 'IT WATCHES', water: 'SUPPLIES' };
    if (ppm > 3.5) for (const s of (o.getSigns && o.getSigns()) || []) {
      const X = sx2(s.x), Z = sz2(s.z); if (X < -40 || Z < -40 || X > w + 40 || Z > h + 40) continue;
      const bad = s.g === 'danger' || s.g === 'eye' || s.g === 'dead', col = bad ? RED : BLUE, r = mulberry32(hash3(Math.round(s.x * 10), Math.round(s.z * 10), 3));
      pen(col, 1.3, 0.9); ctx.beginPath();
      if (s.g === 'fwd' || s.g === 'back') { const a = (s.r || 0) + (s.g === 'back' ? Math.PI : 0), dx = -Math.sin(a), dz = -Math.cos(a), L = Math.max(7, ppm * 1.2); hand(ctx, X - dx * L, Z - dz * L, X + dx * L, Z + dz * L, r, 0.8, 0); hand(ctx, X + dx * L, Z + dz * L, X + dx * L * 0.3 - dz * L * 0.45, Z + dz * L * 0.3 + dx * L * 0.45, r, 0.5, 0); hand(ctx, X + dx * L, Z + dz * L, X + dx * L * 0.3 + dz * L * 0.45, Z + dz * L * 0.3 - dx * L * 0.45, r, 0.5, 0); } else { hand(ctx, X - 4, Z - 4, X + 4, Z + 4, r, 0.6, 1); hand(ctx, X - 4, Z + 4, X + 4, Z - 4, r, 0.6, 1); }
      ctx.stroke(); ctx.globalAlpha = 1;
      if (ppm > 7) label(SIGN[s.g] || '', X + 8, Z - 6, clamp(ppm * 0.9, 9, 13), col, { rot: (r() - 0.5) * 0.2, alpha: 0.9 });
    }

    // where everyone came in
    { const X = sx2(14.4), Z = sz2(14.4), r = mulberry32(4); pen(INK, 1.2, 0.8); ctx.beginPath(); hand(ctx, X - 9, Z, X + 9, Z, r, 0.6, 1); hand(ctx, X, Z - 9, X, Z + 9, r, 0.6, 1); ctx.stroke(); ring(X, Z, 5.5, r); ctx.globalAlpha = 1; if (ppm > 5) label('ENTRY POINT', X + 12, Z + 15, 10.5, INK, { alpha: 0.8, bg: true }); }

    // other people
    for (const p of (o.getPeers && o.getPeers()) || []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const X = sx2(p.x), Z = sz2(p.z), r = mulberry32(hash3(String(p.name || '').length, 7, 1));
      pen(BLUE, 1.5, 0.95); ring(X, Z, 5, r); ctx.globalAlpha = 1;
      label(String(p.name || '?').replace(/^@/, '').slice(0, 12), X + 9, Z + 4, 11, BLUE, { bold: true });
    }
    // you
    const me = o.getPlayer && o.getPlayer();
    if (me) {
      const X = sx2(me.x), Z = sz2(me.z), dx = -Math.sin(me.yaw), dz = -Math.cos(me.yaw), r = mulberry32(2);
      ctx.fillStyle = 'rgba(168,40,28,.09)'; ctx.beginPath(); ctx.moveTo(X, Z); ctx.arc(X, Z, Math.max(46, ppm * 8), Math.atan2(dz, dx) - 0.5, Math.atan2(dz, dx) + 0.5); ctx.closePath(); ctx.fill();
      pen(RED, 2, 1); ring(X, Z, 7, r, 1.25);
      ctx.beginPath(); hand(ctx, X + dx * 7, Z + dz * 7, X + dx * 30, Z + dz * 30, r, 0.5, 0); hand(ctx, X + dx * 30, Z + dz * 30, X + dx * 21 - dz * 6, Z + dz * 21 + dx * 6, r, 0.4, 0); hand(ctx, X + dx * 30, Z + dz * 30, X + dx * 21 + dz * 6, Z + dz * 21 - dx * 6, r, 0.4, 0); ctx.stroke();
      label('YOU', X + 11, Z - 10, 12, RED, { bold: true, rot: -0.06, bg: true });
    }

    // ---- fixed to the sheet: margins, north, scale, title block ----
    // sector coordinates along the top and left margins
    ctx.fillStyle = 'rgba(231,223,198,.86)'; ctx.fillRect(0, 0, w, 20); ctx.fillRect(0, 0, 26, h);
    if (secPx > 46) {
      for (let i = x0; i <= x1; i++) label(i === 0 ? 'C0' : i > 0 ? 'E' + i : 'W' + -i, sx2((i + 0.5) * SEC_M), 14, 10.5, '#3d6e8f', { align: 'center', bold: true });
      for (let j = z0; j <= z1; j++) label(j === 0 ? 'C0' : j > 0 ? 'S' + j : 'N' + -j, 13, sz2((j + 0.5) * SEC_M) + 4, 10.5, '#3d6e8f', { align: 'center', bold: true });
    }
    // north arrow
    { const X = w - 46, Z = 112, r = mulberry32(11); ctx.fillStyle = 'rgba(231,223,198,.9)'; ctx.beginPath(); ctx.arc(X, Z - 6, 40, 0, 6.3); ctx.fill(); pen(INK, 1.6, 0.9); ctx.beginPath(); hand(ctx, X, Z + 26, X, Z - 26, r, 0.6, 0); hand(ctx, X, Z - 26, X - 8, Z - 10, r, 0.4, 0); hand(ctx, X, Z - 26, X + 8, Z - 10, r, 0.4, 0); hand(ctx, X - 13, Z + 8, X + 13, Z + 8, r, 0.5, 1); ctx.stroke(); ctx.globalAlpha = 1; label('N', X, Z - 34, 15, INK, { align: 'center', bold: true }); }
    // scale bar
    { const nice = [1, 2, 5, 10, 20, 50, 100, 200].find((m) => m * ppm > 70) || 200, L = nice * ppm, X = 44, Z = h - 30, r = mulberry32(12);
      pen(INK, 1.5, 0.9); ctx.beginPath(); hand(ctx, X, Z, X + L, Z, r, 0.5, 0); hand(ctx, X, Z - 6, X, Z + 6, r, 0.3, 0); hand(ctx, X + L, Z - 6, X + L, Z + 6, r, 0.3, 0); hand(ctx, X + L / 2, Z - 4, X + L / 2, Z + 4, r, 0.3, 0); ctx.stroke(); ctx.globalAlpha = 1;
      label(nice + ' m', X + L + 10, Z + 4, 12, INK, { bold: true, bg: true });
      const p = cursor || (me ? { x: me.x, z: me.z } : null);
      if (p) label(sectorCode(Math.floor(p.x / SEC_M), Math.floor(p.z / SEC_M)) + '  ' + Math.round(Math.hypot(p.x - 14.4, p.z - 14.4)) + ' m from entry', X, Z - 18, 11, PENCIL, { bg: true }); }
    // title block
    if (w > 520) {
      const bw = 268, bh = 92, X = w - bw - 16, Z = h - bh - 16, r = mulberry32(13);
      ctx.fillStyle = 'rgba(231,223,198,.93)'; ctx.fillRect(X, Z, bw, bh);
      pen(INK, 1.5, 0.9); ctx.beginPath(); hand(ctx, X, Z, X + bw, Z, r, 0.5, 2); hand(ctx, X + bw, Z, X + bw, Z + bh, r, 0.5, 2); hand(ctx, X + bw, Z + bh, X, Z + bh, r, 0.5, 2); hand(ctx, X, Z + bh, X, Z, r, 0.5, 2); hand(ctx, X, Z + 38, X + bw, Z + 38, r, 0.5, 0); ctx.stroke(); ctx.globalAlpha = 1;
      label('LEVEL 0', X + 12, Z + 28, 22, INK, { tube: true, track: 0.02 });
      label('FLOOR SURVEY', X + bw - 12, Z + 18, 10.5, INK, { align: 'right', bold: true }); label('WORKING COPY', X + bw - 12, Z + 31, 10, RED, { align: 'right' });
      label(`${mapped} sector${mapped === 1 ? '' : 's'} mapped, ${mineN} by you`, X + 12, Z + 56, 11.5, INK);
      label(`${who.size} surveyor${who.size === 1 ? '' : 's'}. Ink is yours, pencil is theirs.`, X + 12, Z + 72, 10.5, PENCIL);
      label('Distances are not to be trusted.', X + 12, Z + 86, 10, PENCIL, { rot: -0.008 });
    }
    // tape
    ctx.fillStyle = 'rgba(214,196,140,.55)';
    for (const [tx, tz, a] of [[-18, 10, -0.7], [w - 60, -8, 0.6]]) { ctx.save(); ctx.translate(tx + 39, tz + 13); ctx.rotate(a); ctx.fillRect(-39, -13, 78, 26); ctx.restore(); }
    if (mapped === 0) label('Nothing has been surveyed yet. Somebody has to go in first.', w / 2, h / 2 + 64, 15, PENCIL, { align: 'center' });
  }

  function frame() {
    raf = 0; if (!open) return;
    const t = performance.now();
    if (t - lastData > 300) { lastData = t; dirty = true; }   // people move, sectors arrive
    if (queue.length) pump();
    if (dirty) { dirty = false; try { draw(); } catch (e) { console.warn('[map]', e); } }
    raf = requestAnimationFrame(frame);
  }

  // ---- input ----
  const pts = new Map(); let pinch = 0, moved = 0;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; moved = 0; });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect(), p = pts.get(e.pointerId);
    cursor = { x: V.x + (e.clientX - r.left - V.w / 2) / V.ppm, z: V.z + (e.clientY - r.top - V.h / 2) / V.ppm }; dirty = true;
    if (!p) return;
    if (pts.size === 1) { V.x -= (e.clientX - p[0]) / V.ppm; V.z -= (e.clientY - p[1]) / V.ppm; moved += Math.abs(e.clientX - p[0]) + Math.abs(e.clientY - p[1]); }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) zoomAt(d / pinch, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top); pinch = d; }
  });
  const up = (e) => { pts.delete(e.pointerId); pinch = 0; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { cursor = null; dirty = true; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (b) { const m = b.dataset.m; if (m === 'in') zoomAt(1.5); else if (m === 'out') zoomAt(1 / 1.5); else if (m === 'me') centre(); else api.close(); if (o.sound) o.sound('click'); return; }
    if (e.target === el) api.close();
  });
  addEventListener('keydown', (e) => {
    if (!open) return;
    const k = e.code, step = 90 / V.ppm;
    if (k === 'Escape' || k === 'KeyM') { e.preventDefault(); e.stopImmediatePropagation(); api.close(); return; }
    if (k === 'Tab') return;
    if (k === 'ArrowLeft' || k === 'KeyA') V.x -= step; else if (k === 'ArrowRight' || k === 'KeyD') V.x += step;
    else if (k === 'ArrowUp' || k === 'KeyW') V.z -= step; else if (k === 'ArrowDown' || k === 'KeyS') V.z += step;
    else if (k === 'Equal' || k === 'NumpadAdd') zoomAt(1.3); else if (k === 'Minus' || k === 'NumpadSubtract') zoomAt(1 / 1.3);
    else if (k === 'KeyC' || k === 'Digit0' || k === 'Home') centre(); else return;
    e.preventDefault(); e.stopImmediatePropagation(); dirty = true;
  }, true);
  addEventListener('resize', () => { if (open) fit(); });

  let returnFocus = null;
  const api = {
    get isOpen() { return open; },
    open() {
      if (open) return; open = true; el.hidden = false; returnFocus = document.activeElement;
      fit(); centre(); cv.focus({ preventScroll: true }); if (o.sound) o.sound('open');
      if (!raf) raf = requestAnimationFrame(frame);
      if (o.onOpen) o.onOpen();
    },
    close() {
      if (!open) return; open = false; el.hidden = true; pts.clear(); if (o.sound) o.sound('back');
      if (returnFocus && document.contains(returnFocus) && returnFocus.focus) { try { returnFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
      if (o.onClose) o.onClose();
    },
    toggle() { if (open) api.close(); else api.open(); },
    // a scrap of the sheet for the handheld unit: centred on the player, turned the way they face
    mini(c, w, h, ppm, me) {
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = PAPER; c.fillRect(0, 0, w, h);
      c.translate(w / 2, h / 2); c.rotate(me.yaw);
      const claims = o.getClaims ? o.getClaims() : new Map(), reach = Math.hypot(w, h) / 2 / ppm, secPx = SEC_M * ppm;
      for (let j = Math.floor((me.z - reach) / SEC_M); j <= Math.floor((me.z + reach) / SEC_M); j++) for (let i = Math.floor((me.x - reach) / SEC_M); i <= Math.floor((me.x + reach) / SEC_M); i++) {
        const cl = claims.get(i + ',' + j); if (!cl) continue;
        const img = sectorImage(i, j, cl, 0); if (!img) continue;
        const k = secPx / (img.width - PAD * 2);
        c.drawImage(img, (i * SEC_M - me.x) * ppm - PAD * k, (j * SEC_M - me.z) * ppm - PAD * k, img.width * k, img.height * k);
      }
      c.restore();
      if (queue.length && !open) pump();
    },
    redraw() { fit(); draw(); },     // for tests in a hidden tab, where animation frames do not run
    pump, view: V,
  };
  return api;
}
