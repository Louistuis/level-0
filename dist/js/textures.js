// Every texture in the game is painted here at load time. No image files.
import * as THREE from './three.module.min.js';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function rnd(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function grain(ctx, w, h, amt, r, mono = true) {
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amt;
    d[i] += n; d[i + 1] += mono ? n : (r() - 0.5) * amt; d[i + 2] += mono ? n * 0.8 : (r() - 0.5) * amt;
  }
  ctx.putImageData(im, 0, 0);
}
function normalFrom(hc, strength) {
  const w = hc.width, h = hc.height, src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h), octx = out.getContext('2d'), im = octx.createImageData(w, h), d = im.data;
  const H = (x, y) => src[(((x + w) % w) + ((y + h) % h) * w) * 4];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) / 255 * strength, dy = (H(x, y + 1) - H(x, y - 1)) / 255 * strength;
    const l = 1 / Math.hypot(dx, dy, 1), i = (x + y * w) * 4;
    d[i] = (-dx * l * 0.5 + 0.5) * 255; d[i + 1] = (-dy * l * 0.5 + 0.5) * 255; d[i + 2] = l * 255; d[i + 3] = 255;
  }
  octx.putImageData(im, 0, 0);
  return out;
}
function tex(c, srgb, aniso) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function wallpaper(size) {
  const r = rnd(11), c = canvas(size, size), x = c.getContext('2d'), hc = canvas(size / 2, size / 2), hx = hc.getContext('2d');
  x.fillStyle = '#bfa94f'; x.fillRect(0, 0, size, size);
  hx.fillStyle = '#808080'; hx.fillRect(0, 0, size / 2, size / 2);
  // blotchy ageing
  for (let i = 0; i < 90; i++) {
    const px = r() * size, py = r() * size, rad = 60 + r() * 220;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      const g = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, rad);
      const dark = r() < 0.5;
      g.addColorStop(0, dark ? 'rgba(120,98,30,0.07)' : 'rgba(226,208,120,0.07)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(px + ox - rad, py + oy - rad, rad * 2, rad * 2);
    }
  }
  // stripes
  const sw = size / 16;
  for (let i = 0; i < 16; i++) {
    x.fillStyle = i % 2 ? 'rgba(96,78,18,0.10)' : 'rgba(240,226,150,0.05)';
    x.fillRect(i * sw + sw * 0.18, 0, sw * 0.64, size);
    x.fillStyle = 'rgba(88,70,16,0.22)'; x.fillRect(i * sw, 0, 2, size);
    hx.fillStyle = i % 2 ? '#787878' : '#888888'; hx.fillRect((i * sw + sw * 0.18) / 2, 0, sw * 0.32, size / 2);
  }
  // repeating motif: a small ogee between the stripes
  const m = size / 8;
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const cx = i * m + m / 2 + (j % 2 ? m / 2 : 0), cy = j * m + m / 2;
    for (const [ctx2, sc, col] of [[x, 1, 'rgba(92,74,16,0.30)'], [hx, 0.5, '#6c6c6c']]) {
      ctx2.save(); ctx2.translate(cx * sc, cy * sc); ctx2.scale(sc, sc);
      ctx2.strokeStyle = col; ctx2.lineWidth = 3; ctx2.beginPath();
      ctx2.moveTo(0, -m * 0.34); ctx2.bezierCurveTo(m * 0.26, -m * 0.12, m * 0.26, m * 0.12, 0, m * 0.34);
      ctx2.bezierCurveTo(-m * 0.26, m * 0.12, -m * 0.26, -m * 0.12, 0, -m * 0.34); ctx2.stroke();
      ctx2.beginPath(); ctx2.arc(0, 0, m * 0.06, 0, 6.3); ctx2.stroke();
      ctx2.restore();
    }
  }
  // paper: fine vertical fibre streaks and a soft, slightly misregistered second print pass
  for (let i = 0; i < size * 1.2; i++) {
    const px = r() * size, py = r() * size, len = 20 + r() * 160;
    x.fillStyle = r() < 0.5 ? 'rgba(255,245,190,0.035)' : 'rgba(80,64,20,0.04)'; x.fillRect(px, py, 1, len);
    if (py + len > size) x.fillRect(px, py - size, 1, len);
  }
  x.save(); x.globalAlpha = 0.18; x.filter = 'blur(1.2px)'; x.drawImage(c, 1.5, 0.8); x.drawImage(c, 1.5 - size, 0.8); x.drawImage(c, 1.5, 0.8 - size); x.restore();
  grain(x, size, size, 22, r);
  grain(hx, size / 2, size / 2, 34, r);
  return [c, normalFrom(hc, 2.0)];
}

