// LEVEL 0 sound engine.
// Fully procedural WebAudio: no audio files, no libraries. Everything here is synthesized at runtime.
// Signal flow:
//   sources -> mix -> hood coloration (box bump + 9.5k lowpass) -> death lowpass -> pause duck
//           -> compressor -> limiter -> master -> speakers
//   reverb send bus -> predelay -> one ConvolverNode (4 channel IR: short + long tails, crossfaded by s.room) -> mix
//   UI sounds skip the hood, the death filter and the pause duck.
// 0.3.0 (see the block at the end of the file and biomes.js):
//   ambience: Level 0 beds -> l0Bus ┐
//             place layers (built on first visit, freed 12 s after leaving) -> amb -> tension thinning
//             -> entity duck -> after-hit duck -> tension hush -> mix. Places crossfade over about 3 s.
//   reverb:   every send -> revIn -> Level 0's room-size convolver + one convolver per place, crossfaded.
//   big hits: scare / lunge / houndRush / stealerTurn / the Howler's howl -> hitBus -> limiter (no compressor).
//   master:   ... limiter -> master gain -> soft clipper (linear below 0.7, never above 0.93).
//   update(dt, state) reads, on top of the 0.2 fields: place (BIOMES key), water (m), tension (0..1), run (0..1).
//   footstep(kind, loud, surface), entity(id, type, x, y, z, state), play(name, { pos, vol, pitch, delay }), hush(sec).

const MAX_VOICES = 16;
const MAX_ENTITIES = 12;
const TAU = Math.PI * 2;

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const wpick = (list) => {
  let tot = 0;
  for (const it of list) tot += Math.max(0, it[1]);
  let r = Math.random() * tot;
  for (const it of list) { r -= Math.max(0, it[1]); if (r <= 0) return it[0]; }
  return list[0][0];
};

// Equal-power crossfade curves for the noise beds (uncorrelated grains: sin^2 + cos^2 = 1).
const FADE_IN = new Float32Array(64);
const FADE_OUT = new Float32Array(64);
for (let i = 0; i < 64; i++) {
  FADE_IN[i] = Math.sin((i / 63) * Math.PI / 2);
  FADE_OUT[i] = Math.cos((i / 63) * Math.PI / 2);
}

// Dissonant chord shapes (semitones over the root) for the slow tonal undertow.
const CHORDS = [[0, 1, 7, 12], [0, 6, 13, 18], [0, 3, 6, 11], [0, 1, 5, 13], [-12, 0, 6, 7], [0, 2, 8, 13], [-5, 0, 1, 6]];

// Formant targets [F1, F2, F3] in Hz for a neutral adult tract.
const VOWELS = {
  a: [780, 1250, 2550],
  e: [530, 1850, 2550],
  i: [300, 2250, 3000],
  o: [480, 830, 2600],
  u: [330, 760, 2450],
  uh: [560, 1350, 2500],
  l: [380, 1150, 2700],
  m: [280, 1000, 2300],
};

// One shots that may exceed the voice cap a little.
const PRIO = new Set(['hit', 'death', 'respawn', 'stinger', 'exit', 'flashOn', 'flashOff', 'uiHover', 'uiClick', 'uiBack', 'apparition']);

// Reverb send per one shot.
const SEND = {
  flashOn: 0, flashOff: 0, pickup: 0.05, drink: 0, battery: 0.04, discover: 0.55, artifact: 0.6, sign: 0.08,
  hit: 0.1, death: 0.4, respawn: 0.15, exit: 0.6, stinger: 0.5, apparition: 0.9, knock: 0.55, doorSlam: 0.95,
  geiger: 0, radio: 0.05, _thud: 0.95, _drag: 0.9, _pipe: 0.9, _foot: 0.08, _lamp: 0.25,
  _creak: 0.85, _metal: 0.9, _farTone: 1.1, _farSteps: 0.75, _clunk: 0.6,
  radarSweep: 0, radarBlip: 0.04, radarGhost: 0.08, radarOn: 0, radarOff: 0,
};

