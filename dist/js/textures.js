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
  grain(x, size, size, 26, r);
  grain(hx, size / 2, size / 2, 40, r);
  return [c, normalFrom(hc, 2.2)];
}

function carpet(size) {
  const r = rnd(23), c = canvas(size, size), x = c.getContext('2d');
  x.fillStyle = '#8f7d4e'; x.fillRect(0, 0, size, size);
  const tones = ['#7a6a3f', '#a08d5a', '#6b5c36', '#b09c66', '#85733f', '#574a2a'];
  for (let i = 0; i < size * size * 0.22; i++) {
    x.fillStyle = tones[(r() * tones.length) | 0]; x.globalAlpha = 0.35 + r() * 0.5;
    const px = r() * size, py = r() * size;
    x.fillRect(px, py, 1 + r() * 2.5, 1 + r() * 2.5);
  }
  x.globalAlpha = 1;
  grain(x, size, size, 34, r);
  const hc = canvas(size, size), hx = hc.getContext('2d');
  hx.drawImage(c, 0, 0);
  return [c, normalFrom(hc, 3.5)];
}

function ceiling(size) {
  const r = rnd(37), c = canvas(size, size), x = c.getContext('2d'), hc = canvas(size, size), hx = hc.getContext('2d');
  x.fillStyle = '#d3cdb4'; x.fillRect(0, 0, size, size);
  hx.fillStyle = '#909090'; hx.fillRect(0, 0, size, size);
  const t = size / 2;
  for (let i = 0; i < 5200; i++) {
    const px = r() * size, py = r() * size, s = 0.4 + r() * r() * 1.9;
    x.fillStyle = `rgba(90,82,60,${0.2 + r() * 0.4})`; x.beginPath(); x.arc(px, py, s, 0, 6.3); x.fill();
    hx.fillStyle = '#303030'; hx.beginPath(); hx.arc(px, py, s, 0, 6.3); hx.fill();
  }
  for (let i = 0; i < 520; i++) {
    let px = r() * size, py = r() * size; const a = r() * 6.3;
    x.strokeStyle = `rgba(80,72,52,${0.3 + r() * 0.4})`; x.lineWidth = 0.8 + r() * 1.4; x.beginPath(); x.moveTo(px, py);
    hx.strokeStyle = '#404040'; hx.lineWidth = 1.5; hx.beginPath(); hx.moveTo(px, py);
    for (let k = 0; k < 4; k++) { px += Math.cos(a + (r() - 0.5) * 2) * 5; py += Math.sin(a + (r() - 0.5) * 2) * 5; x.lineTo(px, py); hx.lineTo(px, py); }
    x.stroke(); hx.stroke();
  }
  grain(x, size, size, 16, r);
  // T-bar grid
  const bw = size / 2 * 0.045;
  for (let i = 0; i < 2; i++) {
    for (const [ctx2, colA, colB] of [[x, '#e9e6da', 'rgba(40,36,26,0.55)'], [hx, '#d8d8d8', '#585858']]) {
      ctx2.fillStyle = colB; ctx2.fillRect(i * t - bw / 2 - 2, 0, bw + 4, size); ctx2.fillRect(0, i * t - bw / 2 - 2, size, bw + 4);
      ctx2.fillRect(size - bw / 2 - 2, 0, bw, size); ctx2.fillRect(0, size - bw / 2 - 2, size, bw);
      ctx2.fillStyle = colA; ctx2.fillRect(i * t - bw / 2, 0, bw, size); ctx2.fillRect(0, i * t - bw / 2, size, bw);
      ctx2.fillRect(size - bw / 2, 0, bw, size); ctx2.fillRect(0, size - bw / 2, size, bw);
    }
  }
  return [c, normalFrom(hc, 2.6)];
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

export function makeTextures(aniso = 8) {
  const big = Math.min(aniso, 16) >= 4 ? 1024 : 512;
  const [wc, wn] = wallpaper(big), [cc, cn] = carpet(512), [tc, tn] = ceiling(512);
  return {
    wall: tex(wc, true, aniso), wallN: tex(wn, false, aniso),
    carpet: tex(cc, true, aniso), carpetN: tex(cn, false, aniso),
    ceil: tex(tc, true, aniso), ceilN: tex(tn, false, aniso),
    marks: marksAtlas(), signs: signsAtlas(), exit: exitTexture(),
  };
}
