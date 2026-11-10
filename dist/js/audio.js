// LEVEL 0 sound engine.
// Fully procedural WebAudio: no audio files, no libraries. Everything here is synthesized at runtime.
// Signal flow:
//   sources -> mix -> hood coloration (box bump + 9.5k lowpass) -> death lowpass -> pause duck
//           -> compressor -> limiter -> master -> speakers
//   reverb send bus -> predelay -> one ConvolverNode (4 channel IR: short + long tails, crossfaded by s.room) -> mix
//   UI sounds skip the hood, the death filter and the pause duck.

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
    this._s = { hum: 0.6, room: 0.4, exertion: 0, fear: 0, sanity: 1, dark: 0, blackout: 0, dead: false };
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
    this._distT = rnd(15, 40);
    this._sanT = rnd(8, 20);
    this._curves = {};
    this._tex = {};
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
      if (this._ready) this._tg(this.pauseG.gain, this._paused ? 0.03 : 1, 0.25);
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
      this._beds(now, st);
      this._breathTick(now, st);
      this._heartTick(now, st);
      this._events(dt, st);
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
    try { w.oversample = '2x'; } catch (e) { /* ignore */ }
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
    this._tg(sp.sg.gain, this._sendFor(sp.send, d), 0.1);
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
    this._chain(this.mix, box, box2, hoodLP, this.deadLP, this.pauseG, comp, lim, this.masterG, c.destination);
    this.uiBus = this._gain(0.8);
    this.uiBus.connect(comp);

    // Listener up vector is fixed.
    try {
      const l = c.listener;
      if (l.upX) { l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0; }
    } catch (e) { /* ignore */ }

    const parts = [this._buildReverb, this._buildHum, this._buildRoom, this._buildBreath, this._buildHeart,
      this._buildDrones, this._buildSuit, this._buildTinnitus];
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
    this._white = mk(2, (d) => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }, false);
    this._pink = mk(4, (d) => {
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
    this._brown = mk(4, (d) => {
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
    this._glotWave = this._mkWave(48, (n) => 1 / Math.pow(n, 1.45), true);
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
    this.preDelay = c.createDelay(0.2);
    this.preDelay.delayTime.value = 0.012;
    this.revIn.connect(this.preDelay);
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
      this.revIn.connect(dl); dl.connect(g); g.connect(erM, 0, ch);
    }
    this.erG = this._gain(0.2);
    this._chain(erM, this._bq('lowpass', 3200, 0.5), this.erG, this.mix);
  }

  _buildHum() {
    const c = this.ctx;
    const m = c.createChannelMerger(2);
    this._humOsc = [];
    const add = (type, f, g, chs) => {
      const o = this._osc(type, f), gn = this._gain(g);
      o.connect(gn);
      for (const ch of chs) gn.connect(m, 0, ch);
      o.start();
      this._humOsc.push(o);
      return o;
    };
    // Detuned pairs per ear give a very slow beating that wanders between the ears.
    add(this._humWave, 60.0, 0.5, [0]);
    add(this._humWave, 60.035, 0.5, [1]);
    add('sine', 119.93, 0.3, [0]);
    add('sine', 120.07, 0.3, [1]);
    add('sine', 180.04, 0.06, [0, 1]);
    add('sine', 239.9, 0.05, [0]);
    add('sine', 240.12, 0.05, [1]);

    // Ballast buzz: rich 120 Hz, bandpassed into the kHz range, fluttering slowly.
    const buzz = add(this._buzzWave, 120, 1, []);
    buzz.disconnect();
    const buzzAM = this._gain(0.6), buzzG = this._gain(0.3);
    this._chain(buzz, this._bq('bandpass', 2300, 0.55), buzzAM, buzzG);
    buzzG.connect(m, 0, 0);
    const bd = c.createDelay(0.01);
    bd.delayTime.value = 0.0007;
    buzzG.connect(bd); bd.connect(m, 0, 1);
    for (const [f, d] of [[0.71, 0.22], [0.113, 0.18], [3.3, 0.05]]) {
      const l = this._osc('sine', f), lg = this._gain(d);
      l.connect(lg); lg.connect(buzzAM.gain); l.start();
    }

    // Tube hiss, decorrelated per ear.
    for (const ch of [0, 1]) {
      const n = this._loop(this._white), g = this._gain(0.03);
      this._chain(n, this._bq('bandpass', 5200 + ch * 400, 0.5), g);
      g.connect(m, 0, ch);
      n.start(0, rnd(0, 1.9));
    }

    this.humLP = this._bq('lowpass', 7000, 0.5);
    const wob = this._gain(1);
    const wl = this._osc('sine', 0.09), wg = this._gain(0.04);
    wl.connect(wg); wg.connect(wob.gain); wl.start();
    this.humG = this._gain(0);
    this._chain(m, this.humLP, wob, this.humG, this.mix);
    const hs = this._gain(0.12);
    this.humG.connect(hs); hs.connect(this.revIn);
  }

  _buildRoom() {
    const c = this.ctx;
    // Brown noise air, two offsets of the same loop for width.
    const m = c.createChannelMerger(2);
    for (const ch of [0, 1]) {
      const n = this._loop(this._brown);
      n.connect(m, 0, ch);
      n.start(0, rnd(0, 3.9));
    }
    this.roomPeak = this._bq('peaking', 380, 4, 0);
    this.roomG = this._gain(0.05);
    this._chain(m, this._bq('lowpass', 280, 0.6), this.roomPeak, this.roomG, this.mix);

    // Far ventilation rumble, breathing very slowly.
    const v = this._loop(this._pink);
    const vAM = this._gain(0.75);
    const vl = this._osc('sine', 0.047), vlg = this._gain(0.25);
    vl.connect(vlg); vlg.connect(vAM.gain); vl.start();
    this.ventG = this._gain(0.04);
    this._chain(v, this._bq('bandpass', 85, 0.8), vAM, this.ventG, this.mix);
    const vs = this._gain(0.5);
    this.ventG.connect(vs); vs.connect(this.revIn);
    v.start(0, rnd(0, 3.9));

    // A thin whistle somewhere in the ducts, barely there.
    const w = this._loop(this._pink);
    const wAM = this._gain(0.5);
    const wl = this._osc('sine', 0.031), wlg = this._gain(0.5);
    wl.connect(wlg); wlg.connect(wAM.gain); wl.start();
    this.ductG = this._gain(0.006);
    this._chain(w, this._bq('bandpass', 1380, 28), wAM, this.ductG, this.mix);
    const ws = this._gain(0.6);
    this.ductG.connect(ws); ws.connect(this.revIn);
    w.start(0, rnd(0, 3.9));
  }

  _buildBreath() {
    // Breath noise through the filter cartridge and the mask cavity.
    const n = this._loop(this._white);
    this.bAir = this._bq('bandpass', 1300, 0.9);
    const mask = this._bq('peaking', 1150, 3, 8);
    const boom = this._bq('peaking', 170, 1, 4);
    this.bLP = this._bq('lowpass', 4500, 0.6);
    this.bAM = this._gain(1);
    this.bG = this._gain(0);
    this._chain(n, this.bAir, mask, boom, this.bLP, this.bAM, this.bG, this.mix);
    n.start(0, rnd(0, 1.9));
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
    this._chain(this.hbOsc, this.hbG, this._bq('lowpass', 150, 0.7), this.mix);
    this.hbOsc.start();
  }

  _buildDrones() {
    // Fear: low beating saw drone.
    const fLP = this._bq('lowpass', 150, 1.5);
    this.fearG = this._gain(0);
    for (const [t, f] of [['sawtooth', 41.2], ['sawtooth', 41.75], ['sine', 55]]) {
      const o = this._osc(t, f);
      o.connect(fLP); o.start();
    }
    this._chain(fLP, this.fearG, this.mix);

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
    this._chain(sLP, this.sanG, this.mix);
    const ss = this._gain(0.6);
    this.sanG.connect(ss); ss.connect(this.revIn);
  }

  _buildSuit() {
    const n = this._loop(this._white);
    this.suitG = this._gain(0.004);
    this._chain(n, this._bq('bandpass', 3400, 0.5), this.suitG, this.mix);
    n.start(0, rnd(0, 1.9));
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
    const ins = clamp((0.5 - st.sanity) / 0.5);

    if (this.humG) {
      const lvl = 0.11 * st.hum * (1 - st.blackout) * (1 - 0.78 * st.dark) * alive;
      const tc = st.dead ? 1.2 : st.blackout > 0.05 ? 0.07 : 0.35;
      this._tg(this.humG.gain, lvl, tc);
      // Power sag as the lights are forced off.
      const det = -380 * st.blackout;
      for (const o of this._humOsc) this._tg(o.detune, det, 0.12);
      this._tg(this.humLP.frequency, 7000 - 3600 * st.dark, 0.4);
    }
    if (this.roomG) {
      this._tg(this.roomG.gain, (0.045 + 0.045 * st.dark) * (st.dead ? 0.4 : 1), 0.6);
      this._tg(this.roomPeak.gain, 11 * st.dark, 0.8);
      this._tg(this.ventG.gain, 0.04 * (1 - 0.35 * st.dark) * (st.dead ? 0.3 : 1), 0.8);
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
    if (this.suitG) this._tg(this.suitG.gain, (0.004 + 0.009 * st.exertion) * alive, 0.5);
    if (this.fearG) this._tg(this.fearG.gain, 0.06 * st.fear * st.fear * alive, 0.5);
    if (this.sanG) {
      this._tg(this.sanG.gain, 0.05 * ins * alive, 1.2);
      this._tg(this.sanDet.gain, 15 + 70 * ins, 1);
      this._tg(this.sanDet2.gain, 18 + 90 * ins, 1);
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

  _breathTick(now, s) {
    const b = this._br;
    if (!this.bG) return;
    if (s.dead) {
      if (!b.off) {
        this.bG.gain.cancelScheduledValues(now);
        this.bG.gain.setTargetAtTime(0, now, 0.1);
        b.off = true;
      }
      b.next = now + 1.5;
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
    const pIn = (0.14 + 0.3 * drive) * depth;
    const pEx = (0.17 + 0.36 * drive) * depth * rnd(0.85, 1.1);
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
    const lvl = smoothstep(0.35, 1, s.fear) * (s.dead ? 0 : 1);
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

  _events(dt, st) {
    if (st.dead) return;
    const ins = clamp((0.5 - st.sanity) / 0.5);
    this._distT -= dt;
    if (this._distT <= 0) {
      this._distT = rnd(20, 90) * (0.35 + 0.65 * st.sanity);
      this._distant(st);
    }
    if (ins > 0) {
      this._sanT -= dt;
      if (this._sanT <= 0) {
        this._sanT = rnd(5, 18) * (1.15 - ins);
        this._sanityEvent(ins);
      }
    }
  }

  _distant(st) {
    const L = this._L, a = rnd(0, TAU), d = rnd(22, 55);
    const pos = [L.x + Math.cos(a) * d, L.y + rnd(-1, 2.5), L.z + Math.sin(a) * d];
    if (Math.random() < 0.12 + 0.3 * (1 - st.sanity)) {
      this._whisperAt(pos, pick(['murmur', 'murmur', 'call', 'cry', 'laugh']), false, 0.8);
      return;
    }
    const name = pick(['_thud', '_thud', 'doorSlam', '_drag', '_pipe', '_pipe']);
    this._shot(name, { pos, vol: rnd(0.5, 0.9) });
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

  _voice(o) {
    const c = this.ctx;
    if (!c || c.state === 'closed') return null;
    if (this._active >= MAX_VOICES && !(o.prio && this._active < MAX_VOICES + 6)) return null;
    const v = { nodes: [], srcs: 0, done: false, timer: 0 };
    v.out = this._gain(1);
    v.nodes.push(v.out);
    if (o.ui) {
      v.out.connect(this.uiBus);
    } else if (o.pos) {
      const [x, y, z] = o.pos;
      const d = this._dist(x, y, z);
      const lp = this._bq('lowpass', this._lpFor(d), 0.5);
      const p = this._panner(!!o.hrtf);
      const sg = this._gain(this._sendFor(o.send || 0, d));
      v.out.connect(lp); lp.connect(p); p.connect(this.mix);
      lp.connect(sg); sg.connect(this.revIn);
      this._setPos(p, x, y, z, false);
      v.nodes.push(lp, p, sg);
    } else {
      v.out.connect(this.mix);
      if (o.send > 0) {
        const sg = this._gain(o.send);
        v.out.connect(sg); sg.connect(this.revIn);
        v.nodes.push(sg);
      }
    }
    this._active++;
    return v;
  }

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
    this._active = Math.max(0, this._active - 1);
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
    if (!fn || !this._ready) return;
    o = o || {};
    let pos = null;
    if (Array.isArray(o.pos) && o.pos.length >= 3) pos = [num(o.pos[0], 0), num(o.pos[1], 0), num(o.pos[2], 0)];
    if (!pos && name === 'apparition') {
      const L = this._L;
      pos = [L.x - L.fx * 3, L.y + 0.1, L.z - L.fz * 3];
    }
    const v = this._voice({
      prio: PRIO.has(name) || (extra && extra.prio),
      pos,
      send: SEND[name] !== undefined ? SEND[name] : 0.15,
      ui: name.startsWith('ui'),
      hrtf: !!(extra && extra.hrtf),
    });
    if (!v) return;
    v.out.gain.value = clamp(num(o.vol, 1), 0, 2);
    let dur = 1;
    try {
      dur = fn.call(this, v, this.ctx.currentTime + 0.006, o, extra) || 1;
    } catch (e) {
      this._err(e);
    }
    this._finish(v, dur);
  }

  play(name, opts) {
    if (!this._ready || typeof name !== 'string' || name[0] === '_') return;
    try { this._shot(name, opts); } catch (e) { this._err(e); }
  }

  footstep(kind, loud) {
    if (!this._ready) return;
    try {
      const k = kind === 'stair' || kind === 'crouch' || kind === 'land' ? kind : 'carpet';
      this._shot('_foot', { vol: 1 }, { kind: k, loud: clamp(num(loud, 0.5)) });
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

  _whisperAt(pos, kind, prio, vol, send) {
    const d = this._dist(pos[0], pos[1], pos[2]);
    const sendAmt = send !== undefined ? send : d < 2.5 ? 0.25 : 1.1;
    const v = this._voice({ prio, pos, send: sendAmt, hrtf: true });
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

  entity(id, type, x, y, z, s) {
    if (!this._ready) return;
    try {
      s = s || {};
      let e = this._ents.get(id);
      if (e && e.type !== type) { this.removeEntity(id); e = null; }
      if (!e) {
        if (this._ents.size >= MAX_ENTITIES) return;
        if (type !== 'longarm' && type !== 'hollow' && type !== 'biter') return;
        e = this._entMake(type);
        if (!e) return;
        this._ents.set(id, e);
      }
      this._spSet(e.sp, x, y, z);
      e.update(s);
    } catch (err) { this._err(err); }
  }

  removeEntity(id) {
    if (!this._ready) return;
    try {
      const e = this._ents.get(id);
      if (!e) return;
      this._ents.delete(id);
      e.out.gain.cancelScheduledValues(this.ctx.currentTime);
      e.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      setTimeout(() => this._dispose(e), 600);
    } catch (err) { this._err(err); }
  }

  _dispose(e) {
    for (const s of e.srcs) { try { s.stop(); } catch (x) { /* ignore */ } }
    for (const n of e.nodes.concat(e.sp ? e.sp.nodes : [])) { try { n.disconnect(); } catch (x) { /* ignore */ } }
    e.nodes.length = 0; e.srcs.length = 0;
  }

  _entMake(type) {
    const e = { type, nodes: [], srcs: [], wt: 0, vol: 1 };
    const N = (n) => { e.nodes.push(n); return n; };
    const S = (src, off) => { e.srcs.push(src); e.nodes.push(src); src.start(0, off || 0); return src; };
    const SO = (o) => { e.srcs.push(o); e.nodes.push(o); o.start(); return o; };
    e.sp = this._spMake(true, type === 'hollow' ? 0.3 : 0.6);
    e.out = N(this._gain(0));
    e.out.connect(e.sp.lp);
    e.out.gain.setTargetAtTime(1, this.ctx.currentTime, 0.12);

    if (type === 'longarm') {
      this._texture('clicks');
      this._texture('drag');
      // Wet clicking.
      const clicks = S(N(this._loop(this._tex.clicks)), rnd(0, 2));
      const clickG = N(this._gain(0));
      this._chain(clicks, N(this._bq('highpass', 380, 0.7)), clickG, e.out);
      // Dragging along the carpet.
      const drag = S(N(this._loop(this._tex.drag)), rnd(0, 3));
      const dragG = N(this._gain(0));
      this._chain(drag, N(this._bq('lowpass', 1800, 0.6)), dragG, e.out);
      // Throaty moan: glottal source + throat noise -> formants, with a growl AM and drive for the shriek.
      const moan = SO(N(this._osc(this._glotWave, 72)));
      const jit = S(N(this._loop(this._brown, 0.3)), rnd(0, 3));
      const jg = N(this._gain(7));
      jit.connect(jg); jg.connect(moan.frequency);
      const mIn = N(this._gain(1));
      moan.connect(mIn);
      const thr = S(N(this._loop(this._white)), rnd(0, 1.5));
      this._chain(thr, N(this._bq('bandpass', 520, 0.8)), N(this._gain(0.3)), mIn);
      const mSum = N(this._gain(1));
      const F1 = N(this._bq('bandpass', 430, 5)), F2 = N(this._bq('bandpass', 950, 6)), F3 = N(this._bq('bandpass', 2700, 7));
      const g3 = N(this._gain(0.1));
      this._chain(mIn, F1, N(this._gain(1)), mSum);
      this._chain(mIn, F2, N(this._gain(0.5)), mSum);
      this._chain(mIn, F3, g3, mSum);
      const am = N(this._gain(0.85)), dry = N(this._gain(1)), wet = N(this._gain(0));
      this._chain(mSum, dry, am);
      this._chain(mSum, N(this._shaper(6)), wet, am);
      const gl = SO(N(this._osc('sine', 31))), glg = N(this._gain(0.15));
      gl.connect(glg); glg.connect(am.gain);
      const swell = N(this._gain(0.5)), moanG = N(this._gain(0));
      this._chain(am, swell, moanG, e.out);
      e.chase = 0;
      e.update = (s) => {
        const c = clamp(num(s.chase, 0)), vol = clamp(num(s.vol, 1), 0, 2);
        e.chase = c;
        this._tg(clickG.gain, 0.55 * vol * (0.6 + 0.5 * c), 0.2);
        this._tg(clicks.playbackRate, 1 + 0.6 * c, 0.3);
        this._tg(dragG.gain, 0.4 * vol * (1 - 0.5 * c), 0.3);
        this._tg(moanG.gain, 0.4 * vol * (0.5 + 0.9 * c), 0.25);
        this._tg(g3.gain, 0.1 + 0.8 * c, 0.2);
        this._tg(wet.gain, c * 0.9, 0.2);
        this._tg(dry.gain, 1 - 0.7 * c, 0.2);
        this._tg(glg.gain, 0.15 + 0.5 * c, 0.2);
      };
      e.tick = () => {
        const c = e.chase;
        e.wt = rnd(0.4, 1.8) * (1 - 0.6 * c);
        this._tg(moan.frequency, (70 + 170 * c) * rnd(0.85, 1.18), 0.25 - 0.15 * c);
        this._tg(swell.gain, Math.max(rnd(0.1, 1), 0.6 * c), 0.35);
        this._tg(F1.frequency, rnd(350, 600) * (1 + 0.4 * c), 0.2);
        this._tg(F2.frequency, rnd(800, 1300) + 700 * c, 0.2);
        this._tg(drag.playbackRate, rnd(0.8, 1.2), 0.4);
      };
    } else if (type === 'hollow') {
      this._texture('creak');
      // Faint respirator hiss with nobody breathing through it, and fabric creak when it moves.
      const hiss = S(N(this._loop(this._white)), rnd(0, 1.5));
      const hAM = N(this._gain(0.6));
      const hl = SO(N(this._osc('sine', 0.21))), hlg = N(this._gain(0.4));
      hl.connect(hlg); hlg.connect(hAM.gain);
      const hissG = N(this._gain(0));
      this._chain(hiss, N(this._bq('bandpass', 1700, 1.2)), hAM, hissG, e.out);
      const creak = S(N(this._loop(this._tex.creak)), rnd(0, 3));
      const creakG = N(this._gain(0));
      this._chain(creak, creakG, e.out);
      e.mv = 0;
      e.update = (s) => {
        const m = clamp(num(s.moving, 0)), vol = clamp(num(s.vol, 1), 0, 2);
        e.mv = m;
        this._tg(hissG.gain, 0.05 * vol * (0.35 + 0.65 * m), 0.4);
        this._tg(creakG.gain, 0.55 * vol * m, m > 0.05 ? 0.06 : 0.15);
      };
      e.tick = () => {
        e.wt = rnd(1, 3);
        this._tg(creak.playbackRate, rnd(0.85, 1.15), 0.5);
        this._tg(hl.frequency, rnd(0.15, 0.3), 1);
      };
    } else if (type === 'biter') {
      // Sub throb.
      const sub = SO(N(this._osc('sine', 36)));
      const sAM = N(this._gain(0.5));
      const sl = SO(N(this._osc('sine', 1.6))), slg = N(this._gain(0.5));
      sl.connect(slg); slg.connect(sAM.gain);
      const subG = N(this._gain(0));
      this._chain(sub, sAM, subG, e.out);
      // Dying electrical whine.
      const wh = SO(N(this._osc('sawtooth', 4800)));
      const wAM = N(this._gain(0.6));
      const wl = SO(N(this._osc('sine', 13))), wlg = N(this._gain(0.4));
      wl.connect(wlg); wlg.connect(wAM.gain);
      const whG = N(this._gain(0));
      this._chain(wh, N(this._bq('bandpass', 4200, 5)), wAM, whG, e.out);
      // Crackle, gated in tick().
      const cr = S(N(this._loop(this._white)), rnd(0, 1.5));
      const crG = N(this._gain(0)), crAmt = N(this._gain(0));
      this._chain(cr, N(this._bq('highpass', 2600, 0.7)), crG, crAmt, e.out);
      e.near = 0; e.wf = rnd(4500, 6000);
      e.update = (s) => {
        const n = clamp(num(s.near, 0)), vol = clamp(num(s.vol, 1), 0, 2);
        e.near = n;
        this._tg(subG.gain, 0.7 * vol * (0.35 + 0.65 * n), 0.3);
        this._tg(sl.frequency, 1.2 + 3 * n, 0.5);
        this._tg(whG.gain, 0.03 * vol * (0.3 + 0.7 * n), 0.3);
        this._tg(crAmt.gain, 0.25 * vol * (0.2 + 0.8 * n), 0.2);
      };
      e.tick = () => {
        e.wt = rnd(0.08, 0.35);
        e.wf -= rnd(20, 140);
        if (e.wf < 2200) e.wf = rnd(4500, 6200);
        this._tg(wh.frequency, e.wf * rnd(0.98, 1.02), 0.15);
        const t = this.ctx.currentTime + 0.01, k = 1 + ((Math.random() * 4) | 0);
        for (let i = 0; i < k; i++) {
          const ti = t + rnd(0, 0.3);
          crG.gain.setValueAtTime(rnd(0.3, 1), ti);
          crG.gain.setTargetAtTime(0, ti + 0.002, 0.004);
        }
      };
    }
    return e;
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

  uiHover(v, t) {
    this._burst(v, t, 'bandpass', 3200, 5, 0.1, 0.0005, 0.012);
    return 0.05;
  },
  uiClick(v, t) {
    this._burst(v, t, 'bandpass', 2400, 4, 0.3, 0.0005, 0.02);
    this._tone(v, t, 'sine', 220, 140, 0.04, 0.22, 0.001, 0.05);
    return 0.1;
  },
  uiBack(v, t) {
    this._burst(v, t, 'bandpass', 1800, 4, 0.22, 0.0005, 0.02);
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
      this._burst(v, tk, 'bandpass', 1800, 2, 0.2, 0.0005, 0.014);
      tk += rnd(0.26, 0.34) + (k === 1 ? rnd(0, 0.08) : 0);
    }
    return tk - t + 0.3;
  },

  doorSlam(v, t) {
    this._tone(v, t, 'sine', 65, 40, 0.2, 1, 0.002, 0.6);
    this._tone(v, t + 0.03, 'sine', 120, 90, 0.05, 0.4, 0.002, 0.15);
    this._burst(v, t, 'lowpass', 900, 0.7, 0.9, 0.002, 0.35);
    const k = 3 + ((Math.random() * 3) | 0);
    for (let i = 0; i < k; i++) this._burst(v, t + rnd(0.05, 0.25), 'bandpass', 2600, 6, 0.15, 0.0005, 0.015);
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

  // Footsteps heard from inside the suit.
  _foot(v, t, o, x) {
    const kind = x.kind, g = (0.15 + 0.85 * x.loud) * rnd(0.85, 1.15), p = rnd(0.92, 1.08);
    const boom = this._bq('peaking', 115, 1, 5);
    boom.connect(v.out); v.nodes.push(boom);
    const rustle = (amp, a, d) => this._burst(v, t + rnd(-0.01, 0.03), 'bandpass', rnd(2600, 3600), 0.6, amp, a, d, boom);
    if (kind === 'carpet') {
      this._tone(v, t, 'sine', 90 * p, 55 * p, 0.05, 0.55 * g, 0.002, 0.09, boom);
      this._burst(v, t, 'lowpass', 500 * p, 0.7, 0.5 * g, 0.003, 0.08, boom);
      this._burst(v, t + rnd(0.05, 0.08), 'lowpass', 800 * p, 0.7, 0.3 * g, 0.003, 0.06, boom);
      this._burst(v, t + 0.02, 'bandpass', 1100 * p, 2, 0.06 * g, 0.01, 0.06, boom); // damp squish
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
    this._tone(v, t, 'sine', 75 * p, 35 * p, 0.12, 1.0 * g, 0.002, 0.25, boom);
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

  // Distant ambience.
  _thud(v, t) {
    this._tone(v, t, 'sine', 55, 35, 0.3, 1, 0.003, 0.7);
    this._burst(v, t, 'lowpass', 400, 0.7, 0.8, 0.003, 0.5);
    return 1.2;
  },

  _drag(v, t) {
    const dur = rnd(1.2, 2.8);
    const n = this._loop(this._brown), lp = this._bq('lowpass', 700, 0.8), g = this._gain(0);
    this._chain(n, lp, g, v.out);
    v.nodes.push(lp, g);
    let tt = t;
    while (tt < t + dur) {
      const p = (tt - t) / dur;
      g.gain.setValueAtTime(Math.sin(Math.PI * p) * rnd(0.3, 1.4), tt);
      tt += rnd(0.01, 0.04);
    }
    g.gain.setValueAtTime(0, t + dur);
    this._run(v, n, t, t + dur + 0.05, rnd(0, 3));
    return dur + 0.2;
  },

  _pipe(v, t) {
    const f = rnd(180, 320), k = 2 + ((Math.random() * 2) | 0);
    let tk = t;
    for (let i = 0; i < k; i++) {
      [[1, 0.6, 0.5], [2.76, 0.4, 0.3], [5.4, 0.25, 0.2], [8.9, 0.15, 0.12]].forEach(([r, d, a]) =>
        this._tone(v, tk, 'sine', f * r, 0, 0, a, 0.001, d));
      this._burst(v, tk, 'bandpass', 2500, 1, 0.2, 0.0005, 0.01);
      tk += rnd(0.18, 0.4);
    }
    return tk - t + 0.8;
  },
};

function flashClick(eng, v, t, pitch) {
  eng._burst(v, t, 'bandpass', 2900 * pitch, 6, 0.4, 0.0005, 0.012);
  eng._tone(v, t, 'sine', 180 * pitch, 150, 0.02, 0.2, 0.001, 0.03);
  eng._burst(v, t + 0.045, 'bandpass', 3600 * pitch, 6, 0.25, 0.0005, 0.01);
  return 0.15;
}
