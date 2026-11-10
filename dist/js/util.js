// Shared constants and small deterministic helpers.
export const S = 0.6;            // cell size in meters (one ceiling tile)
export const SEC = 48;           // cells per sector side (28.8 m)
export const LAT = 6;            // wall / lamp lattice period in cells
export const BAYS = SEC / LAT;   // 8 bays per sector side
export const CEIL = 2.7;         // default ceiling height
export const MAPN = 256;         // toroidal world-map texture size in cells
export const WORLD_SEED = 0x4c563030;
export const SEC_M = SEC * S;

export function hash3(a, b, c) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) * 2246822519;
  return (h ^ (h >>> 15)) >>> 0;
}
export function hash01(a, b, c) { return hash3(a, b, c) / 4294967296; }

export function mulberry32(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.int = (n) => Math.floor(f() * n);
  f.range = (a2, b2) => a2 + f() * (b2 - a2);
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  return f;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mod = (a, n) => ((a % n) + n) % n;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
export function angDiff(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }

// Sector code shown on the HUD, e.g. "E3 / S12"
export function sectorCode(sx, sz) {
  const ew = sx === 0 ? 'C0' : (sx > 0 ? 'E' + sx : 'W' + -sx);
  const ns = sz === 0 ? 'C0' : (sz > 0 ? 'S' + sz : 'N' + -sz);
  return ew + ' / ' + ns;
}

export const ARTIFACTS = [
  { id: 'cube', name: 'Humming Cube', desc: 'A dull metal cube. It hums at the same pitch as the lights. It is warm.' },
  { id: 'polaroid', name: 'Wet Polaroid', desc: 'A photo of this exact corridor. You are in it, seen from behind.' },
  { id: 'clock', name: 'Unwound Clock', desc: 'The hands move only while nobody watches. It is always later than you think.' },
  { id: 'bulb', name: 'Black Bulb', desc: 'A lamp that shines darkness. Things nearby lose their shadows.' },
  { id: 'glove', name: 'Left Glove', desc: 'A hazmat glove, still inflated. The fingers are curled around nothing.' },
  { id: 'coin', name: 'Warm Coin', desc: 'Minted in a year that has not happened. Both faces are the same door.' },
  { id: 'tape', name: 'Blank Tape', desc: 'Forty minutes of fluorescent hum. At the end, someone clears their throat.' },
  { id: 'bird', name: 'Paper Bird', desc: 'Folded from wallpaper. It points toward the nearest way out. It has been wrong.' },
  { id: 'jar', name: 'Jar of Carpet', desc: 'A sealed jar of damp fibers. The level inside rises when you sleep.' },
  { id: 'key', name: 'Toothed Key', desc: 'Cut for a lock with far too many pins. It fits every door that is not there.' },
  { id: 'phone', name: 'Desk Phone', desc: 'Not connected to anything. It rang once when you picked it up.' },
  { id: 'eye', name: 'Glass Eye', desc: 'It is the same colour as yours. It was looking at the door before you were.' },
];

export const SIGNS = [
  { id: 'fwd', label: 'This way' },
  { id: 'back', label: 'Turn back' },
  { id: 'safe', label: 'Safe' },
  { id: 'danger', label: 'Danger' },
  { id: 'dead', label: 'Dead end' },
  { id: 'exit', label: 'Exit?' },
  { id: 'eye', label: 'It watches' },
  { id: 'water', label: 'Supplies' },
];