function detectMobile() {
  try {
    const touch = (navigator.maxTouchPoints || 0) > 0;
    const s = window.screen || {};
    const small = Math.min(s.width || 9999, s.height || 9999) <= 900;
    return touch && small;
  } catch (e) {
    return false;
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this._ready = false;
    this._starting = null;
    this._masterVol = 0.8;
    this._paused = false;
    this._L = { x: 0, y: 1.6, z: 0, fx: 0, fy: 0, fz: -1 };
    this._s = { hum: 0.6, room: 0.4, exertion: 0, fear: 0, sanity: 1, dark: 0, blackout: 0, dead: false, menu: false };
    this._mk = 0; // smoothed menu amount, 0 = gameplay, 1 = title screen
    this._mkInit = false;
    this._e = {}; // effective state after the menu blend
    this._bedList = [];
    this._follow = null;
    this._hushPlan = false;
    this._hushOn = false;
    this._ents = new Map();
    this._vox = new Map();
    this._mics = [];
    this._active = 0;
    this._last = new WeakMap();
    this._errs = 0;
    this._mobile = detectMobile();
    this._wasDead = false;
    this._br = { next: 0, off: false };
    this._hb = { next: 0 };
    this._distT = rnd(6, 16);
    this._sanT = rnd(8, 20);
    this._curves = {};
    this._tex = {};
    // 0.3.0: places, water, tension, the Level ! chase.
    this._place = 'level0';
    this._pw = { level0: 1 }; // crossfade weight per place, 0..1
    this._layers = {}; // place key -> ambience layer (built on first visit, freed a while after leaving)
    this._revs = {}; // place key -> reverb (convolver) for that place
    this._x = { water: 0, tension: 0, run: 0 };
    this._tens = { hushT: 0, cool: 0, armed: true };
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    try {
      if (this.ctx && this.ctx.state === 'closed') {
        this.ctx = null;
        this._ready = false;
        this._ents.clear();
        this._vox.clear();
        this._active = 0;
      }
      if (this.ctx) {
        await this._resume();
        return;
      }
      if (this._starting) return this._starting;
      this._starting = (async () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try {
          // Ask iOS to treat this as media playback so the silent switch does not mute the game.
          if (navigator.audioSession) navigator.audioSession.type = 'playback';
        } catch (e) { /* not supported */ }
        let ctx;
        try {
          ctx = new AC({ latencyHint: 'interactive' });
        } catch (e) {
          ctx = new AC();
        }
        this.ctx = ctx;
        this._build();
        this._ready = true;
        this._hookLifecycle();
        await this._resume();
      })();
      try {
        await this._starting;
      } finally {
        this._starting = null;
      }
    } catch (e) {
      this._err(e);
    }
  }

  get ready() {
    return !!(this._ready && this.ctx && this.ctx.state !== 'closed');
  }

  // resume() can stay pending forever without a gesture (iOS), so never wait on it for long.
  _resume() {
    const c = this.ctx;
    if (!c || c.state === 'running' || c.state === 'closed') return Promise.resolve();
    let p;
    try {
      p = c.resume();
    } catch (e) {
      return Promise.resolve();
    }
    return Promise.race([
      Promise.resolve(p).catch(() => {}),
      new Promise((r) => setTimeout(r, 400)),
    ]);
  }

  _hookLifecycle() {
    if (this._hooked) return;
    this._hooked = true;
    try {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.ctx && this.ctx.state !== 'running') this._resume();
      });
      // iOS puts the context into 'interrupted' after calls or Siri. The next start() resumes it.
      this.ctx.onstatechange = () => {};
    } catch (e) { /* ignore */ }
  }

  _err(e) {
    if (this._errs++ < 8) {
      try { console.warn('[audio]', e && e.message ? e.message : e); } catch (x) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- public controls

  setMaster(v) {
    try {
      this._masterVol = clamp(num(v, this._masterVol));
      if (this._ready) this._tg(this.masterG.gain, this._masterVol, 0.05);
    } catch (e) { this._err(e); }
  }

  setPaused(b) {
    try {
      this._paused = !!b;
      if (this._ready) {
        this._tg(this.pauseG.gain, this._paused ? 0.03 : 1, 0.25);
        if (this.hitBus) this._tg(this.hitBus.gain, this._paused ? 0.03 : 1, 0.25);
      }
    } catch (e) { this._err(e); }
  }

  setListener(x, y, z, fx, fy, fz) {
    try {
      const L = this._L;
      L.x = num(x, L.x); L.y = num(y, L.y); L.z = num(z, L.z);
      let ax = num(fx, L.fx), ay = num(fy, L.fy), az = num(fz, L.fz);
      // Forward must not be parallel to up (+Y).
      if (Math.abs(ax) + Math.abs(az) < 1e-3) az = -1e-3;
      const len = Math.hypot(ax, ay, az) || 1;
      L.fx = ax / len; L.fy = ay / len; L.fz = az / len;
      if (!this._ready) return;
      const l = this.ctx.listener;
      if (l.positionX) {
        this._tg(l.positionX, L.x, 0.015); this._tg(l.positionY, L.y, 0.015); this._tg(l.positionZ, L.z, 0.015);
        this._tg(l.forwardX, L.fx, 0.015); this._tg(l.forwardY, L.fy, 0.015); this._tg(l.forwardZ, L.fz, 0.015);
      } else {
        if (l.setPosition) l.setPosition(L.x, L.y, L.z);
        if (l.setOrientation) l.setOrientation(L.fx, L.fy, L.fz, 0, 1, 0);
      }
    } catch (e) { this._err(e); }
  }

  update(dt, s) {
    if (!this._ready) return;
    try {
      const now = this.ctx.currentTime;
      dt = clamp(num(dt, 0.016), 0, 0.1);
      s = s || {};
      const st = this._s;
      st.hum = clamp(num(s.hum, st.hum));
      st.room = clamp(num(s.room, st.room));
      st.exertion = clamp(num(s.exertion, st.exertion));
      st.fear = clamp(num(s.fear, st.fear));
      st.sanity = clamp(num(s.sanity, st.sanity));
      st.dark = clamp(num(s.dark, st.dark));
      st.blackout = clamp(num(s.blackout, st.blackout));
      st.dead = !!s.dead;
      st.menu = !!s.menu;
      // Title screen blend: jump straight in on the very first frame, crossfade (about 2.5 s) after that.
      if (!this._mkInit) { this._mkInit = true; this._mk = st.menu ? 1 : 0; }
      const mt = st.menu ? 1 : 0;
      this._mk = clamp(this._mk + clamp(mt - this._mk, -dt / 2.5, dt / 2.5));
      const mk = this._mk, e = this._e;
      // On the title screen the game state is ignored: a fixed, distant, slightly dim mood.
      e.hum = lerp(st.hum, 0.55, mk);
      e.room = lerp(st.room, 0.8, mk);
      e.exertion = st.exertion * (1 - mk);
      e.fear = st.fear * (1 - mk);
      e.sanity = lerp(st.sanity, 1, mk);
      e.dark = lerp(st.dark, 0.3, mk);
      e.blackout = st.blackout * (1 - mk);
      e.dead = st.dead && !st.menu;
      e.menu = st.menu;
      e.mk = mk;
      // 0.3.0 fields. Missing place means Level 0; the title screen always sounds like Level 0.
      const X = this._x;
      const pk = typeof s.place === 'string' && PLACE_KEYS.includes(s.place) ? s.place : 'level0';
      this._place = mk > 0.5 ? 'level0' : pk;
      X.water = clamp(num(s.water, 0), 0, 2);
      X.tension = clamp(num(s.tension, 0)) * (1 - mk) * (e.dead ? 0 : 1);
      X.run = clamp(num(s.run, 0));
      try { this._bedsTick(now); } catch (x) { this._err(x); }
      try { this._placesTick(now, dt, e); } catch (x) { this._err(x); }
      this._beds(now, e);
      try { this._tensionTick(now, dt, e); } catch (x) { this._err(x); }
      try { this._entsMix(now); } catch (x) { this._err(x); }
      try { this._ambTick(now, dt, e); } catch (x) { this._err(x); }
      this._breathTick(now, e);
      this._heartTick(now, e);
      this._events(dt, e);
      for (const e of this._ents.values()) {
        e.wt -= dt;
        if (e.wt <= 0) {
          try { e.tick(); } catch (x) { this._err(x); }
        }
      }
    } catch (e) {
      this._err(e);
    }
  }

  // ---------------------------------------------------------------- param helpers

  // Smoothly move an AudioParam toward v, skipping redundant automation events.
  _tg(p, v, tc) {
    if (!p) return;
    const last = this._last.get(p);
    if (last !== undefined && Math.abs(last - v) <= 1e-4 * Math.max(1, Math.abs(v))) return;
    this._last.set(p, v);
    p.setTargetAtTime(v, this.ctx.currentTime, Math.max(0.005, tc));
  }

  // Attack then exponential-ish decay. Total length about a + d.
  _ad(p, t, a, peak, d) {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + Math.max(0.0005, a));
    p.setTargetAtTime(0, t + Math.max(0.0005, a), Math.max(0.001, d / 4));
  }

  _gain(v) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  _bq(type, f, Q, gain) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    if (Q !== undefined) b.Q.value = Q;
    if (gain !== undefined) b.gain.value = gain;
    return b;
  }

  _chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  _osc(type, f) {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type;
    else o.setPeriodicWave(type);
    o.frequency.value = f;
    return o;
  }

  _loop(buf, rate) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    if (rate) s.playbackRate.value = rate;
    return s;
  }

  _curve(drive) {
    const k = drive.toFixed(2);
    if (this._curves[k]) return this._curves[k];
    const n = 1024, c = new Float32Array(n), norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * drive) / norm;
    }
    return (this._curves[k] = c);
  }

  _shaper(drive) {
    const w = this.ctx.createWaveShaper();
    w.curve = this._curve(drive);
    try { w.oversample = this._mobile ? 'none' : '2x'; } catch (e) { /* ignore */ }
    return w;
  }

  _panner(hrtf) {
    const p = this.ctx.createPanner();
    p.panningModel = hrtf && !this._mobile ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 1.5;
    p.maxDistance = 250;
    p.rolloffFactor = 1;
    return p;
  }

  _setPos(p, x, y, z, smooth) {
    if (p.positionX) {
      if (smooth) {
        this._tg(p.positionX, x, 0.03); this._tg(p.positionY, y, 0.03); this._tg(p.positionZ, z, 0.03);
      } else {
        const t = this.ctx.currentTime;
        p.positionX.setValueAtTime(x, t); p.positionY.setValueAtTime(y, t); p.positionZ.setValueAtTime(z, t);
      }
    } else if (p.setPosition) {
      p.setPosition(x, y, z);
    }
  }

  _dist(x, y, z) {
    const L = this._L;
    return Math.hypot(x - L.x, y - L.y, z - L.z);
  }

  // Distance cues not covered by the panner: air and wall absorption, more reverb far away.
  _lpFor(d) { return Math.max(450, 19000 / (1 + d * 0.13)); }
  _sendFor(base, d) { return (base * (0.35 + 0.65 * Math.min(1, d / 14))) / (1 + d * 0.035); }

  // Persistent spatial chain (entities, remote voices): lowpass -> panner -> mix, lowpass -> reverb send.
  _spMake(hrtf, send) {
    const lp = this._bq('lowpass', 19000, 0.5);
    const p = this._panner(hrtf);
    const sg = this._gain(0);
    lp.connect(p); p.connect(this.mix);
    lp.connect(sg); sg.connect(this.revIn);
    return { lp, p, sg, send, init: false, nodes: [lp, p, sg] };
  }

  _spSet(sp, x, y, z) {
    x = num(x, 0); y = num(y, 0); z = num(z, 0);
    this._setPos(sp.p, x, y, z, sp.init);
    sp.init = true;
    const d = this._dist(x, y, z);
    this._tg(sp.lp.frequency, this._lpFor(d), 0.08);
    this._tg(sp.sg.gain, this._sendFor(sp.send, d) * (sp.far ? 1 / (1 + d / 12) : 1), 0.1);
  }

  // ---------------------------------------------------------------- graph

  _build() {
    const c = this.ctx;
    this._mkBuffers();

    // Master chain with inside-the-hood coloration.
    this.mix = this._gain(1);
    const box = this._bq('peaking', 760, 1.1, 2.5);
    const box2 = this._bq('peaking', 240, 0.9, 1.5);
    const hoodLP = this._bq('lowpass', 9500, 0.6);
    this.deadLP = this._bq('lowpass', 20000, 0.5);
    this.pauseG = this._gain(this._paused ? 0.03 : 1);
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 3.5;
    comp.attack.value = 0.006; comp.release.value = 0.25;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.002; lim.release.value = 0.12;
    this.masterG = this._gain(this._masterVol);
    // Last stage: a soft clipper that is a straight line below 0.7 and can never pass 0.99, so a pile-up of
    // sounds cannot clip even if the limiter (which is not a brickwall) lets a transient through.
    const clip = c.createWaveShaper();
    clip.curve = this._softClipCurve();
    this._chain(this.mix, box, box2, hoodLP, this.deadLP, this.pauseG, comp, lim, this.masterG, clip, c.destination);
    this.comp = comp;
    this.lim = lim;
    this.uiBus = this._gain(0.8);
    this.uiBus.connect(comp);
    // The big moments (scare, lunge, rush, the Howler's charge) skip the compressor so they land clearly louder
    // than everything else; only the limiter and the soft clipper sit after them.
    this.hitBus = this._gain(this._paused ? 0.03 : 1);
    const hitLP = this._bq('lowpass', 14000, 0.5);
    this._chain(this.hitBus, hitLP, lim);
    // Ambience bus (hum, room tone, drones): one gain so the building can 'hold its breath' before an event.
    //   amb -> tension thinning (low shelf + level) -> entity duck -> after-hit duck -> tension hush -> mix
    this.amb = this._gain(1);
    this.tensLS = this._bq('lowshelf', 320, undefined, 0);
    this.tensG = this._gain(1);
    this.duckG = this._gain(1);
    this.hitDuck = this._gain(1);
    this.hushG = this._gain(1);
    this._chain(this.amb, this.tensLS, this.tensG, this.duckG, this.hitDuck, this.hushG, this.mix);
    // Level 0's own beds (lamp hum, air, ventilation, duct whistle) share one gain so other places can replace them.
    this.l0Bus = this._gain(1);
    this.l0Bus.connect(this.amb);

    // Listener up vector is fixed.
    try {
      const l = c.listener;
      if (l.upX) { l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0; }
    } catch (e) { /* ignore */ }

    const parts = [this._buildReverb, this._buildHum, this._buildRoom, this._buildBreath, this._buildHeart,
      this._buildDrones, this._buildSuit, this._buildTinnitus, this._buildPressure, this._buildTension];
    for (const fn of parts) {
      try { fn.call(this); } catch (e) { this._err(e); }
    }
    if (!this.revIn) this.revIn = this._gain(0); // reverb failed: sends go nowhere
    this.setListener(this._L.x, this._L.y, this._L.z, this._L.fx, this._L.fy, this._L.fz);
  }

  _mkBuffers() {
    const c = this.ctx, sr = c.sampleRate;
    const mk = (sec, fill, fade) => {
      const n = Math.floor(sr * sec), F = fade ? Math.floor(sr * 0.08) : 0;
      const tmp = new Float32Array(n + F);
      fill(tmp);
      // Crossfade the tail into the head so the loop seam is inaudible.
      for (let i = 0; i < F; i++) {
        const k = i / F;
        tmp[i] = tmp[i] * k + tmp[n + i] * (1 - k);
      }
      let mean = 0, peak = 0;
      for (let i = 0; i < n; i++) mean += tmp[i];
      mean /= n;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(tmp[i] - mean));
      const b = c.createBuffer(1, n, sr), d = b.getChannelData(0), g = 0.95 / (peak || 1);
      for (let i = 0; i < n; i++) d[i] = (tmp[i] - mean) * g;
      return b;
    };
    // Long noise tables with mutually prime-ish lengths. The beds never play them as plain loops: see _mkBed.
    const k = this._mobile ? 1 : 2;
    this._white = mk(6.1 * k, (d) => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }, true);
    this._pink = mk(7.3 * k, (d) => {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
    }, true);
    this._brown = mk(8.9 * k, (d) => {
      let b = 0;
      for (let i = 0; i < d.length; i++) {
        b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = b;
      }
    }, true);

    // Respirator valve: soft rubber flap tick.
    this._valveBuf = this._shortBuf(0.04, (t) =>
      Math.exp(-t / 0.004) * Math.sin(TAU * 1250 * t) * 0.6 +
      Math.exp(-t / 0.012) * Math.sin(TAU * 190 * t) * 0.5 +
      (Math.random() * 2 - 1) * Math.exp(-t / 0.0015) * 0.3);
    // Geiger tick: sharp, tiny.
    this._geigerBuf = this._shortBuf(0.012, (t) =>
      (Math.random() * 2 - 1) * Math.exp(-t / 0.0004) + Math.sin(TAU * 4100 * t) * Math.exp(-t / 0.0015) * 0.6);

    this._humWave = this._mkWave(64, (n) => {
      const fixed = { 1: 0.55, 2: 1, 3: 0.24, 4: 0.42, 5: 0.09, 6: 0.2, 7: 0.05, 8: 0.13, 10: 0.07, 12: 0.06 };
      if (fixed[n] !== undefined) return fixed[n];
      if (n > 58) return 0;
      return 0.045 * (n % 2 ? 0.5 : 1) * Math.exp(-(n - 9) / 22) * rnd(0.4, 1);
    });
    this._buzzWave = this._mkWave(40, (n) => (1 / n) * (n % 2 ? 1 : 0.55));
    // Harsher, more nasal ballast: strong odd harmonics in the 1 to 3 kHz region.
    this._buzzWave2 = this._mkWave(40, (n) => (n % 2 ? 1 : 0.3) / Math.pow(n, 0.75) * (n > 6 && n < 26 ? 1.4 : 1));
    this._glotWave = this._mkWave(48, (n) => 1 / Math.pow(n, 1.45), true);
    // Soft, reedy pad voice: a few harmonics so the undertow is heard on small speakers, not only felt.
    this._padWave = this._mkWave(10, (n) => (n > 8 ? 0 : 1 / Math.pow(n, 0.75)) * (n % 2 ? 1 : 0.8));
  }

  _shortBuf(sec, fn) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * sec);
    const b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = fn(i / sr);
    return b;
  }

  _mkWave(N, amp, zeroPhase) {
    const real = new Float32Array(N), imag = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      const a = amp(n), ph = zeroPhase ? 0 : rnd(0, TAU);
      real[n] = a * Math.sin(ph);
      imag[n] = a * Math.cos(ph);
    }
    return this.ctx.createPeriodicWave(real, imag);
  }

  // Generated impulse response. Four channels = true stereo convolution: input L feeds the short (tunnel)
  // tail, input R feeds the long (hall) tail, so one ConvolverNode can morph room size.
  _makeIR(sec, rtShort, rtLong, four) {
    const c = this.ctx, sr = c.sampleRate, n = Math.floor(sr * sec), chs = four ? 4 : 2;
    const buf = c.createBuffer(chs, n, sr);
    for (let ch = 0; ch < chs; ch++) {
      const rt = four && ch < 2 ? rtShort : rtLong;
      const tau = rt / 6.91, d = buf.getChannelData(ch);
      let y = 0, energy = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        if (t > rt * 1.3) break;
        // Lowpass closes over time: carpet and ceiling tile eat the highs first.
        const a = 0.62 - 0.5 * Math.min(1, t / rt);
        y += a * (Math.random() * 2 - 1 - y);
        const onset = Math.min(1, t / 0.014);
        d[i] = y * Math.exp(-t / tau) * onset;
      }
      // Early reflections: sparse taps, wall and ceiling bounces.
      const span = four && ch < 2 ? 0.035 : 0.075;
      for (let k = 0; k < 12; k++) {
        const t = 0.002 + Math.pow(Math.random(), 1.4) * span;
        const i = Math.floor(t * sr);
        const amp = rnd(0.4, 1) * Math.exp(-t / 0.05) * (Math.random() < 0.5 ? -1 : 1) * 0.8;
        for (let j = 0; j < 6 && i + j < n; j++) d[i + j] += amp * (1 - j / 6);
      }
      for (let i = 0; i < n; i++) energy += d[i] * d[i];
      const g = 1 / Math.sqrt(energy || 1);
      for (let i = 0; i < n; i++) d[i] *= g;
    }
    return buf;
  }

  _buildReverb() {
    const c = this.ctx;
    this.revIn = this._gain(1);
    // Level 0's reverb (the room-size morph below) is one send among the per-place reverbs; see _placeRev.
    this.l0Rev = this._gain(1);
    this.revIn.connect(this.l0Rev);
    this.preDelay = c.createDelay(0.2);
    this.preDelay.delayTime.value = 0.012;
    this.l0Rev.connect(this.preDelay);
    let four = !this._mobile;
    let conv = c.createConvolver();
    try {
      conv.buffer = four ? this._makeIR(3.2, 0.55, 2.9, true) : this._makeIR(1.7, 0.5, 1.4, false);
    } catch (e) {
      four = false;
      conv = c.createConvolver();
      conv.buffer = this._makeIR(1.8, 0.5, 1.5, false);
    }
    this.conv = conv;
    if (four) {
      const m = c.createChannelMerger(2);
      this.revShort = this._gain(0.7);
      this.revLong = this._gain(0.7);
      this.preDelay.connect(this.revShort); this.revShort.connect(m, 0, 0);
      this.preDelay.connect(this.revLong); this.revLong.connect(m, 0, 1);
      m.connect(conv);
    } else {
      this.preDelay.connect(conv);
    }
    this.revLP = this._bq('lowpass', 6000, 0.5);
    this.revRet = this._gain(0.5);
    this._chain(conv, this.revLP, this.revRet, this.mix);

    // Early reflection taps outside the convolver: strong in tight corridors.
    const erM = c.createChannelMerger(2);
    const taps = [[0.0093, 0], [0.0141, 1], [0.0207, 0], [0.0263, 1], [0.0331, 0]];
    for (const [t, ch] of taps) {
      const dl = c.createDelay(0.1);
      dl.delayTime.value = t;
      const g = this._gain(rnd(0.45, 0.8));
      this.l0Rev.connect(dl); dl.connect(g); g.connect(erM, 0, ch);
    }
    this.erG = this._gain(0.2);
    this._chain(erM, this._bq('lowpass', 3200, 0.5), this.erG, this.mix);
  }

  // ---------------------------------------------------------------- non-repeating noise beds

  // A bed plays a long noise table as a sequence of grains: every few seconds a new looped source starts at
  // a random offset with a slightly different playback rate, equal-power crossfaded with the previous one.
  // Nothing is ever replayed with the same alignment, so there is no loop period to hear. If update() stops
  // (hidden tab) the last grain just keeps looping its long table.
  _mkBed(buf, dest, seg, rate, xf) {
    const bed = { buf, dest, seg: seg || [4, 9], rate: rate || [0.93, 1.07], xf: xf || 1.6, cur: null, next: 0 };
    this._bedList.push(bed);
    this._bedGrain(bed, this.ctx.currentTime, true);
    return bed;
  }

  _bedGrain(bed, t, first) {
    const s = this.ctx.createBufferSource();
    s.buffer = bed.buf;
    s.loop = true;
    s.playbackRate.value = rnd(bed.rate[0], bed.rate[1]);
    const g = this._gain(first ? 1 : 0);
    s.connect(g); g.connect(bed.dest);
    if (!first) g.gain.setValueCurveAtTime(FADE_IN, t, bed.xf);
    s.start(t, rnd(0, bed.buf.duration * 0.97));
    const old = bed.cur;
    if (old) {
      try { old.g.gain.setValueCurveAtTime(FADE_OUT, t, bed.xf); } catch (e) { old.g.gain.setTargetAtTime(0, t, bed.xf / 3); }
      old.s.onended = () => { try { old.s.disconnect(); old.g.disconnect(); } catch (e) { /* ignore */ } };
      try { old.s.stop(t + bed.xf + 0.05); } catch (e) { /* ignore */ }
    }
    bed.cur = { s, g };
    bed.next = t + bed.xf + rnd(bed.seg[0], bed.seg[1]);
  }

  _bedsTick(now) {
    for (const bed of this._bedList) {
      if (now < bed.next - 0.25) continue;
      try {
        this._bedGrain(bed, Math.max(now + 0.05, bed.next), false);
      } catch (e) {
        this._err(e);
        bed.next = now + 5;
      }
    }
  }

  // ---------------------------------------------------------------- ambience graph

  // Fluorescent lamps. Mains 60/120 Hz kept low and identical in both ears (the old detuned pairs beat into a
  // slow 7 s throb in mono). The character lives in three ballast 'fixtures' (120 Hz buzz shaped into the
  // 0.4 to 3 kHz range, panned apart) plus a gritty 120 Hz-modulated noise sizzle. _ambTick makes it breathe:
  // per-fixture level drift, slow timbre changes, ballast flutter and short dropouts.
  _buildHum() {
    const c = this.ctx;
    this._humOsc = [];
    const sum = this._gain(1);
    this.humDrop = this._gain(1);
    this.humLP = this._bq('lowpass', 7000, 0.5);
    this.humG = this._gain(0);
    this._chain(sum, this.humDrop, this.humLP, this.humG, this.l0Bus);
    const hs = this._gain(0.14);
    this.humG.connect(hs); hs.connect(this._l0s());

    // Mains, mono.
    this.mainsG = this._gain(0.2);
    this.mainsG.connect(sum);
    const o60 = this._osc(this._humWave, 60), g60 = this._gain(0.55);
    o60.connect(g60); g60.connect(this.mainsG); o60.start();
    const o120 = this._osc('sine', 120), g120 = this._gain(0.3);
    o120.connect(g120); g120.connect(this.mainsG); o120.start();
    this._humOsc.push(o60, o120);

    // Ballast fixtures.
    this._fix = [];
    const pans = [-0.6, 0.5, 0.05];
    for (let i = 0; i < 3; i++) {
      const o = this._osc(i === 1 ? this._buzzWave2 : this._buzzWave, 120 * (1 + rnd(-0.0005, 0.0005)));
      const bp = this._bq('bandpass', rnd(900, 2400), rnd(0.55, 1));
      const body = this._bq('peaking', rnd(380, 620), 1.1, 4);
      const am = this._gain(1), lv = this._gain(0.7);
      this._chain(o, bp, body, am, lv);
      let pan = null;
      try { pan = c.createStereoPanner(); pan.pan.value = pans[i]; } catch (e) { pan = null; }
      if (pan) { lv.connect(pan); pan.connect(sum); } else lv.connect(sum);
      o.start();
      this._humOsc.push(o);
      this._fix.push({ o, bp, am, lv, next: 0 });
    }
    // The far fixture sits behind a wall: darker.
    this._fix[2].bp.frequency.value = 650;

    // Sizzle: noise ring-modulated by the ballast wave. The crackly electric fizz of old tubes.
    const szIn = this._gain(1);
    const szAM = this._gain(0);
    const zm = this._osc(this._buzzWave, 120), zg = this._gain(0.6);
    zm.connect(zg); zg.connect(szAM.gain); zm.start();
    this._humOsc.push(zm);
    this.sizzleG = this._gain(0.07);
    this._chain(szIn, this._bq('bandpass', 2800, 0.7), szAM, this.sizzleG, sum);
    this._mkBed(this._white, szIn, [5, 10]);

    // Tube hiss, decorrelated per ear.
    const m = c.createChannelMerger(2);
    for (const ch of [0, 1]) {
      const g = this._gain(1);
      g.connect(m, 0, ch);
      this._mkBed(this._white, g, [4, 9]);
    }
    this._chain(m, this._bq('bandpass', 5000, 0.6), this._gain(0.022), sum);
  }

  // Room tone: air whose colour follows room size, low rumble, a ventilation system that switches on and off,
  // and an occasional thin duct whistle.
  _buildRoom() {
    const c = this.ctx;
    // Air, decorrelated pink grains per ear.
    const am = c.createChannelMerger(2);
    for (const ch of [0, 1]) {
      const g = this._gain(1);
      g.connect(am, 0, ch);
      this._mkBed(this._pink, g, [4, 10]);
    }
    this.airBP = this._bq('bandpass', 600, 0.7);
    this.airPk = this._bq('peaking', 480, 1.4, 0);
    this.airLP = this._bq('lowpass', 3200, 0.5);
    this.airAM = this._gain(1);
    this.airG = this._gain(0);
    this._chain(am, this.airBP, this.airPk, this.airLP, this.airAM, this.airG, this.l0Bus);
    const as = this._gain(0.3);
    this.airG.connect(as); as.connect(this._l0s());

    // Low rumble of the building.
    const rm = c.createChannelMerger(2);
    for (const ch of [0, 1]) {
      const g = this._gain(1);
      g.connect(rm, 0, ch);
      this._mkBed(this._brown, g, [6, 12], [0.9, 1.1], 2.2);
    }
    this.roomPeak = this._bq('peaking', 380, 4, 0);
    this.roomG = this._gain(0.04);
    this._chain(rm, this._bq('lowpass', 320, 0.6), this.roomPeak, this.roomG, this.amb);

    // Ventilation: a body band and a duct roar band, slowly breathing.
    const vIn = this._gain(1);
    this._mkBed(this._pink, vIn, [5, 11]);
    this.ventLo = this._bq('bandpass', 140, 0.8);
    this.ventHi = this._bq('bandpass', 300, 1.3);
    const vSum = this._gain(1), vHiG = this._gain(0.55);
    vIn.connect(this.ventLo); this.ventLo.connect(vSum);
    vIn.connect(this.ventHi); this.ventHi.connect(vHiG); vHiG.connect(vSum);
    const vAM = this._gain(0.8);
    const vl = this._osc('sine', 0.047), vlg = this._gain(0.18);
    vl.connect(vlg); vlg.connect(vAM.gain); vl.start();
    this.ventG = this._gain(0.02);
    this._chain(vSum, vAM, this.ventG, this.l0Bus);
    const vs = this._gain(0.45);
    this.ventG.connect(vs); vs.connect(this._l0s());

    // A thin whistle somewhere in the ducts. Mostly absent; _ambTick brings it in now and then.
    const wIn = this._gain(1);
    this._mkBed(this._pink, wIn, [5, 10]);
    this.ductBP = this._bq('bandpass', 1380, 30);
    this.ductG = this._gain(0);
    this._chain(wIn, this.ductBP, this.ductG, this.l0Bus);
    const ws = this._gain(0.7);
    this.ductG.connect(ws); ws.connect(this._l0s());
  }

  _buildBreath() {
    // Breath noise through the filter cartridge and the mask cavity.
    const n = this._gain(1);
    this._mkBed(this._white, n, [5, 10]);
    this.bAir = this._bq('bandpass', 1300, 0.9);
    const mask = this._bq('peaking', 1150, 3, 8);
    const boom = this._bq('peaking', 170, 1, 4);
    this.bLP = this._bq('lowpass', 4500, 0.6);
    this.bAM = this._gain(1);
    this.bG = this._gain(0);
    this._chain(n, this.bAir, mask, boom, this.bLP, this.bAM, this.bG, this.mix);
    // Shudder for fear.
    const tr = this._osc('sine', 7.5);
    this.bTrem = this._gain(0);
    tr.connect(this.bTrem); this.bTrem.connect(this.bAM.gain); tr.start();
    this.valveG = this._gain(0.16);
    this.valveG.connect(this.mix);
  }

  _valve(t, a) {
    if (!this._valveBuf) return;
    const s = this.ctx.createBufferSource(), g = this._gain(a);
    s.buffer = this._valveBuf;
    s.playbackRate.value = rnd(0.88, 1.12);
    s.connect(g); g.connect(this.valveG);
    s.onended = () => { try { s.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
    s.start(Math.max(t, this.ctx.currentTime));
  }

  _buildHeart() {
    this.hbOsc = this._osc('sine', 45);
    this.hbG = this._gain(0);
    // A little second harmonic and a 'thump' band so the beat reads on small speakers too.
    const sh = this._shaper(2.5);
    this._chain(this.hbOsc, this.hbG, sh, this._bq('lowpass', 260, 0.7), this.mix);
    this.hbOsc.start();
  }

  _buildDrones() {
    // Fear: low beating saw drone. The lowpass opens with fear so its upper harmonics reach laptop speakers.
    this.fearLP = this._bq('lowpass', 180, 1.5);
    this.fearG = this._gain(0);
    for (const [t, f] of [['sawtooth', 41.2], ['sawtooth', 41.75], ['sine', 55], ['sawtooth', 82.9]]) {
      const o = this._osc(t, f);
      if (f > 80) { const g = this._gain(0.35); o.connect(g); g.connect(this.fearLP); } else o.connect(this.fearLP);
      o.start();
    }
    this._chain(this.fearLP, this.fearG, this.amb);

    // Sanity: detuned, wandering cluster.
    const sLP = this._bq('lowpass', 650, 1.2);
    const sl = this._osc('sine', 0.05), slg = this._gain(250);
    sl.connect(slg); slg.connect(sLP.frequency); sl.start();
    this.sanDet = this._gain(20);
    this.sanDet2 = this._gain(20);
    const la = this._osc('sine', 0.071), lb = this._osc('sine', 0.113);
    la.connect(this.sanDet); lb.connect(this.sanDet2); la.start(); lb.start();
    const defs = [['triangle', 98, this.sanDet], ['sawtooth', 103.8, this.sanDet2], ['sine', 146, this.sanDet], ['triangle', 207.6, this.sanDet2]];
    for (const [t, f, det] of defs) {
      const o = this._osc(t, f), g = this._gain(t === 'sawtooth' ? 0.35 : 0.6);
      det.connect(o.detune);
      o.connect(g); g.connect(sLP); o.start();
    }
    this.sanG = this._gain(0);
    this._chain(sLP, this.sanG, this.amb);
    const ss = this._gain(0.6);
    this.sanG.connect(ss); ss.connect(this.revIn);

    // Undertow: four slow voices that glide between dissonant chords, mostly heard through the reverb.
    // Always there at a whisper; dark, fear, low sanity and the title screen bring it forward.
    this.padLP = this._bq('lowpass', 500, 0.8);
    this.padG = this._gain(0);
    this._chain(this.padLP, this.padG, this.amb);
    const ps = this._gain(1.1);
    this.padG.connect(ps); ps.connect(this.revIn);
    this._pad = [];
    const root = 110;
    const ch0 = CHORDS[0];
    for (let i = 0; i < 4; i++) {
      const o = this._osc(this._padWave, root * Math.pow(2, ch0[i] / 12));
      const g = this._gain(0.2);
      const lfo = this._osc('sine', rnd(0.03, 0.11)), lg = this._gain(rnd(6, 14));
      lfo.connect(lg); lg.connect(o.detune); lfo.start();
      o.connect(g); g.connect(this.padLP); o.start();
      this._pad.push({ o, g });
    }

    // Wind tone: resonant noise slowly sweeping, the building exhaling somewhere far away.
    const wIn = this._gain(1);
    this._mkBed(this._pink, wIn, [5, 11]);
    this.windBP = this._bq('bandpass', 420, 5);
    this.windG = this._gain(0);
    this._chain(wIn, this.windBP, this.windG, this.amb);
    const wsend = this._gain(0.8);
    this.windG.connect(wsend); wsend.connect(this.revIn);
  }

  _buildSuit() {
    const n = this._gain(1);
    this._mkBed(this._white, n, [5, 10]);
    this.suitG = this._gain(0.004);
    this._chain(n, this._bq('bandpass', 3400, 0.5), this.suitG, this.mix);
  }

  _buildTinnitus() {
    this.tinG = this._gain(0);
    for (const f of [6950, 7012]) {
      const o = this._osc('sine', f);
      o.connect(this.tinG); o.start();
    }
    this.tinG.connect(this.pauseG);
  }

  // ---------------------------------------------------------------- beds driven by update()

  _beds(now, st) {
    const alive = st.dead ? 0 : 1;
    const mk = st.mk || 0, play = 1 - mk;
    const ins = clamp((0.5 - st.sanity) / 0.5);
    // Slower glides while crossfading to or from the title screen.
    const slow = mk > 0.001 && mk < 0.999 ? 0.6 : 0;

    if (this.humG) {
      // Light-driven, quieter than before, and on the title screen a distant lamp through a wall.
      const lvl = (0.085 * Math.pow(st.hum, 1.15) * (1 - st.blackout) * (1 - 0.78 * st.dark) * play + 0.05 * mk) * alive;
      const tc = st.dead ? 1.2 : st.blackout > 0.05 ? 0.07 : 0.35 + slow;
      this._tg(this.humG.gain, lvl, tc);
      this._tg(this.humLP.frequency, lerp(7000 - 3600 * st.dark, 1700, mk), 0.4 + slow);
    }
    if (this.airG) {
      const r = st.room;
      // Small rooms: boxy, closer, brighter air. Big halls: darker, wider, more of it in the reverb.
      this._tg(this.airBP.frequency, lerp(820, 380, r), 0.8);
      this._tg(this.airBP.Q, lerp(0.9, 0.5, r), 0.8);
      this._tg(this.airPk.gain, lerp(5, -2, r), 0.8);
      this._tg(this.airLP.frequency, lerp(3600, 2000, r) * (1 - 0.35 * st.dark), 0.8);
      this._tg(this.airG.gain, ((0.026 + 0.012 * r + 0.012 * st.dark) * play + 0.03 * mk) * (st.dead ? 0.4 : 1), 0.8 + slow);
    }
    if (this.roomG) {
      this._tg(this.roomG.gain, (0.035 + 0.04 * st.dark) * (st.dead ? 0.4 : 1) * this._pfv('rumble'), 0.6 + slow);
      this._tg(this.roomPeak.gain, 9 * st.dark, 0.8);
    }
    if (this.revRet) {
      const r = st.room;
      if (this.revShort) {
        this._tg(this.revShort.gain, Math.cos(r * Math.PI / 2), 0.4);
        this._tg(this.revLong.gain, Math.sin(r * Math.PI / 2), 0.4);
      }
      this._tg(this.revRet.gain, 0.35 + 0.65 * r, 0.4);
      this._tg(this.preDelay.delayTime, 0.004 + 0.026 * r, 0.4);
      this._tg(this.revLP.frequency, 3800 + 3200 * r, 0.4);
      this._tg(this.erG.gain, 0.06 + 0.34 * (1 - r), 0.4);
    }
    if (this.suitG) this._tg(this.suitG.gain, (0.004 + 0.009 * st.exertion) * alive * play, 0.5 + slow);
    if (this.fearG) {
      this._tg(this.fearG.gain, 0.06 * st.fear * st.fear * alive, 0.5);
      this._tg(this.fearLP.frequency, 180 + 420 * st.fear, 0.5);
    }
    if (this.sanG) {
      this._tg(this.sanG.gain, 0.05 * ins * alive, 1.2);
      this._tg(this.sanDet.gain, 15 + 70 * ins, 1);
      this._tg(this.sanDet2.gain, 18 + 90 * ins, 1);
    }
    if (this.padG) {
      const lvl = ((0.006 + 0.022 * st.dark + 0.02 * st.fear + 0.022 * ins) * play + 0.03 * mk) * alive;
      this._tg(this.padG.gain, lvl * this._pfv('pad'), 1.5 + slow);
      this._tg(this.padLP.frequency, (650 + 900 * st.fear + 400 * ins + 250 * mk) * (this._padOpen || 1), 2);
    }
    if (this.windG) {
      this._tg(this.windG.gain, ((0.007 + 0.025 * st.dark + 0.01 * st.room) * play + 0.03 * mk) * (st.dead ? 0.3 : 1) * this._pfv('wind'), 1.5 + slow);
    }
    if (this.bTrem) this._tg(this.bTrem.gain, 0.45 * st.fear * alive, 0.3);

    if (this.deadLP) this._tg(this.deadLP.frequency, st.dead ? 380 : 20000, st.dead ? 0.7 : 0.25);
    if (st.dead !== this._wasDead && this.tinG) {
      this._wasDead = st.dead;
      const g = this.tinG.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      if (st.dead) {
        g.setTargetAtTime(0.016, now, 0.3);
        g.setTargetAtTime(0.004, now + 3, 2.5);
      } else {
        g.setTargetAtTime(0, now, 0.2);
      }
    }
  }

  // Slow life in the beds: lamp drift, flutter and dropouts, mains drift, ventilation cycles, duct whistle,
  // chord changes in the undertow, wind sweeps. Everything here is sparse and randomised, nothing periodic.
  _ambTick(now, dt, st) {
    const A = this._am || (this._am = {
      chr: rnd(8, 20), fl: rnd(3, 10), dr: rnd(20, 50), drift: 0, dT: 0,
      vent: true, vT: rnd(25, 60), vS: 0, duct: rnd(15, 40), ductOn: 0,
      pad: 0, wind: 0, air: 0,
    });
    const mk = st.mk || 0, alive = st.dead ? 0 : 1;
    const humLvl = st.hum * (1 - st.blackout) * (1 - st.dark) * alive;

    // Lamps.
    if (this._fix) {
      for (const f of this._fix) {
        if (now < f.next) continue;
        f.next = now + rnd(1.2, 4.5);
        // Mostly steady, sometimes one tube sags for a while.
        const target = Math.random() < 0.15 ? rnd(0.15, 0.45) : rnd(0.55, 1);
        this._tg(f.lv.gain, target, rnd(0.6, 2.5));
      }
      A.dT -= dt;
      if (A.dT <= 0) {
        A.dT = rnd(2, 6);
        A.drift = clamp(A.drift + rnd(-1.5, 1.5), -5, 5); // mains frequency wander, in cents
      }
      const det = A.drift - 380 * st.blackout;
      for (const o of this._humOsc) this._tg(o.detune, det, st.blackout > 0.01 ? 0.12 : 1.5);

      A.chr -= dt;
      if (A.chr <= 0) {
        // A new character: the tubes warm up, a different one dominates, the buzz gets thinner or harsher.
        A.chr = rnd(14, 45);
        this._fix.forEach((f, i) => {
          const tc = rnd(2.5, 6);
          this._tg(f.bp.frequency, i === 2 ? rnd(450, 900) : rnd(700, 2800), tc);
          this._tg(f.bp.Q, rnd(0.5, 1.4), tc);
        });
        this._tg(this.mainsG.gain, rnd(0.13, 0.26), rnd(3, 6));
        this._tg(this.sizzleG.gain, Math.random() < 0.3 ? rnd(0.1, 0.18) : rnd(0.03, 0.09), rnd(2, 5));
      }

      A.fl -= dt;
      if (A.fl <= 0) {
        A.fl = rnd(6, 20) * (1 + mk);
        if (humLvl > 0.08 || mk > 0.5) this._flutter(now, mk);
      }
      A.dr -= dt;
      if (A.dr <= 0) {
        A.dr = rnd(30, 95) * (1 + 1.5 * mk);
        if (humLvl > 0.2 && mk < 0.5 && (this._pw.level0 || 0) > 0.5) this._dropout(now);
      }
    }

    // Ventilation switching on and off.
    if (this.ventG) {
      A.vT -= dt;
      if (A.vT <= 0) {
        A.vent = !A.vent;
        A.vT = A.vent ? rnd(30, 90) : rnd(18, 55);
        const tc = A.vent ? rnd(1.2, 2.5) : rnd(2.5, 5);
        this._tg(this.ventHi.frequency, A.vent ? rnd(380, 560) : 220, tc);
        this._tg(this.ventLo.frequency, A.vent ? rnd(130, 170) : 100, tc);
        if (alive && (this._pw.level0 || 0) > 0.5) {
          const L = this._L, a = rnd(0, TAU), d = rnd(5, 14);
          this._shot('_clunk', { pos: [L.x + Math.cos(a) * d, L.y + 1.4, L.z + Math.sin(a) * d], vol: (A.vent ? 0.7 : 0.45) * (1 - 0.5 * mk) }, { ref: 5 });
        }
      }
      A.vS -= dt;
      if (A.vS <= 0) { A.vS = rnd(3, 8); A.vSurge = rnd(0.75, 1.25); }
      const vl = (A.vent ? 0.05 : 0.01) * (A.vSurge || 1) * (1 - 0.3 * st.dark) * (st.dead ? 0.3 : 1) * (1 - 0.3 * mk);
      this._tg(this.ventG.gain, vl, A.vent ? 1.6 : 3);
    }

    // Duct whistle, now and then.
    if (this.ductG) {
      A.duct -= dt;
      if (A.duct <= 0) {
        if (A.ductOn) {
          A.ductOn = 0;
          A.duct = rnd(20, 60);
          this._tg(this.ductG.gain, 0, rnd(2, 5));
        } else if (Math.random() < 0.55) {
          A.ductOn = 1;
          A.duct = rnd(6, 18);
          this._tg(this.ductBP.frequency, rnd(800, 1900), rnd(4, 9));
          this._tg(this.ductG.gain, rnd(0.004, 0.011) * alive, rnd(2, 5));
        } else {
          A.duct = rnd(15, 40);
        }
      }
    }

    // Undertow chords.
    if (this._pad) {
      A.pad -= dt;
      if (A.pad <= 0) {
        A.pad = rnd(12, 30) * (mk > 0.5 ? 1.3 : 1);
        const root = pick([110, 116.5, 123.5, 130.8, 138.6, 146.8]);
        const chord = pick(CHORDS);
        const glide = rnd(2.5, 8);
        this._pad.forEach((v, i) => {
          let f = root * Math.pow(2, chord[i] / 12);
          while (f < 100) f *= 2; // keep it where small speakers can play it
          this._tg(v.o.frequency, f, glide * rnd(0.7, 1.3));
          this._tg(v.g.gain, Math.random() < 0.2 ? 0 : rnd(0.12, 0.3), rnd(3, 7));
        });
        this._padOpen = rnd(0.8, 1.35);
      }
    }
    if (this.windBP) {
      A.wind -= dt;
      if (A.wind <= 0) {
        A.wind = rnd(4, 12);
        this._tg(this.windBP.frequency, rnd(240, 820), rnd(3, 7));
        this._tg(this.windBP.Q, rnd(3, 9), 4);
      }
    }
    if (this.airAM) {
      A.air -= dt;
      if (A.air <= 0) { A.air = rnd(4, 10); this._tg(this.airAM.gain, rnd(0.75, 1.15), rnd(2, 4)); }
    }
  }

  // Ballast flutter on one fixture: the irregular stutter of a tube about to fail.
  _flutter(now, mk) {
    const f = pick(this._fix);
    const g = f.am.gain, t0 = now + 0.03, dur = rnd(0.15, mk > 0.5 ? 0.8 : 1.8);
    g.cancelScheduledValues(t0);
    let tt = t0;
    while (tt < t0 + dur) {
      g.setTargetAtTime(Math.random() < 0.35 ? rnd(0, 0.25) : rnd(0.6, 1.6), tt, 0.006);
      tt += rnd(0.02, 0.09);
    }
    g.setTargetAtTime(1, t0 + dur, 0.06);
    if (Math.random() < 0.4 && mk < 0.5 && (this._pw.level0 || 0) > 0.5) {
      const L = this._L;
      this._shot('_lamp', { pos: [L.x + rnd(-4, 4), L.y + 1.4, L.z + rnd(-4, 4)], vol: 0.35 }, { s: rnd(0.25, 0.5) });
    }
  }

  // All lamps dip at once for a moment (a brownout), then catch again.
  _dropout(now) {
    const g = this.humDrop.gain, t0 = now + 0.02;
    g.cancelScheduledValues(t0);
    const n = Math.random() < 0.35 ? 2 : 1;
    let t = t0;
    for (let i = 0; i < n; i++) {
      const len = rnd(0.06, 0.4);
      g.setTargetAtTime(rnd(0.04, 0.3), t, 0.012);
      g.setTargetAtTime(1, t + len, 0.03);
      t += len + rnd(0.12, 0.35);
    }
    const L = this._L;
    this._shot('_lamp', { pos: [L.x + rnd(-3, 3), L.y + 1.4, L.z + rnd(-3, 3)], vol: 0.45 }, { s: rnd(0.3, 0.6) });
  }

  _breathTick(now, s) {
    const b = this._br;
    if (!this.bG) return;
    // No breathing while dead or on the title screen; it starts again gently after the crossfade.
    if (s.dead || (s.mk || 0) > 0.35) {
      if (!b.off) {
        this.bG.gain.cancelScheduledValues(now);
        this.bG.gain.setTargetAtTime(0, now, s.dead ? 0.1 : 0.6);
        b.off = true;
      }
      b.next = now + (s.dead ? 1.5 : 0.8);
      return;
    }
    b.off = false;
    const drive = clamp(Math.max(s.exertion, s.fear * 0.9));
    // A sudden sprint or scare cuts the calm pause short instead of waiting for the slow cycle.
    if (b.restAt && now >= b.restAt && drive > b.drive + 0.25) b.next = now;
    if (now < b.next - 0.06) return;
    const t = Math.max(now + 0.03, b.next);
    const bpm = (13 + 27 * drive) * rnd(0.88, 1.12);
    const cyc = 60 / bpm;
    const depth = rnd(0.78, 1.15);
    const pIn = (0.11 + 0.33 * drive) * depth;
    const pEx = (0.13 + 0.4 * drive) * depth * rnd(0.85, 1.1);
    const inD = cyc * lerp(0.34, 0.42, drive) * rnd(0.9, 1.1);
    const exD = cyc * lerp(0.42, 0.48, drive) * rnd(0.9, 1.1);
    const te = t + inD + rnd(0.03, 0.08);
    const g = this.bG.gain, f = this.bAir.frequency, lp = this.bLP.frequency;
    g.cancelScheduledValues(t); f.cancelScheduledValues(t); lp.cancelScheduledValues(t);

    // Inhale: airy, a little whistly through the cartridge.
    f.setTargetAtTime((1450 + 550 * drive) * rnd(0.92, 1.08), t, inD * 0.4);
    lp.setTargetAtTime(4200 + 2600 * drive, t, 0.1);
    if (s.fear > 0.3 && Math.random() < s.fear) {
      const k = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < k; i++) {
        const ti = t + (inD * i) / k;
        g.setTargetAtTime(pIn * rnd(0.45, 1.1), ti, (inD / k) * 0.3);
        g.setTargetAtTime(pIn * 0.2, ti + (inD / k) * 0.65, 0.02);
      }
    } else {
      g.setTargetAtTime(pIn, t, inD * 0.35);
    }
    g.setTargetAtTime(0, t + inD * 0.8, inD * 0.08);

    // Exhale: lower, wider, pushed out through the exhale valve.
    f.setTargetAtTime(820 + 320 * drive, te, 0.05);
    f.setTargetAtTime(640, te + exD * 0.5, exD * 0.3);
    lp.setTargetAtTime(2500 + 2700 * drive, te, 0.1);
    g.setTargetAtTime(pEx, te, exD * 0.18);
    g.setTargetAtTime(0, te + exD * 0.55, exD * 0.22);

    this._valve(t - 0.01, 0.5 + 0.4 * drive);
    this._valve(te - 0.01, 0.8 + 0.3 * drive);
    b.next = t + cyc;
    b.restAt = te + exD * 0.7;
    b.drive = drive;
  }

  _heartTick(now, s) {
    const hb = this._hb;
    if (!this.hbG) return;
    const lvl = smoothstep(0.35, 1, s.fear) * (s.dead ? 0 : 1) * (1 - (s.mk || 0));
    if (lvl < 0.01) { hb.next = now; return; }
    if (now < hb.next - 0.06) return;
    const t = Math.max(now + 0.02, hb.next);
    const per = 60 / (72 + 85 * clamp((s.fear - 0.35) / 0.65));
    const A = 0.45 * lvl;
    const g = this.hbG.gain, f = this.hbOsc.frequency;
    const beat = (tb, a, f0) => {
      f.setValueAtTime(f0, tb);
      f.setTargetAtTime(36, tb + 0.005, 0.05);
      g.setTargetAtTime(a, tb, 0.007);
      g.setTargetAtTime(0, tb + 0.04, 0.045);
    };
    beat(t, A, 64);
    beat(t + Math.min(0.3, per * 0.34), A * 0.7, 72);
    hb.next = t + per * rnd(0.97, 1.03);
  }

  // Distant life. Sparse and irregular: an event every 8 to 26 s (sooner as sanity drops), sometimes a
  // follow-up a few seconds later from nearly the same place, and sometimes the whole ambience 'holds its
  // breath' for a couple of seconds before it. On the title screen only slow, far, non-human sounds.
  _events(dt, st) {
    if (st.dead) return;
    const mk = st.mk || 0;
    const ins = clamp((0.5 - st.sanity) / 0.5);
    if (this._follow) {
      this._follow.t -= dt;
      if (this._follow.t <= 0) {
        const f = this._follow;
        this._follow = null;
        if (mk < 0.5) this._farEvent(f.name, f.pos, f.vol);
      }
    }
    this._distT -= dt;
    if (this._hushPlan && !this._hushOn && this._distT < 2.4 && mk < 0.5 && this.amb) {
      this._hushOn = true;
      this._tg(this.amb.gain, 0.45, 0.6);
    }
    if (this._distT <= 0) {
      this._distT = rnd(8, 26) * (0.45 + 0.55 * st.sanity) * (1 + 1.4 * mk) / Math.max(0.2, this._pfv('ev'));
      this._distant(st, mk);
      if (this._hushOn && this.amb) {
        // Let the room come back slowly after the sound.
        this._hushOn = false;
        const g = this.amb.gain, now = this.ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.setTargetAtTime(1, now + 1.4, 2.2);
        this._last.set(g, 1);
      }
      this._hushPlan = mk < 0.5 && Math.random() < 0.3;
    }
    if (ins > 0 && mk < 0.5) {
      this._sanT -= dt;
      if (this._sanT <= 0) {
        this._sanT = rnd(5, 18) * (1.15 - ins);
        this._sanityEvent(ins);
      }
    }
  }

  _farEvent(name, pos, vol) {
    this._shot(name, { pos, vol }, { ref: 9 });
  }

  _distant(st, mk) {
    const L = this._L, a = rnd(0, TAU), d = rnd(16, 42);
    const pos = [L.x + Math.cos(a) * d, L.y + rnd(-1, 2.5), L.z + Math.sin(a) * d];
    const pl = this._domPlace();
    if (mk < 0.5 && pl !== 'level0') {
      // Other places have their own far-off life (see PLACE_EVENTS). Level ! has none: only the alarm and the roar.
      const list = PLACE_EVENTS[pl];
      if (!list) return;
      if (pl === 'level5' && Math.random() < 0.12 + 0.3 * (1 - st.sanity)) {
        this._whisperAt(pos, pick(['murmur', 'murmur', 'cry', 'laugh']), false, 0.6, undefined, 7);
        return;
      }
      const name = wpick(list);
      this._farEvent(name, pos, rnd(0.5, 1.1) * (pl === 'level37' ? 0.6 : 1));
      return;
    }
    if (mk < 0.5 && Math.random() < 0.08 + 0.3 * (1 - st.sanity)) {
      this._whisperAt(pos, pick(['murmur', 'murmur', 'call', 'cry', 'laugh']), false, 0.8, undefined, 7);
      return;
    }
    const name = mk >= 0.5
      ? wpick([['_farTone', 2], ['_creak', 2], ['_pipe', 1], ['_thud', 0.7], ['_metal', 0.6]])
      : wpick([['_thud', 2], ['doorSlam', 0.8], ['_drag', 1], ['_pipe', 1.4], ['_creak', 1.6], ['_metal', 1],
        ['_farTone', 0.5 + 1.5 * (1 - st.sanity) + 0.5 * st.dark], ['_farSteps', 0.6 + 0.6 * st.dark], ['knock', 0.3]]);
    const vol = rnd(0.6, 1.2) * (mk >= 0.5 ? 0.5 : 1);
    this._farEvent(name, pos, vol);
    if (mk < 0.5 && Math.random() < 0.28) {
      const next = { _thud: '_drag', _drag: '_thud', doorSlam: '_farSteps', _metal: '_metal', _pipe: '_pipe', _creak: '_creak', _farSteps: 'doorSlam', knock: 'knock' }[name];
      if (next) {
        const b = a + rnd(-0.25, 0.25), d2 = d + rnd(-4, 4);
        this._follow = { t: rnd(1.2, 4.5), name: next, pos: [L.x + Math.cos(b) * d2, pos[1], L.z + Math.sin(b) * d2], vol: vol * rnd(0.6, 1) };
      }
    }
  }

  _sanityEvent(ins) {
    const L = this._L, a = rnd(0, TAU);
    if (Math.random() < 0.55) {
      const d = rnd(0.6, 1.3);
      this._whisperAt([L.x + Math.cos(a) * d, L.y + rnd(-0.2, 0.3), L.z + Math.sin(a) * d], 'whisper', false, 0.35 + 0.4 * ins, 0.15);
    } else {
      const d = rnd(3, 7);
      this._shot('apparition', { pos: [L.x + Math.cos(a) * d, L.y, L.z + Math.sin(a) * d], vol: 0.3 + 0.4 * ins });
    }
  }

  // ---------------------------------------------------------------- one shot voices

  // o: pos [x,y,z] (3D) | ui | dest (a node to feed instead of the mix) | big (skip the compressor) |
  //    free (owned by an entity or a place layer: not counted against the voice cap, the owner caps it).
  _voice(o) {
    const c = this.ctx;
    if (!c || c.state === 'closed') return null;
    if (!o.free && this._active >= this._maxVoices() && !(o.prio && this._active < this._maxVoices() + 6)) return null;
    const v = { nodes: [], srcs: 0, done: false, timer: 0, free: !!o.free, onFree: o.onFree || null };
    v.out = this._gain(1);
    v.nodes.push(v.out);
    const bus = o.big ? this.hitBus : (o.dest || this.mix);
    if (o.ui) {
      v.out.connect(this.uiBus);
    } else if (o.pos) {
      const [x, y, z] = o.pos;
      const d = this._dist(x, y, z);
      const lp = this._bq('lowpass', this._lpFor(d), 0.5);
      const p = this._panner(!!o.hrtf);
      if (o.ref) p.refDistance = o.ref; // distant ambience: audible far away instead of -30 dB
      const sg = this._gain(this._sendFor(o.send || 0, d));
      v.out.connect(lp); lp.connect(p); p.connect(bus);
      lp.connect(sg); sg.connect(this.revIn);
      this._setPos(p, x, y, z, false);
      v.nodes.push(lp, p, sg);
    } else {
      v.out.connect(bus);
      if (o.send > 0 && !o.dest) {
        const sg = this._gain(o.send);
        v.out.connect(sg); sg.connect(this.revIn);
        v.nodes.push(sg);
      }
    }
    if (!v.free) this._active++;
    return v;
  }

  _maxVoices() { return this._mobile ? 12 : MAX_VOICES; }

  _run(v, src, t0, t1, off) {
    v.nodes.push(src);
    v.srcs++;
    src.onended = () => {
      v.srcs--;
      if (v.srcs <= 0) this._free(v);
    };
    if (off) src.start(t0, off);
    else src.start(t0);
    src.stop(t1);
  }

  _finish(v, dur) {
    if (v.srcs <= 0) { this._free(v); return; }
    // Safety net: frees the voice even if 'ended' never fires (suspended context).
    v.timer = setTimeout(() => this._free(v), (dur + 1.5) * 1000);
  }

  _free(v) {
    if (v.done) return;
    v.done = true;
    if (!v.free) this._active = Math.max(0, this._active - 1);
    if (v.onFree) { try { v.onFree(); } catch (e) { /* ignore */ } v.onFree = null; }
    clearTimeout(v.timer);
    for (const n of v.nodes) {
      try { if (n.onended !== undefined) n.onended = null; } catch (e) { /* ignore */ }
      try { n.disconnect(); } catch (e) { /* ignore */ }
    }
    v.nodes.length = 0;
  }

  // Oscillator with pitch glide and AD envelope.
  _tone(v, t, type, f0, f1, glide, peak, a, d, dest) {
    const o = this._osc(type, f0);
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
    const g = this._gain(0);
    this._ad(g.gain, t, a, peak, d);
    o.connect(g); g.connect(dest || v.out);
    v.nodes.push(g);
    this._run(v, o, t, t + a + d + 0.05);
    return o;
  }

  // Filtered noise burst with AD envelope.
  _burst(v, t, ftype, f, Q, peak, a, d, dest, buf) {
    const s = this._loop(buf || this._white);
    const fl = this._bq(ftype, f, Q);
    const g = this._gain(0);
    this._ad(g.gain, t, a, peak, d);
    this._chain(s, fl, g, dest || v.out);
    v.nodes.push(fl, g);
    this._run(v, s, t, t + a + d + 0.05, rnd(0, 1.5));
    return { s, fl, g };
  }

  _shot(name, o, extra) {
    const fn = SFX[name];
    if (!fn || !this._ready) return null;
    o = o || {};
    extra = extra || null;
    let pos = null;
    if (Array.isArray(o.pos) && o.pos.length >= 3) pos = [num(o.pos[0], 0), num(o.pos[1], 0), num(o.pos[2], 0)];
    if (!pos && name === 'apparition') {
      const L = this._L;
      pos = [L.x - L.fx * 3, L.y + 0.1, L.z - L.fz * 3];
    }
    if (!pos && name === 'behind') {
      const L = this._L;
      pos = [L.x - L.fx * 0.45, L.y - 0.05, L.z - L.fz * 0.45];
    }
    const x = extra || {};
    const v = this._voice({
      prio: PRIO.has(name) || BIG.has(name) || x.prio,
      pos,
      send: x.send !== undefined ? x.send : SEND[name] !== undefined ? SEND[name] : 0.15,
      ui: name.startsWith('ui'),
      hrtf: !!x.hrtf || BIG.has(name) || name === 'behind',
      ref: x.ref,
      big: x.big || BIG.has(name),
      dest: x.dest,
      free: x.free,
      onFree: x.onFree,
    });
    if (!v) return null;
    v.out.gain.value = clamp(num(o.vol, 1), 0, 2);
    let dur = 1;
    try {
      dur = fn.call(this, v, this.ctx.currentTime + 0.006 + clamp(num(x.delay, 0), 0, 3), o, x) || 1;
    } catch (e) {
      this._err(e);
    }
    this._finish(v, dur);
    return v;
  }

  // opts: { pos: [x, y, z], vol (0..2), pitch (0.5..2, SOUNDS_03 names), delay (s) }.
  // With a delay the room drops to near-silence first and the sound lands after it (the half second of quiet
  // before a scare). Unknown names are ignored.
  play(name, opts) {
    if (!this._ready || typeof name !== 'string' || name[0] === '_' || !SFX[name]) return;
    try {
      const delay = clamp(num(opts && opts.delay, 0), 0, 3);
      if (delay > 0) this.hush(delay + 0.05, true);
      this._shot(name, opts, delay > 0 ? { delay } : null);
    } catch (e) { this._err(e); }
  }

  // Duck the room tone and the lamp hum to near-silence for sec seconds (0.5 s is the 'quiet before').
  hush(sec, fast) {
    if (!this._ready || !this.hitDuck) return;
    try {
      const g = this.hitDuck.gain, now = this.ctx.currentTime, d = clamp(num(sec, 0.5), 0.05, 6);
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.setTargetAtTime(0.04, now, fast ? 0.03 : 0.12);
      g.setTargetAtTime(1, now + d, 0.9);
    } catch (e) { this._err(e); }
  }

  // kind: 'carpet' (a normal step; the name is historic) | 'stair' | 'crouch' | 'land'.
  // surface: one of STEPS in biomes.js; missing means the current place's floor. Standing in water (state.water)
  // turns any step into wading, louder and longer the deeper and faster.
  footstep(kind, loud, surface) {
    if (!this._ready) return;
    try {
      const k = kind === 'stair' || kind === 'crouch' || kind === 'land' ? kind : 'carpet';
      let surf = STEP_SET.has(surface) ? surface : (PLACE_STEP[this._domPlace()] || 'carpet');
      if (this._x.water > 0.03) surf = 'water';
      this._shot('_foot', { vol: 1 }, { kind: k, loud: clamp(num(loud, 0.5)), surf, depth: this._x.water });
    } catch (e) { this._err(e); }
  }

  lampTick(x, y, z, strength) {
    if (!this._ready) return;
    try {
      this._shot('_lamp', { pos: [x, y, z] }, { s: clamp(num(strength, 0.6)) });
    } catch (e) { this._err(e); }
  }

  // ---------------------------------------------------------------- voices (formant synthesis)

  whisper(x, y, z, kind) {
    if (!this._ready) return;
    try {
      const k = ['whisper', 'call', 'laugh', 'cry', 'mimic', 'murmur'].includes(kind) ? kind : 'whisper';
      this._whisperAt([num(x, 0), num(y, 0), num(z, 0)], k, true, 1);
    } catch (e) { this._err(e); }
  }

  _whisperAt(pos, kind, prio, vol, send, ref) {
    const d = this._dist(pos[0], pos[1], pos[2]);
    const sendAmt = send !== undefined ? send : d < 2.5 ? 0.25 : 1.1;
    const v = this._voice({ prio, pos, send: sendAmt, hrtf: true, ref });
    if (!v) return;
    v.out.gain.value = vol;
    let dur = 3;
    try { dur = this._speak(v, this.ctx.currentTime + 0.02, kind); } catch (e) { this._err(e); }
    this._finish(v, dur);
  }

  // Glottal source + aspiration noise -> parallel formant bank, driven by a syllable plan.
  _speak(v, t, kind) {
    const female = Math.random() < 0.45;
    let base = female ? rnd(195, 235) : rnd(105, 135);
    let tract = female ? rnd(1.08, 1.16) : rnd(0.96, 1.04);
    let vib = 0.01, vibRate = rnd(4.8, 5.8), breathy = 0.12, voiced = true, hAmt = 0.7, level = 1;
    const sy = [];
    const vowels = ['a', 'e', 'i', 'o', 'u', 'uh', 'uh'];

    if (kind === 'whisper') {
      voiced = false; level = 0.9;
      const n = 5 + ((Math.random() * 8) | 0);
      for (let i = 0; i < n; i++) {
        if (i > 2 && Math.random() < 0.15) sy.push({ pause: true, d: rnd(0.12, 0.3) });
        sy.push({ d: rnd(0.1, 0.2), vw: pick(vowels), amp: rnd(0.5, 1), on: pick(['s', 'sh', 'h', 'k', 'f', null, null, 'h']) });
      }
    } else if (kind === 'murmur') {
      // Someone talking quietly a few rooms away.
      level = 0.55; breathy = 0.2;
      const n = 7 + ((Math.random() * 10) | 0);
      let p = rnd(0.95, 1.08);
      for (let i = 0; i < n; i++) {
        if (i > 2 && Math.random() < 0.18) sy.push({ pause: true, d: rnd(0.15, 0.45) });
        const p2 = p * rnd(0.93, 1.06);
        sy.push({ d: rnd(0.09, 0.2), vw: pick(vowels), a: p, b: p2, amp: rnd(0.5, 1), on: pick(['m', 'l', 'k', 's', 'h', null, null]) });
        p = clamp(p2, 0.85, 1.15);
      }
    } else if (kind === 'call' || kind === 'mimic') {
      // "hello?" shape: short 'heh', long rising 'lo'.
      const mimic = kind === 'mimic';
      level = 1.15;
      if (mimic) { vib = 0; tract *= pick([0.84, 1.2]); }
      const rise = mimic ? 1 : 1.35;
      sy.push({ d: 0.17, vw: 'e', a: 1.06, b: 1.0, amp: 0.85, on: 'h' });
      if (mimic && Math.random() < 0.7) sy.push({ d: 0.12, vw: 'o', a: 1, b: 1, amp: 0.8, on: 'l' });
      sy.push({ d: rnd(0.45, 0.6), vw: 'o', a: 0.96, b: rise, amp: 1, on: 'l' });
      if (mimic) sy.push({ d: 0.45, vw: 'o', a: 1, b: 0.5, amp: 0.7, on: null }); // wrong, sagging tail
      if (!mimic && Math.random() < 0.4) {
        sy.push({ pause: true, d: rnd(0.6, 1.0) });
        sy.push({ d: 0.15, vw: 'e', a: 1.04, b: 1.0, amp: 0.7, on: 'h' });
        sy.push({ d: rnd(0.5, 0.7), vw: 'o', a: 0.95, b: 1.25, amp: 0.8, on: 'l' });
      }
    } else if (kind === 'laugh') {
      // A short laugh that goes wrong: slows down and drops too low.
      hAmt = 1; breathy = 0.3; level = 0.9;
      base *= 1.25;
      const n = 4 + ((Math.random() * 4) | 0);
      let p = 1.25;
      for (let i = 0; i < n; i++) {
        const late = i >= n - 2;
        sy.push({ d: late ? rnd(0.24, 0.32) : rnd(0.13, 0.17), vw: 'a', a: p, b: p * 0.95, amp: rnd(0.75, 1), on: 'h', tr: late ? 0.85 : 1 });
        p *= late ? 0.72 : 0.94;
      }
    } else if (kind === 'cry') {
      vib = 0.035; vibRate = 6.5; breathy = 0.35; level = 0.85;
      base *= 1.45;
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        sy.push({ d: rnd(0.2, 0.3), vw: 'uh', amp: 0.55, on: 'h', unvoiced: true }); // gasp
        sy.push({ d: rnd(0.45, 0.8), vw: pick(['u', 'a', 'uh']), a: rnd(1.05, 1.2), b: rnd(0.8, 0.9), amp: 1, on: null });
        sy.push({ pause: true, d: rnd(0.1, 0.35) });
      }
    }

    // Nodes.
    const glot = this._gain(1);
    const sum = this._gain(1);
    const outLP = this._bq('lowpass', 5200, 0.6);
    this._chain(sum, outLP, v.out);
    v.nodes.push(glot, sum, outLP);
    const Qs = voiced ? [6, 10, 13] : [3, 6, 8];
    const fg = [1, 0.55, 0.3];
    const F = [0, 1, 2].map((i) => {
      const f = this._bq('bandpass', VOWELS.uh[i] * tract, Qs[i]);
      const g = this._gain(fg[i]);
      glot.connect(f); f.connect(g); g.connect(sum);
      v.nodes.push(f, g);
      return f;
    });
    const f4 = this._bq('bandpass', 3500 * tract, 7), f4g = this._gain(0.12);
    glot.connect(f4); f4.connect(f4g); f4g.connect(sum);
    v.nodes.push(f4, f4g);

    // Estimate the plan length first so every source gets one stop time.
    let total = 0.05;
    for (const s of sy) total += s.d;
    const tEnd = t + total + 0.4;

    let osc = null, vg = null;
    if (voiced) {
      osc = this._osc(this._glotWave, base);
      vg = this._gain(0);
      osc.connect(vg); vg.connect(glot);
      v.nodes.push(vg);
      this._run(v, osc, t, tEnd);
      if (vib > 0) {
        const lfo = this._osc('sine', vibRate), lg = this._gain(base * vib);
        lfo.connect(lg); lg.connect(osc.frequency);
        v.nodes.push(lg);
        this._run(v, lfo, t, tEnd);
      }
      // Slow random pitch wander (jitter) from slowed brown noise.
      const jit = this._loop(this._brown, 0.35), jg = this._gain(base * 0.025);
      jit.connect(jg); jg.connect(osc.frequency);
      v.nodes.push(jg);
      this._run(v, jit, t, tEnd, rnd(0, 3));
    }
    const bn = this._loop(this._white), bg = this._gain(0);
    bn.connect(bg); bg.connect(glot);
    v.nodes.push(bg);
    this._run(v, bn, t, tEnd, rnd(0, 1.5));
    const fn = this._loop(this._white), fF = this._bq('bandpass', 5000, 1.6), fG = this._gain(0);
    this._chain(fn, fF, fG, sum);
    v.nodes.push(fF, fG);
    this._run(v, fn, t, tEnd, rnd(0, 1.5));

    let tt = t + 0.03;
    for (const s of sy) {
      if (s.pause) {
        if (vg) vg.gain.setTargetAtTime(0, tt, 0.03);
        bg.gain.setTargetAtTime(0, tt, 0.03);
        tt += s.d;
        continue;
      }
      const tr = tract * (s.tr || 1);
      const fv = VOWELS[s.vw] || VOWELS.uh;
      const amp = s.amp * level;
      let on = 0;
      if (s.on === 'l' || s.on === 'm') {
        const fc = VOWELS[s.on];
        for (let i = 0; i < 3; i++) F[i].frequency.setTargetAtTime(fc[i] * tr, tt, 0.012);
        if (vg) vg.gain.setTargetAtTime(amp * 0.45, tt, 0.012);
        on = 0.055;
      } else if (s.on === 'h') {
        bg.gain.setTargetAtTime(amp * hAmt, tt, 0.012);
        if (vg) vg.gain.setTargetAtTime(0, tt, 0.01);
        on = 0.06;
      } else if (s.on === 's' || s.on === 'sh' || s.on === 'f') {
        fF.frequency.setValueAtTime(s.on === 's' ? 6300 : s.on === 'sh' ? 3100 : 4600, tt);
        fG.gain.setTargetAtTime(amp * (voiced ? 0.3 : 0.45), tt, 0.015);
        fG.gain.setTargetAtTime(0, tt + 0.075, 0.018);
        if (vg) vg.gain.setTargetAtTime(0, tt, 0.01);
        on = 0.085;
      } else if (s.on === 'k') {
        if (vg) vg.gain.setTargetAtTime(0, tt, 0.006);
        bg.gain.setTargetAtTime(0, tt, 0.006);
        fF.frequency.setValueAtTime(2500, tt + 0.03);
        fG.gain.setTargetAtTime(amp * 0.55, tt + 0.03, 0.003);
        fG.gain.setTargetAtTime(0, tt + 0.045, 0.01);
        on = 0.06;
      }
      const vs = tt + on;
      for (let i = 0; i < 3; i++) F[i].frequency.setTargetAtTime(fv[i] * tr, vs, 0.03);
      if (voiced && !s.unvoiced) {
        const a = num(s.a, 1), b = num(s.b, a);
        osc.frequency.setTargetAtTime(base * a, tt, 0.025);
        osc.frequency.setTargetAtTime(base * b, vs + s.d * 0.3, s.d * 0.3);
        vg.gain.setTargetAtTime(amp, vs, 0.02);
        vg.gain.setTargetAtTime(amp * 0.08, tt + s.d * 0.85, 0.025);
        bg.gain.setTargetAtTime(amp * breathy, vs, 0.03);
        bg.gain.setTargetAtTime(amp * breathy * 0.3, tt + s.d * 0.85, 0.03);
      } else {
        if (vg) vg.gain.setTargetAtTime(0, tt, 0.02);
        bg.gain.setTargetAtTime(amp * (voiced ? 0.8 : 1), vs, 0.02);
        bg.gain.setTargetAtTime(amp * 0.1, tt + s.d * 0.8, 0.03);
      }
      tt += Math.max(s.d, on + 0.03);
    }
    if (vg) vg.gain.setTargetAtTime(0, tt, 0.04);
    bg.gain.setTargetAtTime(0, tt, 0.04);
    fG.gain.setTargetAtTime(0, tt, 0.02);
    return tEnd - t + 0.2;
  }

  // ---------------------------------------------------------------- continuous entities

  // type: 'longarm' (the Howler) | 'hollow' | 'smiler' ('biter' is an alias) | 'stealer' | 'hound' | 'faceling' | 'horde'.
  // s (all optional, 0..1 unless noted): chase, moving, near, seen (bool), reveal (Skin-Stealer showing itself),
  // rush (Hound / Howler charge), attack (bool), vol (0..2). Unknown types are ignored.
  entity(id, type, x, y, z, s) {
    if (!this._ready) return;
    try {
      s = s || {};
      if (type === 'biter') type = 'smiler';
      if (!ENT_TYPES.has(type)) return;
      let e = this._ents.get(id);
      if (e && e.type !== type) { this.removeEntity(id); e = null; }
      if (!e) {
        if (this._ents.size >= (this._mobile ? 4 : MAX_ENTITIES)) {
          // Full: a closer newcomer replaces the farthest one (which comes back when it is near again).
          const dn = this._dist(num(x, 0), num(y, 0), num(z, 0));
          let far = null, fd = dn + 5;
          for (const [k, o] of this._ents) if (o.d > fd) { fd = o.d; far = k; }
          if (far === null) return;
          this.removeEntity(far);
        }
        e = this._entMake(type);
        if (!e) return;
        this._ents.set(id, e);
      }
      x = num(x, 0); y = num(y, 0); z = num(z, 0);
      const now = this.ctx.currentTime;
      const dt = e.seenAt ? clamp(now - e.seenAt, 0, 0.25) : 0;
      e.x = x; e.y = y; e.z = z; e.seenAt = now;
      e.d = this._dist(x, y, z);
      this._spSet(e.sp, x, y, z);
      this._entState(e, s, dt);
      e.update(e.st, e.d, dt);
    } catch (err) { this._err(err); }
  }

  removeEntity(id) {
    if (!this._ready) return;
    try {
      const e = this._ents.get(id);
      if (!e) return;
      this._ents.delete(id);
      e.gone = true;
      e.out.gain.cancelScheduledValues(this.ctx.currentTime);
      e.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      setTimeout(() => this._dispose(e), 600);
    } catch (err) { this._err(err); }
  }

  _dispose(e) {
    for (const b of e.beds) this._bedKill(b);
    for (const s of e.srcs) { try { s.stop(); } catch (x) { /* ignore */ } }
    for (const n of e.nodes.concat(e.sp ? e.sp.nodes : [])) { try { n.disconnect(); } catch (x) { /* ignore */ } }
    e.nodes.length = 0; e.srcs.length = 0; e.beds.length = 0;
  }

  // Precomputed textures for entities, built on first use.
  _texture(name) {
    if (this._tex[name]) return this._tex[name];
    const sr = this.ctx.sampleRate;
    const sec = name === 'clicks' ? 3 : 4;
    const n = Math.floor(sr * sec);
    const b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    const add = (i, v) => { if (i >= 0 && i < n) d[i] += v; };
    if (name === 'clicks') {
      let t = 0.05;
      while (t < sec - 0.25) {
        const k = 2 + ((Math.random() * 6) | 0), f0 = rnd(900, 2700);
        let tt = t;
        for (let c = 0; c < k; c++) {
          const f = f0 * rnd(0.85, 1.15), dec = rnd(0.003, 0.009), amp = rnd(0.4, 1);
          const s0 = Math.floor(tt * sr), len = Math.floor(dec * 6 * sr);
          for (let j = 0; j < len; j++) {
            const x = j / sr;
            add(s0 + j, amp * Math.exp(-x / dec) * (Math.sin(TAU * f * x) * 0.8 + (Math.random() * 2 - 1) * 0.4 * Math.exp(-x / 0.0007)));
          }
          tt += rnd(0.012, 0.045);
        }
        if (Math.random() < 0.45) {
          // Wet squelch.
          const s0 = Math.floor(tt * sr), len = Math.floor(0.05 * sr);
          let ph = 0, y = 0;
          for (let j = 0; j < len; j++) {
            const p = j / len, f = 600 - 350 * p;
            ph += (TAU * f) / sr;
            y += 0.2 * (Math.random() * 2 - 1 - y);
            add(s0 + j, 0.3 * Math.sin(Math.PI * p) * (Math.sin(ph) * 0.5 + y));
          }
        }
        t = tt + rnd(0.12, 0.6);
      }
    } else if (name === 'drag') {
      let t = 0.1;
      while (t < sec - 0.7) {
        const len = Math.min(rnd(0.6, 1.4), sec - t - 0.1), s0 = Math.floor(t * sr), L = Math.floor(len * sr);
        let y = 0, grain = 1, gi = 0, y2 = 0;
        for (let j = 0; j < L; j++) {
          if (j >= gi) { grain = Math.pow(Math.random(), 1.5) * rnd(0.5, 1); gi = j + Math.floor(rnd(0.004, 0.012) * sr); }
          const p = j / L, env = Math.pow(Math.sin(Math.PI * p), 1.5);
          const w = Math.random() * 2 - 1;
          y += 0.08 * (w - y);
          y2 += 0.4 * (w - y2);
          add(s0 + j, env * grain * (y * 3 + y2 * 0.25));
        }
        t += len + rnd(0.1, 0.6);
      }
    } else {
      // Creak: fabric rustle plus slow stick-slip squeaks.
      let t = 0.1;
      while (t < sec - 0.6) {
        const len = Math.min(rnd(0.2, 0.5), sec - t - 0.1), s0 = Math.floor(t * sr), L = Math.floor(len * sr);
        let y = 0, prev = 0;
        for (let j = 0; j < L; j++) {
          const p = j / L, env = Math.sin(Math.PI * p);
          const w = Math.random() * 2 - 1;
          y += 0.5 * (w - y);
          const hp = y - prev;
          prev = y;
          add(s0 + j, env * hp * 0.5);
        }
        if (Math.random() < 0.6) {
          const rate = rnd(35, 90), fr = rnd(300, 700), L2 = Math.floor(rnd(0.15, 0.4) * sr);
          for (let pt = 0; pt < L2; pt += Math.floor(sr / (rate * rnd(0.85, 1.15)))) {
            const a = Math.sin((Math.PI * pt) / L2) * rnd(0.3, 0.8);
            for (let j = 0; j < sr * 0.01; j++) {
              const x = j / sr;
              add(s0 + pt + j, a * Math.exp(-x / 0.002) * Math.sin(TAU * fr * x));
            }
          }
        }
        t += len + rnd(0.15, 0.7);
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    const g = 0.9 / (peak || 1);
    for (let i = 0; i < n; i++) d[i] *= g;
    return (this._tex[name] = b);
  }

  // ---------------------------------------------------------------- proximity voice chat

  attachVoice(id, stream) {
    if (!this._ready || !stream) return;
    try {
      this.detachVoice(id);
      const c = this.ctx;
      const vx = { nodes: [], srcs: [], el: null };
      // Chrome only feeds a remote WebRTC stream into WebAudio if a media element also consumes it.
      try {
        const el = new Audio();
        el.muted = true;
        el.srcObject = stream;
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
        vx.el = el;
      } catch (e) { /* ignore */ }
      const N = (n) => { vx.nodes.push(n); return n; };
      const src = N(c.createMediaStreamSource(stream));
      // Respirator / suit radio: band limited, boxy, lightly driven, short comb.
      const comb = N(this._gain(1));
      this._chain(src, N(this._bq('highpass', 300, 0.7)), N(this._bq('lowpass', 3200, 0.9)),
        N(this._bq('peaking', 1400, 2.5, 5)), N(this._bq('peaking', 520, 1, 2)), N(this._shaper(2.2)), comb);
      const dl = N(c.createDelay(0.05));
      dl.delayTime.value = 0.0031;
      const fb = N(this._gain(0.28));
      comb.connect(dl); dl.connect(fb); fb.connect(comb);
      const out = N(this._gain(0.9));
      comb.connect(out);
      // Faint radio hiss under the voice.
      const hn = this._loop(this._white);
      vx.srcs.push(hn); vx.nodes.push(hn);
      this._chain(hn, N(this._bq('bandpass', 2400, 0.8)), N(this._gain(0.004)), out);
      hn.start(0, rnd(0, 1.5));
      vx.sp = this._spMake(true, 0.35);
      out.connect(vx.sp.lp);
      this._spSet(vx.sp, this._L.x, this._L.y, this._L.z - 2);
      this._vox.set(id, vx);
    } catch (e) { this._err(e); }
  }

  setVoicePos(id, x, y, z) {
    if (!this._ready) return;
    try {
      const vx = this._vox.get(id);
      if (vx) this._spSet(vx.sp, x, y, z);
    } catch (e) { this._err(e); }
  }

  detachVoice(id) {
    if (!this._ready) return;
    try {
      const vx = this._vox.get(id);
      if (!vx) return;
      this._vox.delete(id);
      for (const s of vx.srcs) { try { s.stop(); } catch (e) { /* ignore */ } }
      for (const n of vx.nodes.concat(vx.sp ? vx.sp.nodes : [])) { try { n.disconnect(); } catch (e) { /* ignore */ } }
      if (vx.el) { try { vx.el.pause(); vx.el.srcObject = null; } catch (e) { /* ignore */ } }
    } catch (e) { this._err(e); }
  }

  processMic(stream) {
    try {
      if (!this._ready || !stream) return stream;
      const c = this.ctx;
      if (!c.createMediaStreamDestination || !stream.getAudioTracks || !stream.getAudioTracks().length) return stream;
      const src = c.createMediaStreamSource(stream);
      const hp = this._bq('highpass', 90, 0.7);
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -26; comp.knee.value = 10; comp.ratio.value = 3;
      comp.attack.value = 0.005; comp.release.value = 0.2;
      const mk = this._gain(1.6);
      const dest = c.createMediaStreamDestination();
      this._chain(src, hp, comp, mk, dest);
      this._mics.push({ src, hp, comp, mk, dest });
      return dest.stream;
    } catch (e) {
      this._err(e);
      return stream;
    }
  }
}

// ------------------------------------------------------------------ one shot recipes
// Each gets (voice, startTime, opts, extra), builds into v.out, returns its length in seconds.

const SFX = {
  flashOn(v, t) { return flashClick(this, v, t, 1.12); },
  flashOff(v, t) { return flashClick(this, v, t, 0.9); },

  pickup(v, t) {
    this._burst(v, t, 'bandpass', 2600, 0.7, 0.16, 0.08, 0.3);
    this._tone(v, t + 0.09, 'sine', 240, 170, 0.05, 0.3, 0.002, 0.09);
    this._burst(v, t + 0.09, 'bandpass', 1800, 4, 0.25, 0.0008, 0.03);
    return 0.6;
  },

  drink(v, t) {
    this._burst(v, t, 'bandpass', 900, 3, 0.05, 0.1, 0.35);
    const n = 2 + ((Math.random() * 2) | 0);
    let tk = t + 0.18;
    for (let i = 0; i < n; i++) {
      this._tone(v, tk, 'sine', rnd(340, 420), rnd(140, 170), 0.07, 0.32, 0.005, 0.1);
      this._burst(v, tk, 'lowpass', 650, 1, 0.22, 0.008, 0.09);
      this._tone(v, tk + 0.1, 'sine', 90, 60, 0.05, 0.25, 0.004, 0.08); // swallow in the throat
      tk += rnd(0.3, 0.4);
    }
    return tk - t + 0.3;
  },

  battery(v, t) {
    this._burst(v, t, 'bandpass', 2200, 5, 0.35, 0.001, 0.025);
    this._burst(v, t + 0.07, 'bandpass', 3000, 5, 0.45, 0.001, 0.03);
    this._tone(v, t + 0.07, 'sine', 70, 58, 0.04, 0.3, 0.002, 0.07);
    const bp = this._bq('bandpass', 2000, 3);
    bp.connect(v.out); v.nodes.push(bp);
    this._tone(v, t + 0.14, 'sawtooth', 1100, 2700, 0.45, 0.05, 0.08, 0.45, bp);
    return 0.9;
  },

  discover(v, t) {
    // Two sub voices a semitone apart, beating, sinking slightly. Uneasy, not a reward.
    for (const [f, g] of [[82.4, 0.12], [87.3, 0.1], [164.2, 0.04]]) {
      const o = this._tone(v, t, 'triangle', f, f * 0.97, 4.5, g, 1.6, 3.2);
      o.detune.setValueAtTime(0, t);
    }
    const o = this._tone(v, t + 0.4, 'sine', 1244, 1206, 4, 0.012, 1.4, 2.8);
    const lfo = this._osc('sine', 5.1), lg = this._gain(9);
    lfo.connect(lg); lg.connect(o.detune);
    v.nodes.push(lg);
    this._run(v, lfo, t, t + 5);
    return 5.2;
  },

  artifact(v, t) {
    const f = rnd(380, 520);
    const lfo = this._osc('sine', 4.4), lg = this._gain(7);
    lfo.connect(lg);
    v.nodes.push(lg);
    this._run(v, lfo, t, t + 6);
    [1, 2.31, 3.97, 5.81, 8.2].forEach((r, i) => {
      for (const sgn of [-1, 1]) {
        const o = this._tone(v, t, 'sine', f * r + sgn * rnd(0.6, 2.2), 0, 0, 0.07 / Math.pow(i + 1, 0.8), 0.35 + i * 0.05, 4.5 - i * 0.5);
        lg.connect(o.detune);
      }
    });
    return 6;
  },

  sign(v, t) {
    // Chalk: stick-slip scrape plus a thin squeal.
    const dur = rnd(0.5, 0.9);
    const s = this._loop(this._white), bp = this._bq('bandpass', 3200, 3), hp = this._bq('highpass', 1200, 0.7);
    const g = this._gain(0), env = this._gain(0);
    this._chain(s, bp, hp, g, env, v.out);
    v.nodes.push(bp, hp, g, env);
    let tt = t;
    while (tt < t + dur) {
      g.gain.setValueAtTime(Math.pow(Math.random(), 2) * 0.9, tt);
      bp.frequency.setValueAtTime(rnd(2200, 4800), tt);
      tt += rnd(0.012, 0.028);
    }
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.04);
    env.gain.setValueAtTime(0.5, t + dur - 0.06);
    env.gain.linearRampToValueAtTime(0, t + dur);
    this._run(v, s, t, t + dur + 0.05, rnd(0, 1.5));
    const sq = this._tone(v, t + dur * 0.2, 'triangle', rnd(1700, 2500), 0, 0, 0.025, 0.02, dur * 0.6);
    sq.frequency.setTargetAtTime(rnd(1600, 2600), t + dur * 0.4, 0.05);
    return dur + 0.3;
  },

  hit(v, t) {
    this._tone(v, t, 'sine', 110, 38, 0.15, 0.9, 0.002, 0.35);
    this._burst(v, t, 'lowpass', 900, 0.7, 0.6, 0.002, 0.16);
    this._burst(v, t, 'bandpass', 2000, 0.8, 0.22, 0.005, 0.22);
    // Suit alarm: two band limited square beeps from a small speaker.
    const spk = this._bq('bandpass', 1700, 1.2);
    spk.connect(v.out); v.nodes.push(spk);
    for (const tb of [t + 0.13, t + 0.31]) {
      const o = this._osc('square', 1760), g = this._gain(0);
      g.gain.setValueAtTime(0, tb);
      g.gain.linearRampToValueAtTime(0.11, tb + 0.003);
      g.gain.setValueAtTime(0.11, tb + 0.09);
      g.gain.linearRampToValueAtTime(0, tb + 0.1);
      o.connect(g); g.connect(spk);
      v.nodes.push(g);
      this._run(v, o, tb, tb + 0.12);
    }
    return 0.7;
  },

  death(v, t) {
    this._tone(v, t, 'sine', 90, 30, 1.2, 0.9, 0.003, 2.5);
    const w = this._burst(v, t, 'lowpass', 2000, 0.7, 0.35, 0.02, 2.6);
    w.fl.frequency.setValueAtTime(2000, t);
    w.fl.frequency.exponentialRampToValueAtTime(150, t + 2.5);
    const lp = this._bq('lowpass', 420, 0.8);
    lp.connect(v.out); v.nodes.push(lp);
    for (const f of [55, 58.3, 61.7]) this._tone(v, t + 0.1, 'sawtooth', f, f * 0.94, 3.5, 0.06, 0.8, 3.4, lp);
    return 4.6;
  },

  respawn(v, t) {
    // Falling whoosh, then landing.
    const w = this._loop(this._white), bp = this._bq('bandpass', 250, 1.2), g = this._gain(0);
    this._chain(w, bp, g, v.out);
    v.nodes.push(bp, g);
    bp.frequency.setValueAtTime(250, t);
    bp.frequency.exponentialRampToValueAtTime(1800, t + 1.2);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 1.15);
    g.gain.linearRampToValueAtTime(0, t + 1.22);
    this._run(v, w, t, t + 1.3, rnd(0, 1.5));
    const r = this._burst(v, t, 'lowpass', 200, 0.7, 0.4, 1.0, 0.25, null, this._brown);
    r.fl.frequency.exponentialRampToValueAtTime(700, t + 1.2);
    const tl = t + 1.22;
    this._tone(v, tl, 'sine', 95, 35, 0.2, 1, 0.002, 0.4);
    this._burst(v, tl, 'lowpass', 600, 0.7, 0.8, 0.002, 0.25);
    this._burst(v, tl, 'bandpass', 2600, 0.6, 0.15, 0.01, 0.35);
    return 2;
  },

  exit(v, t) {
    this._burst(v, t, 'bandpass', 500, 0.5, 0.14, 1.5, 3, null, this._pink);
    for (const [f, g] of [[110, 0.06], [165, 0.05], [220.6, 0.035]]) this._tone(v, t + 0.2, 'sine', f, f * 1.02, 4, g, 2, 3);
    return 5.6;
  },

  // UI: a worn terminal. Soft tick on hover, a relay click with a tiny ballast zap on select.
  uiHover(v, t) {
    this._burst(v, t, 'bandpass', rnd(2900, 3400), 5, 0.1, 0.0005, 0.012);
    this._tone(v, t, 'sine', 1760, 0, 0, 0.012, 0.001, 0.03);
    return 0.06;
  },
  uiClick(v, t) {
    this._burst(v, t, 'bandpass', 2400, 4, 0.3, 0.0005, 0.02);
    this._burst(v, t + 0.011, 'bandpass', 3600, 5, 0.14, 0.0005, 0.012); // relay bounce
    this._tone(v, t, 'sine', 220, 140, 0.04, 0.22, 0.001, 0.05);
    const b = this._osc(this._buzzWave, 120), bp = this._bq('bandpass', 1400, 0.8), g = this._gain(0);
    this._ad(g.gain, t + 0.01, 0.004, 0.035, 0.07);
    this._chain(b, bp, g, v.out);
    v.nodes.push(bp, g);
    this._run(v, b, t, t + 0.12);
    return 0.15;
  },
  uiBack(v, t) {
    this._burst(v, t, 'bandpass', 1800, 4, 0.22, 0.0005, 0.02);
    this._burst(v, t + 0.014, 'bandpass', 2600, 5, 0.1, 0.0005, 0.012);
    this._tone(v, t, 'sine', 330, 160, 0.08, 0.2, 0.002, 0.09);
    return 0.15;
  },

  stinger(v, t) {
    this._tone(v, t, 'sine', 70, 34, 0.4, 0.9, 0.001, 0.9);
    this._burst(v, t, 'bandpass', 2500, 2, 0.35, 0.003, 0.9);
    const lp = this._bq('lowpass', 5000, 1), sh = this._shaper(3), g = this._gain(1);
    this._chain(lp, sh, g, v.out);
    v.nodes.push(lp, sh, g);
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 1.3);
    for (const f of [233, 247, 262, 470, 494]) this._tone(v, t, 'sawtooth', f, f * 0.985, 1.5, 0.07, 0.005, 1.5, lp);
    return 2.2;
  },

  apparition(v, t) {
    // Swells like a reversed sound: grows, then stops dead.
    const T = rnd(1.6, 2.2);
    const env = this._gain(0);
    env.connect(v.out); v.nodes.push(env);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.5, t + T);
    env.gain.linearRampToValueAtTime(0, t + T + 0.05);
    const n = this._loop(this._white), bp = this._bq('bandpass', 900, 2), ng = this._gain(0.35);
    this._chain(n, bp, ng, env);
    v.nodes.push(bp, ng);
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(1700, t + T);
    this._run(v, n, t, t + T + 0.1, rnd(0, 1.5));
    for (const [f, g] of [[196, 0.25], [207.6, 0.2], [404, 0.08]]) {
      const o = this._osc('sine', f), og = this._gain(g);
      o.detune.setValueAtTime(-40, t);
      o.detune.linearRampToValueAtTime(80, t + T);
      o.connect(og); og.connect(env);
      v.nodes.push(og);
      this._run(v, o, t, t + T + 0.1);
    }
    return T + 0.3;
  },

  knock(v, t, o) {
    let tk = t;
    for (let k = 0; k < 3; k++) {
      this._tone(v, tk, 'sine', 150, 110, 0.03, 0.6, 0.001, 0.12);
      this._burst(v, tk, 'bandpass', 320, 2.5, 0.7, 0.001, 0.06);
      this._burst(v, tk, 'bandpass', rnd(550, 700), 2, 2.6, 0.001, 0.05, null, this._pink);
      this._burst(v, tk, 'bandpass', 1800, 2, 0.2, 0.0005, 0.014);
      tk += rnd(0.26, 0.34) + (k === 1 ? rnd(0, 0.08) : 0);
    }
    return tk - t + 0.3;
  },

  doorSlam(v, t) {
    this._tone(v, t, 'sine', 65, 40, 0.2, 1, 0.002, 0.6);
    this._tone(v, t + 0.03, 'sine', 120, 90, 0.05, 0.4, 0.002, 0.15);
    this._burst(v, t, 'lowpass', 900, 0.7, 0.9, 0.002, 0.35);
    this._burst(v, t, 'bandpass', rnd(260, 360), 1.2, 5, 0.002, 0.3, null, this._pink); // the door panel
    this._burst(v, t, 'bandpass', 3200, 8, 0.35, 0.0005, 0.012); // latch
    const k = 3 + ((Math.random() * 3) | 0);
    for (let i = 0; i < k; i++) this._burst(v, t + rnd(0.05, 0.25), 'bandpass', rnd(2200, 3000), 6, 0.28, 0.0005, 0.015);
    return 1.5;
  },

  geiger(v, t) {
    const s = this.ctx.createBufferSource();
    s.buffer = this._geigerBuf;
    s.playbackRate.value = rnd(0.9, 1.1);
    const g = this._gain(0.5);
    s.connect(g); g.connect(v.out);
    v.nodes.push(g);
    this._run(v, s, t, t + 0.03);
    return 0.05;
  },

  radio(v, t) {
    const dur = rnd(0.45, 0.75);
    this._tone(v, t, 'sine', 1150, 0, 0, 0.06, 0.002, 0.05);
    const n = this._loop(this._white), bp = this._bq('bandpass', 1800, 0.9), sh = this._shaper(4), gate = this._gain(0);
    this._chain(n, bp, sh, gate, v.out);
    v.nodes.push(bp, sh, gate);
    let tt = t + 0.04;
    while (tt < t + dur) {
      gate.gain.setValueAtTime(Math.random() < 0.25 ? 0.02 : rnd(0.08, 0.22), tt);
      tt += rnd(0.008, 0.025);
    }
    gate.gain.setValueAtTime(0.25, t + dur);
    gate.gain.setValueAtTime(0, t + dur + 0.1); // squelch tail, cut hard
    this._run(v, n, t, t + dur + 0.15, rnd(0, 1.5));
    return dur + 0.2;
  },

  // Handheld analog radar. Non-positional, inside the hood like the flashlight.
  // Sweep: one soft, slightly varied tick and motor whirr per revolution. Kept very low and dull on purpose.
  radarSweep(v, t) {
    this._burst(v, t, 'bandpass', rnd(1500, 1900), 3, 0.035, 0.001, 0.02, null, this._pink);
    const w = this._burst(v, t, 'bandpass', rnd(260, 340), 2, 0.05, 0.06, 0.22, null, this._pink);
    w.fl.frequency.setValueAtTime(rnd(240, 300), t);
    w.fl.frequency.linearRampToValueAtTime(rnd(320, 380), t + 0.25);
    return 0.4;
  },

  // Friend located: a round, slightly detuned ping, a touch higher for closer contacts (opts.pitch 0..1).
  radarBlip(v, t, o) {
    const pitch = clamp(num(o && o.pitch, 0));
    const f = 880 * (1 + 0.15 * pitch) * rnd(0.995, 1.005);
    this._tone(v, t, 'sine', f, f * 0.985, 0.3, 0.07, 0.004, 0.38);
    this._tone(v, t, 'sine', f * 1.0045, f * 0.99, 0.3, 0.05, 0.004, 0.32);
    this._tone(v, t, 'sine', f * 2.001, 0, 0, 0.012, 0.003, 0.15);
    return 0.5;
  },

  // An echo that is not a person: the same ping, unstable and crackly, quieter.
  radarGhost(v, t) {
    const f = rnd(620, 980);
    const o = this._tone(v, t, 'sine', f, 0, 0, 0.04, 0.01, 0.45);
    let tt = t;
    while (tt < t + 0.45) {
      o.frequency.setTargetAtTime(f * rnd(0.9, 1.08), tt, 0.015);
      tt += rnd(0.02, 0.06);
    }
    this._tone(v, t + 0.02, 'sine', f * rnd(1.01, 1.03), 0, 0, 0.02, 0.01, 0.3);
    const n = this._loop(this._white), bp = this._bq('bandpass', 2600, 1.2), gate = this._gain(0);
    this._chain(n, bp, gate, v.out);
    v.nodes.push(bp, gate);
    tt = t;
    while (tt < t + 0.35) {
      gate.gain.setValueAtTime(Math.random() < 0.5 ? 0 : rnd(0.005, 0.02), tt);
      tt += rnd(0.006, 0.02);
    }
    gate.gain.setValueAtTime(0, tt);
    this._run(v, n, t, tt + 0.02, rnd(0, 5));
    return 0.6;
  },

  // Power switch with a CRT charge-up whine.
  radarOn(v, t) {
    flashClick(this, v, t, 1.05);
    this._tone(v, t + 0.03, 'sine', 180, 2600, 0.35, 0.02, 0.05, 0.35);
    this._burst(v, t + 0.03, 'bandpass', 3000, 1, 0.012, 0.25, 0.2);
    return 0.7;
  },
  // Switch off, charge bleeding away.
  radarOff(v, t) {
    flashClick(this, v, t, 0.92);
    this._tone(v, t + 0.02, 'sine', 2400, 140, 0.3, 0.02, 0.003, 0.35);
    return 0.5;
  },

  // Footsteps heard from inside the suit.
  _foot(v, t, o, x) {
    const kind = x.kind, g = (0.15 + 0.85 * x.loud) * rnd(0.85, 1.15), p = rnd(0.92, 1.08);
    const boom = this._bq('peaking', 115, 1, 5);
    boom.connect(v.out); v.nodes.push(boom);
    const rustle = (amp, a, d) => this._burst(v, t + rnd(-0.01, 0.03), 'bandpass', rnd(2600, 3600), 0.6, amp, a, d, boom);
    if (kind === 'carpet') {
      // Heel: thump plus the boot sole body (the part small speakers can actually play).
      this._tone(v, t, 'sine', 90 * p, 55 * p, 0.05, 0.32 * g, 0.002, 0.09, boom);
      this._burst(v, t, 'lowpass', 500 * p, 0.7, 0.45 * g, 0.003, 0.08, boom);
      this._burst(v, t, 'bandpass', rnd(230, 320) * p, 1.2, 2.6 * g, 0.003, 0.08, boom, this._pink);
      // Toe roll a little later.
      const tt = t + rnd(0.05, 0.09);
      this._burst(v, tt, 'lowpass', 800 * p, 0.7, 0.28 * g, 0.003, 0.06, boom);
      this._burst(v, tt, 'bandpass', rnd(380, 520) * p, 1.4, 1.3 * g, 0.003, 0.05, boom, this._pink);
      // Damp carpet: a short crackly squish, different every step.
      const sq = this._loop(this._white), sbp = this._bq('bandpass', rnd(650, 1150) * p, 1.6), sgt = this._gain(0);
      this._chain(sq, sbp, sgt, boom);
      v.nodes.push(sbp, sgt);
      const sd = rnd(0.06, 0.12);
      let ts = t + 0.015;
      while (ts < t + 0.015 + sd) {
        sgt.gain.setValueAtTime(Math.random() < 0.4 ? 0 : rnd(0.05, 0.14) * g, ts);
        ts += rnd(0.004, 0.012);
      }
      sgt.gain.setValueAtTime(0, ts);
      this._run(v, sq, t, ts + 0.02, rnd(0, 5));
      if (Math.random() < 0.7) rustle(0.07 * g, 0.03, 0.18);
      return 0.35;
    }
    if (kind === 'stair') {
      this._tone(v, t, 'sine', 140 * p, 90 * p, 0.04, 0.6 * g, 0.001, 0.1, boom);
      this._burst(v, t, 'bandpass', 420 * p, 3, 0.6 * g, 0.001, 0.12, boom);
      this._burst(v, t, 'bandpass', 2200 * p, 2, 0.15 * g, 0.0005, 0.02, boom);
      rustle(0.06 * g, 0.02, 0.15);
      return 0.35;
    }
    if (kind === 'crouch') {
      this._burst(v, t, 'lowpass', 400 * p, 0.7, 0.25 * g, 0.01, 0.1, boom);
      rustle(0.12 * g, 0.06, 0.3);
      return 0.45;
    }
    // land
    this._tone(v, t, 'sine', 75 * p, 35 * p, 0.12, 0.8 * g, 0.002, 0.25, boom);
    this._burst(v, t, 'bandpass', rnd(180, 260) * p, 1, 4 * g, 0.003, 0.2, boom, this._pink);
    this._burst(v, t, 'lowpass', 600 * p, 0.7, 0.9 * g, 0.002, 0.18, boom);
    rustle(0.2 * g, 0.02, 0.35);
    this._burst(v, t + 0.05, 'bandpass', 520, 9, 0.05 * g, 0.02, 0.15, boom); // suit creak
    return 0.6;
  },

  // Flickering lamp: a glassy tink and a burst of crackling ballast buzz.
  _lamp(v, t, o, x) {
    const s = x.s;
    this._tone(v, t, 'sine', rnd(4200, 6200), 0, 0, 0.12 * s, 0.0005, 0.05);
    this._burst(v, t, 'highpass', 3000, 0.7, 0.15 * s, 0.0003, 0.008);
    const dur = rnd(0.06, 0.12) + 0.15 * s;
    const b = this._osc(this._buzzWave, 120), bp = this._bq('bandpass', 1500, 0.7), gate = this._gain(0);
    this._chain(b, bp, gate, v.out);
    v.nodes.push(bp, gate);
    let tt = t + 0.01;
    while (tt < t + dur) {
      gate.gain.setValueAtTime(Math.random() < 0.3 ? 0 : rnd(0.1, 0.35) * s, tt);
      tt += rnd(0.006, 0.02);
    }
    gate.gain.setValueAtTime(0, t + dur);
    this._run(v, b, t, t + dur + 0.02);
    return dur + 0.1;
  },

  // Distant ambience. These are placed 16 to 42 m away with a large panner refDistance, so the panner's
  // distance lowpass and the reverb do the 'far' work; each recipe keeps some body in the 150 Hz to 2 kHz
  // range so it still reads on laptop and phone speakers.
  _thud(v, t) {
    this._tone(v, t, 'sine', 58, 34, 0.3, 0.5, 0.003, 0.8);
    this._tone(v, t, 'triangle', rnd(130, 170), 80, 0.15, 0.6, 0.002, 0.35);
    this._burst(v, t, 'lowpass', 420, 0.7, 0.6, 0.003, 0.5);
    this._burst(v, t, 'bandpass', rnd(220, 320), 1.2, 5, 0.003, 0.45, null, this._pink); // the wall it hit
    this._burst(v, t, 'bandpass', rnd(700, 1100), 1.5, 2.2, 0.001, 0.08, null, this._pink); // the knock of it
    if (Math.random() < 0.5) this._burst(v, t + rnd(0.08, 0.2), 'bandpass', rnd(1800, 2600), 4, 0.05, 0.002, 0.3); // something rattles
    return 1.4;
  },

  _drag(v, t) {
    const dur = rnd(1.2, 2.8);
    const n = this._loop(this._brown), lp = this._bq('lowpass', 700, 0.8), g = this._gain(0);
    const gr = this._loop(this._white), grBP = this._bq('bandpass', rnd(900, 1600), 1.2), grG = this._gain(0);
    this._chain(n, lp, g, v.out);
    this._chain(gr, grBP, grG, v.out);
    v.nodes.push(lp, g, grBP, grG);
    let tt = t;
    while (tt < t + dur) {
      const p = (tt - t) / dur, k = Math.sin(Math.PI * p) * rnd(0.3, 1.4);
      g.gain.setValueAtTime(k, tt);
      grG.gain.setValueAtTime(k * k * rnd(0.02, 0.09), tt);
      tt += rnd(0.01, 0.04);
    }
    g.gain.setValueAtTime(0, t + dur);
    grG.gain.setValueAtTime(0, t + dur);
    this._run(v, n, t, t + dur + 0.05, rnd(0, 3));
    this._run(v, gr, t, t + dur + 0.05, rnd(0, 3));
    return dur + 0.2;
  },

  _pipe(v, t) {
    const f = rnd(180, 320), k = 2 + ((Math.random() * 2) | 0);
    let tk = t;
    for (let i = 0; i < k; i++) {
      const a = i === 0 ? 1 : rnd(0.5, 0.9);
      [[1, 0.9, 0.5], [2.76, 0.6, 0.3], [5.4, 0.35, 0.2], [8.9, 0.2, 0.12]].forEach(([r, d, amp]) =>
        this._tone(v, tk, 'sine', f * r * rnd(0.998, 1.002), 0, 0, amp * a, 0.001, d));
      this._burst(v, tk, 'bandpass', 2500, 1, 0.2 * a, 0.0005, 0.01);
      tk += rnd(0.18, 0.4);
    }
    return tk - t + 1;
  },

  // The building settling: stick-slip creak through a resonant beam.
  _creak(v, t) {
    const dur = rnd(0.7, 2.2), f = rnd(260, 560);
    const o = this._osc('sawtooth', rnd(14, 24));
    o.frequency.setValueAtTime(rnd(12, 22), t);
    o.frequency.linearRampToValueAtTime(rnd(28, 60), t + dur * rnd(0.3, 0.6));
    o.frequency.linearRampToValueAtTime(rnd(9, 20), t + dur);
    const env = this._gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(2.2, t + 0.12);
    env.gain.setValueAtTime(2.2, t + dur - 0.2);
    env.gain.linearRampToValueAtTime(0, t + dur);
    const b1 = this._bq('bandpass', f, 9), b2 = this._bq('bandpass', f * 2.37, 7), b2g = this._gain(0.5);
    b1.frequency.setValueAtTime(f, t);
    b1.frequency.linearRampToValueAtTime(f * rnd(0.85, 1.15), t + dur);
    o.connect(env);
    env.connect(b1); b1.connect(v.out);
    env.connect(b2); b2.connect(b2g); b2g.connect(v.out);
    v.nodes.push(env, b1, b2, b2g);
    this._run(v, o, t, t + dur + 0.05);
    return dur + 0.5;
  },

  // Metal somewhere: a struck panel or a dropped bar, inharmonic and long.
  _metal(v, t) {
    const f = rnd(170, 420), hits = Math.random() < 0.5 ? 1 : 2 + ((Math.random() * 3) | 0);
    let tk = t;
    for (let h = 0; h < hits; h++) {
      const a = h === 0 ? 1 : rnd(0.25, 0.6);
      [[1, 1.8, 0.22], [2.41, 1.3, 0.16], [3.87, 0.9, 0.12], [5.33, 0.6, 0.08], [6.9, 0.4, 0.05]].forEach(([r, d, amp]) =>
        this._tone(v, tk, 'sine', f * r * rnd(0.995, 1.005), 0, 0, amp * a, 0.001, d * rnd(0.8, 1.2)));
      this._burst(v, tk, 'bandpass', rnd(1500, 3000), 1.2, 0.3 * a, 0.0005, 0.02);
      tk += h === 0 ? rnd(0.15, 0.35) : rnd(0.06, 0.16);
    }
    return tk - t + 2.2;
  },

  // A very far, voice-like tone: almost singing, almost a moan. Formants on a glottal source.
  _farTone(v, t) {
    const dur = rnd(2.5, 5), f0 = rnd(140, 250);
    const o = this._osc(this._glotWave, f0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * rnd(0.86, 1.1), t + dur * 0.7);
    o.frequency.linearRampToValueAtTime(f0 * rnd(0.75, 0.95), t + dur);
    const lfo = this._osc('sine', rnd(4.5, 5.8)), lg = this._gain(rnd(10, 22));
    lfo.connect(lg); lg.connect(o.detune);
    const env = this._gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1.1, t + dur * rnd(0.3, 0.5));
    env.gain.linearRampToValueAtTime(0.9, t + dur * 0.75);
    env.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(env);
    const sum = this._gain(1);
    sum.connect(v.out);
    v.nodes.push(lg, env, sum);
    for (const [fr, q, g] of [[rnd(480, 760), 5, 1], [rnd(850, 1300), 7, 0.5], [rnd(2400, 2800), 8, 0.12]]) {
      const bp = this._bq('bandpass', fr, q), gg = this._gain(g);
      env.connect(bp); bp.connect(gg); gg.connect(sum);
      v.nodes.push(bp, gg);
    }
    this._burst(v, t + dur * 0.2, 'bandpass', 1300, 1, 0.03, dur * 0.3, dur * 0.5, sum); // breath on it
    this._run(v, o, t, t + dur + 0.05);
    this._run(v, lfo, t, t + dur + 0.05);
    return dur + 0.4;
  },

  // Someone walking, slowly, far away. Then they stop.
  _farSteps(v, t) {
    const n = 3 + ((Math.random() * 5) | 0), per = rnd(0.55, 0.75);
    let tk = t;
    for (let i = 0; i < n; i++) {
      const a = rnd(0.7, 1) * (i === n - 1 ? 0.6 : 1);
      this._tone(v, tk, 'sine', 110, 60, 0.05, 0.5 * a, 0.002, 0.12);
      this._burst(v, tk, 'lowpass', 520, 0.7, 0.45 * a, 0.003, 0.09);
      this._burst(v, tk, 'bandpass', rnd(260, 340), 1.5, 4 * a, 0.003, 0.1, null, this._pink);
      this._burst(v, tk + 0.03, 'bandpass', rnd(900, 1400), 1.5, 0.9 * a, 0.004, 0.06, null, this._pink);
      tk += per * rnd(0.92, 1.08);
    }
    return tk - t + 0.5;
  },

  // Ventilation damper or relay switching somewhere in the ceiling.
  _clunk(v, t) {
    this._tone(v, t, 'sine', 95, 60, 0.08, 0.6, 0.002, 0.2);
    this._burst(v, t, 'bandpass', 700, 1.5, 2, 0.001, 0.07, null, this._pink);
    this._burst(v, t, 'bandpass', 340, 1.5, 2.4, 0.002, 0.12, null, this._pink);
    this._tone(v, t + 0.01, 'sine', rnd(1300, 1700), 0, 0, 0.05, 0.001, 0.25);
    const k = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < k; i++) this._burst(v, t + rnd(0.04, 0.22), 'bandpass', rnd(1800, 3200), 5, 0.08, 0.0005, 0.02);
    return 0.8;
  },
};