// Commercial loop pile, 1.5 m per repeat: rows of small loops in a few heathered tones,
// tufting lines, and a little matting. Height = loop tops for the normal map.
function carpet(size) {
  const r = rnd(23), c = canvas(size, size), x = c.getContext('2d'), im = x.createImageData(size, size), d = im.data;
  const hc = canvas(size, size), hx = hc.getContext('2d'), hm = hx.createImageData(size, size), h = hm.data;
  const tones = [[143, 125, 78], [122, 106, 63], [160, 141, 90], [107, 92, 54], [176, 156, 102], [133, 115, 63], [87, 74, 42]];
  const lp = Math.max(2, Math.round(size / 420));   // loop pitch in pixels (~3.5 mm)
  const cols = Math.ceil(size / lp), rows = Math.ceil(size / lp);
  const tone = new Uint8Array(cols * rows), lh = new Float32Array(cols * rows);
  const blot = wnoise(16, 24), blot2 = wnoise(64, 25);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const b = blot(i / cols * 16, j / rows * 16);
    tone[i + j * cols] = Math.min(tones.length - 1, Math.floor(Math.pow(r(), 1.3 - b * 0.6) * tones.length));
    lh[i + j * cols] = 0.55 + r() * 0.45;
  }
  for (let y = 0; y < size; y++) {
    const j = Math.floor(y / lp), fy = (y % lp + 0.5) / lp - 0.5;
    for (let xx = 0; xx < size; xx++) {
      const jo = j & 1 ? lp / 2 : 0, i = Math.floor((xx + jo) / lp) % cols, fx = ((xx + jo) % lp + 0.5) / lp - 0.5;
      const k = i + (j % rows) * cols, tn = tones[tone[k]];
      const dome = Math.max(0, 1 - (fx * fx + fy * fy) * 3.2) * lh[k];
      const m = 0.8 + 0.36 * dome + (blot2(xx / size * 64, y / size * 64) - 0.5) * 0.2 + (r() - 0.5) * 0.16;
      const o = (xx + y * size) * 4;
      d[o] = tn[0] * m; d[o + 1] = tn[1] * m; d[o + 2] = tn[2] * m * 0.97; d[o + 3] = 255;
      const hv = 70 + 150 * dome + (r() - 0.5) * 30; h[o] = h[o + 1] = h[o + 2] = hv; h[o + 3] = 255;
    }
  }
  x.putImageData(im, 0, 0); hx.putImageData(hm, 0, 0);
  // tufting lines: faint darker rows every ~2.5 cm
  const tl = Math.round(size / 60);
  x.fillStyle = 'rgba(60,50,25,0.07)'; for (let y = 0; y < size; y += tl) x.fillRect(0, y, size, Math.max(1, lp * 0.5));
  // flecks of darker yarn
  for (let i = 0; i < size * size * 0.004; i++) { x.fillStyle = r() < 0.5 ? 'rgba(70,58,30,0.5)' : 'rgba(190,172,120,0.35)'; x.fillRect(r() * size, r() * size, lp * (1 + r()), lp * (0.6 + r() * 0.6)); }
  return [c, normalFrom(hc, 2.4)];
}

// Four different 0.6 m mineral-fibre tiles in a 2 x 2 atlas (the shader picks one per cell and
// flips it). Fissured face: pinholes and short worm-like fissures, soft mottling, a cut edge.
// The grid itself is geometry now, so no bars are painted here.
function ceiling(size) {
  const r = rnd(37), c = canvas(size, size), x = c.getContext('2d'), hc = canvas(size, size), hx = hc.getContext('2d');
  const t = size / 2, sc = size / 1024;
  x.fillStyle = '#d4cdb3'; x.fillRect(0, 0, size, size);
  hx.fillStyle = '#9a9a9a'; hx.fillRect(0, 0, size, size);
  // soft mottling (each tile its own)
  for (let i = 0; i < 160; i++) {
    const px = r() * size, py = r() * size, rad = (20 + r() * 70) * sc;
    const g = x.createRadialGradient(px, py, 0, px, py, rad), dark = r() < 0.55;
    g.addColorStop(0, dark ? 'rgba(160,148,110,0.07)' : 'rgba(236,230,206,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(px - rad, py - rad, rad * 2, rad * 2);
  }
  // fissures: short wandering grooves, densest in drifts
  for (let i = 0; i < 7000 * sc * sc + 2000; i++) {
    let px = r() * size, py = r() * size, a = r() * 6.3;
    const n = 1 + ((r() * 4) | 0), step = (1.5 + r() * 2.5) * sc, w = (0.6 + r() * 0.9) * sc;
    x.strokeStyle = `rgba(120,110,84,${0.18 + r() * 0.28})`; x.lineWidth = w; x.lineCap = 'round'; x.beginPath(); x.moveTo(px, py);
    hx.strokeStyle = `rgb(${50 + r() * 30 | 0},${50 + r() * 30 | 0},${50 + r() * 30 | 0})`; hx.lineWidth = w * 1.3; hx.lineCap = 'round'; hx.beginPath(); hx.moveTo(px, py);
    for (let k = 0; k < n; k++) { a += (r() - 0.5) * 1.6; px += Math.cos(a) * step; py += Math.sin(a) * step; x.lineTo(px, py); hx.lineTo(px, py); }
    x.stroke(); hx.stroke();
  }
  // pinholes
  for (let i = 0; i < 26000 * sc * sc + 4000; i++) {
    const px = r() * size, py = r() * size, s = (0.5 + r() * r() * 1.6) * sc;
    x.fillStyle = `rgba(110,100,76,${0.15 + r() * 0.35})`; x.fillRect(px - s / 2, py - s / 2, s, s);
    hx.fillStyle = '#2c2c2c'; hx.fillRect(px - s / 2, py - s / 2, s, s);
  }
  grain(x, size, size, 12, r);
  grain(hx, size, size, 26, r);
  // cut edge of each tile: a narrow bevel, a little dirtier
  const be = Math.max(2, 7 * sc);
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
    const ox = tx * t, oy = ty * t;
    for (let k = 0; k < be; k++) {
      const f = k / be;
      x.strokeStyle = `rgba(70,62,44,${0.22 * (1 - f)})`; x.lineWidth = 1; x.strokeRect(ox + k + 0.5, oy + k + 0.5, t - 2 * k - 1, t - 2 * k - 1);
      const g = Math.round(60 + 94 * f * f); hx.strokeStyle = `rgb(${g},${g},${g})`; hx.lineWidth = 1; hx.strokeRect(ox + k + 0.5, oy + k + 0.5, t - 2 * k - 1, t - 2 * k - 1);
    }
  }
  return [c, normalFrom(hc, 2.2)];
}

const HAND = '"Bradley Hand", "Segoe Print", "Marker Felt", "Comic Sans MS", cursive';
function scrawl(x, text, cx, cy, px, r, col) {
  x.font = `700 ${px}px ${HAND}`; x.textBaseline = 'middle';
  const lines = text.split('\n');
  lines.forEach((ln, li) => {
    let w = 0; for (const ch of ln) w += x.measureText(ch).width * 0.96;
    let ox = cx - w / 2; const oy = cy + (li - (lines.length - 1) / 2) * px * 1.15;
    for (const ch of ln) {
      const cw = x.measureText(ch).width * 0.96;
      for (let pass = 0; pass < 2; pass++) {
        x.save(); x.translate(ox + cw / 2 + (r() - 0.5) * 3, oy + (r() - 0.5) * px * 0.14); x.rotate((r() - 0.5) * 0.22);
        x.fillStyle = col; x.globalAlpha = 0.55 + r() * 0.4; x.textAlign = 'center'; x.fillText(ch, 0, 0); x.restore();
      }
      ox += cw;
    }
  });
  x.globalAlpha = 1;
}
function stroke(x, pts, r, col, lw) {
  for (let pass = 0; pass < 3; pass++) {
    x.strokeStyle = col; x.lineWidth = lw * (0.6 + r() * 0.7); x.globalAlpha = 0.45 + r() * 0.4; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath();
    pts.forEach((p, i) => { const px = p[0] + (r() - 0.5) * lw * 0.8, py = p[1] + (r() - 0.5) * lw * 0.8; if (i) x.lineTo(px, py); else x.moveTo(px, py); });
    x.stroke();
  }
  x.globalAlpha = 1;
}

