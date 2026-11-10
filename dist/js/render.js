// Renderer: HDR scene target, bloom chain, and the final visor / lens / grade pass.
import * as THREE from './three.module.min.js';
import { POST_VS, DOWN_FS, UP_FS, FINAL_FS } from './shaders.js';

const QUAL = {
  low: { h: 540, q: 0, msaa: 0 },
  medium: { h: 760, q: 1, msaa: 0 },
  high: { h: 1100, q: 2, msaa: 4 },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, depth: false, powerPreference: 'high-performance' });
    this.r.setClearColor(0x000000, 1);
    this.r.info.autoReset = true;
    const gl = this.r.getContext();
    this.float = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.maxAniso = this.r.capabilities.getMaxAnisotropy();
    this.level = 'medium';
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.pscene = new THREE.Scene(); this.pscene.add(this.quad);
    this.pcam = new THREE.Camera();
    const mk = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: POST_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.mDown = mk(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: 0 } });
    this.mUp = mk(UP_FS, { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.fx = {
      tScene: { value: null }, tBloom: { value: null }, tBlur: { value: null }, tHalo: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
      uSrcTexel: { value: new THREE.Vector2(1, 1) }, uSharpen: { value: 0 }, uPostQ: { value: 1 },
      uTime: { value: 0 }, uExposure: { value: 1.5 }, uGrain: { value: 1 }, uVisor: { value: 1 }, uBreath: { value: 0.1 },
      uCrack: { value: 0 }, uSanity: { value: 1 }, uDamage: { value: 0 }, uDead: { value: 0 }, uFade: { value: 1 }, uBlink: { value: 0 },
    };
    this.mFinal = mk(FINAL_FS, this.fx);
    this.rts = null;
    this.onQuality = () => {};
  }
  setQuality(level) {
    if (!QUAL[level]) level = 'medium';
    this.level = level; this.resize(true);
    this.onQuality(QUAL[level].q);
  }
  get q() { return QUAL[this.level].q; }
  resize(force) {
    const cw = this.canvas.clientWidth || innerWidth, ch = this.canvas.clientHeight || innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const Q = QUAL[this.level];
    const outH = Math.min(Math.round(ch * dpr), 1440), outW = Math.round(outH * cw / ch);
    const h = Math.max(240, Math.min(outH, Q.h)), w = Math.max(320, Math.round(h * cw / ch));
    if (!force && this.w === w && this.h === h && this.ow === outW && this.oh === outH) return;
    this.w = w; this.h = h; this.ow = outW; this.oh = outH;
    this.r.setPixelRatio(1); this.r.setSize(outW, outH, false);
    if (this.rts) for (const t of this.rts.all) t.dispose();
    const type = this.float ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const rt = (W, H, depth, samples) => {
      const t = new THREE.WebGLRenderTarget(Math.max(2, W | 0), Math.max(2, H | 0), { type, depthBuffer: depth, samples: samples || 0, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat });
      t.texture.generateMipmaps = false; return t;
    };
    const scene = rt(w, h, true, Q.msaa);
    const down = [], up = [];
    for (let i = 1; i <= 5; i++) down.push(rt(w >> i, h >> i, false));
    for (let i = 1; i <= 4; i++) up.push(rt(w >> i, h >> i, false));
    const blur = [rt(w >> 2, h >> 2, false), rt(w >> 3, h >> 3, false), rt(w >> 4, h >> 4, false)];
    this.rts = { scene, down, up, blur, all: [scene, ...down, ...up, ...blur] };
    this.fx.uRes.value.set(outW, outH);
    this.fx.uSrcTexel.value.set(1 / w, 1 / h);
    // sharpen more the further we upscale (low 540p, medium 760p, high 1100p)
    this.fx.uSharpen.value = Math.max(0, Math.min(0.85, (outH / h - 1) * 0.75));
    this.fx.uPostQ.value = Q.q;
  }
  _pass(mat, target) { this.quad.material = mat; this.r.setRenderTarget(target); this.r.render(this.pscene, this.pcam); }
  render(scene, camera) {
    const { r, rts } = this;
    r.setRenderTarget(rts.scene); r.render(scene, camera);
    const D = this.mDown.uniforms, U = this.mUp.uniforms;
    let src = rts.scene;
    for (let i = 0; i < 5; i++) {
      D.tSrc.value = src.texture; D.uTexel.value.set(1 / src.width, 1 / src.height); D.uThresh.value = i === 0 ? 1.15 : 0;
      this._pass(this.mDown, rts.down[i]); src = rts.down[i];
    }
    src = rts.scene; D.uThresh.value = 0;
    for (let i = 0; i < 3; i++) { D.tSrc.value = src.texture; D.uTexel.value.set((i === 0 ? 2 : 1) / src.width, (i === 0 ? 2 : 1) / src.height); this._pass(this.mDown, rts.blur[i]); src = rts.blur[i]; }
    let low = rts.down[4];
    for (let i = 3; i >= 0; i--) {
      U.tSrc.value = low.texture; U.tAdd.value = rts.down[i].texture; U.uTexel.value.set(1 / low.width, 1 / low.height);
      this._pass(this.mUp, rts.up[i]); low = rts.up[i];
    }
    this.fx.tScene.value = rts.scene.texture; this.fx.tBloom.value = rts.up[0].texture; this.fx.tBlur.value = rts.blur[2].texture; this.fx.tHalo.value = rts.up[2].texture;
    this._pass(this.mFinal, null);
  }
}