function flashClick(eng, v, t, pitch) {
  eng._burst(v, t, 'bandpass', 2900 * pitch, 6, 0.4, 0.0005, 0.012);
  eng._tone(v, t, 'sine', 180 * pitch, 150, 0.02, 0.2, 0.001, 0.03);
  eng._burst(v, t + 0.045, 'bandpass', 3600 * pitch, 6, 0.25, 0.0005, 0.01);
  return 0.15;
}

// ==================================================================== 0.3.0: places, tension, entities
// Contract: biomes.js (place keys, STEPS, ENTITIES[code].audio, SOUNDS_03).

const PLACE_KEYS = ['level0', 'level1', 'level2', 'level5', 'level37', 'levelrun'];
const PLACE_STEP = { level0: 'carpet', level1: 'concrete', level2: 'metal', level5: 'rug', level37: 'tile', levelrun: 'tile' };
const STEP_SET = new Set(['carpet', 'tile', 'water', 'concrete', 'rug', 'metal']);
const ENT_TYPES = new Set(['longarm', 'hollow', 'smiler', 'stealer', 'hound', 'faceling', 'horde']);
// One shots that skip the compressor: the moments that should make a player flinch.
const BIG = new Set(['scare', 'lunge', 'houndRush', 'stealerTurn', '_eHowl']);
// How much of the shared layers each place keeps (Level 0 = 1 everywhere).
const PLACE_MIX = {
  level0: { wind: 1, rumble: 1, pad: 1, ev: 1 },
  level1: { wind: 1.2, rumble: 1.1, pad: 1, ev: 0.8 },
  level2: { wind: 0.35, rumble: 1.2, pad: 0.9, ev: 0.9 },
  level5: { wind: 0.25, rumble: 0.45, pad: 1.1, ev: 0.8 },
  level37: { wind: 0.2, rumble: 0.25, pad: 0.45, ev: 0.35 },
  levelrun: { wind: 0, rumble: 1.4, pad: 0.25, ev: 0.0001 },
};
// Far-off life per place (Level 0 keeps its own list in _distant).
const PLACE_EVENTS = {
  level1: [['_thud', 1.4], ['_metal', 1.1], ['_drag', 0.7], ['_shutter', 1], ['_farSteps', 0.6], ['_farTone', 0.5], ['_drip', 1.2]],
  level2: [['_metal', 1.1], ['_pipe', 1.4], ['_clunk', 1], ['_steam', 0.8], ['_farTone', 0.6], ['_pipeKnock', 1.2]],
  level5: [['_creak', 2], ['_board', 2], ['knock', 0.6], ['doorSlam', 0.4], ['_farSteps', 0.8], ['doorCreak', 0.9]],
  level37: [['_drip', 2], ['_gurgle', 1]],
};
// Reverb per place. rt = decay time (s), a0/a1 = brightness at the start / end of the tail (one pole coefficient),
// er = early reflection spread (s), pre = predelay, lp = return lowpass, ret = return level, modes = ringing pipe
// or tile modes mixed into the tail.
const REV = {
  level1: { rt: 3.6, a0: 0.36, a1: 0.07, er: 0.09, pre: 0.035, lp: 3000, ret: 0.8, modes: 0 },
  level2: { rt: 0.55, a0: 0.75, a1: 0.35, er: 0.016, pre: 0.003, lp: 7000, ret: 0.85, modes: 6 },
  level5: { rt: 0.38, a0: 0.28, a1: 0.05, er: 0.018, pre: 0.003, lp: 2200, ret: 0.4, modes: 0 },
  level37: { rt: 5.2, a0: 0.93, a1: 0.6, er: 0.06, pre: 0.024, lp: 10000, ret: 0.95, modes: 3 },
  levelrun: { rt: 1.7, a0: 0.7, a1: 0.3, er: 0.04, pre: 0.012, lp: 6000, ret: 0.7, modes: 2 },
};
const eqp = (w) => Math.sin(clamp(w) * Math.PI / 2);