function marksAtlas() {
  const r = rnd(51), c = canvas(1024, 1024), x = c.getContext('2d'), q = 256;
  const ink = () => (r() < 0.3 ? '#3a0d08' : '#14110c');
  const cell = (i, fn) => { x.save(); x.translate((i % 4) * q, ((i / 4) | 0) * q); fn(); x.restore(); };
  const arrow = (flip) => () => { const col = ink(); const a = flip ? 216 : 40, b = flip ? 40 : 216; stroke(x, [[a, 128], [b, 128]], r, col, 9); stroke(x, [[b + (flip ? 44 : -44), 92], [b, 128], [b + (flip ? 44 : -44), 164]], r, col, 9); };
  cell(0, arrow(false)); cell(1, arrow(true));
  cell(2, () => { const col = ink(); for (let g = 0; g < 3; g++) { for (let k = 0; k < 4; k++) stroke(x, [[34 + g * 74 + k * 13, 86], [36 + g * 74 + k * 13, 170]], r, col, 5); stroke(x, [[26 + g * 74, 160], [84 + g * 74, 96]], r, col, 5); } });
  cell(3, () => scrawl(x, 'NO\nEXIT', 128, 128, 66, r, ink()));
  cell(4, () => { const col = ink(); const p = []; for (let k = 0; k <= 20; k++) { const t = k / 20; p.push([40 + t * 176, 128 - Math.sin(t * Math.PI) * 52]); } const p2 = p.map((v) => [v[0], 256 - v[1]]); stroke(x, p, r, col, 6); stroke(x, p2, r, col, 6); const c2 = []; for (let k = 0; k <= 16; k++) c2.push([128 + Math.cos(k / 16 * 6.3) * 26, 128 + Math.sin(k / 16 * 6.3) * 26]); stroke(x, c2, r, col, 7); x.fillStyle = col; x.beginPath(); x.arc(128, 128, 11, 0, 6.3); x.fill(); });
  cell(5, () => scrawl(x, 'IT HEARS\nYOU', 128, 128, 46, r, ink()));
  cell(6, () => scrawl(x, "DON'T\nRUN", 128, 128, 60, r, '#3a0d08'));
  cell(7, () => { const p = []; for (let k = 0; k < 90; k++) { const a = k * 0.33, rad = 6 + k * 1.05; p.push([128 + Math.cos(a) * rad, 128 + Math.sin(a) * rad]); } stroke(x, p, r, ink(), 5); });
  cell(8, () => scrawl(x, 'DAY 41\nDAY 41\nDAY 4', 128, 128, 44, r, ink()));
  cell(9, () => { const col = ink(); const h = []; for (let k = 0; k <= 14; k++) h.push([128 + Math.cos(k / 14 * 6.3) * 20, 70 + Math.sin(k / 14 * 6.3) * 20]); stroke(x, h, r, col, 5); stroke(x, [[128, 90], [128, 160]], r, col, 5); stroke(x, [[96, 118], [160, 118]], r, col, 5); stroke(x, [[128, 160], [102, 206]], r, col, 5); stroke(x, [[128, 160], [154, 206]], r, col, 5); stroke(x, [[70, 40], [186, 220]], r, '#4a0f0a', 7); stroke(x, [[186, 40], [70, 220]], r, '#4a0f0a', 7); });
  cell(10, () => scrawl(x, 'KEEP\nLEFT', 128, 128, 62, r, ink()));
  cell(11, () => scrawl(x, 'NOT EVERY\nSUIT HAS\nSOMEONE IN IT', 128, 128, 30, r, ink()));
  cell(12, () => { const col = ink(); stroke(x, [[78, 226], [78, 42], [178, 42], [178, 226]], r, col, 6); x.fillStyle = col; x.beginPath(); x.arc(160, 140, 6, 0, 6.3); x.fill(); scrawl(x, '?', 128, 110, 60, r, col); });
  cell(13, () => scrawl(x, 'LIGHT\n= SAFE', 128, 128, 54, r, ink()));
  cell(14, () => { stroke(x, [[50, 50], [206, 206]], r, '#4a0f0a', 12); stroke(x, [[206, 50], [50, 206]], r, '#4a0f0a', 12); });
  cell(15, () => scrawl(x, 'hello?', 128, 128, 58, r, ink()));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function signsAtlas() {
  const r = rnd(77), c = canvas(1024, 512), x = c.getContext('2d'), q = 256, ch = '#e9e4d0';
  const cell = (i, fn) => { x.save(); x.translate((i % 4) * q, ((i / 4) | 0) * q); fn(); x.restore(); };
  cell(0, () => { stroke(x, [[128, 216], [128, 44]], r, ch, 11); stroke(x, [[82, 96], [128, 44], [174, 96]], r, ch, 11); });
  cell(1, () => { stroke(x, [[170, 60], [170, 150], [90, 150], [90, 70]], r, ch, 10); stroke(x, [[56, 108], [90, 66], [124, 108]], r, ch, 10); stroke(x, [[60, 200], [196, 200]], r, ch, 8); });
  cell(2, () => { const p = []; for (let k = 0; k <= 22; k++) p.push([128 + Math.cos(k / 22 * 6.3) * 78, 118 + Math.sin(k / 22 * 6.3) * 78]); stroke(x, p, r, ch, 9); stroke(x, [[92, 120], [120, 150], [168, 88]], r, ch, 10); scrawl(x, 'SAFE', 128, 226, 34, r, ch); });
  cell(3, () => { stroke(x, [[128, 34], [220, 196], [36, 196], [128, 34]], r, ch, 9); stroke(x, [[128, 86], [128, 144]], r, ch, 11); x.fillStyle = ch; x.beginPath(); x.arc(128, 170, 8, 0, 6.3); x.fill(); });
  cell(4, () => { stroke(x, [[60, 70], [196, 70]], r, ch, 11); stroke(x, [[128, 70], [128, 190]], r, ch, 11); scrawl(x, 'DEAD END', 128, 224, 32, r, ch); });
  cell(5, () => { scrawl(x, 'EXIT?', 128, 150, 70, r, ch); stroke(x, [[128, 100], [128, 34]], r, ch, 9); stroke(x, [[98, 64], [128, 34], [158, 64]], r, ch, 9); });
  cell(6, () => { const p = []; for (let k = 0; k <= 20; k++) { const t = k / 20; p.push([34 + t * 188, 128 - Math.sin(t * Math.PI) * 58]); } stroke(x, p, r, ch, 8); stroke(x, p.map((v) => [v[0], 256 - v[1]]), r, ch, 8); const c2 = []; for (let k = 0; k <= 16; k++) c2.push([128 + Math.cos(k / 16 * 6.3) * 28, 128 + Math.sin(k / 16 * 6.3) * 28]); stroke(x, c2, r, ch, 9); });
  cell(7, () => { stroke(x, [[104, 60], [104, 34], [152, 34], [152, 60], [176, 96], [176, 206], [80, 206], [80, 96], [104, 60]], r, ch, 8); stroke(x, [[80, 130], [176, 130]], r, ch, 6); scrawl(x, '+', 128, 168, 54, r, ch); });
  // chalk is dusty: punch holes
  const im = x.getImageData(0, 0, 1024, 512), d = im.data;
  for (let i = 3; i < d.length; i += 4) d[i] *= 0.45 + r() * 0.55;
  x.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export function labelTexture(text, opts = {}) {
  const c = canvas(512, 96), x = c.getContext('2d');
  x.font = '600 44px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = 'rgba(0,0,0,0.9)'; x.shadowBlur = 10;
  x.fillStyle = opts.color || '#ead9a0'; x.fillText(text.slice(0, 18), 256, 50);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export function exitTexture() {
  const c = canvas(256, 128), x = c.getContext('2d');
  x.fillStyle = '#06140a'; x.fillRect(0, 0, 256, 128);
  x.fillStyle = '#54ff8a'; x.font = '800 86px "Arial Narrow", "Helvetica Neue", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('EXIT', 128, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Tileable value noise on an n x n lattice (world painters).
function wnoise(n, seed) {
  const r = rnd(seed), g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % n) + n) % n, y0 = ((yi % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const a = g[x0 + y0 * n], b = g[x1 + y0 * n], c = g[x0 + y1 * n], d = g[x1 + y1 * n];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
// World macro noise, sampled in world space by the world shader to break up tiling:
// R = soft low frequency, G = mid frequency, B = round blotches (damp, stains), A = fine speckle.
function worldNoise(N = 256) {
  // raw bytes, not a canvas: a canvas would premultiply the alpha channel into the colour ones
  const d = new Uint8Array(N * N * 4);
  const o = [wnoise(4, 101), wnoise(8, 102), wnoise(16, 103), wnoise(32, 104), wnoise(64, 105), wnoise(128, 106)];
  const r = rnd(107), pts = [];
  for (let i = 0; i < 26; i++) pts.push([r() * N, r() * N, 14 + r() * 26]);
  for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) {
    const u = xx / N, v = y / N;
    const lo = o[0](u * 4, v * 4) * 0.5 + o[1](u * 8, v * 8) * 0.3 + o[2](u * 16, v * 16) * 0.2;
    const mid = o[2](u * 16, v * 16) * 0.45 + o[3](u * 32, v * 32) * 0.35 + o[4](u * 64, v * 64) * 0.2;
    let bl = 0;
    for (const p of pts) {
      let dx = Math.abs(xx - p[0]), dy = Math.abs(y - p[1]); dx = Math.min(dx, N - dx); dy = Math.min(dy, N - dy);
      const t = 1 - Math.hypot(dx, dy) / p[2]; if (t > 0) bl = Math.max(bl, t * t * (3 - 2 * t));
    }
    bl = bl * 0.82 + (o[3](u * 32 + 7, v * 32) - 0.5) * 0.3 + 0.08;
    const fine = o[4](u * 64, v * 64) * 0.35 + o[5](u * 128, v * 128) * 0.4 + r() * 0.25;
    const i = (xx + y * N) * 4;
    d[i] = lo * 255; d[i + 1] = mid * 255; d[i + 2] = Math.max(0, Math.min(1, bl)) * 255; d[i + 3] = Math.min(1, fine) * 255;
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

export function makeTextures(aniso = 8) {
  const big = Math.min(aniso, 16) >= 4 ? 1024 : 512;
  const [wc, wn] = wallpaper(big), [cc, cn] = carpet(big), [tc, tn] = ceiling(big);
  return {
    wall: tex(wc, true, aniso), wallN: tex(wn, false, aniso),
    carpet: tex(cc, true, aniso), carpetN: tex(cn, false, aniso),
    ceil: tex(tc, true, aniso), ceilN: tex(tn, false, aniso),
    noise: worldNoise(256),
    marks: marksAtlas(), signs: signsAtlas(), exit: exitTexture(),
  };
}

// ---------- object textures (props.js) ----------
// Tiling detail map sampled in object space by the obj shader:
// R = broad grime blotches, G = fine bump (pores, weave, pitting), B = drips and streaks.
function tnoise(n, seed) {
  const r = rnd(seed), g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (a, b) => g[((a % n) + n) % n + (((b % n) + n) % n) * n];
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
let detailCache = null;
export function objectDetailTexture() {
  if (detailCache) return detailCache;
  const N = 256, c = canvas(N, N), x = c.getContext('2d'), im = x.createImageData(N, N), d = im.data;
  const n4 = tnoise(4, 3), n8 = tnoise(8, 5), n16 = tnoise(16, 7), n32 = tnoise(32, 9), n64 = tnoise(64, 11), n128 = tnoise(128, 13);
  const s1 = tnoise(32, 21), s2 = tnoise(8, 23);
  const r = rnd(99);
  for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) {
    const u = xx / N, v = y / N;
    const blot = n4(u * 4, v * 4) * 0.45 + n8(u * 8, v * 8) * 0.3 + n16(u * 16, v * 16) * 0.17 + n32(u * 32, v * 32) * 0.08;
    const fine = n32(u * 32, v * 32) * 0.3 + n64(u * 64, v * 64) * 0.45 + n128(u * 128, v * 128) * 0.25;
    // vertical streaks: stretched noise
    const st = s1(u * 32, v * 2) * 0.6 + s2(u * 8, v * 1) * 0.4;
    const streak = Math.max(0, Math.min(1, (st - 0.45) * 2.2));
    const i = (xx + y * N) * 4;
    d[i] = Math.max(0, Math.min(255, (blot - 0.18) * 1.6 * 255));
    d[i + 1] = fine * 255;
    d[i + 2] = streak * 255;
    d[i + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  detailCache = t;
  return t;
}

// One atlas with every printed surface on the props. Regions are [x, y, w, h] in pixels;
// ATLAS_UV turns them into [u0, v0, u1, v1] for the geometry builders.
const AW = 1024, AH = 1024;
export const ATLAS_REG = {
  white: [904, 8, 112, 112],
  bottle: [0, 0, 512, 160],
  battery: [512, 0, 384, 160],
  exit: [0, 168, 256, 120],
  tank: [0, 296, 256, 64],
  badge: [0, 368, 256, 96],
  photo: [264, 168, 240, 240],
  clock: [512, 168, 256, 256],
  coin: [776, 168, 128, 128],
  filter: [776, 304, 240, 64],
  tape: [0, 472, 320, 128],
  paper: [328, 472, 256, 256],
  keypad: [592, 432, 192, 256],
  eye: [792, 432, 224, 224],
  dial: [0, 608, 320, 96],
  hazard: [0, 712, 256, 64],
};
export function atlasUV(name) {
  const [x, y, w, h] = ATLAS_REG[name];
  return [x / AW, 1 - (y + h) / AH, (x + w) / AW, 1 - y / AH];
}
let atlasCache = null;
export function propAtlas() {
  if (atlasCache) return atlasCache;
  const r = rnd(4242), c = canvas(AW, AH), x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, AW, AH);
  const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif', COND = '"Arial Narrow", "Helvetica Neue", Arial, sans-serif', MONO = 'ui-monospace, Menlo, Consolas, monospace';
  const reg = (name, fn) => { const [rx, ry, w, h] = ATLAS_REG[name]; x.save(); x.beginPath(); x.rect(rx, ry, w, h); x.clip(); x.translate(rx, ry); fn(w, h); x.restore(); };
  const speckle = (w, h, n, col, a = 0.3, s = 2) => { for (let i = 0; i < n; i++) { x.fillStyle = col; x.globalAlpha = r() * a; x.fillRect(r() * w, r() * h, 1 + r() * s, 1 + r() * s); } x.globalAlpha = 1; };
  const scuff = (w, h, n, a = 0.25) => { for (let i = 0; i < n; i++) { x.strokeStyle = r() < 0.5 ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,1)'; x.globalAlpha = r() * a; x.lineWidth = 0.5 + r(); const px = r() * w, py = r() * h, a2 = r() * 6.3, l = 3 + r() * 14; x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a2) * l, py + Math.sin(a2) * l); x.stroke(); } x.globalAlpha = 1; };

  reg('white', (w, h) => { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); });

  // almond water label: wraps once around the bottle (u = angle)
  reg('bottle', (w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#efe6cc'); g.addColorStop(1, '#e2d6b4');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = '#6b4a2a'; x.fillRect(0, 10, w, 7); x.fillRect(0, h - 17, w, 7);
    x.fillStyle = '#8b6a3c'; x.fillRect(0, 20, w, 2); x.fillRect(0, h - 22, w, 2);
    // almond drawing
    const ax = 120, ay = h / 2 + 4;
    x.save(); x.translate(ax, ay); x.rotate(-0.5);
    x.fillStyle = '#a8743e'; x.beginPath(); x.ellipse(0, 0, 20, 34, 0, 0, 6.3); x.fill();
    x.strokeStyle = '#6b4320'; x.lineWidth = 1.2; for (let k = -2; k <= 2; k++) { x.beginPath(); x.moveTo(k * 6, -28 + Math.abs(k) * 4); x.quadraticCurveTo(k * 8, 0, k * 6, 28 - Math.abs(k) * 4); x.stroke(); }
    x.restore();
    x.fillStyle = '#4b6b3a'; x.beginPath(); x.ellipse(ax + 26, ay - 26, 9, 20, 0.9, 0, 6.3); x.fill();
    x.fillStyle = '#3a2614'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `italic 700 34px Georgia, "Times New Roman", serif`; x.fillText('Almond', 300, h / 2 - 16);
    x.font = `600 22px ${SANS}`; x.fillText('W A T E R', 300, h / 2 + 18);
    x.font = `500 11px ${SANS}`; x.fillText('500 ml  ·  drink slowly', 300, h / 2 + 44);
    x.font = `500 10px ${MONO}`; x.textAlign = 'left'; x.fillStyle = '#5a4630';
    ['BEST BEFORE', '--/--/----', 'LOT 0-0-0'].forEach((s, i) => x.fillText(s, 420, 52 + i * 14));
    for (let i = 0; i < 18; i++) { x.fillStyle = i % 3 ? '#222' : '#555'; x.fillRect(430 + i * 3.4, 100, i % 4 ? 1.6 : 2.4, 26); }
    speckle(w, h, 900, '#5a4630', 0.18);
    // water damage at the bottom edge
    for (let i = 0; i < 40; i++) { x.fillStyle = 'rgba(120,96,50,0.06)'; x.beginPath(); x.arc(r() * w, h - r() * 30, 6 + r() * 26, 0, 6.3); x.fill(); }
  });

  // battery wrap: u = around, v = along (+ end at the top of the region)
  reg('battery', (w, h) => {
    x.fillStyle = '#121212'; x.fillRect(0, 0, w, h);
    const g = x.createLinearGradient(0, 0, 0, 52); g.addColorStop(0, '#c2702c'); g.addColorStop(1, '#8a4614');
    x.fillStyle = g; x.fillRect(0, 0, w, 52);
    x.fillStyle = '#e8e2d2'; x.fillRect(0, 52, w, 3);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#efe9da'; x.font = `800 30px ${COND}`; x.fillText('ALKALINE', w * 0.3, 92);
    x.font = `700 16px ${SANS}`; x.fillText('LR20  ·  1.5 V', w * 0.3, 124);
    x.fillStyle = '#1b1b1b'; x.font = `900 40px ${SANS}`; x.fillText('+', w * 0.3, 27);
    x.fillStyle = '#efe9da'; x.font = `800 30px ${COND}`; x.fillText('ALKALINE', w * 0.8, 92);
    x.font = `500 10px ${SANS}`; x.fillStyle = '#aaa39a'; x.fillText('DO NOT RECHARGE · DO NOT HEAT', w * 0.8, 120); x.fillText('INSERT CORRECTLY', w * 0.8, 134);
    scuff(w, h, 120, 0.35);
  });

  reg('exit', (w, h) => {
    x.fillStyle = '#071a0c'; x.fillRect(0, 0, w, h);
    const g = x.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.6); g.addColorStop(0, 'rgba(60,140,80,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = '#62ff96'; x.font = `800 84px ${COND}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('EXIT', w / 2 + 14, h / 2 + 4);
    x.beginPath(); x.moveTo(18, h / 2); x.lineTo(42, h / 2 - 20); x.lineTo(42, h / 2 + 20); x.fill();
    x.fillRect(40, h / 2 - 6, 18, 12);
    // dead pixels and grime
    speckle(w, h, 200, '#000', 0.5, 3);
  });

  reg('tank', (w, h) => {
    x.fillStyle = '#d8d2c0'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#1d1d1b'; x.font = `800 26px ${COND}`; x.textAlign = 'left'; x.textBaseline = 'middle';
    x.fillText('BREATHING AIR', 10, 22); x.font = `600 14px ${MONO}`; x.fillText('300 BAR  ·  6.8 L', 10, 48);
    x.fillStyle = '#1f4e8a'; x.fillRect(196, 8, 52, 48);
    scuff(w, h, 80, 0.4);
  });

  reg('badge', (w, h) => {
    x.fillStyle = '#e9e3cf'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#121110'; x.fillRect(0, 0, 70, h);
    x.fillStyle = '#e8b51a'; x.beginPath(); x.moveTo(35, 18); x.lineTo(60, 66); x.lineTo(10, 66); x.closePath(); x.fill();
    x.fillStyle = '#121110'; x.font = `900 30px ${SANS}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('!', 35, 52);
    x.textAlign = 'left'; x.font = `800 26px ${COND}`; x.fillText('SURVEY TEAM', 82, 30);
    x.font = `600 15px ${MONO}`; x.fillText('L0 · UNIT 7', 82, 60);
    x.font = `500 11px ${MONO}`; x.fillText('DO NOT REMOVE HOOD', 82, 82);
    speckle(w, h, 400, '#3a3020', 0.3);
  });

  // the polaroid: this corridor, from behind someone in a yellow suit
  reg('photo', (w, h) => {
    x.fillStyle = '#efeadb'; x.fillRect(0, 0, w, h);
    const px = 16, py = 16, pw = w - 32, ph = h - 64;
    x.save(); x.beginPath(); x.rect(px, py, pw, ph); x.clip();
    const vx = px + pw / 2 + 8, vy = py + ph * 0.46;
    x.fillStyle = '#6e6234'; x.fillRect(px, py, pw, ph);
    // ceiling
    x.fillStyle = '#b6ae8a'; x.beginPath(); x.moveTo(px, py); x.lineTo(px + pw, py); x.lineTo(vx + 26, vy - 18); x.lineTo(vx - 26, vy - 18); x.closePath(); x.fill();
    // walls
    x.fillStyle = '#b39c42'; x.beginPath(); x.moveTo(px, py); x.lineTo(vx - 26, vy - 18); x.lineTo(vx - 26, vy + 16); x.lineTo(px, py + ph); x.closePath(); x.fill();
    x.fillStyle = '#a28c38'; x.beginPath(); x.moveTo(px + pw, py); x.lineTo(vx + 26, vy - 18); x.lineTo(vx + 26, vy + 16); x.lineTo(px + pw, py + ph); x.closePath(); x.fill();
    x.fillStyle = '#7d6c3c'; x.beginPath(); x.moveTo(px, py + ph); x.lineTo(vx - 26, vy + 16); x.lineTo(vx + 26, vy + 16); x.lineTo(px + pw, py + ph); x.closePath(); x.fill();
    x.fillStyle = '#2a2414'; x.fillRect(vx - 26, vy - 18, 52, 34);
    // lamps
    x.fillStyle = '#fffbe4';
    for (let k = 0; k < 4; k++) { const t = [0.15, 0.42, 0.63, 0.78][k], lx = vx + (px + pw * 0.5 - vx) * (1 - t), ly = vy - 18 + (py - vy + 18) * (1 - t); const s = (1 - t) * 30 + 3; x.fillRect(lx - s, ly - s * 0.15, s * 2, s * 0.3); }
    // stripes on the walls
    x.strokeStyle = 'rgba(90,70,20,0.35)'; x.lineWidth = 1;
    for (let k = 0; k < 16; k++) { const t = k / 16; x.beginPath(); x.moveTo(px + t * (vx - 26 - px), py + t * (vy - 18 - py)); x.lineTo(px + t * (vx - 26 - px), py + ph + t * (vy + 16 - py - ph)); x.stroke(); }
    // the figure, from behind, close to the camera
    const fx = px + pw * 0.38, fy = py + ph * 0.98;
    x.fillStyle = '#c99a1c'; x.beginPath(); x.ellipse(fx, fy - 70, 34, 50, 0, 0, 6.3); x.fill();
    x.beginPath(); x.ellipse(fx, fy - 128, 24, 26, 0, 0, 6.3); x.fill();
    x.fillStyle = '#4a4a46'; x.fillRect(fx - 12, fy - 104, 24, 52);
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.beginPath(); x.ellipse(fx + 10, fy - 70, 18, 46, 0, 0, 6.3); x.fill();
    // wash, blur and water
    const g = x.createRadialGradient(vx, vy, 10, vx, vy, pw * 0.8); g.addColorStop(0, 'rgba(255,240,180,0.12)'); g.addColorStop(1, 'rgba(30,20,0,0.45)');
    x.fillStyle = g; x.fillRect(px, py, pw, ph);
    for (let i = 0; i < 14; i++) { x.fillStyle = 'rgba(255,255,240,0.08)'; x.beginPath(); x.arc(px + r() * pw, py + r() * ph, 4 + r() * 18, 0, 6.3); x.fill(); }
    speckle(w, h, 1500, '#000', 0.12);
    x.restore();
    x.fillStyle = '#2b2a28'; x.font = `italic 400 15px ${HAND}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('this is you', w / 2, h - 24);
    for (let i = 0; i < 30; i++) { x.fillStyle = 'rgba(140,120,80,0.05)'; x.beginPath(); x.arc(r() * w, r() * h, 6 + r() * 30, 0, 6.3); x.fill(); }
  });

  reg('clock', (w, h) => {
    const cx = w / 2, cy = h / 2, R = w / 2;
    x.fillStyle = '#e9e4d4'; x.beginPath(); x.arc(cx, cy, R, 0, 6.3); x.fill();
    const g = x.createRadialGradient(cx, cy, R * 0.2, cx, cy, R); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(90,70,30,0.35)'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#1a1916'; x.fillStyle = '#1a1916';
    for (let k = 0; k < 60; k++) { const a = k / 60 * Math.PI * 2, big = k % 5 === 0, r1 = R * 0.92, r2 = R * (big ? 0.8 : 0.87); x.lineWidth = big ? 4 : 1.5; x.beginPath(); x.moveTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1); x.lineTo(cx + Math.sin(a) * r2, cy - Math.cos(a) * r2); x.stroke(); }
    x.font = `700 26px ${SANS}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    const nums = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13];
    nums.forEach((n, k) => { const a = k / 12 * Math.PI * 2; x.fillText(String(n), cx + Math.sin(a) * R * 0.66, cy - Math.cos(a) * R * 0.66); });
    x.font = `600 10px ${SANS}`; x.fillText('QUARTZ', cx, cy + R * 0.35);
    for (let i = 0; i < 26; i++) { x.fillStyle = 'rgba(110,90,50,0.07)'; x.beginPath(); x.arc(r() * w, r() * h, 5 + r() * 24, 0, 6.3); x.fill(); }
  });

  // coin face: a door in relief and a rim legend
  reg('coin', (w, h) => {
    const cx = w / 2, cy = h / 2, R = w / 2;
    const g = x.createRadialGradient(cx - 20, cy - 20, 4, cx, cy, R); g.addColorStop(0, '#f4d48a'); g.addColorStop(1, '#a8782c');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(70,45,10,0.8)'; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, R * 0.86, 0, 6.3); x.stroke();
    x.fillStyle = '#5e3e12'; x.font = `700 11px ${SANS}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    const txt = 'NO EXIT · MMXXXI · NO EXIT · ';
    for (let i = 0; i < txt.length; i++) { const a = -Math.PI / 2 + (i / txt.length) * Math.PI * 2; x.save(); x.translate(cx + Math.cos(a) * R * 0.74, cy + Math.sin(a) * R * 0.74); x.rotate(a + Math.PI / 2); x.fillText(txt[i], 0, 0); x.restore(); }
    x.fillStyle = 'rgba(70,45,10,0.55)'; x.fillRect(cx - 15, cy - 26, 30, 50);
    x.fillStyle = 'rgba(255,230,160,0.5)'; x.fillRect(cx - 12, cy - 23, 24, 46);
    x.fillStyle = 'rgba(70,45,10,0.6)'; x.beginPath(); x.arc(cx + 7, cy, 2.2, 0, 6.3); x.fill();
    speckle(w, h, 400, '#3a2006', 0.25);
  });

  reg('filter', (w, h) => {
    x.fillStyle = '#c23c8c'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#f2e8ee'; x.font = `800 22px ${COND}`; x.textAlign = 'left'; x.textBaseline = 'middle';
    x.fillText('P3 R  A2B2E2K2', 8, 20); x.font = `600 12px ${MONO}`; x.fillText('REPLACE AFTER USE', 8, 46);
    x.fillStyle = '#2a1a22'; x.fillRect(196, 8, 36, 48);
    scuff(w, h, 60, 0.4);
  });

  reg('tape', (w, h) => {
    x.fillStyle = '#eee9da'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#c4352a'; x.fillRect(0, 0, w, 16); x.fillStyle = '#2b5ea8'; x.fillRect(0, 16, w, 6);
    x.strokeStyle = 'rgba(90,110,160,0.5)'; x.lineWidth = 1; for (let k = 0; k < 5; k++) { x.beginPath(); x.moveTo(10, 40 + k * 18); x.lineTo(w - 10, 40 + k * 18); x.stroke(); }
    x.fillStyle = '#1e2b5a'; x.font = `400 22px ${HAND}`; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    x.fillText('hum  (40 min)', 18, 56); x.font = `400 16px ${HAND}`; x.fillText("don't play side B", 18, 92);
    x.fillStyle = '#111'; x.font = `800 18px ${SANS}`; x.fillText('A', w - 30, 50);
    speckle(w, h, 300, '#5a4630', 0.2);
  });

  reg('paper', (w, h) => {
    x.fillStyle = '#c4ad55'; x.fillRect(0, 0, w, h);
    const sw = w / 8;
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? 'rgba(96,78,18,0.16)' : 'rgba(240,226,150,0.12)'; x.fillRect(i * sw + sw * 0.18, 0, sw * 0.64, h); x.fillStyle = 'rgba(88,70,16,0.3)'; x.fillRect(i * sw, 0, 2, h); }
    x.strokeStyle = 'rgba(92,74,16,0.4)'; x.lineWidth = 2;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const cx = i * 64 + 32 + (j % 2 ? 32 : 0), cy = j * 64 + 32, m = 64; x.beginPath(); x.moveTo(cx, cy - m * 0.34); x.bezierCurveTo(cx + m * 0.26, cy - m * 0.12, cx + m * 0.26, cy + m * 0.12, cx, cy + m * 0.34); x.bezierCurveTo(cx - m * 0.26, cy + m * 0.12, cx - m * 0.26, cy - m * 0.12, cx, cy - m * 0.34); x.stroke(); }
    for (let i = 0; i < 20; i++) { x.fillStyle = 'rgba(90,70,20,0.08)'; x.beginPath(); x.arc(r() * w, r() * h, 8 + r() * 40, 0, 6.3); x.fill(); }
    speckle(w, h, 1200, '#4a3a10', 0.2);
  });

  // 3 x 4 phone keys, each 64 x 64
  reg('keypad', (w, h) => {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'], sub = ['', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ', '', '+', ''];
    keys.forEach((k, i) => {
      const cx = (i % 3) * 64, cy = Math.floor(i / 3) * 64;
      x.fillStyle = '#d9d4c4'; x.fillRect(cx, cy, 64, 64);
      x.fillStyle = 'rgba(0,0,0,0.12)'; x.fillRect(cx, cy + 56, 64, 8);
      x.fillStyle = '#1e1d1a'; x.font = `600 30px ${SANS}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(k, cx + 32, cy + 27);
      x.font = `600 9px ${SANS}`; x.fillText(sub[i], cx + 32, cy + 48);
    });
    speckle(w, h, 300, '#3a3020', 0.3);
  });

  // glass eye: centre = cornea, edge = back of the ball
  reg('eye', (w, h) => {
    const cx = w / 2, cy = h / 2, R = w / 2;
    x.fillStyle = '#e8e1d2'; x.fillRect(0, 0, w, h);
    const sg = x.createRadialGradient(cx, cy, R * 0.3, cx, cy, R); sg.addColorStop(0, '#f2ede2'); sg.addColorStop(0.7, '#e6dccb'); sg.addColorStop(1, '#c9b49a'); x.fillStyle = sg; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) { let a = r() * 6.3, rr = R * (0.98 - r() * 0.05); x.strokeStyle = `rgba(${150 + r() * 40},${30 + r() * 20},${30},${0.35 + r() * 0.4})`; x.lineWidth = 0.6 + r() * 1.3; x.beginPath(); x.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); for (let k = 0; k < 8; k++) { rr -= R * (0.03 + r() * 0.05); a += (r() - 0.5) * 0.25; x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); if (rr < R * 0.32) break; } x.stroke(); }
    const ir = R * 0.27;
    const ig = x.createRadialGradient(cx, cy, ir * 0.3, cx, cy, ir); ig.addColorStop(0, '#6a5a2a'); ig.addColorStop(0.5, '#4f6a5a'); ig.addColorStop(0.9, '#33463e'); ig.addColorStop(1, '#141a16');
    x.fillStyle = ig; x.beginPath(); x.arc(cx, cy, ir, 0, 6.3); x.fill();
    for (let k = 0; k < 90; k++) { const a = k / 90 * 6.3 + r() * 0.05; x.strokeStyle = r() < 0.5 ? 'rgba(200,190,140,0.35)' : 'rgba(10,20,15,0.35)'; x.lineWidth = 0.8; x.beginPath(); x.moveTo(cx + Math.cos(a) * ir * 0.38, cy + Math.sin(a) * ir * 0.38); x.lineTo(cx + Math.cos(a) * ir * (0.8 + r() * 0.2), cy + Math.sin(a) * ir * (0.8 + r() * 0.2)); x.stroke(); }
    x.fillStyle = '#050505'; x.beginPath(); x.arc(cx, cy, ir * 0.36, 0, 6.3); x.fill();
  });

  // gauge dial for the air tank / clock-like small dials
  reg('dial', (w, h) => {
    x.fillStyle = '#e8e3d4'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#1a1916'; x.lineWidth = 2; x.beginPath(); x.arc(48, 48, 40, 0, 6.3); x.stroke();
    x.strokeStyle = '#b8261c'; x.lineWidth = 6; x.beginPath(); x.arc(48, 48, 34, Math.PI * 0.75, Math.PI * 1.0); x.stroke();
    x.strokeStyle = '#1a1916'; x.lineWidth = 1.5; for (let k = 0; k <= 10; k++) { const a = Math.PI * 0.75 + k / 10 * Math.PI * 1.5; x.beginPath(); x.moveTo(48 + Math.cos(a) * 30, 48 + Math.sin(a) * 30); x.lineTo(48 + Math.cos(a) * 38, 48 + Math.sin(a) * 38); x.stroke(); }
    x.lineWidth = 3; x.beginPath(); x.moveTo(48, 48); x.lineTo(48 + Math.cos(2.6) * 30, 48 + Math.sin(2.6) * 30); x.stroke();
    x.fillStyle = '#1a1916'; x.font = `700 12px ${SANS}`; x.textAlign = 'center'; x.fillText('BAR', 48, 72);
  });

  reg('hazard', (w, h) => {
    x.fillStyle = '#e2b11c'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#141310';
    for (let k = -4; k < 12; k++) { x.beginPath(); x.moveTo(k * 32, 0); x.lineTo(k * 32 + 16, 0); x.lineTo(k * 32 + 16 + h, h); x.lineTo(k * 32 + h, h); x.closePath(); x.fill(); }
    scuff(w, h, 140, 0.45);
  });

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  atlasCache = t;
  return t;
}
