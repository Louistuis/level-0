// LEVEL 0 interface layer. DOM and CSS only, no canvas work.
// The engine (main.js) drives everything through createUI(opts); see the
// contract in the project brief. Everything here is plain ES2020, no deps.

const SETTINGS_KEY = 'level0.settings';
const PROFILE_KEY = 'level0.profile';
const DEFAULTS = Object.freeze({
  quality: 'auto', sens: 1, fov: 78, volume: 0.8, headbob: true,
  grain: 1, visor: true, voice: false, invertY: false, showFps: false,
});
const RANGES = { sens: [0.2, 3, 0.05], fov: [60, 100, 1], volume: [0, 1, 0.01], grain: [0, 1.5, 0.05] };
const QUALITIES = ['auto', 'low', 'medium', 'high'];
const NAME_RE = /^[A-Za-z0-9 _-]{2,16}$/;
const SEG = 20;            // vitals bar segments
const DET_TICKS = 12;      // detector ticks
const PX_PER_DEG = 2.4;    // compass tape scale

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const pad = (n, w) => String(Math.max(0, Math.round(n))).padStart(w, '0');
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
const load = (k) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
const at = (name) => { const s = String(name ?? '').trim(); return s ? (s.startsWith('@') ? s : '@' + s) : ''; };

/* ------------------------------------------------------------------ icons */
const MIC = 'M12 3.5a2.75 2.75 0 0 0-2.75 2.75v5.5a2.75 2.75 0 0 0 5.5 0v-5.5A2.75 2.75 0 0 0 12 3.5zM6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5';
const P = {
  flashlight: 'M8 3.5h8l-1.6 5v12h-4.8v-12L8 3.5zM9.6 8.5h4.8M12 12.5v3',
  mic: MIC,
  micOff: MIC + 'M4.5 4.5l15 15',
  crouch: 'M6.5 7.5l5.5 5.5 5.5-5.5M5 18.5h14',
  interact: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  chalk: 'M4.5 19.5l1-4 10-10 3 3-10 10-4 1zM13.5 7.5l3 3',
  pause: 'M9 5.5v13M15 5.5v13',
  people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19.5c.4-3 2.7-4.8 5.5-4.8s5.1 1.8 5.5 4.8M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.9c1.7.6 2.8 2.2 3 4.6',
  arrow: 'M4.5 12h15M13.5 6l6 6-6 6',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  danger: 'M12 3.5l9.5 16.5h-19L12 3.5zM12 10v4.5M12 17.2v.3',
  safe: 'M12 3.5l7.5 2.8v5.6c0 4.6-3.2 7.6-7.5 8.6-4.3-1-7.5-4-7.5-8.6V6.3L12 3.5zM8.5 12l2.5 2.5 4.5-5',
  deadend: 'M4 12h11M17.5 5v14',
  exit: 'M5.5 3.5h9v17h-9zM14.5 12h6M18 9l3 3-3 3',
  external: 'M14 4.5h5.5V10M19.5 4.5l-8.5 8.5M17.5 14v5.5h-13v-13H10',
  code: 'M8.5 7l-5 5 5 5M15.5 7l5 5-5 5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  back: 'M14.5 5.5L8 12l6.5 6.5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  catalog: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
  board: 'M5 20V11M12 20V5M19 20v-6',
  help: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.7M12 16.8v.3',
  quit: 'M10 4.5H5v15h5M14 8l4 4-4 4M18 12H9',
  resume: 'M8 5.5l10 6.5-10 6.5z',
  dot: 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  keys: 'M3.5 7.5h17v10h-17zM7 11h.01M10 11h.01M13 11h.01M16 11h.01M8 14.5h8',
  radar: 'M12 3.5a8.5 8.5 0 1 0 8.5 8.5M12 7.5a4.5 4.5 0 1 0 4.5 4.5M12 12l6-6M16.6 15.2h.01',
  map: 'M3.5 6.6l5.5-2.1 6 2.1 5.5-2.1v12.9l-5.5 2.1-6-2.1-5.5 2.1zM9 4.5v12.9M15 6.6v12.9',
  // a slice, crust up, in the same 1.5 stroke as everything else
  pizza: 'M3.6 7.4C8.9 4.3 15.1 4.3 20.4 7.4L12 20.6 3.6 7.4zM5.3 10.1c4.4-2.3 9-2.3 13.4 0M9.4 12.3a1.1 1.1 0 1 0 2.2 0 1.1 1.1 0 1 0-2.2 0zM13.3 14.6a.9.9 0 1 0 1.8 0 .9.9 0 1 0-1.8 0z',
};
const icon = (name, cls = '', style = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${style ? ` style="${style}"` : ''}><path d="${P[name] || P.dot}"/></svg>`;

function signIcon(sign) {
  const s = `${sign.id} ${sign.label}`.toLowerCase();
  if (/left/.test(s)) return icon('arrow', '', 'transform:rotate(180deg)');
  if (/right/.test(s)) return icon('arrow');
  if (/back|behind|down|return/.test(s)) return icon('arrow', '', 'transform:rotate(90deg)');
  if (/dead|stop|end/.test(s)) return icon('deadend');
  if (/safe/.test(s)) return icon('safe');
  if (/danger|warn|run/.test(s)) return icon('danger');
  if (/exit|door|out/.test(s)) return icon('exit');
  if (/eye|watch|look/.test(s)) return icon('eye');
  if (/up|forward|ahead|straight|arrow/.test(s)) return icon('arrow', '', 'transform:rotate(-90deg)');
  return icon('chalk');
}

/* ---------------------------------------------------- artifact sigils */
function hash(str) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sigil(id) {
  const r = rng(hash(id));
  const p = [];
  const f = (n) => n.toFixed(1);
  const kind = Math.floor(r() * 5);
  if (kind === 0) p.push(`<circle cx="24" cy="24" r="${f(13 + r() * 5)}"/>`);
  else if (kind === 1) p.push(`<rect x="12" y="12" width="24" height="24" transform="rotate(${Math.round(r() * 3) * 15} 24 24)"/>`);
  else if (kind === 2) p.push('<path d="M24 8.5L38 33.5H10Z"/>');
  else if (kind === 3) p.push('<path d="M24 7v34M10 17l28 14M38 17L10 31"/>');
  else p.push(`<path d="M10 24a14 14 0 0 1 28 0"/><path d="M14 30h20"/>`);
  if (r() > 0.35) p.push(`<circle cx="24" cy="24" r="${f(3 + r() * 5)}"/>`);
  const lines = 1 + Math.floor(r() * 2);
  for (let i = 0; i < lines; i++) {
    const a = r() * Math.PI, l = 8 + r() * 12, ox = (r() - 0.5) * 8, oy = (r() - 0.5) * 8;
    p.push(`<path d="M${f(24 + ox - Math.cos(a) * l)} ${f(24 + oy - Math.sin(a) * l)}L${f(24 + ox + Math.cos(a) * l)} ${f(24 + oy + Math.sin(a) * l)}"/>`);
  }
  const dots = 1 + Math.floor(r() * 3);
  for (let i = 0; i < dots; i++) {
    const a = r() * Math.PI * 2, d = 6 + r() * 14;
    p.push(`<circle class="d" cx="${f(24 + Math.cos(a) * d)}" cy="${f(24 + Math.sin(a) * d)}" r="1.6"/>`);
  }
  return `<svg class="sigil" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${p.join('')}</svg>`;
}

/* ------------------------------------------------------------ helpers */
function fmtTime(t) {
  if (typeof t === 'string') return t;
  const s = Math.max(0, Math.floor(num(t)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(ss, 2)}`;
}
function fmtSetting(k, v) {
  if (k === 'sens') return `${(+v).toFixed(2)}x`;
  if (k === 'fov') return `${Math.round(v)}°`;
  return `${Math.round(v * 100)}%`;
}
function sanitizeSettings(src) {
  const s = { ...DEFAULTS };
  if (!src || typeof src !== 'object') return s;
  if (QUALITIES.includes(src.quality)) s.quality = src.quality;
  for (const k of Object.keys(RANGES)) if (Number.isFinite(+src[k])) s[k] = clamp(+src[k], RANGES[k][0], RANGES[k][1]);
  for (const k of ['headbob', 'visor', 'voice', 'invertY', 'showFps']) if (typeof src[k] === 'boolean') s[k] = src[k];
  return s;
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* =================================================================== */
export function createUI(opts = {}) {
  const o = {
    version: '0.0.0', edition: 'websim', repoUrl: '#', donateUrl: '#',
    artifacts: [], signs: [], credits: [], places: [], entities: [], ...opts,
  };
  const lou15 = o.edition === 'lou15';
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const handlers = new Map();
  const emit = (ev, ...args) => {
    const list = handlers.get(ev);
    if (!list) return;
    for (const fn of [...list]) { try { fn(...args); } catch (e) { console.error(`[ui] ${ev} handler`, e); } }
  };

  const settings = sanitizeSettings(load(SETTINGS_KEY));
  const profile = { name: '', adult: false, ...(load(PROFILE_KEY) || {}) };

  /* ---------------------------------------------------------- state */
  const st = {
    screen: 'none', // none | title | pause | death | escape
    panels: [],     // stack of panel names
    inGame: false,
    signs: false,
    roster: false,
    progress: null,
    status: '',
    title: {},
    hud: {},        // last known HUD values (for discover toast, pause readout)
    found: new Set(),
    leaderboard: [],
    players: [],
    online: 0,
    pauseAt: 0,
    returnFocus: [],
    keyboard: false,
    prompt: false,
  };

  /* ----------------------------------------------------------- root */
  let root = document.getElementById('ui');
  if (!root) { root = document.createElement('div'); root.id = 'ui'; document.body.appendChild(root); }
  root.className = 'l0';
  root.dataset.edition = lou15 ? 'lou15' : 'websim';
  if (reduced) root.classList.add('reduced');

  // menu rows are unlit tubes; they strike on hover or keyboard focus (CSS)
  const menuItem = (act, label, extra = '', ic = '') =>
    `<button type="button" class="mi tube" data-act="${act}" ${extra}>${ic ? icon(ic, 'mi-ico') : ''}<span class="mi-l">${label}</span></button>`;
  const panelBtn = (panel, label, ic) => menuItem('panel', label, `data-panel="${panel}"`, ic);
  const extLink = (href, cls, inner, label) =>
    `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener" data-act="link"${label ? ` aria-label="${esc(label)}"` : ''}>${inner}</a>`;
  // backlit sign box: the EXIT-sign primary action
  const signBtn = (act, label, extra = '', cls = '') =>
    `<button type="button" class="btn-sign ${cls}" data-act="${act}" ${extra}><span class="bs-l">${label}</span>${icon('arrow', 'bs-ico')}</button>`;
  // one span per letter, so single tubes can misbehave
  const tubeWord = (text, odd = {}) => [...text].map((c, i) =>
    c === ' ' ? '<span class="tl-sp"> </span>' : `<span class="tl${odd[i] ? ' ' + odd[i] : ''}" style="--k:${i}">${esc(c)}</span>`).join('');
  // screw heads for the laminate header plates
  const screws = '<i class="screw screw-l" aria-hidden="true"></i><i class="screw screw-r" aria-hidden="true"></i>';

  const compassTicks = (() => {
    const out = [];
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = -180; d <= 540; d += 15) {
      const n = ((d % 360) + 360) % 360;
      const x = (d + 180) * PX_PER_DEG;
      if (names[n] !== undefined) out.push(`<span class="ct ct-l${n % 90 === 0 ? ' ct-card' : ''}" style="left:${x}px">${names[n]}</span>`);
      else out.push(`<span class="ct ct-t${n % 30 === 0 ? ' ct-m' : ''}" style="left:${x}px"></span>`);
    }
    return out.join('');
  })();

  const vitalRow = (k, label) => `
    <div class="vt" data-vital="${k}">
      <span class="vt-k">${label}</span>
      <span class="vt-bar"><i class="vt-fill"></i></span>
      <span class="vt-n">100</span>
    </div>`;

  const n = o.signs.length || 1;
  const signButtons = o.signs.map((s, i) => {
    const a = (i * 360) / n;
    return `<button type="button" class="sg" data-sign="${esc(s.id)}" data-i="${i}" style="--a:${a}deg" aria-label="${esc(s.label)}">
      <span class="sg-in"><span class="sg-ico">${signIcon(s)}</span><span class="sg-l">${esc(s.label)}</span><span class="sg-k">${i < 9 ? i + 1 : ''}</span></span></button>`;
  }).join('');
  const signArcs = o.signs.map((s, i) => {
    const span = (Math.PI * 2) / n, a0 = -Math.PI / 2 + i * span - span / 2 + 0.012, a1 = a0 + span - 0.024;
    const r1 = 50, r2 = 98;
    const pt = (r, a) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
    const large = span > Math.PI ? 1 : 0;
    return `<path class="arc" data-i="${i}" d="M${pt(r1, a0)}L${pt(r2, a0)}A${r2} ${r2} 0 ${large} 1 ${pt(r2, a1)}L${pt(r1, a1)}A${r1} ${r1} 0 ${large} 0 ${pt(r1, a0)}Z"/>`;
  }).join('');

  root.innerHTML = `
  <div class="dmg" data-r="dmg"></div>

  <div class="hud" data-r="hud" aria-hidden="true">
    <div class="hud-safe">
      <div class="hud-tl hb">
        <div class="hud-sector" data-r="sector">--</div>
        <div class="hud-name" data-r="sectorName"></div>
        <div class="hud-disc" data-r="disc">Unrecorded</div>
        <div class="hud-depth"><span>Depth</span><b data-r="depth">0000</b><span>m</span></div>
      </div>

      <div class="hud-tc">
        <div class="cmp">
          <div class="cmp-win"><div class="cmp-tape" data-r="tape">${compassTicks}</div></div>
          <i class="cmp-notch"></i>
          <span class="cmp-deg" data-r="deg">000</span>
        </div>
      </div>

      <div class="hud-tr hb">
        <div class="hud-row"><i class="pip"></i><b data-r="players">0</b><span>online</span></div>
        <div class="hud-row hud-mic" data-r="mic">${icon('micOff', 'mic-off')}${icon('mic', 'mic-on')}<span data-r="micT">MIC OFF</span></div>
        <div class="hud-row hud-keyhint"><span class="hk">M</span><span>Map</span><span class="hk">R</span><span>Radar</span></div>
        <div class="hud-row hud-fps" data-r="fpsRow"><b data-r="fps">--</b><span>fps</span></div>
      </div>

      <div class="hud-bl hb">
        ${vitalRow('health', 'Integrity')}
        ${vitalRow('sanity', 'Cognition')}
        ${vitalRow('stamina', 'Air')}
        ${vitalRow('battery', 'Cell')}
        <div class="hud-states">
          <span class="hs" data-r="lamp">${icon('flashlight')}<span>Lamp</span></span>
          <span class="hs" data-r="stance">${icon('crouch')}<span>Low</span></span>
        </div>
      </div>

      <div class="hud-br hb" data-r="det">
        <div class="det-k"><span>Anomaly</span><i class="det-blink"></i></div>
        <div class="det-m"><i class="det-track"></i><i class="det-fill" data-r="detFill"></i></div>
      </div>

      <div class="toasts" data-r="toasts"></div>
      <div class="prompt" data-r="prompt"><span class="kc" data-r="promptKey">E</span><span class="prompt-t" data-r="promptText"></span></div>
    </div>
    <div class="reticle"></div>
    <div class="disc-stage" data-r="discStage"></div>
  </div>

  <div class="subtitle" data-r="subtitle"><span data-r="subtitleT"></span></div>
  <div class="sr-only" aria-live="polite" data-r="live"></div>

  <div class="touch" data-r="touch" aria-hidden="true">
    <div class="stick" data-r="stick"><i class="stick-ring"></i><i class="stick-knob" data-r="knob"></i></div>
    <button type="button" class="tb tb-pause" data-touch="pause" aria-label="Pause">${icon('pause')}</button>
    <button type="button" class="tb tb-roster" data-touch="roster" aria-label="Players">${icon('people')}</button>
    <button type="button" class="tb tb-map" data-touch="map" aria-label="Map">${icon('map')}</button>
    <button type="button" class="tb tb-radar" data-touch="radar" aria-label="Radar">${icon('radar')}</button>
    <button type="button" class="tb tb-voice" data-touch="voice" aria-label="Talk">${icon('mic')}</button>
    <div class="tb-cluster">
      <button type="button" class="tb tb-light" data-touch="flashlight" aria-label="Flashlight">${icon('flashlight')}</button>
      <button type="button" class="tb tb-crouch" data-touch="crouch" aria-label="Crouch">${icon('crouch')}</button>
      <button type="button" class="tb tb-sign" data-touch="sign" aria-label="Chalk sign">${icon('chalk')}</button>
      <button type="button" class="tb tb-use" data-touch="interact" aria-label="Interact">${icon('interact')}</button>
    </div>
  </div>

  <div class="roster layer" data-r="roster" aria-hidden="true">
    <div class="roster-card plate">
      ${screws}
      <div class="roster-col">
        <p class="roster-h"><b data-r="rOnline">0</b> online</p>
        <ol class="rlist" data-r="rPlayers"></ol>
      </div>
      <div class="roster-col">
        <p class="roster-h">Most sectors</p>
        <ol class="rlist" data-r="rBoard"></ol>
      </div>
    </div>
    <p class="roster-hint">Release Tab to close</p>
  </div>

  <div class="signs layer" data-r="signs" role="dialog" aria-modal="true" aria-label="Leave a chalk sign">
    <div class="wheel" data-r="wheel" style="--n:${n}">
      <svg class="wheel-svg" viewBox="-100 -100 200 200" aria-hidden="true" focusable="false">
        <defs><filter id="l0-chalk"><feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="1" seed="4"/><feDisplacementMap in="SourceGraphic" scale="1.6"/></filter></defs>
        <circle class="wheel-bg" r="99"/>
        <circle class="wheel-rim" r="97.5"/>
        ${signArcs}
        <circle class="wheel-hub" r="46"/>
      </svg>
      ${signButtons}
      <button type="button" class="wheel-center" data-act="signs-cancel" aria-label="Cancel">
        <span class="wc-l" data-r="signLabel">Pick a mark</span>
        <span class="wc-h">${n > 1 ? `1 to ${Math.min(n, 9)}` : '1'} &middot; Esc</span>
      </button>
    </div>
  </div>

  <!-- TITLE -->
  <section class="screen scr-title layer" data-screen="title" role="dialog" aria-modal="true" aria-labelledby="l0-wm">
    <div class="scrim scrim-title"></div>
    <div class="title-grid">
      <header class="title-top rv" style="--i:0">
        <div class="chip" data-r="chip" hidden><img alt="" data-r="avatar" width="28" height="28" decoding="async"><span data-r="uname"></span></div>
        <div class="online"><i class="pip"></i><b data-r="onlineT">0</b><span>online</span></div>
      </header>

      <main class="title-main">
        <h1 class="wordmark" id="l0-wm" aria-label="Level 0"><span class="tw" aria-hidden="true">${tubeWord('LEVEL 0', { 3: 'wm-e', 6: 'wm-0' })}</span></h1>
        <p class="tagline rv" style="--i:1">You are not supposed to be here.</p>

        ${lou15 ? `
        <div class="onboard rv" style="--i:2">
          <label class="field">
            <span class="field-k">Name on the suit</span>
            <span class="nameplate">${screws}<input type="text" data-r="name" maxlength="16" autocomplete="nickname" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="2 to 16 characters" aria-describedby="l0-name-hint"></span>
            <span class="field-h" id="l0-name-hint" data-r="nameHint">Letters, digits, space, _ and -</span>
          </label>
          <label class="check">
            <input type="checkbox" data-r="adult">
            <span class="box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></span>
            <span class="check-l">I am 13 or older and fine with horror content</span>
          </label>
        </div>` : ''}

        <div class="status rv" style="--i:3" data-r="statusWrap">
          <span class="status-bar" data-r="statusBar" aria-hidden="true"><i data-r="progress"></i></span>
          <span class="status-t" data-r="status" role="status"></span>
        </div>

        <div class="enter-row rv" style="--i:4">
          <button type="button" class="btn-sign btn-enter" data-act="play" data-r="enter" data-autofocus>
            <span class="bs-l" data-r="enterL">Enter</span>${icon('arrow', 'bs-ico')}
          </button>
          <span class="enter-note" data-r="enterNote"></span>
        </div>

        <nav class="title-menu rv" style="--i:5" aria-label="Menu">
          ${panelBtn('settings', 'Settings')}
          ${menuItem('map', 'Map')}
          ${panelBtn('catalog', 'Catalog')}
          ${panelBtn('leaderboard', 'Leaderboard')}
          ${panelBtn('howto', 'How to play')}
          ${panelBtn('credits', 'Credits')}
        </nav>

        <p class="title-stats rv" style="--i:6" data-r="stats" hidden></p>
      </main>

      <footer class="title-foot rv" style="--i:7">
        <div class="foot-links">
          ${extLink(o.repoUrl, 'foot-link tube', `<span class="fl-h">${icon('code', 'fl-ico')}<span>Source code</span>${icon('external', 'ext')}</span><span class="fl-s">Open source. Contributions welcome.</span>`)}
          ${extLink(o.donateUrl, 'foot-link tube', `<span class="fl-h">${icon('pizza', 'fl-ico')}<span>Buy me a pizza</span>${icon('external', 'ext')}</span><span class="fl-s">Made by one person. Pizza keeps the lights on.</span>`)}
        </div>
        <div class="foot-meta">
          <span class="cnote">Horror. Flashing lights. Headphones recommended.</span>
          <span class="foot-row">
            <span>v${esc(o.version)}</span>
            ${lou15 ? '' : `<span class="websim" data-r="websim"><img src="assets/websim-logo.png" alt="made on websim" data-r="websimImg" height="26"><span class="websim-t" data-r="websimT" hidden>made on websim</span></span>`}
          </span>
        </div>
      </footer>
    </div>
  </section>

  <!-- PAUSE -->
  <section class="screen scr-pause layer" data-screen="pause" role="dialog" aria-modal="true" aria-labelledby="l0-pause-h">
    <div class="scrim scrim-pause"></div>
    <div class="pause-grid">
      <div class="pause-col">
        <h2 class="scr-h pause-h" id="l0-pause-h" aria-label="Paused"><span class="tw" aria-hidden="true">${tubeWord('Paused', { 4: 'wm-e' })}</span></h2>
        <p class="pause-sub rv" style="--i:1">The world does not pause.</p>
        <div class="pause-go rv" style="--i:2">${signBtn('resume', 'Resume', 'data-autofocus')}</div>
        <nav class="mlist rv" style="--i:3" aria-label="Pause menu">
          ${menuItem('map', 'Map', '', 'map')}
          ${panelBtn('settings', 'Settings', 'sliders')}
          ${panelBtn('catalog', 'Catalog', 'catalog')}
          ${panelBtn('leaderboard', 'Leaderboard', 'board')}
          ${panelBtn('players', 'Players', 'people')}
          ${panelBtn('howto', 'Controls', 'keys')}
          ${panelBtn('credits', 'Credits', 'help')}
          <span class="mlist-gap" aria-hidden="true"></span>
          ${extLink(o.repoUrl, 'mi tube mi-ext', `${icon('code', 'mi-ico')}<span class="mi-l">Source code</span>${icon('external', 'ext')}`, 'Source code, opens in a new tab')}
          ${extLink(o.donateUrl, 'mi tube mi-ext', `${icon('pizza', 'mi-ico')}<span class="mi-l">Buy me a pizza</span>${icon('external', 'ext')}`, 'Buy me a pizza, opens in a new tab')}
          <span class="mlist-gap" aria-hidden="true"></span>
          ${menuItem('quit', 'Quit to title', '', 'quit')}
        </nav>
      </div>
      <aside class="pause-side rv" style="--i:4" aria-label="Last known position">
        <p class="ps-sector" data-r="psSector">--</p>
        <p class="ps-name" data-r="psName"></p>
        <p class="ps-disc" data-r="psDisc"></p>
        <p class="ps-meta"><span data-r="psDepth">0 m</span> from where you came in</p>
      </aside>
    </div>
  </section>

  <!-- DEATH -->
  <section class="screen scr-death layer" data-screen="death" role="alertdialog" aria-modal="true" aria-labelledby="l0-death-h" aria-describedby="l0-death-cause">
    <div class="scrim scrim-death"></div>
    <div class="death-wrap">
      <h2 class="scr-h death-h" id="l0-death-h" aria-label="Signal lost"><span class="tw" aria-hidden="true">${tubeWord('Signal lost', { 2: 't-fail', 7: 't-dead', 9: 't-fail2' })}</span></h2>
      <p class="death-cause rv" style="--i:1" id="l0-death-cause" data-r="cause"></p>
      <dl class="tele rv" style="--i:2" data-r="deathTele"></dl>
      <div class="death-act rv" style="--i:3">
        ${signBtn('respawn', 'Respawn', 'data-autofocus')}
        <span class="fine">A new suit is ready.</span>
      </div>
    </div>
  </section>

  <!-- ESCAPE -->
  <section class="screen scr-escape layer" data-screen="escape" role="dialog" aria-modal="true" aria-labelledby="l0-esc-h">
    <div class="scrim scrim-escape"></div>
    <div class="escape-wrap">
      <h2 class="scr-h escape-h" id="l0-esc-h" aria-label="Outside."><span class="tw" aria-hidden="true">${tubeWord('Outside.')}</span></h2>
      <p class="escape-sub rv" style="--i:1">It is very quiet here. You do not remember the door.</p>
      <dl class="tele rv" style="--i:2" data-r="escTele"></dl>
      <div class="death-act rv" style="--i:3">${signBtn('respawn', 'Go back in', 'data-autofocus', 'btn-day')}</div>
    </div>
  </section>

  <!-- PANELS -->
  ${sheet('settings', 'Settings', `<div class="settings" data-r="settingsBody"></div>`)}
  ${sheet('catalog', 'Catalog', `<p class="sheet-lead" data-r="catLead"></p><div data-r="catPlaces"></div><div data-r="catEnts"></div><h3 class="cat-h" data-r="catObjH">Objects</h3><div class="cat-grid" data-r="catGrid"></div>`)}
  ${sheet('leaderboard', 'Leaderboard', `<div data-r="boardBody"></div>`)}
  ${sheet('players', 'Players', `<div data-r="playersBody"></div>`)}
  ${sheet('howto', 'How to play', howtoHtml())}
  ${sheet('credits', 'Credits', `<div data-r="creditsBody"></div>`)}
  `;

  function sheet(name, title, body) {
    return `
    <div class="sheet layer" data-panel="${name}" role="dialog" aria-modal="true" aria-labelledby="l0-p-${name}">
      <div class="sheet-scrim" data-act="back"></div>
      <div class="sheet-card plate">
        <header class="sheet-head">
          ${screws}
          <button type="button" class="icon-btn sheet-back" data-act="back" aria-label="Back">${icon('back')}</button>
          <h2 class="sheet-ttl" id="l0-p-${name}">${title}</h2>
          <button type="button" class="icon-btn sheet-close" data-act="back" aria-label="Close">${icon('close')}</button>
        </header>
        <div class="sheet-body">${body}</div>
      </div>
    </div>`;
  }

  function howtoHtml() {
    const rows = [
      [['W', 'A', 'S', 'D'], 'Move'], [['Mouse'], 'Look'], [['Shift'], 'Sprint'], [['C', 'Ctrl'], 'Crouch'],
      [['F'], 'Flashlight'], [['E'], 'Interact'], [['Q'], 'Leave a chalk sign'], [['V'], 'Hold to talk'],
      [['M'], 'Survey map'], [['R'], 'Handheld radar and map'], [['Tab'], 'Players'], [['Esc'], 'Pause'],
    ];
    const keys = (ks) => ks.map((k, i) => `${i && ks.length === 2 ? '<span class="or">or</span>' : ''}<kbd>${k}</kbd>`).join('');
    const touchRows = [['Left thumb', 'Move. Push to the edge to sprint'], ['Right side', 'Drag to look'], ['Buttons', 'Light, crouch, chalk, interact']];
    const rules = [
      ['Stay in the light.', 'Your cell drains. Darkness is where it goes wrong.'],
      ['Sprinting is loud.', 'Air runs out, and things hear you breathing.'],
      ['Some things only move when you are not looking.', 'Keep them in view.'],
      ['Not everything is hunted the same way.', 'Some chase what runs. Some want you to look away. The Catalog keeps notes on what you have met.'],
      ['Level 0 is not the only level.', 'Walk far enough and the wallpaper gives way to something else. The exit is a long way in.'],
      ['Drink almond water to keep your head.', 'Cognition slips the longer you stay.'],
      ['Everyone shares this one world.', 'The first person to enter a sector is recorded forever.'],
    ];
    return `
      <div class="howto">
        <section class="ht-sec">
          <h3 class="ht-h">Controls</h3>
          <table class="ctl"><tbody>${rows.map(([k, a]) => `<tr><td class="ctl-k">${keys(k)}</td><td>${a}</td></tr>`).join('')}</tbody></table>
          <div class="ht-touch">
            <h3 class="ht-h">Touch screens</h3>
            <table class="ctl"><tbody>${touchRows.map(([k, a]) => `<tr><td class="ctl-k"><span class="tk">${k}</span></td><td>${a}</td></tr>`).join('')}</tbody></table>
          </div>
        </section>
        <section class="ht-sec">
          <h3 class="ht-h">Survival</h3>
          <ul class="rules">${rules.map(([a, b]) => `<li><p><b>${a}</b> ${b}</p></li>`).join('')}</ul>
        </section>
      </div>`;
  }

  /* ------------------------------------------------------- refs */
  const $ = (sel) => root.querySelector(sel);
  const R = {};
  root.querySelectorAll('[data-r]').forEach((el) => { R[el.dataset.r] = el; });
  const screens = {};
  root.querySelectorAll('[data-screen]').forEach((el) => { screens[el.dataset.screen] = el; });
  const sheets = {};
  root.querySelectorAll('.sheet[data-panel]').forEach((el) => { sheets[el.dataset.panel] = el; });
  const vit = {};
  root.querySelectorAll('[data-vital]').forEach((el) => {
    vit[el.dataset.vital] = { el, fill: el.querySelector('.vt-fill'), n: el.querySelector('.vt-n') };
  });
  const allLayers = [...Object.values(screens), ...Object.values(sheets), R.signs, R.roster];
  allLayers.forEach((l) => l.setAttribute('inert', ''));

  /* websim logo fallback */
  if (R.websimImg) {
    const fail = () => { R.websimImg.remove(); R.websimT.hidden = false; };
    R.websimImg.addEventListener('error', fail, { once: true });
    if (R.websimImg.complete && R.websimImg.naturalWidth === 0) fail();
  }

  /* --------------------------------------------- layer management */
  function setOpen(el, open) {
    if (!el) return;
    el.classList.toggle('is-open', open);
    if (open) el.removeAttribute('inert'); else el.setAttribute('inert', '');
  }
  function topLayer() {
    if (st.signs) return R.signs;
    if (st.panels.length) return sheets[st.panels[st.panels.length - 1]];
    return screens[st.screen] || null;
  }
  function focusIn(layer) {
    if (!layer) return;
    const go = () => {
      const vis = (x) => x && x.getClientRects().length > 0;
      const auto = layer.querySelector('[data-autofocus]:not([disabled])');
      const t = vis(auto) ? auto : [...layer.querySelectorAll(FOCUSABLE)].find(vis);
      if (t) t.focus({ preventScroll: true });
    };
    go();
    if (!layer.contains(document.activeElement)) requestAnimationFrame(go);
  }
  function refresh() {
    const blocking = st.screen !== 'none' || st.panels.length > 0 || st.signs;
    // base screens stay visible under panels but go inert
    for (const [name, el] of Object.entries(screens)) {
      const vis = st.screen === name;
      el.classList.toggle('is-open', vis);
      if (vis && !st.panels.length && !st.signs) el.removeAttribute('inert'); else el.setAttribute('inert', '');
    }
    root.classList.toggle('has-panel', st.panels.length > 0);
    for (const [name, el] of Object.entries(sheets)) {
      const idx = st.panels.indexOf(name);
      const top = idx === st.panels.length - 1 && idx >= 0;
      el.classList.toggle('is-open', idx >= 0);
      if (top) el.removeAttribute('inert'); else el.setAttribute('inert', '');
    }
    setOpen(R.signs, st.signs);
    R.roster.classList.toggle('is-open', st.roster && !blocking);
    const hudOn = st.inGame && (st.screen === 'none' || st.screen === 'pause');
    R.hud.classList.toggle('is-on', hudOn);
    R.hud.classList.toggle('is-dim', st.screen === 'pause' || st.signs);
    root.classList.toggle('in-game', st.inGame && st.screen === 'none');
    const touchOn = touch.enabled && st.inGame && !blocking;
    R.touch.classList.toggle('is-on', touchOn);
    if (!touchOn) { endStick(); lookPointer = null; }
    R.touch.querySelector('.tb-voice').hidden = !settings.voice;
    root.classList.toggle('show-fps', !!settings.showFps);
    root.classList.toggle('voice-on', !!settings.voice);
    root.classList.toggle('touch-dev', touch.enabled);
    root.classList.toggle('reduce-visor', !settings.visor);
  }

  function openPanel(name) {
    if (!sheets[name]) return;
    if (name === 'catalog') renderCatalog();
    if (name === 'leaderboard') renderBoard();
    if (name === 'players') renderPlayers();
    if (name === 'credits') renderCredits();
    st.returnFocus.push(document.activeElement);
    st.panels.push(name);
    refresh();
    const body = sheets[name].querySelector('.sheet-body');
    if (body) body.scrollTop = 0;
    focusIn(sheets[name]);
  }
  function closePanel() {
    if (!st.panels.length) return false;
    st.panels.pop();
    refresh();
    const back = st.returnFocus.pop();
    const layer = topLayer();
    if (back && layer && layer.contains(back) && document.contains(back)) back.focus({ preventScroll: true });
    else focusIn(layer);
    return true;
  }
  function showScreen(name) {
    st.screen = name;
    st.panels = [];
    st.returnFocus = [];
    st.signs = false;
    refresh();
    if (name !== 'none') focusIn(screens[name]);
    else if (root.contains(document.activeElement)) document.activeElement.blur();
  }

  /* ----------------------------------------------- input modality */
  window.addEventListener('keydown', () => { st.keyboard = true; }, true);
  window.addEventListener('pointerdown', () => { st.keyboard = false; }, true);

  /* hover sounds: once per element entry, mouse only */
  let hoverEl = null;
  const HOVERABLE = 'button, a[href], [role="switch"], input[type="range"], input[type="checkbox"], .sg';
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest(HOVERABLE);
    if (el === hoverEl) return;
    hoverEl = el;
    if (el && !el.disabled && root.contains(el)) emit('ui', 'hover');
  });
  root.addEventListener('pointerleave', () => { hoverEl = null; });
  root.addEventListener('focusin', (e) => {
    if (!st.keyboard) return;
    if (e.target.matches && e.target.matches(HOVERABLE + ', input')) emit('ui', 'hover');
  });

  /* ------------------------------------------------ click routing */
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const act = el.dataset.act;
    if (act === 'link') { emit('ui', 'click'); return; } // native navigation in a new tab
    if (act === 'back') { e.preventDefault(); emit('ui', 'back'); closePanel(); return; }
    if (act === 'signs-cancel') { emit('ui', 'back'); closeSigns(); return; }
    e.preventDefault();
    if (el.disabled) return;
    if (act === 'play') { tryPlay(); return; }
    emit('ui', 'click');
    if (act === 'panel') openPanel(el.dataset.panel);
    else if (act === 'resume') emit('resume');
    else if (act === 'respawn') emit('respawn');
    else if (act === 'quit') emit('quit');
    else if (act === 'map') emit('map');
  });

  function canPlay() {
    if (st.screen !== 'title') return false;
    if (st.progress != null && st.progress < 1) return false;
    if (lou15 && !(validName(R.name.value) && R.adult.checked)) return false;
    return true;
  }
  function tryPlay() {
    if (!canPlay()) return;
    const name = lou15 ? R.name.value.trim() : (st.title.username || '');
    if (lou15) { profile.name = name; profile.adult = true; save(PROFILE_KEY, profile); }
    emit('ui', 'click');
    emit('play', { name }); // synchronous, still inside the user gesture
  }
  function validName(v) { const t = String(v || '').trim(); return NAME_RE.test(t) && t.length >= 2; }
  function updateEnter() {
    const loading = st.progress != null && st.progress < 1;
    let ok = !loading;
    if (lou15) {
      const nm = R.name.value;
      const nameOk = validName(nm);
      ok = ok && nameOk && R.adult.checked;
      R.nameHint.classList.toggle('bad', nm.trim().length > 0 && !nameOk);
      R.nameHint.textContent = nm.trim().length > 0 && !nameOk ? '2 to 16 letters, digits, space, _ or -' : 'Letters, digits, space, _ and -';
    }
    R.enter.disabled = !ok;
    R.enter.classList.toggle('is-loading', loading);
  }
  if (lou15) {
    R.name.value = typeof profile.name === 'string' ? profile.name.slice(0, 16) : '';
    R.adult.checked = !!profile.adult;
    R.name.addEventListener('input', () => {
      updateEnter();
      if (validName(R.name.value)) { profile.name = R.name.value.trim(); save(PROFILE_KEY, profile); }
    });
    R.adult.addEventListener('change', () => {
      emit('ui', 'click');
      profile.adult = R.adult.checked; save(PROFILE_KEY, profile);
      updateEnter();
    });
  }

  /* ----------------------------------------------------- keyboard */
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const k = e.key;
    // sign wheel
    if (st.signs) {
      if (k === 'Escape' || k === 'q' || k === 'Q') { e.preventDefault(); emit('ui', 'back'); closeSigns(); return; }
      const d = parseInt(k, 10);
      if (d >= 1 && d <= Math.min(9, o.signs.length)) { e.preventDefault(); pickSign(d - 1); return; }
      if ((k === 'Enter' || k === ' ') && wheelSel >= 0 && !(document.activeElement && document.activeElement.classList.contains('sg'))) { e.preventDefault(); pickSign(wheelSel); return; }
      if (k.startsWith('Arrow')) {
        e.preventDefault();
        const step = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1;
        const next = ((wheelSel < 0 ? (step > 0 ? -1 : 0) : wheelSel) + step + o.signs.length) % o.signs.length;
        setWheelSel(next);
        const b = R.wheel.querySelector(`.sg[data-i="${next}"]`);
        if (b) b.focus({ preventScroll: true });
        return;
      }
      return;
    }
    if (k === 'Escape') {
      if (st.panels.length) { e.preventDefault(); emit('ui', 'back'); closePanel(); return; }
      if (st.screen === 'pause' && performance.now() - st.pauseAt > 900) {
        // the browser refuses pointer lock right after Esc released it, so give it a moment
        e.preventDefault(); emit('ui', 'click'); emit('resume'); return;
      }
      return;
    }
    const layer = topLayer();
    if (!layer || !st.menuVisible) return;
    const ae = document.activeElement;
    const tag = ae && ae.tagName;
    const typing = tag === 'INPUT' && (ae.type === 'text' || ae.type === 'range');
    if (k === 'Enter' && st.screen === 'title' && !st.panels.length) {
      if (!ae || ae === document.body || !layer.contains(ae) || (tag === 'INPUT' && ae.type !== 'range')) {
        e.preventDefault(); tryPlay(); return;
      }
    }
    if (!typing && (k === 'ArrowDown' || k === 'ArrowUp' || ((k === 'ArrowLeft' || k === 'ArrowRight') && !(ae && ae.closest && ae.closest('.seg'))))) {
      const list = [...layer.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null && !x.closest('[inert]') && !x.classList.contains('sheet-scrim'));
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(ae);
      const dir = k === 'ArrowDown' || k === 'ArrowRight' ? 1 : -1;
      const next = list[i < 0 ? 0 : (i + dir + list.length) % list.length];
      next.focus({ preventScroll: false });
    }
  });
  Object.defineProperty(st, 'menuVisible', { get: () => st.screen !== 'none' || st.panels.length > 0 });

  /* ======================================================= TITLE */
  function setOnline(nn) {
    const v = Math.max(0, Math.round(num(nn)));
    st.online = v;
    R.onlineT.textContent = String(v);
    R.rOnline.textContent = String(v);
  }
  function renderStats() {
    const s = st.title.stats;
    if (!s || !Object.values(s).some((v) => num(v) > 0)) { R.stats.hidden = true; return; }
    const total = o.artifacts.length;
    const plural = (v, one, many) => `<b>${v}</b> ${v === 1 ? one : many}`;
    const items = [
      plural(num(s.sectors), 'sector', 'sectors'),
      total ? `<b>${num(s.artifacts)}</b> of ${total} artifacts` : plural(num(s.artifacts), 'artifact', 'artifacts'),
      plural(num(s.escapes), 'escape', 'escapes'),
      plural(num(s.deaths), 'death', 'deaths'),
      `<b>${Math.round(num(s.farthest))} m</b> farthest`,
    ];
    R.stats.innerHTML = items.map((v) => `<span>${v}</span>`).join(' ');
    R.stats.hidden = false;
  }
  function showTitle(info = {}) {
    st.title = { ...st.title, ...info };
    st.inGame = false;
    const t = st.title;
    if (!lou15 && t.username) {
      R.chip.hidden = false;
      R.uname.textContent = at(t.username);
      if (t.avatarUrl) { R.avatar.src = t.avatarUrl; R.avatar.hidden = false; } else R.avatar.hidden = true;
      R.avatar.onerror = () => { R.avatar.hidden = true; };
    } else R.chip.hidden = true;
    if (t.online != null) setOnline(t.online);
    R.enterL.textContent = t.hasSave ? 'Continue' : 'Enter';
    R.enterNote.textContent = t.hasSave ? 'Last position kept.' : '';
    renderStats();
    updateEnter();
    clearToasts();
    showScreen('title');
    prompt(null);
  }
  function setTitleStatus(text, progress) {
    st.status = text == null ? '' : String(text);
    R.status.textContent = st.status;
    const p = progress == null || !Number.isFinite(+progress) ? null : clamp(+progress, 0, 1);
    st.progress = p;
    R.statusWrap.classList.toggle('has-bar', p != null && p < 1);
    R.statusWrap.classList.toggle('is-done', p != null && p >= 1);
    R.progress.style.transform = `scaleX(${p == null ? 0 : p})`;
    updateEnter();
  }

  /* ========================================================= HUD */
  const prev = Object.create(null);
  const changed = (k, v) => { if (prev[k] === v) return false; prev[k] = v; return true; };
  const setText = (el, k, v) => { if (changed(k, v)) el.textContent = v; };

  function setHud(d) {
    if (!d) return;
    for (const k of ['health', 'sanity', 'stamina', 'battery']) {
      if (!(k in d)) continue;
      const v = clamp(num(d[k], 1), 0, 1);
      const q = Math.ceil(v * SEG - 0.001);
      const r = vit[k];
      if (changed(k + ':q', q)) r.fill.style.clipPath = `inset(0 ${((SEG - q) / SEG) * 100}% 0 0 round 3px)`;
      setText(r.n, k + ':n', pad(v * 100, 3));
      const low = v < 0.25;
      if (changed(k + ':low', low)) r.el.classList.toggle('low', low);
    }
    if ('flashlight' in d && changed('flashlight', !!d.flashlight)) R.lamp.classList.toggle('on', !!d.flashlight);
    if ('crouch' in d && changed('crouch', !!d.crouch)) R.stance.classList.toggle('on', !!d.crouch);
    if ('mic' in d && changed('mic', !!d.mic)) {
      R.mic.classList.toggle('on', !!d.mic);
      R.micT.textContent = d.mic ? 'TRANSMITTING' : 'MIC OFF';
    }
    if ('sector' in d) { st.hud.sector = d.sector; setText(R.sector, 'sector', String(d.sector ?? '--')); }
    if ('sectorName' in d) { st.hud.sectorName = d.sectorName; if (!ghosting) setText(R.sectorName, 'sectorName', String(d.sectorName ?? '')); }
    if ('discoverer' in d) {
      st.hud.discoverer = d.discoverer;
      const who = d.discoverer ? `FIRST ENTERED BY ${at(d.discoverer).toUpperCase()}` : 'UNRECORDED';
      if (changed('disc', who)) { R.disc.textContent = who; R.disc.classList.toggle('none', !d.discoverer); }
    }
    if ('depth' in d) {
      const m = Math.max(0, Math.round(num(d.depth)));
      st.hud.depth = m;
      setText(R.depth, 'depth', m > 9999 ? String(m) : pad(m, 4));
    }
    if ('players' in d) { const p = Math.max(0, Math.round(num(d.players))); st.hud.players = p; if (!ghosting) setText(R.players, 'players', String(p)); }
    if ('detector' in d) {
      const v = clamp(num(d.detector), 0, 1);
      const q = v <= 0.001 ? 0 : Math.max(1, Math.ceil(v * DET_TICKS - 0.001));
      if (changed('det:q', q)) {
        R.det.classList.toggle('on', q > 0);
        R.det.classList.toggle('hot', q >= DET_TICKS * 0.75);
        R.detFill.style.clipPath = `inset(0 ${((DET_TICKS - q) / DET_TICKS) * 100}% 0 0)`;
      }
    }
    if ('heading' in d) {
      const deg = ((((num(d.heading) * 180) / Math.PI) % 360) + 360) % 360;
      const q = Math.round(deg * 2) / 2;
      if (changed('heading', q)) {
        R.tape.style.transform = `translate3d(${(-(q + 180) * PX_PER_DEG).toFixed(1)}px,0,0)`;
        R.deg.textContent = pad(Math.round(q) % 360, 3);
      }
    }
  }

  function setFps(v) {
    if (!settings.showFps) return;
    setText(R.fps, 'fps', String(Math.round(num(v))));
  }

  /* prompt */
  function prompt(key, text) {
    const on = key != null && key !== false && (text != null || key);
    if (on) {
      setText(R.promptKey, 'pk', String(key));
      setText(R.promptText, 'pt', String(text ?? ''));
    }
    if (changed('prompt', !!on)) {
      R.prompt.classList.toggle('on', !!on);
      R.touch.classList.toggle('can-use', !!on);
    }
    st.prompt = !!on;
  }

  /* toasts */
  const toastQ = [];
  let toastLive = [];
  const discQ = [];
  let discBusy = false;
  const toastIcon = { artifact: 'catalog', danger: 'danger', info: 'dot', discover: 'dot' };
  function toast(t) {
    if (!t) return;
    const kind = ['discover', 'artifact', 'info', 'danger'].includes(t.kind) ? t.kind : 'info';
    R.live.textContent = [t.title, t.sub].filter(Boolean).join('. ');
    if (kind === 'discover') { discQ.push(t); pumpDisc(); return; }
    toastQ.push({ ...t, kind });
    if (toastQ.length > 8) toastQ.splice(0, toastQ.length - 8);
    pumpToasts();
  }
  function pumpToasts() {
    while (toastLive.length < 2 && toastQ.length) {
      const t = toastQ.shift();
      const dur = t.kind === 'danger' ? 5200 : t.kind === 'artifact' ? 5600 : 4200;
      const el = document.createElement('div');
      el.className = `toast k-${t.kind}`;
      el.style.setProperty('--d', `${dur}ms`);
      el.innerHTML = `<span class="toast-ico">${icon(toastIcon[t.kind])}</span>
        <span class="toast-b"><span class="toast-t">${esc(t.title || '')}</span>${t.sub ? `<span class="toast-s">${esc(t.sub)}</span>` : ''}</span>
        <i class="toast-time"></i>`;
      R.toasts.appendChild(el);
      toastLive.push(el);
      el._t = setTimeout(() => dismissToast(el), dur);
    }
  }
  function dismissToast(el) {
    if (el._gone) return;
    el._gone = true;
    el.classList.add('out');
    setTimeout(() => {
      el.remove();
      toastLive = toastLive.filter((x) => x !== el);
      pumpToasts();
    }, reduced ? 10 : 420);
  }
  function clearToasts() {
    toastQ.length = 0; discQ.length = 0;
    toastLive.forEach((el) => { clearTimeout(el._t); el.remove(); });
    toastLive = [];
    R.discStage.textContent = '';
    discBusy = false;
  }
  function pumpDisc() {
    if (discBusy || !discQ.length) return;
    discBusy = true;
    const t = discQ.shift();
    const d = new Date();
    const stamp = `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
    const head = String(t.title || 'New sector').toUpperCase();
    // each letter is a tube that strikes on its own, in a slightly uneven order
    const r = rng(hash(head + stamp));
    const letters = [...head].map((c, i) => (c === ' '
      ? '<span class="tl-sp"> </span>'
      : `<span class="tl" style="--c:${(i * 70 + r() * 160).toFixed(0)}ms">${esc(c)}</span>`)).join('');
    const where = [st.hud.sector, st.hud.sectorName].filter(Boolean).map(esc).join(' &middot; ');
    const el = document.createElement('div');
    el.className = 'disc';
    el.innerHTML = `
      <span class="disc-t" aria-hidden="true">${letters}</span>
      <i class="disc-rule"></i>
      ${t.sub ? `<span class="disc-s">${esc(t.sub)}</span>` : ''}
      <span class="disc-f">${where ? `${where}. ` : ''}Logged ${stamp}. This record does not expire.</span>`;
    R.discStage.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => { el.remove(); discBusy = false; pumpDisc(); }, reduced ? 10 : 900);
    }, 6400);
  }

  /* subtitle */
  let subT = 0;
  function subtitle(text, ms = 4000) {
    clearTimeout(subT);
    if (!text) { R.subtitle.classList.remove('on'); return; }
    R.subtitleT.textContent = String(text);
    R.subtitle.classList.remove('on');
    void R.subtitle.offsetWidth; // restart the fade
    R.subtitle.classList.add('on');
    subT = setTimeout(() => R.subtitle.classList.remove('on'), Math.max(800, num(ms, 4000)));
  }

  /* damage */
  function damage(amount) {
    const a = clamp(num(amount), 0, 1);
    if (a <= 0) return;
    const peak = 0.35 + a * 0.65;
    if (R.dmg.animate) {
      R.dmg.animate([{ opacity: peak }, { opacity: 0 }], { duration: 380 + a * 900, easing: 'cubic-bezier(.15,.7,.3,1)' });
    }
  }

  /* sanity */
  let ghosting = false;
  let ghostTimer = 0;
  function setSanityFx(level) {
    const v = clamp(num(level), 0, 1);
    const q = Math.round(v * 20) / 20;
    if (!changed('sanityFx', q)) return;
    R.hud.style.setProperty('--sanity', q);
    R.hud.classList.toggle('uneasy', q >= 0.45 && !reduced);
    R.hud.classList.toggle('breaking', q >= 0.75);
    if (q >= 0.6 && !ghostTimer) ghostTimer = setInterval(ghostTick, 2300);
    if (q < 0.6 && ghostTimer) { clearInterval(ghostTimer); ghostTimer = 0; }
  }
  const GHOST_NAMES = ['you were here before', 'it is not empty', 'keep walking', 'this one is yours'];
  function ghostTick() {
    if (!st.inGame || st.screen !== 'none' || ghosting || Math.random() > 0.45) return;
    ghosting = true;
    const which = Math.random();
    if (which < 0.5) {
      const p = st.hud.players ?? 0;
      R.players.textContent = String(p + 1);
      setTimeout(() => { R.players.textContent = String(st.hud.players ?? p); prev.players = String(st.hud.players ?? p); ghosting = false; }, 520);
    } else {
      R.sectorName.textContent = GHOST_NAMES[Math.floor(Math.random() * GHOST_NAMES.length)];
      R.sectorName.classList.add('ghost');
      setTimeout(() => {
        R.sectorName.classList.remove('ghost');
        R.sectorName.textContent = String(st.hud.sectorName ?? '');
        prev.sectorName = R.sectorName.textContent;
        ghosting = false;
      }, 260);
    }
  }

  /* ========================================================= OVERLAYS */
  function showPause(on) {
    if (on) {
      R.psSector.textContent = st.hud.sector || '--';
      R.psName.textContent = st.hud.sectorName || '';
      R.psDisc.textContent = st.hud.discoverer ? `First entered by ${at(st.hud.discoverer)}` : 'Unrecorded';
      R.psDepth.textContent = `${st.hud.depth ?? 0} m`;
      st.pauseAt = performance.now();
      showScreen('pause');
    } else if (st.screen === 'pause') {
      showScreen('none');
    }
  }
  function teleRows(rows) {
    return rows.map(([k, v]) => `<div><dt>${k}</dt><i aria-hidden="true"></i><dd>${v}</dd></div>`).join('');
  }
  function showDeath(info = {}) {
    R.cause.innerHTML = `<span class="cause-k">Cause</span> <span class="cause-v">${esc(info.cause || 'Unknown')}</span>`;
    R.deathTele.innerHTML = teleRows([
      ['Sectors crossed', esc(num(info.sectors))],
      ['Time inside', esc(fmtTime(info.time))],
      ['Artifacts carried', esc(num(info.artifacts))],
    ]);
    st.roster = false;
    prompt(null);
    showScreen('death');
  }
  function showEscape(info = {}) {
    R.escTele.innerHTML = teleRows([
      ['Sectors crossed', esc(num(info.sectors))],
      ['Time inside', esc(fmtTime(info.time))],
      ['Times out', esc(num(info.escapes))],
    ]);
    st.roster = false;
    prompt(null);
    showScreen('escape');
  }
  function hideOverlays() {
    if (['pause', 'death', 'escape'].includes(st.screen) || st.panels.length) showScreen(st.screen === 'title' ? 'title' : 'none');
  }
  function enterGame() {
    st.inGame = true;
    clearToasts();
    showScreen('none');
    R.hud.classList.remove('boot');
    void R.hud.offsetWidth;
    R.hud.classList.add('boot');
  }

  /* -------------------------------------------------- catalog */
  function setCatalog(ids) {
    st.found = new Set((ids || []).map(String));
    if (st.panels.includes('catalog')) renderCatalog();
    renderStats();
  }
  // Levels walked and entities met (kept in the save, like the objects).
  function setJournal(j) {
    st.places = new Set(((j && j.places) || []).map(Number));
    st.met = new Set(((j && j.entities) || []).map(String));
    if (st.panels.includes('catalog')) renderCatalog();
  }
  function renderJournal() {
    const places = Array.isArray(o.places) ? o.places : [], ents = Array.isArray(o.entities) ? o.entities : [];
    const seenP = st.places || new Set([0]), seenE = st.met || new Set();
    const row = (known, tag, name, text) => (known
      ? `<li class="note known"><span class="note-tag">${esc(tag)}</span><span class="note-n">${esc(name)}</span><span class="note-d">${esc(text)}</span></li>`
      : `<li class="note" aria-label="${esc(tag)}, unrecorded"><span class="note-tag">${esc(tag)}</span><span class="note-n">Unrecorded</span><span class="note-d redact" aria-hidden="true"><i style="width:${52 + (hash(tag) % 36)}%"></i></span></li>`);
    R.catPlaces.innerHTML = places.length ? `<h3 class="cat-h">Levels <span class="cat-c">${places.filter((p) => seenP.has(p.id)).length} of ${places.length}</span></h3>
      <ul class="notes">${places.map((p) => row(seenP.has(p.id), p.level, p.name, p.blurb)).join('')}</ul>` : '';
    R.catEnts.innerHTML = ents.length ? `<h3 class="cat-h">Entities <span class="cat-c">${ents.filter((e) => seenE.has(e.code)).length} of ${ents.length}</span></h3>
      <ul class="notes">${ents.map((e, i) => row(seenE.has(e.code), 'E-' + pad(i + 1, 2), e.name, e.note)).join('')}</ul>` : '';
    R.catObjH.hidden = !(places.length || ents.length);
  }
  function renderCatalog() {
    renderJournal();
    const total = o.artifacts.length;
    const got = o.artifacts.filter((a) => st.found.has(String(a.id))).length;
    R.catLead.innerHTML = total
      ? `<b>${got}</b> of ${total} objects recorded. Objects are kept when you leave. They are not always kept when you die.`
      : 'Nothing has been catalogued.';
    R.catGrid.innerHTML = o.artifacts.map((a, i) => {
      const f = st.found.has(String(a.id));
      const no = `A-${pad(i + 1, 2)}`;
      return f
        ? `<article class="spec found"><div class="spec-sig">${sigil(a.id)}</div><p class="spec-no">${no}</p><h3 class="spec-n">${esc(a.name)}</h3><p class="spec-d">${esc(a.desc)}</p></article>`
        : `<article class="spec" aria-label="${no}, unrecorded"><div class="spec-sig">${sigil(a.id)}</div><p class="spec-no">${no}</p><h3 class="spec-n">Unrecorded</h3><p class="spec-d redact" aria-hidden="true"><i style="width:${60 + (hash(a.id) % 30)}%"></i><i style="width:${30 + (hash(a.id + 'x') % 40)}%"></i></p></article>`;
    }).join('');
  }

  /* -------------------------------------------------- credits */
  function renderCredits() {
    const list = Array.isArray(o.credits) ? o.credits.filter((c) => c && typeof c === 'object') : [];
    const lead = 'LEVEL 0 is open source (MIT). The typeface Troffer was drawn for this game (SIL Open Font License). The levels and entities come from the Backrooms, a collaborative fiction written by many people on the Backrooms wikis (CC BY-SA 3.0); the wording here is our own.';
    R.creditsBody.innerHTML = `
      <p class="sheet-lead">${lead}${list.length ? ' These models are used under Creative Commons Attribution 4.0:' : ''}</p>
      ${list.length ? `<ul class="credits">${list.map((c) => {
        const url = /^https?:\/\//i.test(String(c.url || '')) ? String(c.url) : '';
        return `<li class="cr">
          ${c.what ? `<span class="cr-what">${esc(c.what)}</span>` : ''}
          <span class="cr-title">${esc(c.title || 'Untitled')}</span>
          ${c.author ? `<span class="cr-by">by ${esc(c.author)}</span>` : ''}
          <span class="cr-meta">${c.license ? `<span class="cr-lic">${esc(c.license)}</span>` : ''}${url ? `<a class="cr-link" href="${esc(url)}" target="_blank" rel="noopener" data-act="link">${esc(url.replace(/^https?:\/\//i, '').replace(/\/$/, ''))}${icon('external', 'ext')}</a>` : ''}</span>
        </li>`;
      }).join('')}</ul>` : ''}`;
  }

  /* -------------------------------------------------- leaderboard / players */
  function setLeaderboard(rows) {
    st.leaderboard = Array.isArray(rows) ? rows.slice() : [];
    if (st.panels.includes('leaderboard')) renderBoard();
    renderRoster();
  }
  function setPlayers(rows) {
    st.players = Array.isArray(rows) ? rows.slice() : [];
    if (st.panels.includes('players')) renderPlayers();
    renderRoster();
  }
  function renderBoard() {
    const rows = st.leaderboard;
    if (!rows.length) { R.boardBody.innerHTML = '<p class="empty">No records yet. Somebody has to be first.</p>'; return; }
    R.boardBody.innerHTML = `
      <table class="board">
        <thead><tr><th scope="col" class="c-r">#</th><th scope="col">Name</th><th scope="col" class="c-n">Sectors</th><th scope="col" class="c-n">Artifacts</th><th scope="col" class="c-n">Escapes</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr class="${r.you ? 'you' : ''}">
            <td class="c-r">${pad(i + 1, 2)}</td>
            <td class="c-name">${esc(at(r.username))}${r.you ? '<span class="you-tag">you</span>' : ''}</td>
            <td class="c-n">${num(r.sectors)}</td><td class="c-n">${num(r.artifacts)}</td><td class="c-n">${num(r.escapes)}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  }
  function sortedPlayers() {
    return st.players.slice().sort((a, b) => (b.you ? 1 : 0) - (a.you ? 1 : 0) || num(a.distance, 1e9) - num(b.distance, 1e9));
  }
  const dist = (r) => (r.you ? 'here' : `${Math.round(num(r.distance))} m`);
  function renderPlayers() {
    const rows = sortedPlayers();
    const others = rows.filter((r) => !r.you);
    R.playersBody.innerHTML = `
      <p class="sheet-lead"><b>${Math.max(st.online, rows.length)}</b> online. Distance is measured through walls.</p>
      <ul class="plist">${rows.map((r) => `<li class="${r.you ? 'you' : ''}"><span class="pl-n">${esc(at(r.username))}${r.you ? '<span class="you-tag">you</span>' : ''}</span><span class="pl-d">${dist(r)}</span></li>`).join('')}</ul>
      ${others.length ? '' : '<p class="empty">Nobody else is here. That you know of.</p>'}`;
  }
  function renderRoster() {
    const rows = sortedPlayers().slice(0, 8);
    R.rPlayers.innerHTML = rows.length
      ? rows.map((r) => `<li class="${r.you ? 'you' : ''}"><span>${esc(at(r.username))}</span><b>${dist(r)}</b></li>`).join('')
      : '<li class="empty">Nobody else. That you know of.</li>';
    const top = st.leaderboard.slice(0, 5);
    R.rBoard.innerHTML = top.length
      ? top.map((r, i) => `<li class="${r.you ? 'you' : ''}"><span><em>${pad(i + 1, 2)}</em>${esc(at(r.username))}</span><b>${num(r.sectors)}</b></li>`).join('')
      : '<li class="empty">No records yet.</li>';
  }
  function showRoster(on) {
    st.roster = !!on;
    if (on) { renderRoster(); R.rOnline.textContent = String(Math.max(st.online, st.hud.players || 0)); }
    refresh();
  }

  /* ========================================================= SETTINGS */
  function renderSettings() {
    const seg = (k, label, vals) => `
      <div class="srow srow-seg">
        <span class="srow-k" id="l0-s-${k}">${label}</span>
        <div class="seg" role="radiogroup" aria-labelledby="l0-s-${k}" data-setting="${k}">
          ${vals.map(([v, l]) => `<button type="button" role="radio" data-val="${v}" aria-checked="false" tabindex="-1">${l}</button>`).join('')}
        </div>
      </div>`;
    const slider = (k, label, hint) => {
      const [mn, mx, step] = RANGES[k];
      return `
      <label class="srow srow-range">
        <span class="srow-k">${label}${hint ? `<small>${hint}</small>` : ''}</span>
        <output class="srow-v" data-v="${k}"></output>
        <input type="range" data-setting="${k}" min="${mn}" max="${mx}" step="${step}">
      </label>`;
    };
    const toggle = (k, label, hint) => `
      <button type="button" class="srow srow-tog" role="switch" aria-checked="false" data-setting="${k}">
        <span class="srow-k">${label}${hint ? `<small>${hint}</small>` : ''}</span>
        <span class="sw" aria-hidden="true"><i></i></span>
      </button>`;
    R.settingsBody.innerHTML = `
      <section class="sgroup"><h3 class="sgroup-h">Picture</h3>
        ${seg('quality', 'Quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])}
        ${slider('fov', 'Field of view')}
        ${slider('grain', 'Film grain')}
        ${toggle('visor', 'Visor frame', 'The suit around your eyes')}
        ${toggle('showFps', 'Show frame rate')}
      </section>
      <section class="sgroup"><h3 class="sgroup-h">Control</h3>
        ${slider('sens', 'Look sensitivity')}
        ${toggle('invertY', 'Invert look')}
        ${toggle('headbob', 'Head bob', 'Off if motion makes you unwell')}
      </section>
      <section class="sgroup"><h3 class="sgroup-h">Sound</h3>
        ${slider('volume', 'Volume')}
        ${toggle('voice', 'Proximity voice', 'Others hear you when close. Hold V')}
      </section>
      <button type="button" class="btn-text" data-reset>Restore defaults</button>`;
    syncSettings();
  }
  function syncSettings() {
    const b = R.settingsBody;
    b.querySelectorAll('.seg[data-setting]').forEach((g) => {
      const v = settings[g.dataset.setting];
      g.querySelectorAll('[role="radio"]').forEach((r) => {
        const on = r.dataset.val === v;
        r.setAttribute('aria-checked', String(on));
        r.tabIndex = on ? 0 : -1;
      });
    });
    b.querySelectorAll('input[type="range"][data-setting]').forEach((inp) => {
      const k = inp.dataset.setting;
      inp.value = String(settings[k]);
      paintRange(inp);
    });
    b.querySelectorAll('[role="switch"][data-setting]').forEach((s) => s.setAttribute('aria-checked', String(!!settings[s.dataset.setting])));
  }
  function paintRange(inp) {
    const k = inp.dataset.setting;
    const [mn, mx] = RANGES[k];
    inp.style.setProperty('--p', `${((+inp.value - mn) / (mx - mn)) * 100}%`);
    const out = R.settingsBody.querySelector(`[data-v="${k}"]`);
    if (out) out.textContent = fmtSetting(k, +inp.value);
  }
  function setSetting(k, v) {
    if (!(k in DEFAULTS)) return;
    const next = sanitizeSettings({ ...settings, [k]: v })[k];
    if (settings[k] === next) return;
    settings[k] = next;
    save(SETTINGS_KEY, settings);
    syncSettings();
    refresh();
    if (k === 'showFps' && !next) prev.fps = undefined;
    emit('setting', k, next);
  }
  renderSettings();
  R.settingsBody.addEventListener('click', (e) => {
    const radio = e.target.closest('.seg [role="radio"]');
    if (radio) { emit('ui', 'click'); setSetting(radio.closest('.seg').dataset.setting, radio.dataset.val); return; }
    const sw = e.target.closest('[role="switch"][data-setting]');
    if (sw) { emit('ui', 'click'); setSetting(sw.dataset.setting, !settings[sw.dataset.setting]); return; }
    if (e.target.closest('[data-reset]')) {
      emit('ui', 'click');
      for (const k of Object.keys(DEFAULTS)) setSetting(k, DEFAULTS[k]);
    }
  });
  R.settingsBody.addEventListener('keydown', (e) => {
    const radio = e.target.closest('.seg [role="radio"]');
    if (!radio || !(e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    e.preventDefault();
    const g = radio.closest('.seg');
    const opts2 = [...g.querySelectorAll('[role="radio"]')];
    const i = opts2.indexOf(radio) + (e.key === 'ArrowRight' ? 1 : -1);
    const t = opts2[(i + opts2.length) % opts2.length];
    setSetting(g.dataset.setting, t.dataset.val);
    t.focus();
    emit('ui', 'hover');
  });
  R.settingsBody.addEventListener('input', (e) => {
    const inp = e.target.closest('input[type="range"][data-setting]');
    if (!inp) return;
    paintRange(inp);
    setSetting(inp.dataset.setting, +inp.value);
  });

  /* ========================================================= SIGNS */
  let wheelSel = -1;
  let wheelVec = [0, 0];
  function setWheelSel(i) {
    if (i === wheelSel) return;
    wheelSel = i;
    R.wheel.querySelectorAll('.arc').forEach((a) => a.classList.toggle('sel', +a.dataset.i === i));
    R.wheel.querySelectorAll('.sg').forEach((b) => b.classList.toggle('sel', +b.dataset.i === i));
    R.signLabel.textContent = i >= 0 ? o.signs[i].label : 'Pick a mark';
    if (i >= 0) emit('ui', 'hover');
  }
  function angleToIndex(dx, dy) {
    const nn = o.signs.length;
    let a = Math.atan2(dy, dx) + Math.PI / 2; // 0 at top, clockwise
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return Math.round(a / ((Math.PI * 2) / nn)) % nn;
  }
  function openSigns() {
    if (!o.signs.length || st.signs) return;
    st.signs = true;
    wheelVec = [0, 0];
    wheelSel = -2; setWheelSel(-1);
    refresh();
    if (st.keyboard && !document.pointerLockElement) {
      const b = R.wheel.querySelector('.sg');
      if (b) b.focus({ preventScroll: true });
    }
  }
  function closeSigns() {
    if (!st.signs) return;
    st.signs = false;
    refresh();
    if (root.contains(document.activeElement)) document.activeElement.blur();
  }
  function pickSign(i) {
    const s = o.signs[i];
    if (!s) return;
    emit('ui', 'click');
    closeSigns();
    emit('sign', s.id);
  }
  // pointer locked: steer a virtual cursor with raw movement
  window.addEventListener('mousemove', (e) => {
    if (!st.signs) return;
    if (document.pointerLockElement) {
      wheelVec[0] += e.movementX; wheelVec[1] += e.movementY;
      const len = Math.hypot(wheelVec[0], wheelVec[1]);
      if (len > 90) { wheelVec[0] *= 90 / len; wheelVec[1] *= 90 / len; }
      if (len > 22) setWheelSel(angleToIndex(wheelVec[0], wheelVec[1]));
    }
  });
  window.addEventListener('mousedown', (e) => {
    if (!st.signs || !document.pointerLockElement) return;
    if (e.button === 0 && wheelSel >= 0) { e.preventDefault(); e.stopPropagation(); pickSign(wheelSel); }
    else if (e.button === 2) { e.preventDefault(); closeSigns(); }
  }, true);
  R.wheel.addEventListener('pointermove', (e) => {
    if (document.pointerLockElement) return;
    const r = R.wheel.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < r.width * 0.23) setWheelSel(-1);
    else setWheelSel(angleToIndex(dx, dy));
  });
  R.wheel.addEventListener('click', (e) => {
    if (document.pointerLockElement) return;
    const b = e.target.closest('.sg');
    if (b) { pickSign(+b.dataset.i); return; }
    if (e.target.closest('.wheel-center')) return;
    if (wheelSel >= 0 && e.target.closest('.wheel-svg')) pickSign(wheelSel);
  });
  R.wheel.addEventListener('focusin', (e) => { const b = e.target.closest('.sg'); if (b) setWheelSel(+b.dataset.i); });
  R.signs.addEventListener('click', (e) => { if (e.target === R.signs) { emit('ui', 'back'); closeSigns(); } });

  /* ========================================================= TOUCH */
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : { matches: false };
  let lookX = 0, lookY = 0;
  const touch = {
    enabled: typeof o.touch === 'boolean' ? o.touch : !!coarse.matches,
    mx: 0, my: 0, sprint: false,
    takeLook() { const r = [lookX, lookY]; lookX = 0; lookY = 0; return r; },
  };
  if (typeof o.touch !== 'boolean' && coarse.addEventListener) {
    coarse.addEventListener('change', () => { touch.enabled = coarse.matches; refresh(); });
  }
  let stickPointer = null, stickBase = [0, 0], lookPointer = null, lookLast = [0, 0];
  const STICK_R = 54;
  function endStick() {
    stickPointer = null;
    touch.mx = 0; touch.my = 0; touch.sprint = false;
    R.stick.classList.remove('live', 'sprint');
    R.stick.style.transform = '';
    R.knob.style.transform = '';
  }
  R.touch.addEventListener('pointerdown', (e) => {
    if (!R.touch.classList.contains('is-on')) return;
    const btn = e.target.closest('[data-touch]');
    if (btn) {
      e.preventDefault();
      btn.classList.add('press');
      setTimeout(() => btn.classList.remove('press'), 160);
      emit('action', btn.dataset.touch);
      return;
    }
    const w = window.innerWidth;
    if (e.clientX < w * 0.5 && stickPointer == null) {
      stickPointer = e.pointerId;
      stickBase = [e.clientX, e.clientY];
      R.stick.classList.add('live');
      R.stick.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
    } else if (e.clientX >= w * 0.5 && lookPointer == null) {
      lookPointer = e.pointerId;
      lookLast = [e.clientX, e.clientY];
    } else return;
    try { R.touch.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });
  R.touch.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickPointer) {
      const dx = e.clientX - stickBase[0], dy = e.clientY - stickBase[1];
      const d = Math.hypot(dx, dy);
      const k = d > STICK_R ? STICK_R / d : 1;
      R.knob.style.transform = `translate3d(${dx * k}px,${dy * k}px,0)`;
      touch.mx = clamp((dx * k) / STICK_R, -1, 1);
      touch.my = clamp((-dy * k) / STICK_R, -1, 1);
      const sprint = d / STICK_R >= 0.9;
      if (sprint !== touch.sprint) { touch.sprint = sprint; R.stick.classList.toggle('sprint', sprint); }
    } else if (e.pointerId === lookPointer) {
      lookX += e.clientX - lookLast[0];
      lookY += e.clientY - lookLast[1];
      lookLast = [e.clientX, e.clientY];
    }
  });
  const upT = (e) => {
    if (e.pointerId === stickPointer) endStick();
    if (e.pointerId === lookPointer) lookPointer = null;
  };
  R.touch.addEventListener('pointerup', upT);
  R.touch.addEventListener('pointercancel', upT);
  R.touch.addEventListener('lostpointercapture', upT);
  R.touch.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ========================================================= API */
  refresh();
  updateEnter();

  const ui = {
    on(ev, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
      return () => handlers.get(ev).delete(fn);
    },
    settings,
    touch,
    showTitle,
    setTitleStatus,
    setOnline,
    enterGame,
    setHud,
    prompt,
    toast,
    subtitle,
    damage,
    setSanityFx,
    showPause,
    showRoster,
    showDeath,
    showEscape,
    hideOverlays,
    setCatalog,
    setJournal,
    setLeaderboard,
    setPlayers,
    openSigns,
    closeSigns,
    setFps,
    get menuOpen() { return st.screen !== 'none' || st.panels.length > 0 || st.signs; },
  };
  return ui;
}