Object.assign(AudioEngine.prototype, {
  // Dev / test only: build the whole graph on a context you made (an OfflineAudioContext for silent measuring).
  // The game never calls this.
  _startWith(ctx) {
    this.ctx = ctx;
    this._build();
    this._ready = true;
    return this;
  },

  // ---------------------------------------------------------------- small helpers

  _softClipCurve() {
    const n = 2048, c = new Float32Array(n), k = 0.7, r = 0.29;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
      c[i] = Math.sign(x) * (a < k ? a : k + r * Math.tanh((a - k) / r));
    }
    return c;
  },

  _l0s() {
    if (!this.l0Send) { this.l0Send = this._gain(1); this.l0Send.connect(this.revIn); }
    return this.l0Send;
  },

  // Place factor for a shared layer, blended by the crossfade weights.
  _pfv(k) {
    let s = 0, w = 0;
    for (const p in this._pw) {
      const pw = this._pw[p];
      if (pw <= 0) continue;
      s += pw * ((PLACE_MIX[p] || PLACE_MIX.level0)[k]);
      w += pw;
    }
    return w > 0 ? s / w : 1;
  },

  _domPlace() {
    let best = 'level0', bw = -1;
    for (const p in this._pw) if (this._pw[p] > bw) { bw = this._pw[p]; best = p; }
    return best;
  },

  _bedKill(bed) {
    const i = this._bedList.indexOf(bed);
    if (i >= 0) this._bedList.splice(i, 1);
    if (bed.cur) {
      try { bed.cur.s.stop(); } catch (e) { /* ignore */ }
      try { bed.cur.s.disconnect(); bed.cur.g.disconnect(); } catch (e) { /* ignore */ }
      bed.cur = null;
    }
  },

  _around(dmin, dmax, dy) {
    const L = this._L, a = rnd(0, TAU), d = rnd(dmin, dmax);
    return [L.x + Math.cos(a) * d, L.y + (dy === undefined ? rnd(-0.5, 1.2) : dy), L.z + Math.sin(a) * d];
  },

  // Fires at random intervals in [a, b] seconds; first time somewhere inside the first interval.
  _due(T, k, a, b, dt) {
    if (T[k] === undefined) T[k] = rnd(0, b);
    T[k] -= dt;
    if (T[k] > 0) return false;
    T[k] = rnd(a, b);
    return true;
  },

  // ---------------------------------------------------------------- tension, pressure

  _buildTension() {
    // An almost subliminal layer: a narrow band of air that moves like breath in the walls, a high thin
    // pressure in the ears and a low beating tone, all wandering. Fed after the thinning so it stays.
    const n = this._gain(1);
    this._mkBed(this._pink, n, [5, 10]);
    this.sublBP = this._bq('bandpass', 1400, 6);
    this.sublAM = this._gain(0.6);
    this.sublG = this._gain(0);
    this._chain(n, this.sublBP, this.sublAM, this.sublG, this.duckG);
    this.sublLo = this._gain(0);
    this.sublO = [this._osc('sine', 36)]; // one tone only: two close tones would beat into a throb
    for (const o of this.sublO) { o.connect(this.sublLo); o.start(); }
    this._chain(this.sublLo, this._shaper(2.5), this._bq('lowpass', 220, 0.7), this.duckG);
    this.sublHi = this._gain(0);
    for (const f of [9230, 9301]) { const o = this._osc('sine', f); o.connect(this.sublHi); o.start(); }
    this.sublHi.connect(this.duckG);
  },

  _tensionTick(now, dt, st) {
    if (!this.tensG) return;
    const t = this._x.tension, T = this._tens;
    this._tg(this.tensLS.gain, -15 * t, 0.6);
    this._tg(this.tensG.gain, 1 - 0.5 * t, 0.6);
    const k = Math.pow(t, 1.6);
    this._tg(this.sublG.gain, 0.03 * k, 0.9);
    this._tg(this.sublLo.gain, 0.0022 * k, 1.2);
    this._tg(this.sublHi.gain, 0.0018 * k, 1.2);
    if (k > 0.01) {
      if (this._due(T, 'bp', 2, 6, dt)) { this._tg(this.sublBP.frequency, rnd(600, 2600), rnd(1.5, 4)); this._tg(this.sublBP.Q, rnd(3, 10), 3); }
      if (this._due(T, 'am', 0.8, 3, dt)) this._tg(this.sublAM.gain, rnd(0.15, 1.1), rnd(0.4, 1.5));
      if (this._due(T, 'lo', 3, 9, dt)) this._tg(this.sublO[0].frequency, rnd(31, 46), rnd(2, 5));
    }
    // The top: everything drops to near-silence for a couple of seconds, the quiet before something happens.
    T.cool -= dt;
    if (t >= 0.9 && T.armed && T.cool <= 0) {
      T.armed = false; T.cool = 18; T.hushT = rnd(2, 3.4);
      this._tg(this.hushG.gain, 0.06, 0.22);
    }
    if (T.hushT > 0) {
      T.hushT -= dt;
      if (T.hushT <= 0 || st.dead) { T.hushT = 0; this._tg(this.hushG.gain, 1, 1.1); }
    }
    if (t < 0.7) T.armed = true;
  },

  // Sub-bass pressure, felt more than heard, when something is very close. One shared generator, driven by the
  // closest entity (see _entsMix). A little drive puts harmonics where laptop speakers can play them.
  _buildPressure() {
    const n = this._gain(1);
    this._mkBed(this._brown, n, [6, 12], [0.8, 1.2]);
    this.pressIn = this._gain(1);
    this._chain(n, this._bq('lowpass', 70, 0.9), this.pressIn);
    this.pressO = this._osc('sine', 31);
    const og = this._gain(0.35);
    this.pressO.connect(og); og.connect(this.pressIn); this.pressO.start();
    this.pressG = this._gain(0);
    this._chain(this.pressIn, this._shaper(3), this._bq('lowpass', 190, 0.7), this.pressG, this.mix);
    // The Faceling's silence has a sound: a faint, high pressure in the ears.
    this.earG = this._gain(0);
    for (const f of [7350, 7391]) { const o = this._osc('sine', f); o.connect(this.earG); o.start(); }
    this.earG.connect(this.mix);
  },

  _entsMix(now) {
    let press = 0, duck = 0, ear = 0;
    for (const e of this._ents.values()) {
      if (now - (e.seenAt || 0) > 0.5) continue; // not updated any more: ignore
      press = Math.max(press, e.press || 0);
      duck = Math.max(duck, e.duck || 0);
      ear = Math.max(ear, e.ear || 0);
    }
    if (this.pressG) {
      this._tg(this.pressG.gain, 0.17 * Math.pow(press, 1.4), 0.15);
      if (press > 0.05 && Math.random() < 0.03) this._tg(this.pressO.frequency, rnd(26, 38), 0.5);
    }
    if (this.earG) this._tg(this.earG.gain, 0.0035 * ear, 0.6);
    this._tg(this.duckG.gain, 1 - 0.88 * duck, duck > 0.3 ? 0.3 : 0.6);
  },

  // ---------------------------------------------------------------- places

  _placesTick(now, dt, st) {
    const P = this._pw, target = this._place;
    if (P[target] === undefined) P[target] = 0;
    const rate = dt / 3; // about 3 s crossfade
    for (const k in P) {
      const goal = k === target ? 1 : 0;
      P[k] = clamp(P[k] + clamp(goal - P[k], -rate, rate));
    }
    if (target !== 'level0') {
      if (!this._layers[target]) { try { this._layers[target] = this._placeMake(target); } catch (e) { this._err(e); this._layers[target] = null; } }
      if (!this._revs[target]) { try { this._revs[target] = this._placeRev(target); } catch (e) { this._err(e); this._revs[target] = null; } }
    }
    const w0 = eqp(P.level0 || 0);
    this._tg(this.l0Bus.gain, w0, 0.05);
    if (this.l0Rev) this._tg(this.l0Rev.gain, w0, 0.05);
    if (this.l0Send) this._tg(this.l0Send.gain, w0, 0.05);
    for (const k of PLACE_KEYS) {
      if (k === 'level0') continue;
      const w = P[k] || 0, L = this._layers[k], R = this._revs[k];
      if (L) {
        this._tg(L.out.gain, eqp(w) * L.level, 0.05);
        if (w > 0.001) { L.idle = 0; try { L.tick(now, dt, st, w); } catch (e) { this._err(e); } }
        else if ((L.idle += dt) > 12 && k !== target) { this._placeDispose(L); delete this._layers[k]; }
      }
      if (R) {
        this._tg(R.send.gain, eqp(w), 0.05);
        if (w > 0.001) R.idle = 0;
        else if ((R.idle += dt) > 12 && k !== target) { for (const n of R.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } } delete this._revs[k]; }
      }
      if (w <= 0 && k !== target && !this._layers[k] && !this._revs[k]) delete P[k];
    }
  },

  _placeRev(key) {
    const spec = REV[key];
    if (!spec) return null;
    const c = this.ctx;
    const send = this._gain(0);
    const pre = c.createDelay(0.1);
    pre.delayTime.value = spec.pre;
    const conv = c.createConvolver();
    conv.buffer = this._placeIR(spec);
    const lp = this._bq('lowpass', spec.lp, 0.5);
    const ret = this._gain(spec.ret);
    this.revIn.connect(send);
    this._chain(send, pre, conv, lp, ret, this.mix);
    return { send, nodes: [send, pre, conv, lp, ret], idle: 0 };
  },

  _placeIR(spec) {
    const c = this.ctx, sr = c.sampleRate;
    const len = Math.min(spec.rt * 1.25 + 0.05, this._mobile ? 2.6 : 6.5), n = Math.floor(sr * len);
    const buf = c.createBuffer(2, n, sr);
    const tau = spec.rt / 6.91;
    const modes = [];
    for (let m = 0; m < spec.modes; m++) modes.push({ w: TAU * rnd(220, 1500), tau: tau * rnd(0.4, 1.1), a: rnd(0.04, 0.1) });
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const a = spec.a0 + (spec.a1 - spec.a0) * Math.min(1, t / spec.rt);
        y += a * (Math.random() * 2 - 1 - y);
        let v = y * Math.exp(-t / tau) * Math.min(1, t / 0.01);
        for (const m of modes) v += m.a * Math.sin(m.w * t + ch) * Math.exp(-t / m.tau) * Math.min(1, t / 0.004);
        d[i] = v;
      }
      for (let k = 0; k < 16; k++) {
        const t = 0.002 + Math.pow(Math.random(), 1.3) * spec.er;
        const i = Math.floor(t * sr);
        const amp = rnd(0.3, 1) * Math.exp(-t / (spec.er + 0.02)) * (Math.random() < 0.5 ? -1 : 1) * 0.7;
        for (let j = 0; j < 6 && i + j < n; j++) d[i + j] += amp * (1 - j / 6);
      }
      let energy = 0;
      for (let i = 0; i < n; i++) energy += d[i] * d[i];
      const g = 1 / Math.sqrt(energy || 1);
      for (let i = 0; i < n; i++) d[i] *= g;
    }
    return buf;
  },

  _placeMake(key) {
    const fn = PLACE_BUILD[key];
    if (!fn) return null;
    const L = { key, nodes: [], srcs: [], beds: [], level: 1, idle: 0, live: 0, T: {}, tick: () => {} };
    L.out = this._gain(0);
    L.out.connect(this.amb);
    L.nodes.push(L.out);
    L.N = (n) => { L.nodes.push(n); return n; };
    L.SO = (o) => { L.srcs.push(o); L.nodes.push(o); o.start(); return o; };
    L.bed = (buf, dest, seg, rate, xf) => { const b = this._mkBed(buf, dest, seg, rate, xf); L.beds.push(b); return b; };
    L.send = (node, amt) => { const g = L.N(this._gain(amt)); node.connect(g); g.connect(this.revIn); return g; };
    // A one shot that belongs to this place: plays into the layer (so it fades with it), own cap.
    L.shot = (name, o, x) => {
      if (L.live >= 6 || L.dead) return;
      L.live++;
      const v = this._shot(name, o || {}, Object.assign({ dest: L.out, free: true, onFree: () => { L.live--; } }, x || {}));
      if (!v) L.live--;
    };
    fn.call(this, L);
    return L;
  },

  _placeDispose(L) {
    L.dead = true;
    for (const b of L.beds) this._bedKill(b);
    for (const s of L.srcs) { try { s.stop(); } catch (e) { /* ignore */ } }
    for (const n of L.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    L.nodes.length = 0; L.srcs.length = 0; L.beds.length = 0;
  },

  // Stereo pair of decorrelated noise grains into one node.
  _stereoBed(L, buf, seg) {
    const m = L.N(this.ctx.createChannelMerger(2));
    for (const ch of [0, 1]) {
      const g = L.N(this._gain(1));
      g.connect(m, 0, ch);
      L.bed(buf, g, seg || [4, 10]);
    }
    return m;
  },

  _clockBufs() {
    if (this._clk) return this._clk;
    const mk = (f1, f2, dec) => this._shortBuf(0.09, (t) =>
      Math.exp(-t / dec) * (Math.sin(TAU * f1 * t) * 0.5 + Math.sin(TAU * f2 * t) * 0.35) +
      (Math.random() * 2 - 1) * Math.exp(-t / 0.0012) * 0.5 + Math.sin(TAU * 420 * t) * Math.exp(-t / 0.012) * 0.3);
    return (this._clk = [mk(3100, 4700, 0.006), mk(2600, 3900, 0.008)]);
  },

  // ---------------------------------------------------------------- piano (Level 5)

  // One soft piano note: a few slightly stretched partials, a felt hammer thump. Into dest.
  _pianoNote(L, dest, t, f, vel) {
    if (L.notes >= 9) return;
    L.notes = (L.notes || 0) + 1;
    const nodes = [];
    const g = this._gain(1);
    g.connect(dest); nodes.push(g);
    const parts = [[1, 1], [2.003, 0.42], [3.009, 0.2], [4.02, 0.1], [5.04, 0.05]];
    const base = 2.6 * Math.pow(220 / f, 0.35);
    let last = null;
    for (let k = 0; k < parts.length; k++) {
      const [r, a] = parts[k];
      const o = this._osc('sine', f * r * rnd(0.9995, 1.0005));
      const pg = this._gain(0);
      pg.gain.setValueAtTime(0, t);
      pg.gain.linearRampToValueAtTime(a * vel, t + 0.004);
      pg.gain.setTargetAtTime(a * vel * 0.35, t + 0.004, 0.08 / (k + 1));
      pg.gain.setTargetAtTime(0, t + 0.15, base / (k + 1.2));
      o.connect(pg); pg.connect(g);
      o.start(t); o.stop(t + 4.5);
      nodes.push(o, pg);
      last = o;
    }
    const h = this._loop(this._pink), hl = this._bq('lowpass', 900, 0.7), hg = this._gain(0);
    hg.gain.setValueAtTime(0, t);
    hg.gain.linearRampToValueAtTime(0.5 * vel, t + 0.002);
    hg.gain.setTargetAtTime(0, t + 0.003, 0.012);
    this._chain(h, hl, hg, g);
    h.start(t, rnd(0, 5)); h.stop(t + 0.15);
    nodes.push(h, hl, hg);
    last.onended = () => {
      L.notes--;
      for (const n of nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    };
  },

  // A phrase: a variation of this hotel's motif. Slow, rubato, sometimes it just stops.
  _pianoPhrase(L, t0) {
    const SC = [0, 1, 3, 5, 7, 8, 10];
    const deg = (d) => { const o = Math.floor(d / 7), k = ((d % 7) + 7) % 7; return SC[k] + 12 * o; };
    let m = L.motif.slice();
    const r = Math.random();
    if (r < 0.3) { const p = m[0]; m = m.map((d) => 2 * p - d); } // inversion
    else if (r < 0.45) m.reverse();
    const shift = pick([0, 0, 0, 2, -2, 3, 4, -3]);
    m = m.map((d) => d + shift);
    let d = m[m.length - 1];
    const ext = (Math.random() * 4) | 0;
    for (let i = 0; i < ext; i++) { d += pick([-2, -1, -1, 1, 1, 2, 3, -3]); m.push(d); }
    const stopAt = Math.random() < 0.35 ? 2 + ((Math.random() * (m.length - 2)) | 0) : m.length;
    const tempo = rnd(0.95, 1.35);
    const fold = (f, lo, hi) => { while (f < lo) f *= 2; while (f > hi) f /= 2; return f; };
    const notes = [];
    let t = t0;
    for (let i = 0; i < stopAt; i++) {
      const f = fold(L.root * Math.pow(2, deg(m[i]) / 12), 110, 523);
      const last = i === m.length - 1;
      notes.push({ t, f, v: rnd(0.22, 0.42) * (last ? 0.8 : 1) });
      if (i === 0 && Math.random() < 0.6) notes.push({ t: t + rnd(0, 0.03), f: fold(f / 2, 65, 262), v: rnd(0.15, 0.25) });
      else if (Math.random() < 0.18) notes.push({ t: t + rnd(0.01, 0.05), f: fold(L.root * Math.pow(2, deg(m[i] - 2) / 12), 98, 440), v: rnd(0.12, 0.2) });
      t += pick(L.rhythm) * tempo * rnd(0.9, 1.12) * (last ? 1.6 : 1);
    }
    return notes;
  },
});

// ------------------------------------------------------------------ place layers
// Each builds its nodes into L.out and sets L.tick(now, dt, st, w). Nothing here repeats: noise is played as
// random-offset grains (_mkBed), tones glide to random targets at random times, events come at random intervals.

const PLACE_BUILD = {
  // Level 1: a concrete warehouse / car park. Big dark reverb, ventilation far away, drips, tubes that misbehave.
  level1(L) {
    L.level = 0.6;
    const air = this._stereoBed(L, this._pink, [5, 11]);
    const airLP = L.N(this._bq('lowpass', 850, 0.6)), airAM = L.N(this._gain(1)), airG = L.N(this._gain(0.034));
    this._chain(air, L.N(this._bq('highpass', 70, 0.7)), airLP, airAM, airG, L.out);
    // Ventilation rumble, far: low band plus a duct roar heard mostly through the reverb.
    const vIn = L.N(this._gain(1));
    L.bed(this._brown, vIn, [6, 12], [0.85, 1.15], 2.2);
    const vBP = L.N(this._bq('bandpass', 110, 0.9)), vG = L.N(this._gain(0.06));
    this._chain(vIn, vBP, vG, L.out);
    const rIn = L.N(this._gain(1));
    L.bed(this._pink, rIn, [5, 10]);
    const rBP = L.N(this._bq('bandpass', 320, 1.6)), rG = L.N(this._gain(0.012));
    this._chain(rIn, rBP, rG, L.out);
    L.send(rG, 1.4);
    // A big fan somewhere: a low hum that wanders and sometimes spins down.
    const fan = L.SO(L.N(this._osc('triangle', 29))), fan2 = L.SO(L.N(this._osc('sine', 58.4)));
    const fanG = L.N(this._gain(0)), f2g = L.N(this._gain(0.8));
    fan.connect(fanG); fan2.connect(f2g); f2g.connect(fanG);
    this._chain(fanG, L.N(this._bq('lowpass', 160, 0.7)), L.out);
    // Tubes: two fixtures that tick and buzz unevenly, quieter and colder than Level 0's.
    const tubeSum = L.N(this._gain(1)), tubeG = L.N(this._gain(0));
    this._chain(tubeSum, L.N(this._bq('highpass', 300, 0.7)), tubeG, L.out);
    L.send(tubeG, 0.5);
    const tubes = [];
    for (let i = 0; i < 2; i++) {
      const o = L.SO(L.N(this._osc(i ? this._buzzWave2 : this._buzzWave, 120 * (1 + rnd(-0.001, 0.001)))));
      const bp = L.N(this._bq('bandpass', rnd(1300, 2600), 0.8)), g = L.N(this._gain(0.6));
      this._chain(o, bp, g);
      let pan = null;
      try { pan = L.N(this.ctx.createStereoPanner()); pan.pan.value = i ? 0.55 : -0.45; } catch (e) { pan = null; }
      if (pan) { g.connect(pan); pan.connect(tubeSum); } else g.connect(tubeSum);
      tubes.push({ o, bp, g });
    }
    const T = L.T;
    L.tick = (now, dt, st) => {
      const lit = st.hum * (1 - st.blackout);
      this._tg(tubeG.gain, 0.05 * Math.min(1, lit * 1.4), st.blackout > 0.05 ? 0.07 : 0.4);
      if (this._due(T, 'air', 3, 8, dt)) { this._tg(airAM.gain, rnd(0.7, 1.2), rnd(2, 4)); this._tg(airLP.frequency, rnd(650, 1100), 4); }
      if (this._due(T, 'vent', 4, 12, dt)) {
        this._tg(vBP.frequency, rnd(85, 160), rnd(2, 5));
        this._tg(vG.gain, Math.random() < 0.25 ? rnd(0.1, 0.16) : rnd(0.03, 0.08), rnd(2, 5));
        this._tg(rBP.frequency, rnd(240, 480), rnd(3, 6));
      }
      if (this._due(T, 'fan', 12, 40, dt)) {
        const on = Math.random() < 0.6, f = rnd(26, 34);
        this._tg(fan.frequency, on ? f : f * 0.6, on ? 3 : 6);
        this._tg(fan2.frequency, (on ? f : f * 0.6) * 2.01, on ? 3 : 6);
        this._tg(fanG.gain, on ? rnd(0.015, 0.03) : 0, on ? 3 : 5);
      }
      for (const tb of tubes) {
        if (now < (tb.next || 0)) continue;
        tb.next = now + rnd(0.4, 3.5);
        const r = Math.random();
        if (r < 0.3 && lit > 0.1) {
          // stutter
          const g = tb.g.gain, t0 = now + 0.02, dur = rnd(0.1, 0.9);
          g.cancelScheduledValues(t0);
          let tt = t0;
          while (tt < t0 + dur) { g.setTargetAtTime(Math.random() < 0.45 ? 0 : rnd(0.4, 1.4), tt, 0.005); tt += rnd(0.015, 0.08); }
          g.setTargetAtTime(rnd(0.3, 0.9), t0 + dur, 0.05);
          this._last.delete(g);
          if (Math.random() < 0.5) L.shot('_lamp', { pos: this._around(2, 8, 2.6), vol: 0.35 }, { s: rnd(0.2, 0.5) });
        } else {
          this._tg(tb.g.gain, Math.random() < 0.2 ? rnd(0, 0.2) : rnd(0.35, 1), rnd(0.2, 2));
          this._tg(tb.bp.frequency, rnd(1100, 2800), rnd(1, 4));
        }
      }
      if (this._due(T, 'drip', 3, 13, dt)) L.shot('_drip', { pos: this._around(4, 22, rnd(-1, 1)), vol: rnd(0.35, 0.8) }, { ref: 3, send: 1.3 });
    };
  },

  // Level 2: service tunnels. Tight metal reverb, a machine that labours and wanders, steam, pipes knocking.
  level2(L) {
    L.level = 0.72;
    const dr = L.N(this._gain(1));
    const o1 = L.SO(L.N(this._osc('sawtooth', 46))), o2 = L.SO(L.N(this._osc('sawtooth', 69.3))), o3 = L.SO(L.N(this._osc('sine', 23)));
    const g2 = L.N(this._gain(0.5)), g3 = L.N(this._gain(0.25));
    o1.connect(dr); o2.connect(g2); g2.connect(dr); o3.connect(g3); g3.connect(dr);
    const drLP = L.N(this._bq('lowpass', 320, 1.4)), drAM = L.N(this._gain(0.8)), drG = L.N(this._gain(0.045));
    this._chain(dr, drLP, drAM, drG, L.out);
    // Mechanical unsteadiness: slowed brown noise wobbling the level.
    const wob = L.N(this._gain(0.35));
    wob.connect(drAM.gain);
    L.bed(this._brown, wob, [4, 8], [2.5, 4]);
    // Heat: a dull roaring band that swells, and a faint high fizz.
    const heat = this._stereoBed(L, this._pink, [5, 10]);
    const hBP = L.N(this._bq('bandpass', 600, 0.6)), hAM = L.N(this._gain(1)), hG = L.N(this._gain(0.02));
    this._chain(heat, hBP, hAM, hG, L.out);
    const fz = L.N(this._gain(1));
    L.bed(this._white, fz, [4, 9]);
    const fzG = L.N(this._gain(0.004));
    this._chain(fz, L.N(this._bq('highpass', 6000, 0.7)), fzG, L.out);
    const T = L.T;
    let base = 46;
    L.tick = (now, dt) => {
      if (this._due(T, 'drone', 3, 10, dt)) {
        const labour = Math.random() < 0.18;
        base = clamp(base * rnd(0.94, 1.06), 40, 54);
        const f = labour ? base * 0.86 : base, tc = labour ? rnd(0.6, 1.2) : rnd(2, 5);
        this._tg(o1.frequency, f, tc); this._tg(o2.frequency, f * 1.5 * rnd(1.001, 1.006), tc); this._tg(o3.frequency, f / 2, tc);
        this._tg(drLP.frequency, rnd(180, 650), rnd(2, 5));
        this._tg(drG.gain, rnd(0.03, 0.06), rnd(2, 5));
      }
      if (this._due(T, 'heat', 2, 6, dt)) { this._tg(hAM.gain, rnd(0.5, 1.4), rnd(1, 3)); this._tg(hBP.frequency, rnd(400, 900), 3); }
      if (this._due(T, 'steam', 3, 11, dt)) L.shot('steamHiss', { pos: this._around(2, 9, rnd(0.5, 2.2)), vol: rnd(0.25, 0.6) }, { send: 0.4 });
      if (this._due(T, 'knock', 2.5, 12, dt)) {
        L.shot('_pipeKnock', { pos: this._around(3, 14, 2.3), vol: rnd(0.5, 1) }, { send: 0.6 });
        if (Math.random() < 0.35) T.reply = rnd(1, 3); // something knocks back
      }
      if (T.reply > 0 && (T.reply -= dt) <= 0) { T.reply = 0; L.shot('_pipeKnock', { pos: this._around(18, 30, 2.3), vol: 0.7 }, { send: 0.9, ref: 6 }); }
    };
  },

  // Level 5: the hotel. Dead, carpeted acoustics; a clock; boards settling; a piano through the walls.
  level5(L) {
    L.level = 1.45;
    const air = this._stereoBed(L, this._pink, [5, 11]);
    const airG = L.N(this._gain(0.016));
    this._chain(air, L.N(this._bq('lowpass', 420, 0.6)), airG, L.out);
    // The clock: a fixed spot in the world, a little uneven, sometimes it stops.
    const ck = this._panner(false);
    L.N(ck);
    ck.refDistance = 2;
    const ckG = L.N(this._gain(0.07));
    this._chain(ckG, L.N(this._bq('lowpass', 2600, 0.6)), ck, L.out);
    L.send(ckG, 0.25);
    const ckPos = () => { const p = this._around(5, 11, 1.8); this._setPos(ck, p[0], p[1], p[2], false); L.ckAt = p; };
    ckPos();
    const bufs = this._clockBufs();
    L.ckNext = this.ctx.currentTime + 0.5; L.ckOn = true; L.ck = 0; L.ckRate = rnd(0.97, 1.03);
    // The piano, through two walls: dark, far, with the room on it.
    const pp = this._panner(false);
    L.N(pp);
    pp.refDistance = 6;
    const pBus = L.N(this._gain(0.5));
    this._chain(pBus, L.N(this._bq('lowpass', 900, 0.6)), L.N(this._bq('peaking', 300, 1, 3)), pp, L.out);
    L.send(pBus, 0.5);
    const pPos = () => { const p = this._around(12, 18, 1); this._setPos(pp, p[0], p[1], p[2], false); L.pAt = p; };
    pPos();
    L.root = pick([138.6, 146.8, 155.6, 130.8]);
    L.motif = [0];
    for (let i = 0; i < 4; i++) L.motif.push(L.motif[i] + pick([-2, -1, 1, 1, 2, 3, -3, 4]));
    L.rhythm = pick([[1.1, 1.1, 2.2], [1.5, 0.75, 0.75, 2.2], [1.8, 1.2, 1.2], [1, 1.5, 2.5]]);
    L.notes = 0; L.queue = [];
    const T = L.T;
    T.piano = rnd(3, 10);
    L.tick = (now, dt) => {
      const Lp = this._L;
      if (Math.hypot(Lp.x - L.ckAt[0], Lp.z - L.ckAt[2]) > 22) ckPos();
      if (Math.hypot(Lp.x - L.pAt[0], Lp.z - L.pAt[2]) > 26) pPos();
      if (this._due(T, 'ckOn', 15, 50, dt)) { L.ckOn = Math.random() < 0.65; if (L.ckOn) L.ckNext = now + 0.3; }
      if (L.ckOn) {
        while (L.ckNext < now + 0.2) {
          const t = Math.max(L.ckNext, now + 0.01);
          const s = this.ctx.createBufferSource();
          s.buffer = bufs[L.ck & 1];
          s.playbackRate.value = rnd(0.97, 1.03);
          const g = this._gain(rnd(0.75, 1));
          s.connect(g); g.connect(ckG);
          s.onended = () => { try { s.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
          s.start(t);
          L.ckNext = t + (L.ck & 1 ? 0.53 : 0.47) * L.ckRate;
          L.ck++;
        }
        if (this._due(T, 'ckRate', 6, 20, dt)) L.ckRate = clamp(L.ckRate * rnd(0.99, 1.01), 0.95, 1.06);
      }
      if (this._due(T, 'board', 4, 15, dt)) L.shot('_board', { pos: this._around(2, 10, 0), vol: rnd(0.4, 0.9) }, { send: 0.3 });
      if (!L.queue.length && (T.piano -= dt) <= 0) {
        T.piano = rnd(8, 28);
        if (Math.random() < 0.75) L.queue = this._pianoPhrase(L, now + 0.2);
        if (Math.random() < 0.08) { // a new motif now and then, so even the motif does not settle in
          L.motif = [0];
          for (let i = 0; i < 4; i++) L.motif.push(L.motif[i] + pick([-2, -1, 1, 1, 2, 3, -3, 4]));
        }
      }
      while (L.queue.length && L.queue[0].t < now + 0.25) {
        const n = L.queue.shift();
        this._pianoNote(L, pBus, Math.max(n.t, now + 0.01), n.f, n.v);
      }
    };
  },

  // Level 37: the pool rooms. Long bright reverb, lapping water, drips with long tails, a soft pump.
  level37(L) {
    L.level = 2.6;
    const lapSum = L.N(this._gain(1)), lapG = L.N(this._gain(1));
    this._chain(lapSum, lapG, L.out);
    L.send(lapSum, 0.35);
    const laps = [];
    for (const pan of [-0.65, 0.6, 0]) {
      const n = L.N(this._gain(1));
      L.bed(this._pink, n, [4, 9]);
      const bp = L.N(this._bq('bandpass', 800, 1.3)), g = L.N(this._gain(0));
      const sn = L.N(this._gain(1));
      L.bed(this._white, sn, [4, 9]);
      const sbp = L.N(this._bq('bandpass', 3200, 1.6)), sg = L.N(this._gain(0));
      const mix = L.N(this._gain(1));
      this._chain(n, bp, g, mix);
      this._chain(sn, sbp, sg, mix);
      let p = null;
      try { p = L.N(this.ctx.createStereoPanner()); p.pan.value = pan; } catch (e) { p = null; }
      if (p) { mix.connect(p); p.connect(lapSum); } else mix.connect(lapSum);
      laps.push({ bp, g, sg, next: 0 });
    }
    // Pump: soft, cycles on and off, drifts.
    const pump = L.N(this._gain(1));
    const p1 = L.SO(L.N(this._osc('triangle', 49.5))), p2 = L.SO(L.N(this._osc('sine', 99.2)));
    const p2g = L.N(this._gain(0.3));
    p1.connect(pump); p2.connect(p2g); p2g.connect(pump);
    const pn = L.N(this._gain(1));
    L.bed(this._pink, pn, [5, 10]);
    const pnG = L.N(this._gain(0.35));
    this._chain(pn, L.N(this._bq('bandpass', 180, 2)), pnG, pump);
    const pLP = L.N(this._bq('lowpass', 260, 0.7)), pumpG = L.N(this._gain(0));
    this._chain(pump, pLP, pumpG, L.out);
    L.send(pumpG, 0.5);
    // Bright air.
    const air = this._stereoBed(L, this._pink, [5, 10]);
    const airG = L.N(this._gain(0.007));
    this._chain(air, L.N(this._bq('highpass', 400, 0.7)), L.N(this._bq('lowpass', 5200, 0.6)), airG, L.out);
    const T = L.T;
    L.pumpOn = Math.random() < 0.6;
    L.tick = (now, dt) => {
      const wade = clamp(this._x.water / 0.6);
      this._tg(lapG.gain, 0.55 + 0.9 * wade, 0.5);
      for (const lp of laps) {
        if (now < lp.next) continue;
        const t = now + 0.02, a = rnd(0.02, 0.07) * (Math.random() < 0.15 ? 1.8 : 1), up = rnd(0.12, 0.35), down = rnd(0.15, 0.45);
        lp.g.gain.cancelScheduledValues(t); lp.sg.gain.cancelScheduledValues(t);
        lp.g.gain.setTargetAtTime(a, t, up / 3);
        lp.g.gain.setTargetAtTime(0, t + up, down / 3);
        lp.sg.gain.setTargetAtTime(a * 0.12, t + up * 0.6, 0.02);
        lp.sg.gain.setTargetAtTime(0, t + up + 0.05, 0.04);
        const f0 = rnd(700, 1300);
        lp.bp.frequency.cancelScheduledValues(t);
        lp.bp.frequency.setValueAtTime(f0, t);
        lp.bp.frequency.setTargetAtTime(f0 * rnd(0.45, 0.7), t + up * 0.5, down / 2);
        lp.next = t + up + down * rnd(0.6, 1.6) + (Math.random() < 0.1 ? rnd(0.5, 1.5) : 0);
      }
      if (this._due(T, 'pump', 18, 60, dt)) {
        L.pumpOn = !L.pumpOn;
        const f = rnd(48.5, 50.5);
        this._tg(p1.frequency, L.pumpOn ? f : f * 0.85, L.pumpOn ? 2 : 4);
        this._tg(p2.frequency, (L.pumpOn ? f : f * 0.85) * 2.004, L.pumpOn ? 2 : 4);
        this._tg(pumpG.gain, L.pumpOn ? rnd(0.007, 0.012) : 0, L.pumpOn ? rnd(2, 4) : rnd(3, 6));
      }
      if (this._due(T, 'pLP', 4, 10, dt)) this._tg(pLP.frequency, rnd(160, 300), 3);
      if (this._due(T, 'drip', 1.2, 6, dt)) {
        const k = Math.random() < 0.2 ? 2 + ((Math.random() * 2) | 0) : 1, p = this._around(3, 18, rnd(-0.3, 2.5));
        for (let i = 0; i < k; i++) L.shot('_drip', { pos: [p[0] + rnd(-0.3, 0.3), p[1], p[2] + rnd(-0.3, 0.3)], vol: rnd(0.3, 0.75), delay: i * rnd(0.25, 0.7) }, { ref: 2.5, send: 1.5, delay: i * rnd(0.25, 0.7) });
      }
    };
  },

  // Level !: alarms, a pulse that speeds up with state.run, and the roar coming from behind.
  levelrun(L) {
    L.level = 0.5;
    const klax = [];
    for (let i = 0; i < 2; i++) {
      const a = L.SO(L.N(this._osc('square', 330))), b = L.SO(L.N(this._osc('square', 331.7)));
      const g = L.N(this._gain(0)), bp = L.N(this._bq('bandpass', 900, 1.4)), sh = L.N(this._shaper(2.5));
      const lvl = L.N(this._gain(i ? 0.022 : 0.05));
      a.connect(g); b.connect(g);
      this._chain(g, bp, sh, lvl, L.out);
      L.send(lvl, i ? 1.6 : 0.7);
      klax.push({ a, b, g, next: this.ctx.currentTime + rnd(0.1, 0.8) * (i + 1), f: i ? 290 : 330 });
    }
    // The roar: brown + pink rumble, many feet, throats, placed behind the listener.
    const rp = this._panner(false);
    L.N(rp);
    rp.refDistance = 6;
    const roar = L.N(this._gain(1)), roarLP = L.N(this._bq('lowpass', 400, 0.6)), roarG = L.N(this._gain(0));
    this._chain(roar, roarLP, roarG, rp, L.out);
    L.send(roarG, 0.6);
    const rb = L.N(this._gain(1.4));
    L.bed(this._brown, rb, [5, 10], [0.7, 1.3]);
    rb.connect(roar);
    const rpk = L.N(this._gain(0.5));
    L.bed(this._pink, rpk, [4, 9]);
    this._chain(rpk, L.N(this._bq('bandpass', 380, 0.8)), roar);
    const ft = L.N(this._gain(0.9));
    L.bed(this._hordeTex(), ft, [3, 6], [0.85, 1.15], 0.8);
    ft.connect(roar);
    const thr = [];
    for (const f of [92, 131, 187]) {
      const o = L.SO(L.N(this._osc(this._glotWave, f)));
      const bp = L.N(this._bq('bandpass', rnd(500, 900), 4)), g = L.N(this._gain(0.25));
      this._chain(o, bp, g, L.N(this._shaper(4)), roar);
      thr.push({ o, bp, f });
    }
    // Pulse.
    L.pulseNext = this.ctx.currentTime + 0.5;
    const T = L.T;
    L.tick = (now, dt) => {
      const run = this._x.run;
      for (const k of klax) {
        if (now < k.next - 0.15) continue;
        const t = Math.max(now + 0.01, k.next), dur = rnd(0.85, 1.1);
        k.g.gain.cancelScheduledValues(t);
        k.g.gain.setValueAtTime(0, t);
        k.g.gain.linearRampToValueAtTime(0.5, t + 0.04);
        k.g.gain.setValueAtTime(0.5, t + dur - 0.08);
        k.g.gain.linearRampToValueAtTime(0, t + dur);
        for (const o of [k.a, k.b]) {
          o.frequency.cancelScheduledValues(t);
          o.frequency.setValueAtTime(k.f * rnd(0.97, 1.03) * (o === k.b ? 1.005 : 1), t);
          o.frequency.exponentialRampToValueAtTime(k.f * 2 * rnd(0.97, 1.03), t + dur * 0.85);
        }
        k.next = t + dur + rnd(0.3, 0.6);
      }
      if (L.pulseNext < now + 0.12) {
        const t = Math.max(now + 0.01, L.pulseNext);
        L.shot('_pulse', { vol: 0.45 + 0.55 * run }, { delay: t - now });
        L.pulseNext = t + (60 / (68 + 112 * run)) * rnd(0.97, 1.03);
      }
      const Lp = this._L, dd = 22 - 17 * run;
      this._setPos(rp, Lp.x - Lp.fx * dd, Lp.y, Lp.z - Lp.fz * dd, true);
      this._tg(roarG.gain, 0.05 + 0.5 * Math.pow(run, 1.3), 0.4);
      this._tg(roarLP.frequency, 300 + 2600 * run, 0.4);
      if (this._due(T, 'thr', 0.4, 2, dt)) for (const h of thr) { this._tg(h.o.frequency, h.f * rnd(0.8, 1.5) * (1 + run * 0.6), rnd(0.2, 0.8)); this._tg(h.bp.frequency, rnd(450, 1400), 0.4); }
    };
  },
};

// ------------------------------------------------------------------ entities
// Every creature is built from the same organic parts: a throat (glottal pulse with jitter, vocal fry and
// roughness, through a moving formant bank, partly overdriven), breath (noise through formants, shaped cycle by
// cycle), and body events (steps, claws, joints, teeth, cloth) fired at irregular times into the creature's own
// 3D chain. Distance tells the story: far away only the reverb send and the sparse events carry (a howl, claws,
// a knock); mid range the panner makes it directional; inside a few metres the breath layers open up, the shared
// sub-bass pressure rises and the room tone ducks.
//
// Modes, derived from the state entities.js passes (all fields optional):
//   idle -> search (moving) -> noticed (seen, or chase > 0.12) -> chase (chase > 0.5 or rush > 0.3) -> attack
//   (attack, or chase > 0.7 within 2.2 m).

Object.assign(AudioEngine.prototype, {
  _entState(e, s, dt) {
    const st = e.st || (e.st = {});
    const d = e.d;
    if (e.px !== undefined && dt > 0) {
      const sp = Math.hypot(e.x - e.px, e.z - e.pz) / dt;
      e.spd = lerp(e.spd || 0, Math.min(sp, 12), clamp(dt * 6));
    }
    e.px = e.x; e.pz = e.z;
    st.chase = clamp(num(s.chase, 0));
    st.rush = clamp(num(s.rush, 0));
    st.reveal = clamp(num(s.reveal, 0));
    st.moving = s.moving !== undefined ? clamp(num(+s.moving, 0)) : clamp((e.spd || 0) / 1.2);
    st.near = s.near !== undefined ? clamp(num(+s.near, 0)) : smoothstep(14, 2, d);
    st.seen = !!s.seen;
    st.attack = !!s.attack;
    st.vol = clamp(num(s.vol, 1), 0, 2);
    let m = 'idle';
    if (st.attack || (st.chase > 0.7 && d < 2.2)) m = 'attack';
    else if (st.chase > 0.5 || st.rush > 0.3) m = 'chase';
    else if (st.seen || st.chase > 0.12) m = 'noticed';
    else if (st.moving > 0.2) m = 'search';
    e.changed = m !== e.mode;
    e.prevMode = e.mode;
    e.mode = m;
    e.modeT = e.changed ? 0 : (e.modeT || 0) + dt;
  },

  _entMake(type) {
    const now = this.ctx.currentTime;
    const e = { type, nodes: [], srcs: [], beds: [], wt: 0, d: 99, mode: 'idle', live: 0, press: 0, duck: 0, ear: 0, x: 0, y: 0, z: 0, t: {} };
    const N = (n) => { e.nodes.push(n); return n; };
    e.N = N;
    e.SO = (o) => { e.srcs.push(o); e.nodes.push(o); o.start(); return o; };
    e.B = (buf, dest, seg, rate, xf) => { const b = this._mkBed(buf, dest, seg, rate, xf); e.beds.push(b); return b; };
    e.sp = this._spMake(!this._mobile, ENT_SEND[type] || 0.5);
    e.sp.far = true;
    e.out = N(this._gain(0));
    e.out.connect(e.sp.lp);
    e.out.gain.setTargetAtTime(1, now, 0.12);
    // Body events into the creature's own 3D chain (own cap, outside the global voice cap).
    e.ev = (name, o, x) => {
      if (e.live >= (this._mobile ? 4 : 7) || e.gone) return;
      e.live++;
      const v = this._shot(name, o || {}, Object.assign({ dest: e.out, free: true, onFree: () => { e.live--; } }, x || {}));
      if (!v) e.live--;
    };
    // The big moments: a separate 3D voice on the hit bus (louder than anything else, skips the compressor).
    e.big = (name, o) => { this._shot(name, Object.assign({ pos: [e.x, e.y, e.z] }, o || {}), { big: true, hrtf: true, send: 0.6, prio: true }); };
    e.update = () => {};
    e.tick = () => { e.wt = 1; };
    const fn = ENT_BUILD[type];
    if (!fn) return null;
    fn.call(this, e);
    return e;
  },

  // Continuous throat: glottal pulse (jitter, fry subharmonic, roughness) + aspiration -> 3 formants -> dry / driven.
  // F: [[freq, Q, gain] x3].
  _throat(e, f0, F, rough) {
    const { N } = e;
    const osc = e.SO(N(this._osc(this._glotWave, f0)));
    const jit = N(this._gain(f0 * 0.05));
    jit.connect(osc.frequency);
    e.B(this._brown, jit, [3, 7], [0.25, 0.45], 1);
    const sub = e.SO(N(this._osc(this._glotWave, f0 / 2)));
    const subG = N(this._gain(0.3));
    jit.connect(sub.frequency);
    const src = N(this._gain(1));
    osc.connect(src); sub.connect(subG); subG.connect(src);
    const ng = N(this._gain(0.25));
    e.B(this._white, ng, [4, 8]);
    ng.connect(src);
    const am = N(this._gain(1));
    const rg = N(this._gain(rough || 0.5));
    rg.connect(am.gain);
    e.B(this._brown, rg, [2, 5], [6, 9], 0.6);
    src.connect(am);
    const sum = N(this._gain(1));
    const bps = F.map(([f, q, g]) => {
      const bp = N(this._bq('bandpass', f, q)), gg = N(this._gain(g));
      this._chain(am, bp, gg, sum);
      return bp;
    });
    const dry = N(this._gain(1)), wet = N(this._gain(0)), out = N(this._gain(0));
    sum.connect(dry); dry.connect(out);
    this._chain(sum, N(this._shaper(6)), N(this._bq('lowpass', 5200, 0.6)), wet, out);
    return { osc, sub, subG, ng, rg, F: bps, dry, wet, out, f0 };
  },

  // Continuous breath: noise -> formants -> env (scheduled per breath). F: [[freq, Q, gain] ...].
  _breathL(e, F, buf) {
    const { N } = e;
    const n = N(this._gain(1));
    e.B(buf || this._white, n, [4, 9]);
    const sum = N(this._gain(1)), env = N(this._gain(0));
    const bps = F.map(([f, q, g]) => {
      const bp = N(this._bq('bandpass', f, q)), gg = N(this._gain(g));
      this._chain(n, bp, gg, sum);
      return bp;
    });
    sum.connect(env);
    return { env, F: bps };
  },

  // Wet crackle (saliva, mucus, bubbles): noise gated by random spikes from tick().
  _crackleL(e, hp) {
    const { N } = e;
    const n = N(this._gain(1));
    e.B(this._white, n, [4, 9]);
    const gate = N(this._gain(0)), lvl = N(this._gain(0));
    this._chain(n, N(this._bq('highpass', hp || 1800, 0.7)), N(this._bq('peaking', 3500, 2, 6)), gate, lvl);
    return { gate, lvl };
  },

  _crackle(c, t, len, rate, amp) {
    let tt = t;
    const g = c.gate.gain;
    while (tt < t + len) {
      g.setValueAtTime(Math.pow(Math.random(), 2) * amp, tt);
      g.setTargetAtTime(0, tt + 0.001, 0.003);
      tt += rnd(0.3, 1.7) / rate;
    }
  },

  // One breath: inhale (inD) then exhale (exD), with formant movement. b = _breathL result.
  _breathe(b, t, inD, exD, aIn, aEx, fIn, fEx, gap) {
    const g = b.env.gain, F1 = b.F[0].frequency;
    g.cancelScheduledValues(t); F1.cancelScheduledValues(t);
    g.setTargetAtTime(aIn, t, inD * 0.3);
    F1.setTargetAtTime(fIn, t, 0.05);
    const te = t + inD + (gap || 0);
    g.setTargetAtTime(gap ? 0 : aIn * 0.3, t + inD * 0.85, 0.04);
    if (aEx > 0) {
      g.setTargetAtTime(aEx, te, exD * 0.15);
      F1.setTargetAtTime(fEx, te, 0.06);
      g.setTargetAtTime(0, te + exD * 0.6, exD * 0.2);
    } else {
      g.setTargetAtTime(0, te, 0.05);
    }
    return te + exD;
  },

  _hordeTex() {
    if (this._tex.horde) return this._tex.horde;
    const sr = this.ctx.sampleRate, sec = this._mobile ? 4 : 6, n = Math.floor(sr * sec);
    const b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    const steps = Math.floor(sec * 170);
    for (let k = 0; k < steps; k++) {
      const s0 = Math.floor(Math.random() * (n - sr * 0.08)), a = Math.pow(Math.random(), 2.2), f = rnd(55, 120);
      const L = Math.floor(sr * rnd(0.03, 0.07));
      let y = 0;
      const c = rnd(0.05, 0.3);
      for (let j = 0; j < L; j++) {
        const x = j / sr;
        y += c * (Math.random() * 2 - 1 - y);
        d[s0 + j] += a * (Math.exp(-x / 0.012) * (y * 2.5 + Math.sin(TAU * f * x) * 0.6));
      }
      if (Math.random() < 0.3) { // scuff
        const s1 = s0 + Math.floor(sr * 0.03), L2 = Math.floor(sr * rnd(0.04, 0.12));
        for (let j = 0; j < L2 && s1 + j < n; j++) d[s1 + j] += a * 0.25 * (Math.random() * 2 - 1) * Math.sin(Math.PI * j / L2);
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < n; i++) d[i] *= 0.9 / (peak || 1);
    return (this._tex.horde = b);
  },

  // Throat one shot: o = { dur, f: [[t, hz]...], F: [[t, [f1, f2, f3]]...], amp, att, cut, drive, noise, vib, rough, Q }.
  _voxOne(v, t, o) {
    const dur = o.dur, end = t + dur, f0 = o.f[0][1];
    const osc = this._osc(this._glotWave, f0);
    osc.frequency.setValueAtTime(f0, t);
    for (const [dt, hz] of o.f.slice(1)) osc.frequency.linearRampToValueAtTime(hz, t + dt);
    const src = this._gain(1), am = this._gain(1);
    osc.connect(src);
    v.nodes.push(src, am);
    this._run(v, osc, t, end + 0.05);
    if (o.noise) {
      const n = this._loop(this._white), ng = this._gain(o.noise);
      n.connect(ng); ng.connect(src);
      v.nodes.push(ng);
      this._run(v, n, t, end + 0.05, rnd(0, 5));
    }
    if (o.vib) {
      const l = this._osc('sine', o.vibRate || rnd(4.5, 6.5)), lg = this._gain(f0 * o.vib);
      l.connect(lg); lg.connect(osc.frequency);
      v.nodes.push(lg);
      this._run(v, l, t, end + 0.05);
    }
    if (o.rough) {
      const r = this._loop(this._brown, rnd(6, 9)), rg = this._gain(o.rough);
      r.connect(rg); rg.connect(am.gain);
      v.nodes.push(rg);
      this._run(v, r, t, end + 0.05, rnd(0, 5));
    }
    src.connect(am);
    const sum = this._gain(1);
    v.nodes.push(sum);
    const Q = o.Q || [5, 7, 8], FG = [1, 0.55, 0.2];
    for (let i = 0; i < 3; i++) {
      const bp = this._bq('bandpass', o.F[0][1][i], Q[i]), gg = this._gain(FG[i]);
      for (const [dt, fs] of o.F.slice(1)) bp.frequency.linearRampToValueAtTime(fs[i], t + dt);
      this._chain(am, bp, gg, sum);
      v.nodes.push(bp, gg);
    }
    const env = this._gain(0);
    v.nodes.push(env);
    if (o.drive) {
      const sh = this._shaper(o.drive), lp = this._bq('lowpass', 6500, 0.6), dg = this._gain(o.driveMix || 0.6);
      this._chain(sum, sh, lp, dg, env);
      v.nodes.push(sh, lp, dg);
    }
    sum.connect(env);
    env.connect(o.dest || v.out);
    const amp = o.amp || 0.5, att = o.att || 0.05;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(amp, t + att);
    if (o.cut) {
      env.gain.setValueAtTime(amp * (o.sus || 1), end - 0.035);
      env.gain.linearRampToValueAtTime(0, end);
    } else {
      env.gain.setTargetAtTime(amp * (o.sus || 0.8), t + att, dur * 0.3);
      env.gain.setTargetAtTime(0, end - dur * 0.3, dur * 0.1);
    }
    return { osc, env };
  },

  // Gated noise texture (crackle, scrape, rustle) as a one shot.
  _gated(v, t, dur, ftype, f, Q, amp, step, dest, buf) {
    const s = this._loop(buf || this._white), fl = this._bq(ftype, f, Q), g = this._gain(0);
    this._chain(s, fl, g, dest || v.out);
    v.nodes.push(fl, g);
    let tt = t;
    while (tt < t + dur) {
      const p = (tt - t) / dur;
      g.gain.setValueAtTime(Math.random() < 0.35 ? 0 : Math.pow(Math.random(), 1.5) * amp * Math.sin(Math.PI * p), tt);
      tt += rnd(step[0], step[1]);
    }
    g.gain.setValueAtTime(0, t + dur);
    this._run(v, s, t, t + dur + 0.02, rnd(0, 5));
    return { fl, g };
  },
});

const ENT_SEND = { longarm: 0.75, hollow: 0.35, smiler: 0.5, stealer: 0.4, hound: 0.45, faceling: 0.2, horde: 0.9 };

const ENT_BUILD = {
  // The Howler. Far: a long howl now and then, joints cracking somewhere. Mid: heavy uneven steps, the rattle of
  // its throat. Close: wet rasping breath in your ear, sub pressure. Before a charge: the howl. Charging: a shriek
  // that climbs as it closes in.
  longarm(e) {
    const { N } = e;
    const th = this._throat(e, 64, [[430, 6, 1], [930, 7, 0.55], [2600, 8, 0.14]], 0.7);
    th.out.connect(e.out);
    const rasp = this._breathL(e, [[700, 3, 1], [1250, 4, 0.6], [2900, 5, 0.3]]);
    const raspG = N(this._gain(0));
    rasp.env.connect(raspG); raspG.connect(e.out);
    const cr = this._crackleL(e, 1500);
    cr.lvl.connect(e.out);
    this._texture('clicks');
    this._texture('drag');
    const ci = N(this._gain(1));
    e.B(this._tex.clicks, ci, [1.5, 3.5], [0.85, 1.2], 0.3);
    const clickG = N(this._gain(0));
    this._chain(ci, N(this._bq('highpass', 380, 0.7)), clickG, e.out);
    const di = N(this._gain(1));
    e.B(this._tex.drag, di, [2, 4], [0.8, 1.2], 0.5);
    const dragG = N(this._gain(0));
    this._chain(di, N(this._bq('lowpass', 1800, 0.6)), dragG, e.out);
    // Charge shriek: noise and a buzzing partial through a sweeping resonance, driven hard.
    const sn = N(this._gain(1));
    e.B(this._white, sn, [3, 6]);
    const so = e.SO(N(this._osc('sawtooth', 700))), sog = N(this._gain(0.25));
    so.connect(sog);
    const sbp = N(this._bq('bandpass', 2000, 3)), shG = N(this._gain(0));
    sn.connect(sbp); sog.connect(sbp);
    this._chain(sbp, N(this._shaper(8)), N(this._bq('lowpass', 7000, 0.6)), shG, e.out);
    const T = e.t;
    T.howl = this.ctx.currentTime + rnd(4, 14);
    e.update = (st, d) => {
      const v = st.vol, m = e.mode, now = this.ctx.currentTime;
      const close = smoothstep(12, 2, d), ch = m === 'chase' || m === 'attack' ? 1 : 0;
      const lvl = v * (0.2 * close + (m === 'search' ? 0.06 : 0) + (m === 'noticed' ? 0.3 : 0) + (m === 'chase' ? 0.38 : 0) + (m === 'attack' ? 0.6 : 0));
      this._tg(th.out.gain, lvl, 0.12);
      this._tg(th.wet.gain, 0.15 + 0.85 * ch, 0.15);
      this._tg(th.dry.gain, 1 - 0.55 * ch, 0.15);
      this._tg(th.subG.gain, ch ? 0.15 : 0.55, 0.3);
      this._tg(th.rg.gain, ch ? 0.95 : 0.6, 0.3);
      this._tg(raspG.gain, v * 2.2 * smoothstep(9, 1.2, d), 0.2);
      this._tg(cr.lvl.gain, v * 0.5 * smoothstep(7, 1, d), 0.2);
      this._tg(clickG.gain, v * 0.35 * (0.25 + st.moving) * (0.5 + ch), 0.25);
      this._tg(dragG.gain, v * 0.35 * st.moving * (1 - ch), 0.3);
      const shr = ch * smoothstep(10, 1.2, d) * (0.45 + 0.55 * Math.max(st.rush, st.chase));
      this._tg(shG.gain, v * 0.24 * shr, 0.1);
      this._tg(sbp.frequency, 1300 + 3000 * shr, 0.15);
      this._tg(so.frequency, 450 + 900 * shr, 0.2);
      e.press = smoothstep(7, 1, d) * (m === 'idle' ? 0.5 : 1) * Math.min(1, v);
      e.duck = d < 4 && st.moving < 0.1 ? smoothstep(4.5, 1.5, d) * 0.8 : ch * smoothstep(8, 2, d) * 0.5;
      if (e.changed && m === 'chase' && e.prevMode !== 'attack' && now - (T.big || -99) > 6) {
        T.big = now;
        e.big('_eHowl', { vol: Math.min(1.2, v) });
      }
    };
    e.tick = () => {
      const now = this.ctx.currentTime, m = e.mode, st = e.st || {}, ch = m === 'chase' || m === 'attack';
      e.wt = rnd(0.05, 0.2);
      if (now >= (T.br || 0)) {
        const t = now + 0.02;
        const end = ch
          ? this._breathe(rasp, t, rnd(0.25, 0.4), rnd(0.35, 0.6), rnd(0.3, 0.5), rnd(0.4, 0.7), 900, 650)
          : this._breathe(rasp, t, rnd(1.1, 1.8), rnd(1.4, 2.4), rnd(0.15, 0.3), rnd(0.25, 0.45), rnd(750, 950), rnd(520, 650), Math.random() < 0.3 ? rnd(0.3, 0.9) : 0);
        this._crackle(cr, t, end - t, ch ? 60 : 25, ch ? 0.9 : 0.6);
        T.br = end + (ch ? rnd(0, 0.15) : rnd(0.3, 2.2));
      }
      if (now >= (T.th || 0)) {
        T.th = now + rnd(0.25, 1.5) * (ch ? 0.4 : 1);
        const f = ch ? rnd(150, 270) : rnd(52, 88);
        this._tg(th.osc.frequency, f, ch ? 0.08 : rnd(0.2, 0.6));
        this._tg(th.sub.frequency, f / 2 * rnd(0.98, 1.02), 0.2);
        this._tg(th.F[0].frequency, rnd(330, 650) * (ch ? 1.35 : 1), 0.15);
        this._tg(th.F[1].frequency, rnd(750, 1300) + (ch ? 700 : 0), 0.15);
      }
      if (st.moving > 0.2 && now >= (T.step || 0)) {
        T.limp = !T.limp;
        const per = ch ? rnd(0.24, 0.36) : rnd(0.65, 1.1);
        T.step = now + per * (T.limp ? 1.35 : 0.72);
        e.ev('_eStomp', { vol: (0.6 + 0.4 * st.moving) * st.vol });
      }
      if (now >= (T.joint || 0)) {
        T.joint = now + rnd(1.2, 6) * (ch ? 0.35 : 1);
        e.ev('_eJoint', { vol: rnd(0.4, 1) * st.vol });
      }
      if ((m === 'idle' || m === 'search') && now >= T.howl) {
        T.howl = now + rnd(10, 28);
        e.ev('_eHowlFar', { vol: 0.9 * st.vol });
      }
    };
  },

  // The Hollow: an empty suit. Far: nothing, or one bump against a wall. Mid: cloth and shuffling when it moves
  // (only when nobody looks). Close and still: a respirator hissing with nobody breathing, the helmet's hollow
  // whistle, a valve that clicks without a breath, and the room going quiet.
  hollow(e) {
    const { N } = e;
    const hn = N(this._gain(1));
    e.B(this._white, hn, [4, 9]);
    const hAM = N(this._gain(0.7)), hissG = N(this._gain(0));
    this._chain(hn, N(this._bq('bandpass', 1700, 1.2)), hAM, hissG, e.out);
    const cn = N(this._gain(1));
    e.B(this._pink, cn, [4, 9]);
    const c1 = N(this._bq('bandpass', 210, 24)), c2 = N(this._bq('bandpass', 470, 18)), c2g = N(this._gain(0.5)), cavG = N(this._gain(0));
    cn.connect(c1); c1.connect(cavG);
    cn.connect(c2); c2.connect(c2g); c2g.connect(cavG);
    cavG.connect(e.out);
    this._texture('creak');
    const ki = N(this._gain(1));
    e.B(this._tex.creak, ki, [1.5, 3], [0.85, 1.15], 0.3);
    const creakG = N(this._gain(0));
    this._chain(ki, creakG, e.out);
    const T = e.t;
    e.update = (st, d) => {
      const v = st.vol, mv = st.moving, still = mv < 0.1;
      this._tg(hissG.gain, v * 0.09 * smoothstep(7, 1, d), 0.4);
      this._tg(cavG.gain, v * 2.2 * smoothstep(6, 1, d) * (still ? 1 : 0.35), 0.5);
      this._tg(creakG.gain, v * 0.6 * mv, mv > 0.05 ? 0.05 : 0.12);
      e.press = smoothstep(4, 1, d) * 0.6;
      e.duck = still ? smoothstep(6, 1.5, d) * 0.85 : smoothstep(3, 1, d) * 0.3;
      if (T.wasMv > 0.5 && still && d < 15) e.ev('_eSlump', { vol: v * 0.8 });
      T.wasMv = mv;
    };
    e.tick = () => {
      const now = this.ctx.currentTime, st = e.st || {}, d = e.d;
      e.wt = rnd(0.12, 0.5);
      if (this._due(T, 'cav', 1, 4, 0.3)) { this._tg(c1.frequency, rnd(180, 260), rnd(0.5, 2)); this._tg(c2.frequency, rnd(400, 560), 1.5); this._tg(hAM.gain, rnd(0.3, 1.1), 1); }
      if (st.moving > 0.3) {
        if (now >= (T.step || 0)) { T.step = now + rnd(0.35, 0.9); e.ev(Math.random() < 0.6 ? '_eShuffle' : '_eRustle', { vol: st.vol * rnd(1, 1.5) }); }
        if (d > 10 && now >= (T.bump || 0)) { T.bump = now + rnd(8, 20); if (Math.random() < 0.5) e.ev('_eKnock1', { vol: st.vol * 0.9 }); }
      } else if (d < 7 && now >= (T.valve || 0)) {
        T.valve = now + rnd(2.5, 9);
        e.ev('_eValve', { vol: st.vol * 0.5 });
        if (Math.random() < 0.3) setTimeout(() => e.ev('_eValve', { vol: st.vol * 0.35 }), rnd(150, 400));
      }
    };
  },

  // The Smiler: nearly silent. A faint wet breath through a grin (an /i/ shape), the click of teeth, a high
  // glassy whine you are not sure you hear. Only close. Running makes it breathe faster.
  smiler(e) {
    const { N } = e;
    const br = this._breathL(e, [[310, 4, 1], [2250, 8, 0.75], [3050, 9, 0.45]]);
    const brG = N(this._gain(0));
    br.env.connect(brG); brG.connect(e.out);
    const cr = this._crackleL(e, 2200);
    cr.lvl.connect(e.out);
    const wh = N(this._gain(0));
    for (const f of [5600, 5617, 8410]) { const o = e.SO(N(this._osc('sine', f))); o.connect(wh); }
    wh.connect(e.out);
    const T = e.t;
    e.update = (st, d) => {
      const v = st.vol, ch = e.mode === 'chase' || e.mode === 'attack' ? 1 : 0;
      this._tg(brG.gain, v * 0.95 * smoothstep(8, 1.2, d) * (1 + 0.5 * ch), 0.3);
      this._tg(cr.lvl.gain, v * 0.4 * smoothstep(6, 1, d) * (1 + ch), 0.3);
      this._tg(wh.gain, v * 0.0045 * smoothstep(4.5, 1, d), 0.6);
      e.press = smoothstep(5, 1, d) * 0.75;
      e.duck = smoothstep(7, 2, d) * (st.moving < 0.1 ? 0.8 : 0.4);
    };
    e.tick = () => {
      const now = this.ctx.currentTime, st = e.st || {}, ch = e.mode === 'chase' || e.mode === 'attack';
      e.wt = rnd(0.08, 0.25);
      if (now >= (T.br || 0)) {
        const t = now + 0.02;
        const end = ch
          ? this._breathe(br, t, rnd(0.35, 0.6), rnd(0.4, 0.7), 0.5, 0.6, 360, 300)
          : this._breathe(br, t, rnd(2, 3), rnd(1.5, 2.3), rnd(0.3, 0.45), rnd(0.35, 0.5), 340, 290, rnd(0.2, 0.9));
        this._crackle(cr, t, end - t, ch ? 45 : 18, 0.8);
        T.br = end + (ch ? rnd(0, 0.2) : rnd(0.4, 2.5));
      }
      if (e.d < 11 && now >= (T.teeth || 0)) {
        T.teeth = now + (ch ? rnd(0.4, 1.4) : rnd(2, 8));
        e.ev('_eTeeth', { vol: st.vol * (ch ? 1 : 0.7) }, { n: ch ? 6 : 3 });
      }
    };
  },

  // The Skin-Stealer: a person in a suit, from a distance. Footsteps, a respirator. Up close the breathing is
  // wrong: inhales too long, double inhales, held breath, a valve out of step, a hum that should not be there.
  // Far away it sometimes calls in a voice it took. Revealing: a wet, gurgling throat and stretching skin.
  stealer(e) {
    const { N } = e;
    const br = this._breathL(e, [[1300 * 0.86, 0.9, 1], [1150 * 0.86, 3, 0.8], [2400 * 0.86, 4, 0.25]]);
    const brG = N(this._gain(0));
    this._chain(br.env, N(this._bq('peaking', 170, 1, 4)), N(this._bq('lowpass', 4200, 0.6)), brG, e.out);
    const hum = this._throat(e, 92, [[280, 6, 1], [1000, 8, 0.3], [2300, 9, 0.08]], 0.2);
    hum.out.connect(e.out);
    const rv = this._throat(e, 48, [[520, 4, 1], [1100, 5, 0.6], [2500, 6, 0.2]], 0.9);
    rv.wet.gain.value = 1;
    rv.out.connect(e.out);
    const cr = this._crackleL(e, 1200);
    cr.lvl.connect(e.out);
    const T = e.t;
    e.update = (st, d) => {
      const v = st.vol, rev = st.reveal;
      this._tg(brG.gain, v * 1.2 * smoothstep(15, 1.5, d) * (1 - 0.6 * rev), 0.3);
      this._tg(rv.out.gain, v * 0.6 * rev * smoothstep(14, 1, d), 0.15);
      this._tg(cr.lvl.gain, v * 0.6 * rev * smoothstep(10, 1, d), 0.15);
      e.press = Math.max(rev, 0.3) * smoothstep(5, 1, d);
      e.duck = d < 4 && st.moving < 0.1 ? smoothstep(4, 1.5, d) * 0.6 : 0;
      if (rev > 0.3 && !T.rev) { T.rev = true; e.ev('_eGasp', { vol: v }); }
      if (rev < 0.1) T.rev = false;
    };
    e.tick = () => {
      const now = this.ctx.currentTime, st = e.st || {}, d = e.d;
      e.wt = rnd(0.05, 0.2);
      if (now >= (T.br || 0)) {
        const t = now + 0.02, r = Math.random();
        let end;
        if (r < 0.55) end = this._breathe(br, t, rnd(1.4, 2.1), rnd(0.5, 0.8), 0.32, 0.4, 1600, 950); // inhale too long
        else if (r < 0.7) { const e1 = this._breathe(br, t, rnd(0.6, 0.9), 0, 0.3, 0, 1500, 900, 0.15); end = this._breathe(br, e1 + 0.12, rnd(0.6, 0.9), rnd(0.7, 1.1), 0.34, 0.42, 1700, 950); }
        else if (r < 0.82) { end = t + rnd(3, 6); T.held = end; } // holds its breath
        else { // stutter sniffs
          let tt = t;
          for (let k = 0; k < 3 + ((Math.random() * 2) | 0); k++) tt = this._breathe(br, tt, rnd(0.09, 0.14), 0, 0.35, 0, 1800, 900) + rnd(0.04, 0.1);
          end = this._breathe(br, tt, 0.05, rnd(1.2, 1.8), 0.1, 0.42, 1500, 900);
        }
        if (!T.held || T.held < t) {
          const off = rnd(-0.2, 0.35);
          if (Math.random() < 0.8) setTimeout(() => e.ev('_eValve', { vol: st.vol * 0.55 }, { rate: 0.82 }), Math.max(0, (off + 0.02) * 1000));
        }
        if (d < 8 && Math.random() < 0.08) {
          const th = now + (end - now) + 0.1, g = hum.out.gain;
          this._tg(hum.osc.frequency, rnd(85, 100), 0.05);
          g.setTargetAtTime(0.25 * st.vol, th, 0.05);
          hum.osc.frequency.setTargetAtTime(rnd(70, 80), th + 0.2, 0.2);
          g.setTargetAtTime(0, th + rnd(0.5, 0.8), 0.08);
          this._last.delete(g);
          end += 0.9;
        }
        T.br = end + rnd(0.2, 0.9);
      }
      if (st.reveal > 0.2) {
        if (now >= (T.rvT || 0)) { T.rvT = now + rnd(0.15, 0.6); this._tg(rv.osc.frequency, rnd(38, 70), 0.1); this._tg(rv.F[0].frequency, rnd(350, 800), 0.1); }
        if (now >= (T.crk || 0)) { T.crk = now + rnd(0.2, 0.7); this._crackle(cr, now + 0.01, rnd(0.2, 0.5), 50, 1); }
        if (now >= (T.skin || 0)) { T.skin = now + rnd(0.6, 2); e.ev('_eSkin', { vol: st.vol }); }
      }
      if (st.moving > 0.2 && now >= (T.step || 0)) {
        T.limp = !T.limp;
        T.step = now + rnd(0.48, 0.58) * (T.limp ? 1.2 : 0.85);
        e.ev('_eStep', { vol: st.vol * 1.3 }, { drag: T.limp && Math.random() < 0.5 });
      }
      if (d > 9 && (e.mode === 'idle' || e.mode === 'search') && now >= (T.call || now + 1)) {
        if (T.call) this._whisperAt([e.x, e.y, e.z], pick(['mimic', 'murmur', 'call', 'mimic']), false, 0.7);
        T.call = now + rnd(22, 55);
      }
    };
  },

  // The Hound: on all fours, fast. Far: claws on the floor, a huff. Mid: panting, uneven, a growl when it has
  // noticed you. Close: a snarl, hot wet breath, pressure. Its claws gallop when it chases.
  hound(e) {
    const { N } = e;
    const pt = this._breathL(e, [[760, 3, 1], [1300, 4, 0.6], [2600, 5, 0.25]]);
    const ptG = N(this._gain(0));
    pt.env.connect(ptG); ptG.connect(e.out);
    const gr = this._throat(e, 72, [[360, 5, 1], [820, 6, 0.5], [2400, 7, 0.12]], 0.9);
    gr.out.connect(e.out);
    const cr = this._crackleL(e, 1600);
    cr.lvl.connect(e.out);
    const T = e.t;
    e.update = (st, d) => {
      const v = st.vol, m = e.mode, ch = m === 'chase' || m === 'attack' ? 1 : 0, no = m === 'noticed' ? 1 : 0;
      this._tg(ptG.gain, v * 1.25 * smoothstep(18, 1.5, d) * (0.55 + 0.45 * Math.max(st.moving, ch)), 0.2);
      this._tg(gr.out.gain, v * (0.08 * smoothstep(10, 2, d) + 0.35 * no * smoothstep(18, 2, d) + 0.5 * ch * smoothstep(20, 1.5, d)), 0.12);
      this._tg(gr.wet.gain, 0.2 + 0.8 * Math.max(ch, no * 0.5), 0.15);
      this._tg(cr.lvl.gain, v * 0.45 * smoothstep(6, 1, d), 0.2);
      e.press = smoothstep(6, 1, d) * (0.45 + 0.55 * ch);
      e.duck = d < 4 && st.moving < 0.1 ? 0.5 : 0;
      if (e.changed && (m === 'noticed' || m === 'chase') && e.prevMode !== 'attack') e.ev('_eSnarl', { vol: v * (m === 'chase' ? 1 : 0.7) });
    };
    e.tick = () => {
      const now = this.ctx.currentTime, st = e.st || {}, m = e.mode, ch = m === 'chase' || m === 'attack';
      e.wt = rnd(0.03, 0.08);
      if (now >= (T.pant || 0)) {
        const rate = ch ? rnd(3.4, 4.3) : st.moving > 0.2 ? rnd(2.1, 2.7) : rnd(1.1, 1.6);
        const per = 1 / rate, t = now + 0.01;
        const end = this._breathe(pt, t, per * 0.38, per * 0.5, 0.35, 0.55, rnd(950, 1150), rnd(650, 780));
        if (ch) this._crackle(cr, t, per, 30, 0.6);
        T.pant = end + per * rnd(-0.05, 0.12) + (Math.random() < 0.06 ? rnd(0.4, 0.9) : 0);
      }
      if (now >= (T.gr || 0)) {
        T.gr = now + rnd(0.15, 0.9) * (ch ? 0.5 : 1);
        this._tg(gr.osc.frequency, ch ? rnd(95, 150) : rnd(60, 82), 0.12);
        this._tg(gr.F[0].frequency, ch ? rnd(500, 750) : rnd(300, 420), 0.1);
        this._tg(gr.F[1].frequency, ch ? rnd(1000, 1500) : rnd(700, 950), 0.1);
      }
      if (st.moving > 0.15 && now >= (T.stride || 0)) {
        const gallop = ch || st.moving > 0.7;
        const per = gallop ? rnd(0.23, 0.31) : rnd(0.42, 0.58);
        T.stride = now + per;
        e.ev('_eClaws', { vol: st.vol * (gallop ? 1.5 : 1.1) }, { n: gallop ? 4 : 2, span: gallop ? 0.13 : 0.22, surf: PLACE_STEP[this._domPlace()] });
      }
      if (m === 'idle' && now >= (T.huff || now + 1)) {
        if (T.huff) e.ev('_eHuff', { vol: st.vol });
        T.huff = now + rnd(8, 22);
      }
    };
  },

  // The Faceling makes no sound. Near it, the room tone sinks away and a faint pressure fills the ears.
  faceling(e) {
    e.update = (st, d) => {
      e.duck = smoothstep(16, 3, d) * 0.92 * Math.min(1, st.vol);
      e.ear = smoothstep(7, 1.5, d) * Math.min(1, st.vol);
      e.press = smoothstep(4, 1, d) * 0.35;
    };
    e.tick = () => { e.wt = 1; };
  },

  // The horde on Level !: hundreds of feet, a rumble, many throats. Loud from far away.
  horde(e) {
    const { N } = e;
    e.sp.p.refDistance = 7;
    e.sp.p.rolloffFactor = 0.9;
    const tex = this._hordeTex();
    const m = N(this.ctx.createChannelMerger(2));
    for (const ch of [0, 1]) { const g = N(this._gain(1)); g.connect(m, 0, ch); e.B(tex, g, [2, 5], [0.85, 1.15], 0.6); }
    const fLP = N(this._bq('lowpass', 1500, 0.6)), feetG = N(this._gain(0));
    this._chain(m, fLP, feetG, e.out);
    const rb = N(this._gain(1));
    e.B(this._brown, rb, [5, 10], [0.7, 1.3]);
    const rumG = N(this._gain(0));
    this._chain(rb, N(this._bq('lowpass', 150, 0.7)), rumG, e.out);
    const voices = [];
    for (const f of [105, 158, 236]) {
      const th = this._throat(e, f, [[rnd(500, 800), 4, 1], [rnd(1000, 1500), 5, 0.5], [2600, 6, 0.15]], 0.8);
      th.wet.gain.value = 0.8;
      th.out.connect(e.out);
      voices.push(th);
    }
    const T = e.t;
    e.update = (st, d) => {
      const v = st.vol, close = smoothstep(25, 2, d);
      this._tg(feetG.gain, v * 0.9, 0.3);
      this._tg(fLP.frequency, 1100 + 6000 * close, 0.3);
      this._tg(rumG.gain, v * (0.4 + 0.5 * close), 0.3);
      for (const th of voices) this._tg(th.out.gain, v * 0.12 * (0.3 + 0.7 * close), 0.4);
      e.press = smoothstep(18, 2, d);
      e.duck = 0;
    };
    e.tick = () => {
      e.wt = rnd(0.3, 1.5);
      for (const th of voices) {
        if (Math.random() < 0.5) continue;
        this._tg(th.osc.frequency, th.f0 * rnd(0.7, 1.8), rnd(0.2, 1));
        this._tg(th.F[0].frequency, rnd(400, 950), 0.4);
        this._tg(th.F[1].frequency, rnd(900, 1800), 0.4);
      }
    };
  },
};

// ------------------------------------------------------------------ 0.3.0 one shots
// Public names are SOUNDS_03 in biomes.js; '_' names are private (entities, places). opts.pitch scales the
// public ones (0.5..2).

const pitchOf = (o) => clamp(num(o && o.pitch, 1), 0.5, 2);
const FV = { a: [780, 1250, 2550], o: [480, 830, 2600], u: [330, 760, 2450], uh: [560, 1350, 2500], i: [300, 2250, 3000], e: [530, 1850, 2550] };

Object.assign(SEND, {
  scare: 0.35, lunge: 0.3, houndRush: 0.35, stealerTurn: 0.3, houndBark: 0.6, stealerCall: 0.9, smilerSeen: 0.4,
  facelingSeen: 0.2, facelingGone: 0.5, behind: 0.05, doorCreak: 0.7, splash: 0.5, steamHiss: 0.4, lampPop: 0.5,
  farRun: 0.9, placeFound: 0.8, alarmStart: 0.9, hordeNear: 0.8, blackoutStart: 0.7, blackoutEnd: 0.5, almond: 0.02,
  _drip: 1.2, _pipeKnock: 0.6, _shutter: 1, _board: 0.3, _gurgle: 0.8, _pulse: 0.25, _eHowl: 0.6,
});

Object.assign(AudioEngine.prototype, {
  // Room drops to near-silence the moment a big sound lands and stays down a little after it ends.
  _afterHit(t, len, hold) {
    if (!this.hitDuck) return;
    const g = this.hitDuck.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.03, t, 0.008);
    g.setTargetAtTime(1, t + len + (hold === undefined ? 1.2 : hold), 1.1);
    this._last.delete(g);
  },
});

const FOOT_CARPET = SFX._foot;

Object.assign(SFX, {
  // ---------------------------------------------------------------- footsteps per surface
  _foot(v, t, o, x) {
    const surf = x.surf || 'carpet';
    if (surf === 'carpet' || !FOOT[surf]) return FOOT_CARPET.call(this, v, t, o, x);
    const kind = x.kind || 'carpet';
    let g = (0.15 + 0.85 * (x.loud === undefined ? 0.5 : x.loud)) * rnd(0.85, 1.15);
    if (kind === 'crouch') g *= 0.45;
    if (kind === 'land') g *= 1.6;
    const boom = this._bq('peaking', 115, 1, 5);
    boom.connect(v.out); v.nodes.push(boom);
    return FOOT[surf].call(this, v, t, g, rnd(0.92, 1.08), boom, kind, x);
  },

  // ---------------------------------------------------------------- entity bodies
  _eStomp(v, t) {
    this._tone(v, t, 'sine', 58, 32, 0.2, 0.75, 0.002, 0.3);
    this._burst(v, t, 'bandpass', rnd(150, 220), 1.1, 4.5, 0.003, 0.22, null, this._pink);
    this._burst(v, t, 'lowpass', 500, 0.7, 0.4, 0.003, 0.12);
    this._gated(v, t + 0.01, rnd(0.05, 0.1), 'bandpass', rnd(550, 900), 1.5, 0.35, [0.004, 0.012]); // wet
    const s = this._burst(v, t + rnd(0.08, 0.16), 'lowpass', 900, 0.7, 0.35, 0.05, 0.35, null, this._brown); // drag of the foot
    s.fl.frequency.setTargetAtTime(500, t + 0.2, 0.1);
    return 0.8;
  },

  _eJoint(v, t) {
    let tt = t;
    const k = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < k; i++) {
      this._burst(v, tt, 'bandpass', rnd(2000, 4500), 2, rnd(0.4, 0.8), 0.0004, 0.012);
      tt += rnd(0.008, 0.028);
    }
    this._tone(v, t, 'sine', 190, 115, 0.03, 0.35, 0.001, 0.06);
    this._tone(v, tt, 'sine', 300, 900, 0.015, 0.12, 0.001, 0.03); // wet pop
    return tt - t + 0.2;
  },

  // Far howl: two throats a little apart, slow rise and fall, mostly heard through the reverb.
  _eHowlFar(v, t) {
    const dur = rnd(2.6, 4.2), f0 = rnd(150, 200);
    for (const [k, amp] of [[1, 0.45], [rnd(0.7, 0.76), 0.22]]) {
      this._voxOne(v, t + (k < 1 ? rnd(0.05, 0.25) : 0), {
        dur, amp, att: dur * 0.3, vib: 0.03, vibRate: rnd(4, 5.5), noise: 0.2, drive: 3, driveMix: 0.4,
        f: [[0, f0 * k], [dur * 0.35, f0 * 1.75 * k], [dur * 0.7, f0 * 1.9 * k], [dur, f0 * 1.15 * k]],
        F: [[0, FV.u], [dur * 0.35, FV.o], [dur * 0.65, FV.a], [dur, FV.u]],
      });
    }
    return dur + 0.6;
  },

  // The Howler's howl before a charge: a rattling inhale, then a tearing, rising shriek, cut dead.
  _eHowl(v, t) {
    this._gated(v, t, 0.32, 'bandpass', 700, 1.2, 0.6, [0.005, 0.015]);
    const t1 = t + 0.34, dur = 1.35;
    this._tone(v, t1, 'sine', 90, 30, 0.4, 0.8, 0.002, 0.6);
    for (const [k, amp] of [[1, 0.9], [1.06, 0.55], [0.5, 0.45]]) {
      this._voxOne(v, t1, {
        dur, amp, att: 0.03, cut: true, sus: 1, noise: 0.5, rough: 0.8, drive: 9, driveMix: 0.9,
        f: [[0, 150 * k], [0.45, 420 * k], [1.0, 560 * k], [dur, 470 * k]],
        F: [[0, [700, 1200, 2700]], [0.5, [900, 1600, 3000]], [dur, [850, 1450, 2900]]],
      });
    }
    const n = this._burst(v, t1, 'bandpass', 2500, 1.2, 0.5, 0.05, dur, null);
    n.fl.frequency.linearRampToValueAtTime(5000, t1 + dur);
    n.g.gain.setValueAtTime(0.3, t1 + dur - 0.03);
    n.g.gain.linearRampToValueAtTime(0, t1 + dur);
    this._afterHit(t1, dur, 0.9);
    return dur + 0.6;
  },

  _eShuffle(v, t) {
    this._burst(v, t, 'lowpass', 420, 0.7, 0.35, 0.005, 0.12);
    this._tone(v, t, 'sine', 80, 55, 0.05, 0.25, 0.003, 0.08);
    this._gated(v, t + 0.02, rnd(0.12, 0.25), 'highpass', 2400, 0.7, 0.25, [0.006, 0.02]);
    return 0.4;
  },

  _eRustle(v, t) {
    this._gated(v, t, rnd(0.25, 0.5), 'bandpass', rnd(2500, 4200), 0.8, 0.4, [0.005, 0.018]);
    return 0.6;
  },

  _eSlump(v, t) {
    this._gated(v, t, 0.35, 'bandpass', 3000, 0.8, 0.45, [0.005, 0.015]);
    this._tone(v, t + 0.12, 'sine', 70, 40, 0.1, 0.4, 0.004, 0.2);
    this._burst(v, t + 0.12, 'bandpass', 260, 1.2, 2.5, 0.004, 0.15, null, this._pink);
    this._burst(v, t + 0.2, 'bandpass', 1700, 1.2, 0.06, 0.05, 0.5); // air leaving the suit
    return 1;
  },

  _eValve(v, t, o, x) {
    if (!this._valveBuf) return 0.1;
    const s = this.ctx.createBufferSource();
    s.buffer = this._valveBuf;
    s.playbackRate.value = (x && x.rate) || rnd(0.85, 1);
    const g = this._gain(0.7);
    s.connect(g); g.connect(v.out);
    v.nodes.push(g);
    this._run(v, s, t, t + 0.06);
    return 0.1;
  },

  _eKnock1(v, t) {
    this._tone(v, t, 'sine', 160, 110, 0.03, 0.5, 0.001, 0.12);
    this._burst(v, t, 'bandpass', 320, 2.5, 0.7, 0.001, 0.06);
    this._burst(v, t, 'bandpass', rnd(550, 700), 2, 2.4, 0.001, 0.05, null, this._pink);
    return 0.5;
  },

  _eTeeth(v, t, o, x) {
    const n = (x && x.n) || 3;
    let tt = t;
    for (let i = 0; i < n; i++) {
      this._tone(v, tt, 'sine', rnd(3000, 5200), 0, 0, rnd(0.08, 0.16), 0.0005, 0.006);
      this._burst(v, tt, 'highpass', 3500, 0.7, 0.2, 0.0003, 0.003);
      tt += rnd(0.02, 0.07);
    }
    this._burst(v, tt + 0.03, 'bandpass', 800, 2, 0.4, 0.005, 0.03);
    this._tone(v, tt + 0.03, 'sine', 200, 520, 0.03, 0.08, 0.003, 0.03);
    return tt - t + 0.2;
  },

  _eGasp(v, t) {
    const n = this._burst(v, t, 'bandpass', 1300, 1, 0.5, 0.06, 0.4);
    n.fl.frequency.linearRampToValueAtTime(2200, t + 0.25);
    this._gated(v, t, 0.35, 'highpass', 1800, 0.7, 0.4, [0.004, 0.012]);
    return 0.7;
  },

  _eSkin(v, t) {
    const dur = rnd(0.3, 0.7);
    const o = this._osc('sawtooth', rnd(30, 70));
    o.frequency.linearRampToValueAtTime(rnd(20, 90), t + dur);
    const bp = this._bq('bandpass', rnd(500, 1200), 12), env = this._gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1.6, t + 0.05);
    env.gain.setValueAtTime(1.6, t + dur - 0.05);
    env.gain.linearRampToValueAtTime(0, t + dur);
    this._chain(o, env, bp, v.out);
    v.nodes.push(bp, env);
    this._run(v, o, t, t + dur + 0.02);
    this._gated(v, t, dur, 'highpass', 1500, 0.7, 0.35, [0.004, 0.012]);
    return dur + 0.3;
  },

  _eStep(v, t, o, x) {
    const surf = PLACE_STEP[this._domPlace()] || 'carpet';
    const d = SFX._foot.call(this, v, t, o, { kind: 'carpet', loud: 0.5, surf });
    if (x && x.drag) {
      const s = this._burst(v, t + 0.12, 'bandpass', rnd(800, 1400), 0.8, 0.25, 0.08, 0.3);
      s.fl.frequency.linearRampToValueAtTime(600, t + 0.45);
    }
    return Math.max(d, 0.6);
  },

  _eClaws(v, t, o, x) {
    const n = (x && x.n) || 2, span = (x && x.span) || 0.2, soft = x && (x.surf === 'carpet' || x.surf === 'rug');
    let tt = t;
    for (let i = 0; i < n; i++) {
      if (soft) {
        this._tone(v, tt, 'sine', 95, 60, 0.04, 0.3, 0.002, 0.05);
        this._burst(v, tt, 'bandpass', rnd(900, 1500), 1.5, 0.3, 0.0005, 0.01);
      } else {
        this._burst(v, tt, 'bandpass', rnd(3500, 6000), 2, 0.55, 0.0004, 0.006);
        this._tone(v, tt, 'sine', rnd(2200, 3400), 0, 0, 0.1, 0.0005, 0.012);
        this._tone(v, tt, 'sine', 110, 70, 0.03, 0.15, 0.002, 0.04);
      }
      tt += (span / n) * rnd(0.5, 1.5);
    }
    return span + 0.2;
  },

  _eSnarl(v, t) {
    const dur = rnd(0.6, 0.9);
    this._voxOne(v, t, {
      dur, amp: 0.5, att: 0.03, noise: 0.5, rough: 1, drive: 6, driveMix: 0.8,
      f: [[0, 110], [0.2, rnd(150, 180)], [dur, 115]],
      F: [[0, [650, 1150, 2600]], [0.25, [760, 1350, 2800]], [dur, [600, 1100, 2500]]],
    });
    this._gated(v, t, dur, 'highpass', 4000, 0.7, 0.25, [0.004, 0.012]);
    return dur + 0.3;
  },

  _eHuff(v, t) {
    this._burst(v, t, 'bandpass', 1100, 1.5, 0.6, 0.01, 0.15);
    this._gated(v, t, 0.12, 'bandpass', 700, 2, 0.4, [0.006, 0.014]);
    return 0.4;
  },

  // ---------------------------------------------------------------- place details
  _drip(v, t, o) {
    const P = pitchOf(o), f = rnd(900, 1700) * P;
    this._tone(v, t, 'sine', f, f * rnd(1.5, 1.9), 0.025, 0.3, 0.001, 0.07);
    this._burst(v, t, 'highpass', 4000, 0.7, 0.05, 0.0003, 0.003);
    return 0.3;
  },

  _pipeKnock(v, t) {
    const f = rnd(150, 320), k = 1 + ((Math.random() * 4) | 0);
    let tk = t;
    for (let i = 0; i < k; i++) {
      const a = i === 0 ? 1 : rnd(0.4, 0.9);
      [[1, 0.35, 0.45], [2.76, 0.22, 0.3], [5.4, 0.12, 0.18]].forEach(([r, d, amp]) => this._tone(v, tk, 'sine', f * r * rnd(0.998, 1.002), 0, 0, amp * a, 0.001, d));
      this._burst(v, tk, 'bandpass', 1800, 1.5, 0.35 * a, 0.0005, 0.012);
      tk += i === 0 ? rnd(0.15, 0.5) : rnd(0.12, 0.7);
    }
    return tk - t + 0.6;
  },

  _shutter(v, t) {
    const dur = rnd(1.2, 2.5);
    this._tone(v, t, 'sine', 70, 45, 0.3, 0.4, 0.004, 0.6);
    const r = this._gated(v, t, dur, 'bandpass', rnd(700, 1100), 2, 0.6, [0.015, 0.035]);
    r.fl.frequency.linearRampToValueAtTime(rnd(500, 800), t + dur);
    return dur + 0.4;
  },

  _board(v, t) {
    const dur = rnd(0.15, 0.45), f = rnd(280, 600);
    const o = this._osc('sawtooth', rnd(18, 40));
    o.frequency.linearRampToValueAtTime(rnd(25, 55), t + dur);
    const env = this._gain(0), bp = this._bq('bandpass', f, 8), bp2 = this._bq('bandpass', f * 2.3, 7), g2 = this._gain(0.4);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1.4, t + 0.03);
    env.gain.setValueAtTime(1.4, t + dur - 0.04);
    env.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(env); env.connect(bp); bp.connect(v.out); env.connect(bp2); bp2.connect(g2); g2.connect(v.out);
    v.nodes.push(env, bp, bp2, g2);
    this._run(v, o, t, t + dur + 0.02);
    this._burst(v, t + dur, 'bandpass', rnd(250, 400), 2, 2, 0.002, 0.06, null, this._pink);
    return dur + 0.3;
  },

  _gurgle(v, t) {
    let tt = t;
    const end = t + rnd(0.6, 1.5);
    while (tt < end) {
      const f = rnd(150, 420);
      this._tone(v, tt, 'sine', f, f * rnd(1.3, 2), 0.04, rnd(0.08, 0.2), 0.002, 0.05);
      tt += rnd(0.04, 0.18);
    }
    return tt - t + 0.3;
  },

  _pulse(v, t) {
    this._tone(v, t, 'sine', 62, 38, 0.12, 0.6, 0.002, 0.25);
    this._burst(v, t, 'lowpass', 300, 0.8, 0.3, 0.002, 0.1);
    this._burst(v, t, 'bandpass', 1800, 2, 0.04, 0.0005, 0.01);
    return 0.4;
  },

  // ---------------------------------------------------------------- SOUNDS_03

  stealerCall(v, t) { return this._speak(v, t, 'mimic'); },

  // The Skin-Stealer stops pretending: wet tearing, skin stretching, a voice that drops out of a human range.
  stealerTurn(v, t, o) {
    const P = pitchOf(o), dur = 1.25;
    this._gated(v, t, 0.55, 'lowpass', 1600, 0.7, 0.9, [0.003, 0.01]);
    this._gated(v, t + 0.05, 0.5, 'highpass', 2000, 0.7, 0.5, [0.003, 0.009]);
    SFX._eSkin.call(this, v, t + 0.1);
    this._tone(v, t, 'sine', 80 * P, 30, 0.6, 0.8, 0.003, 0.7);
    this._voxOne(v, t + 0.08, {
      dur, amp: 0.65, att: 0.02, cut: true, sus: 1, noise: 0.35, rough: 0.9, drive: 7, driveMix: 0.8,
      f: [[0, 230 * P], [0.3, 180 * P], [dur, 52 * P]],
      F: [[0, FV.a], [0.6, FV.uh], [dur, FV.u]],
    });
    this._afterHit(t, dur + 0.1, 1.2);
    return dur + 0.5;
  },

  houndBark(v, t, o) {
    const P = pitchOf(o), k = 1 + ((Math.random() * 3) | 0);
    let tt = t;
    for (let i = 0; i < k; i++) {
      const dur = rnd(0.15, 0.22), f = rnd(240, 290) * P;
      this._voxOne(v, tt, {
        dur, amp: 0.6, att: 0.008, cut: true, noise: 0.45, rough: 0.6, drive: 5, driveMix: 0.7,
        f: [[0, f], [dur * 0.3, f * 1.1], [dur, f * 0.72]],
        F: [[0, [700, 1300, 2600]], [dur, [580, 1100, 2450]]], Q: [4, 6, 7],
      });
      this._burst(v, tt, 'bandpass', 1000, 0.8, 0.4, 0.004, dur);
      tt += dur + rnd(0.18, 0.4);
    }
    return tt - t + 0.4;
  },

  // The Hound commits: a roaring snarl, claws scrabbling for grip, a bark at the end, then nothing.
  houndRush(v, t, o) {
    const P = pitchOf(o), dur = 0.95;
    this._voxOne(v, t, {
      dur, amp: 0.7, att: 0.015, cut: true, sus: 1, noise: 0.6, rough: 1, drive: 9, driveMix: 0.9,
      f: [[0, 120 * P], [0.3, 190 * P], [dur, 210 * P]],
      F: [[0, [600, 1100, 2500]], [0.4, [800, 1450, 2900]], [dur, [850, 1500, 3000]]],
    });
    let tt = t;
    while (tt < t + dur - 0.05) {
      this._burst(v, tt, 'bandpass', rnd(3500, 6000), 2, 0.7, 0.0004, 0.006);
      this._tone(v, tt, 'sine', 120, 70, 0.03, 0.3, 0.002, 0.04);
      tt += rnd(0.03, 0.08);
    }
    this._tone(v, t, 'sine', 70, 35, 0.3, 0.7, 0.003, 0.4);
    this._afterHit(t, dur, 1);
    return dur + 0.4;
  },

  // Seeing the Smiler: a slow wet breath in through teeth, and a glassy whine that rises a little.
  smilerSeen(v, t, o) {
    const P = pitchOf(o);
    const n = this._burst(v, t, 'bandpass', 2300 * P, 5, 0.35, 0.5, 0.6);
    n.fl.frequency.linearRampToValueAtTime(2700 * P, t + 0.9);
    this._burst(v, t, 'bandpass', 320 * P, 4, 0.5, 0.5, 0.5);
    this._gated(v, t + 0.1, 0.8, 'highpass', 2200, 0.7, 0.3, [0.01, 0.04]);
    for (const f of [6100, 6140]) this._tone(v, t + 0.2, 'sine', f * P, f * 1.06 * P, 1.6, 0.012, 0.6, 1.4);
    return 2.4;
  },

  // The Faceling: the room drops away.
  facelingSeen(v, t, o) {
    const P = pitchOf(o);
    this.hush(2, true);
    this._tone(v, t, 'sine', 58 * P, 42 * P, 2, 0.25, 0.3, 2);
    this._tone(v, t, 'sine', 7350, 7330, 2, 0.006, 0.4, 2.2);
    return 2.8;
  },

  facelingGone(v, t) {
    const n = this._burst(v, t, 'bandpass', 400, 1.2, 0.18, 0.5, 1, null, this._pink);
    n.fl.frequency.linearRampToValueAtTime(900, t + 1.2);
    if (this.hitDuck) { const g = this.hitDuck.gain; g.cancelScheduledValues(t); g.setTargetAtTime(1, t, 0.5); this._last.delete(g); }
    return 1.6;
  },

  // Something leaps: a whoosh that climbs into a shriek, a hit, then the room is gone.
  lunge(v, t, o) {
    const P = pitchOf(o);
    const w = this._burst(v, t, 'bandpass', 400, 1.1, 0.6, 0.22, 0.3);
    w.fl.frequency.exponentialRampToValueAtTime(3200, t + 0.25);
    this._voxOne(v, t + 0.06, {
      dur: 0.5, amp: 0.6, att: 0.02, cut: true, sus: 1, noise: 0.5, rough: 0.8, drive: 9, driveMix: 0.9,
      f: [[0, 300 * P], [0.3, 700 * P], [0.5, 640 * P]], F: [[0, FV.a], [0.5, [950, 1600, 3100]]],
    });
    this._tone(v, t + 0.22, 'sine', 100, 32, 0.3, 0.9, 0.002, 0.45);
    this._burst(v, t + 0.22, 'lowpass', 2500, 0.7, 0.7, 0.002, 0.2);
    this._afterHit(t, 0.6, 1.2);
    return 1.1;
  },

  // THE scare. Sub drop, a wide slam, a screeching cluster, metal tearing; cut dead after about a second.
  scare(v, t, o) {
    const P = pitchOf(o), end = t + 1.05;
    this._tone(v, t, 'sine', 110 * P, 28, 0.9, 0.95, 0.002, 1);
    this._burst(v, t, 'lowpass', 3000, 0.7, 0.9, 0.002, 0.3);
    this._burst(v, t, 'highpass', 2500, 0.7, 0.35, 0.001, 0.4);
    const bus = this._gain(1), bp = this._bq('bandpass', 2100, 0.7), sh = this._shaper(4), env = this._gain(0);
    this._chain(bus, bp, sh, env, v.out);
    v.nodes.push(bus, bp, sh, env);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.55, t + 0.004);
    env.gain.setTargetAtTime(0.32, t + 0.05, 0.25);
    env.gain.setValueAtTime(0.3, end - 0.03);
    env.gain.linearRampToValueAtTime(0, end);
    for (const f of [1180, 1251, 1330, 1874, 2493]) {
      const s = this._osc('sawtooth', f * P);
      s.frequency.setValueAtTime(f * P, t);
      s.frequency.exponentialRampToValueAtTime(f * P * rnd(0.86, 0.94), end);
      const g = this._gain(0.22);
      s.connect(g); g.connect(bus);
      v.nodes.push(g);
      this._run(v, s, t, end + 0.01);
    }
    const sc = this._gated(v, t + 0.05, 0.9, 'bandpass', 3600, 3, 0.9, [0.006, 0.02]);
    sc.fl.frequency.linearRampToValueAtTime(2400, end);
    this._afterHit(t, 1.05, 1.5);
    return 1.6;
  },

  // A breath, close, right behind you.
  behind(v, t, o) {
    const P = pitchOf(o);
    const n = this._burst(v, t + 0.05, 'bandpass', 1100 * P, 1.1, 0.35, 0.18, 0.75);
    n.fl.frequency.setTargetAtTime(700 * P, t + 0.3, 0.2);
    this._burst(v, t + 0.05, 'bandpass', 560 * P, 3, 0.4, 0.2, 0.6);
    this._gated(v, t + 0.1, 0.6, 'highpass', 2500, 0.7, 0.12, [0.01, 0.04]);
    return 1.2;
  },

  doorCreak(v, t, o) {
    const P = pitchOf(o), dur = rnd(0.9, 2), f = rnd(800, 1300) * P;
    const s = this._osc('sawtooth', rnd(14, 22));
    s.frequency.setValueAtTime(rnd(12, 20), t);
    s.frequency.linearRampToValueAtTime(rnd(30, 55), t + dur * rnd(0.3, 0.6));
    s.frequency.linearRampToValueAtTime(rnd(15, 25), t + dur);
    const env = this._gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1.8, t + 0.1);
    env.gain.setValueAtTime(1.8, t + dur - 0.15);
    env.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(env);
    for (const [r, q, g] of [[1, 10, 1], [1.9, 8, 0.6], [2.95, 9, 0.3]]) {
      const bp = this._bq('bandpass', f * r, q), gg = this._gain(g);
      bp.frequency.linearRampToValueAtTime(f * r * rnd(0.9, 1.15), t + dur);
      env.connect(bp); bp.connect(gg); gg.connect(v.out);
      v.nodes.push(bp, gg);
    }
    v.nodes.push(env);
    this._run(v, s, t, t + dur + 0.05);
    return dur + 0.5;
  },

  splash(v, t, o) {
    const P = pitchOf(o);
    const s = this._burst(v, t, 'bandpass', 2000 * P, 1, 0.6, 0.004, 0.25);
    s.fl.frequency.exponentialRampToValueAtTime(600 * P, t + 0.25);
    this._burst(v, t, 'lowpass', 450, 0.7, 0.5, 0.01, 0.35, null, this._brown);
    this._gated(v, t, 0.2, 'highpass', 3000, 0.7, 0.25, [0.004, 0.012]);
    const k = 3 + ((Math.random() * 4) | 0);
    for (let i = 0; i < k; i++) SFX._drip.call(this, v, t + rnd(0.08, 0.5), { pitch: P * rnd(0.8, 1.4) });
    return 0.9;
  },

  steamHiss(v, t, o) {
    const P = pitchOf(o), dur = rnd(0.5, 1.6);
    const s = this._loop(this._white), hp = this._bq('highpass', 2800 * P, 0.7), pk = this._bq('peaking', rnd(4000, 7000), 2, 6), g = this._gain(0);
    this._chain(s, hp, pk, g, v.out);
    v.nodes.push(hp, pk, g);
    g.gain.setValueAtTime(0, t);
    let tt = t;
    for (let i = 0; i < 3; i++) { g.gain.setValueAtTime(rnd(0.1, 0.35), tt); tt += rnd(0.02, 0.06); g.gain.setValueAtTime(0.02, tt); tt += rnd(0.02, 0.05); }
    g.gain.linearRampToValueAtTime(0.32, tt + 0.03);
    g.gain.setValueAtTime(0.3, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 0.08);
    this._run(v, s, t, t + dur + 0.4, rnd(0, 5));
    return dur + 0.5;
  },

  lampPop(v, t, o) {
    const P = pitchOf(o);
    this._burst(v, t, 'highpass', 2000, 0.7, 0.8, 0.0005, 0.02);
    this._tone(v, t, 'sine', 5200 * P, 0, 0, 0.25, 0.0005, 0.05);
    this._tone(v, t, 'sine', 140, 60, 0.05, 0.4, 0.001, 0.08);
    const k = 4 + ((Math.random() * 4) | 0);
    for (let i = 0; i < k; i++) this._tone(v, t + rnd(0.05, 0.5), 'sine', rnd(4000, 8000) * P, 0, 0, rnd(0.03, 0.08), 0.0005, 0.02);
    const b = this._osc(this._buzzWave, 120), bp = this._bq('bandpass', 1500, 0.7), g = this._gain(0);
    b.frequency.setValueAtTime(120, t);
    b.frequency.exponentialRampToValueAtTime(40, t + 0.35);
    g.gain.setValueAtTime(0.25, t + 0.01);
    g.gain.setTargetAtTime(0, t + 0.02, 0.1);
    this._chain(b, bp, g, v.out);
    v.nodes.push(bp, g);
    this._run(v, b, t, t + 0.5);
    return 0.8;
  },

  // Someone running, far away. Then they stop, or are stopped.
  farRun(v, t, o) {
    const P = pitchOf(o), n = 6 + ((Math.random() * 7) | 0);
    let tk = t, per = rnd(0.32, 0.4);
    for (let i = 0; i < n; i++) {
      const a = rnd(0.7, 1) * Math.min(1, (i + 1) / 3);
      this._tone(v, tk, 'sine', 110 * P, 60, 0.05, 0.5 * a, 0.002, 0.1);
      this._burst(v, tk, 'bandpass', rnd(260, 340) * P, 1.5, 4 * a, 0.003, 0.08, null, this._pink);
      this._burst(v, tk + 0.02, 'bandpass', rnd(900, 1400), 1.5, 0.8 * a, 0.004, 0.05, null, this._pink);
      per *= rnd(0.92, 0.99);
      tk += per;
    }
    return tk - t + 0.5;
  },

  // A new level found: three soft notes that do not resolve.
  placeFound(v, t, o) {
    const P = pitchOf(o), root = rnd(196, 247) * P;
    const shape = pick([[0, 1, 6], [0, 6, 5], [0, -1, -6], [0, 3, 2], [0, 8, 7]]);
    shape.forEach((s, i) => {
      const f = root * Math.pow(2, s / 12), tt = t + i * rnd(0.55, 0.7);
      this._tone(v, tt, 'triangle', f, f * 0.998, 1.5, 0.09, 0.03, 1.8);
      this._tone(v, tt, 'sine', f * 1.003, 0, 0, 0.06, 0.03, 1.6);
      this._tone(v, tt, 'sine', f * 2.002, 0, 0, 0.015, 0.02, 0.8);
    });
    return 3.8;
  },

  alarmStart(v, t, o) {
    const P = pitchOf(o);
    this._burst(v, t, 'bandpass', 2400, 4, 0.5, 0.0005, 0.02);
    this._tone(v, t, 'sine', 95, 60, 0.08, 0.5, 0.002, 0.2);
    const bus = this._gain(1), bp = this._bq('bandpass', 950, 1.4), sh = this._shaper(3);
    this._chain(bus, bp, sh, v.out);
    v.nodes.push(bus, bp, sh);
    for (let i = 0; i < 2; i++) {
      const tt = t + 0.15 + i * 1.05;
      for (const d of [1, 1.006]) {
        const s = this._osc('square', 300 * P * d), g = this._gain(0);
        s.frequency.setValueAtTime(300 * P * d, tt);
        s.frequency.exponentialRampToValueAtTime(640 * P * d, tt + 0.8);
        g.gain.setValueAtTime(0, tt);
        g.gain.linearRampToValueAtTime(0.18, tt + 0.04);
        g.gain.setValueAtTime(0.18, tt + 0.85);
        g.gain.linearRampToValueAtTime(0, tt + 0.9);
        s.connect(g); g.connect(bus);
        v.nodes.push(g);
        this._run(v, s, tt, tt + 0.95);
      }
    }
    return 2.5;
  },

  hordeNear(v, t, o) {
    const P = pitchOf(o), dur = 2.6;
    const s = this._loop(this._hordeTex(), rnd(0.9, 1.1) * P), lp = this._bq('lowpass', 600, 0.6), g = this._gain(0);
    this._chain(s, lp, g, v.out);
    v.nodes.push(lp, g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 0.3);
    lp.frequency.exponentialRampToValueAtTime(4500, t + dur);
    this._run(v, s, t, t + dur + 1.2, rnd(0, 3));
    const r = this._burst(v, t, 'lowpass', 120, 0.7, 0.9, dur, 0.8, null, this._brown);
    r.fl.frequency.linearRampToValueAtTime(300, t + dur);
    for (const f of [140, 197, 263]) {
      this._voxOne(v, t + rnd(0.5, 1.2), {
        dur: dur - 0.6, amp: 0.12, att: 1.2, noise: 0.4, drive: 5, rough: 0.6,
        f: [[0, f * P * 0.8], [dur - 0.6, f * P * 1.4]], F: [[0, FV.o], [dur - 0.6, FV.a]],
      });
    }
    return dur + 1.4;
  },

  blackoutStart(v, t, o) {
    const P = pitchOf(o);
    this._tone(v, t, 'sine', 80, 35, 0.3, 0.6, 0.002, 0.5);
    this._burst(v, t, 'bandpass', 700, 1.5, 2, 0.001, 0.07, null, this._pink);
    this._burst(v, t, 'bandpass', 2800, 5, 0.3, 0.0005, 0.015);
    const b = this._osc(this._buzzWave, 120 * P), bp = this._bq('bandpass', 1200, 0.7), g = this._gain(0);
    b.frequency.setValueAtTime(120 * P, t);
    b.frequency.exponentialRampToValueAtTime(28, t + 1.3);
    g.gain.setValueAtTime(0.3, t);
    g.gain.setTargetAtTime(0, t + 0.2, 0.35);
    this._chain(b, bp, g, v.out);
    v.nodes.push(bp, g);
    this._run(v, b, t, t + 1.6);
    this._tone(v, t, 'sine', 3200, 180, 1.2, 0.02, 0.01, 1.3);
    return 2;
  },

  blackoutEnd(v, t, o) {
    const P = pitchOf(o);
    this._tone(v, t, 'sine', 95, 60, 0.08, 0.5, 0.002, 0.2);
    this._burst(v, t, 'bandpass', 700, 1.5, 1.8, 0.001, 0.07, null, this._pink);
    let tt = t + 0.12;
    for (let i = 0; i < 3 + ((Math.random() * 4) | 0); i++) {
      this._tone(v, tt, 'sine', rnd(4200, 6200), 0, 0, 0.08, 0.0005, 0.04);
      this._burst(v, tt, 'highpass', 3000, 0.7, 0.1, 0.0003, 0.008);
      tt += rnd(0.05, 0.18);
    }
    const b = this._osc(this._buzzWave, 60 * P), bp = this._bq('bandpass', 1500, 0.7), g = this._gain(0);
    b.frequency.setValueAtTime(60 * P, tt);
    b.frequency.exponentialRampToValueAtTime(120 * P, tt + 0.4);
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(0.2, tt + 0.3);
    g.gain.setTargetAtTime(0, tt + 0.45, 0.2);
    this._chain(b, bp, g, v.out);
    v.nodes.push(bp, g);
    this._run(v, b, tt, tt + 1.4);
    return tt - t + 1.5;
  },

  // Almond Water: a couple of small sips, a swallow, and a long easy exhale through the mask.
  almond(v, t, o) {
    const P = pitchOf(o);
    let tk = t + 0.05;
    const n = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) {
      this._gated(v, tk, rnd(0.12, 0.2), 'bandpass', 1200 * P, 1.5, 0.25, [0.005, 0.015]);
      this._tone(v, tk + 0.05, 'sine', 300 * P, 500 * P, 0.05, 0.12, 0.003, 0.05);
      tk += rnd(0.28, 0.4);
    }
    this._tone(v, tk, 'sine', 90, 60, 0.06, 0.28, 0.004, 0.09);
    this._burst(v, tk, 'lowpass', 600, 0.7, 0.2, 0.008, 0.08);
    const te = tk + 0.35;
    const ex = this._burst(v, te, 'bandpass', 950, 0.9, 0.16, 0.25, 1.3);
    ex.fl.frequency.setTargetAtTime(650, te + 0.3, 0.4);
    SFX._eValve.call(this, v, te - 0.01, o, { rate: 0.92 });
    return te - t + 1.8;
  },
});

// Footsteps per surface: (v, t, gain, pitch, dest, kind, extra) -> length.
const FOOT = {
  rug(v, t, g, p, boom, kind) {
    this._tone(v, t, 'sine', 85 * p, 52 * p, 0.05, 0.28 * g, 0.003, 0.09, boom);
    this._burst(v, t, 'lowpass', 380 * p, 0.7, 0.4 * g, 0.004, 0.08, boom);
    this._burst(v, t, 'bandpass', rnd(200, 280) * p, 1.2, 2 * g, 0.004, 0.07, boom, this._pink);
    if (Math.random() < 0.25 && kind !== 'crouch') SFX._board.call(this, v, t + rnd(0.04, 0.12));
    if (kind === 'land') this._tone(v, t, 'sine', 70 * p, 35, 0.12, 0.6 * g, 0.002, 0.25, boom);
    return 0.6;
  },

  tile(v, t, g, p, boom, kind) {
    this._tone(v, t, 'sine', 120 * p, 75 * p, 0.04, 0.3 * g, 0.001, 0.07, boom);
    this._burst(v, t, 'bandpass', rnd(2600, 3600) * p, 2.5, 0.55 * g, 0.0005, 0.012, boom); // heel click
    this._tone(v, t, 'sine', rnd(1800, 2600) * p, 0, 0, 0.04 * g, 0.0005, 0.03, boom); // tile ring
    const tt = t + rnd(0.05, 0.08);
    this._burst(v, tt, 'bandpass', rnd(3000, 4200) * p, 3, 0.3 * g, 0.0005, 0.01, boom); // toe
    this._burst(v, t, 'bandpass', rnd(500, 700) * p, 1.5, 1.4 * g, 0.002, 0.04, boom, this._pink);
    if (kind === 'land') this._tone(v, t, 'sine', 80 * p, 40, 0.1, 0.7 * g, 0.002, 0.2, boom);
    return 0.4;
  },

  concrete(v, t, g, p, boom, kind) {
    this._tone(v, t, 'sine', 100 * p, 60 * p, 0.05, 0.32 * g, 0.002, 0.08, boom);
    this._burst(v, t, 'bandpass', rnd(650, 950) * p, 1.6, 1.6 * g, 0.002, 0.05, boom, this._pink);
    this._burst(v, t, 'lowpass', 700 * p, 0.7, 0.35 * g, 0.002, 0.06, boom);
    this._gated(v, t + 0.02, rnd(0.04, 0.09), 'highpass', 3500, 0.7, 0.22 * g, [0.002, 0.008], boom); // grit
    if (kind === 'land') this._tone(v, t, 'sine', 75 * p, 35, 0.12, 0.8 * g, 0.002, 0.25, boom);
    return 0.4;
  },

  metal(v, t, g, p, boom, kind) {
    const f = rnd(260, 420) * p;
    this._tone(v, t, 'sine', 110 * p, 70, 0.04, 0.3 * g, 0.001, 0.08, boom);
    [[1, 0.18, 0.12], [2.41, 0.12, 0.08], [3.87, 0.08, 0.05], [5.33, 0.05, 0.03]].forEach(([r, d, a]) =>
      this._tone(v, t, 'sine', f * r * rnd(0.99, 1.01), 0, 0, a * g, 0.001, d * (kind === 'land' ? 2 : 1), boom));
    this._burst(v, t, 'bandpass', rnd(1800, 2800), 2, 0.4 * g, 0.0005, 0.015, boom);
    if (Math.random() < 0.4) this._gated(v, t + 0.03, 0.08, 'bandpass', rnd(1200, 2000), 4, 0.2 * g, [0.008, 0.02], boom); // grate rattle
    return 0.5;
  },

  // Wading: deeper and faster splashes more.
  water(v, t, g, p, boom, kind, x) {
    const depth = clamp(num(x.depth, 0.2) / 0.9);
    const s = this._burst(v, t, 'bandpass', 1800 * p, 1, (0.25 + 0.35 * depth) * g, 0.006, 0.18 + 0.2 * depth, boom);
    s.fl.frequency.exponentialRampToValueAtTime(600 * p, t + 0.2 + 0.2 * depth);
    this._burst(v, t, 'lowpass', 380, 0.7, (0.15 + 0.6 * depth) * g, 0.03, 0.25 + 0.35 * depth, boom, this._brown); // slosh
    this._gated(v, t, 0.12 + 0.15 * depth, 'highpass', 2800, 0.7, (0.12 + 0.15 * depth) * g, [0.004, 0.012], boom);
    const k = 1 + ((Math.random() * (2 + 4 * depth)) | 0);
    for (let i = 0; i < k; i++) SFX._drip.call(this, v, t + rnd(0.06, 0.35), { pitch: rnd(0.8, 1.4) });
    if (depth < 0.3) this._tone(v, t, 'sine', rnd(1800, 2600) * p, 0, 0, 0.03 * g, 0.0005, 0.03, boom); // tile under the water
    return 0.7 + 0.3 * depth;
  },
};
