// All GLSL. One lighting model shared by the world, props and creatures:
// every ceiling lamp is a real light read from the world-map texture, shadowed by
// marching the occupancy map, plus a diffused bounce term and flashlights.
import * as THREE from './three.module.min.js';

const LIGHT = /* glsl */`
uniform sampler2D uOcc;
uniform sampler2D uInd;
uniform highp sampler2D uCell;
uniform float uTime;
uniform float uPulse;
uniform float uFrame;
uniform vec3 uFlashPos;
uniform vec3 uFlashDir;
uniform float uFlash;
uniform vec3 uRFPos[3];
uniform vec3 uRFDir[3];
uniform float uRFOn[3];
uniform vec4 uDark;
uniform vec3 uFogCol;
uniform float uFogDen;
const float CS = 0.6;
const float MAPN = 256.0;
const vec3 LAMPCOL = vec3(1.0, 0.95, 0.78);

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ return vnoise(p)*0.5 + vnoise(p*2.03+17.0)*0.25 + vnoise(p*4.01+31.0)*0.125 + vnoise(p*8.1+5.0)*0.0625; }
float ign(vec2 p){ p += uFrame * 5.588238; return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float lampFlicker(float type, float ph){
  if (type < 1.5) return 0.975 + 0.025 * sin(uTime * 41.0 + ph * 50.0);
  if (type < 2.5) {
    float t = uTime * (7.0 + ph * 6.0) + ph * 91.0;
    float a = hash11(floor(t)), slow = hash11(floor(t * 0.17) + ph * 13.0);
    float on = slow < 0.55 ? 1.0 : step(0.45, a);
    return on * (0.8 + 0.2 * hash11(floor(t * 2.0) + 5.0));
  }
  if (type < 3.5) {
    float t = uTime * 11.0 + ph * 91.0;
    float slow = hash11(floor(t * 0.08) + ph * 7.0), a = hash11(floor(t));
    return slow > 0.7 ? step(0.5, a) * 0.7 : 0.03 * step(0.9, a);
  }
  return 0.0;
}
float dk(vec2 xz){ return 1.0 - uDark.w * (1.0 - smoothstep(uDark.z * 0.55, uDark.z, distance(xz, uDark.xy))); }

float occl(vec3 P, vec3 Lp, float jit){
#if QUALITY > 0
  vec2 a = P.xz / CS, d = Lp.xz / CS - a;
  float n = clamp(ceil(length(d) / 0.72), 1.0, float(SHADOW_STEPS));
  float vis = 1.0;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    if (float(i) >= n) break;
    float t = (float(i) + jit) / n;
    float o = texture(uOcc, (a + d * t) / MAPN).r;
    vis *= 1.0 - smoothstep(0.34, 0.72, o);
    if (vis < 0.02) break;
  }
  return vis;
#else
  return 1.0;
#endif
}

vec3 spot(vec3 P, vec3 N, vec3 pos, vec3 dir){
  vec3 L = pos - P; float d2 = dot(L, L); vec3 Ld = L * inversesqrt(d2);
  float c = dot(-Ld, dir);
  float cone = smoothstep(0.84, 0.95, c) * 0.5 + smoothstep(0.955, 0.992, c) * 0.8;
  cone *= 1.0 - 0.14 * smoothstep(0.972, 0.98, c) * (1.0 - smoothstep(0.98, 0.988, c));
  return vec3(0.92, 0.96, 1.0) * cone * max(dot(N, Ld), 0.0) / (1.0 + 0.085 * d2);
}

vec3 shade(vec3 P, vec3 N, vec3 Ng, vec3 alb, float gloss, vec3 V){
  float jit = ign(gl_FragCoord.xy);
  vec3 Po = P + Ng * 0.3;
  vec2 base = floor((P.xz / CS - 3.5) / 6.0 + 0.5);
  float dif = 0.0, sp = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 lc = (base + vec2(float(i), float(j))) * 6.0 + 3.0;
    vec4 info = texelFetch(uCell, ivec2(mod(lc, MAPN)), 0);
    if (info.r < 0.5 || info.r > 3.5) continue;
    vec3 Lp = vec3((lc.x + 0.5) * CS, info.g - 0.05, (lc.y + 1.0) * CS);
    vec3 L = Lp - P; float d2 = dot(L, L);
    float w = clamp(1.0 - d2 / 40.0, 0.0, 1.0); w *= w;
    if (w <= 0.0) continue;
    vec3 Ld = L * inversesqrt(d2);
    float ndl = max(dot(N, Ld), 0.0);
    float emit = max(Ld.y, 0.0) * 0.92 + 0.08;
    float a = lampFlicker(info.r, info.b) * dk(Lp.xz) * w * ndl * emit / (d2 + 0.7);
    if (a < 0.0012) continue;
    a *= occl(Po, Lp, jit);
    dif += a;
    sp += a * pow(max(dot(N, normalize(Ld + V)), 0.0), 22.0);
  }
  vec3 col = (alb * dif + gloss * sp * 0.16) * LAMPCOL * (9.5 * uPulse);
  float ind = texture(uInd, (Po.xz / CS) / MAPN).r; ind *= ind * 2.5;
  col += alb * ind * vec3(0.95, 0.85, 0.56) * (0.115 * uPulse) * dk(P.xz) * (N.y < -0.5 ? 1.9 : 1.0);
  col += alb * vec3(0.0075, 0.007, 0.0055);
  if (uFlash > 0.001) {
    vec3 f = spot(P, N, uFlashPos, uFlashDir);
    col += (alb + gloss * 0.25) * f * (uFlash * 1.9);
  }
#if QUALITY > 0
  for (int k = 0; k < 3; k++) {
    if (uRFOn[k] < 0.01) continue;
    vec3 f = spot(P, N, uRFPos[k], uRFDir[k]);
    if (f.g > 0.0005) col += alb * f * (uRFOn[k] * 1.9) * occl(Po, uRFPos[k], jit);
  }
#endif
  return col;
}
vec3 fog(vec3 col, vec3 P){
  float d = distance(P, cameraPosition);
  float f = 1.0 - exp(-pow(d * uFogDen, 1.5));
  f = max(f, smoothstep(34.0, 45.0, d));
  float ind = texture(uInd, (P.xz / CS) / MAPN).r;
  vec3 fc = uFogCol * (0.02 + ind * ind * 1.3) * uPulse;
  return mix(col, fc, f);
}
`;

const WORLD_VS = /* glsl */`
attribute vec2 aMat;
varying vec3 vW; varying vec3 vN; varying vec2 vMat;
void main(){ vW = position; vN = normal; vMat = aMat; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }
`;
const WORLD_FS = /* glsl */`
varying vec3 vW; varying vec3 vN; varying vec2 vMat;
uniform sampler2D tWall; uniform sampler2D tWallN; uniform sampler2D tCarpet; uniform sampler2D tCarpetN; uniform sampler2D tCeil; uniform sampler2D tCeilN;
${LIGHT}
void main(){
  vec3 Ng = normalize(vN); float mat = vMat.x;
  vec3 V = normalize(cameraPosition - vW);
  vec3 alb; vec3 tn; vec3 T; vec3 B; float gloss = 0.0; vec3 emis = vec3(0.0);
  if (mat < 0.5 || mat > 2.5) {
    bool fl = mat < 0.5;
    float u = abs(Ng.x) > 0.5 ? vW.z : vW.x;
    vec2 uv = fl ? vW.xz / 1.5 : vec2(u, vW.y) / 1.5;
    alb = texture(tCarpet, uv).rgb; tn = texture(tCarpetN, uv).xyz * 2.0 - 1.0;
    T = fl ? vec3(1,0,0) : (abs(Ng.x) > 0.5 ? vec3(0,0,1) : vec3(1,0,0)); B = fl ? vec3(0,0,1) : vec3(0,1,0);
    float big = fbm(vW.xz * 0.21);
    alb *= 0.7 + 0.55 * big;
    float damp = smoothstep(0.5, 0.63, fbm(vW.xz * 0.085 + 40.0));
    alb *= mix(1.0, 0.5, damp); gloss = damp * 0.55;
    if (!fl) alb *= 0.78;
  } else if (mat < 1.5) {
    vec2 cellc = floor(vW.xz / CS), f = fract(vW.xz / CS);
    vec2 uv = vW.xz / (2.0 * CS);
    alb = texture(tCeil, uv).rgb; tn = texture(tCeilN, uv).xyz * 2.0 - 1.0;
    T = vec3(1,0,0); B = vec3(0,0,1);
    float h = hash21(cellc);
    alb *= 0.84 + 0.16 * hash21(cellc + 3.7);
    if (h > 0.962) {
      float s = fbm(f * 3.0 + cellc * 1.7);
      float m = smoothstep(0.42, 0.66, s + (0.5 - distance(f, vec2(0.5))) * 0.6);
      alb = mix(alb, alb * vec3(0.5, 0.36, 0.17), m * 0.9);
    }
    if (h < 0.005) { float inside = step(0.05, f.x) * step(f.x, 0.95) * step(0.05, f.y) * step(f.y, 0.95); alb = mix(alb, vec3(0.01), inside); }
    vec4 info = texelFetch(uCell, ivec2(mod(cellc, MAPN)), 0);
    if (info.r > 0.5) {
      bool second = info.r > 7.5;
      float type = second ? info.r - 8.0 : info.r;
      float pv = second ? f.y + 1.0 : f.y;
      float frame = step(0.07, f.x) * step(f.x, 0.93) * step(0.07, pv) * step(pv, 1.93);
      float I = type > 3.5 ? 0.0 : lampFlicker(type, info.b) * dk(vW.xz) * uPulse;
      float tubes = exp(-pow((f.x - 0.3) / 0.075, 2.0)) + exp(-pow((f.x - 0.7) / 0.075, 2.0));
      float prism = 0.9 + 0.1 * sin(f.x * 94.0) * sin(pv * 94.0);
      alb = mix(vec3(0.42, 0.42, 0.4), vec3(0.5, 0.5, 0.46) * prism, frame);
      emis = frame * I * LAMPCOL * (2.0 + 3.6 * tubes) * prism;
      tn = vec3(0, 0, 1);
    }
  } else {
    float u = abs(Ng.x) > 0.5 ? vW.z : vW.x;
    vec2 uv = vec2(u, vW.y) / 1.2;
    alb = texture(tWall, uv).rgb; tn = texture(tWallN, uv).xyz * 2.0 - 1.0;
    T = abs(Ng.x) > 0.5 ? vec3(0,0,1) : vec3(1,0,0); B = vec3(0,1,0);
    float hb = vW.y - vMat.y;
    float n1 = fbm(vec2(u * 0.33, vW.y * 0.45) + 11.0);
    alb *= 0.72 + 0.52 * n1;
    float drip = fbm(vec2(u * 3.1, vW.y * 0.22) + 3.0);
    alb *= 1.0 - 0.3 * smoothstep(0.5, 0.75, drip);
    alb *= mix(0.6, 1.0, smoothstep(0.06, 0.75, hb + (n1 - 0.5) * 0.35));
    gloss = 0.1;
    if (vMat.y > -900.0) {
      if (hb < 0.105) {
        float e = smoothstep(0.088, 0.105, hb);
        alb = mix(vec3(0.27, 0.23, 0.14) * (0.75 + 0.5 * n1), alb * 0.5, e); gloss = 0.4 * (1.0 - e); tn = mix(vec3(0,0,1), tn, e);
      }
      float cu = floor(u / CS);
      float hh = hash21(vec2(cu, floor(vMat.y * 3.0) + Ng.x * 7.0 + Ng.z * 13.0));
      if (hh < 0.035) {
        vec2 q = vec2((fract(u / CS) - 0.5) * CS, hb - 0.36);
        if (abs(q.x) < 0.036 && abs(q.y) < 0.058) {
          alb = vec3(0.6, 0.58, 0.5); tn = vec3(0, 0, 1); gloss = 0.3;
          if (abs(abs(q.x) - 0.009) < 0.003 && abs(abs(q.y) - 0.022) < 0.009) alb = vec3(0.02);
        }
      }
    }
  }
  vec3 N = normalize(T * tn.x * 0.9 + B * tn.y * 0.9 + Ng * tn.z);
  vec3 col = shade(vW, N, Ng, alb, gloss, V) + emis;
  gl_FragColor = vec4(fog(col, vW), 1.0);
}
`;

const OBJ_VS = /* glsl */`
varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec3 vL;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vL = position; vN = normalize(mat3(modelMatrix) * normal); vUv = uv; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const OBJ_FS = /* glsl */`
varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec3 vL;
uniform vec3 uColor; uniform vec3 uEmis; uniform float uGloss; uniform float uFabric; uniform float uAlpha;
${LIGHT}
void main(){
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  float n = vnoise(vL.xy * 90.0 + vL.z * 57.0) * 0.6 + vnoise(vL.zy * 23.0) * 0.4;
  vec3 alb = uColor * (1.0 - uFabric * 0.45 + uFabric * 0.6 * n);
  vec3 col = shade(vW, N, N, alb, uGloss, V);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float ind = texture(uInd, (vW.xz / CS) / MAPN).r;
  col += rim * uGloss * ind * ind * vec3(0.5, 0.45, 0.3) * 0.25;
  col += uEmis;
  gl_FragColor = vec4(fog(col, vW), uAlpha);
}
`;
const DECAL_FS = /* glsl */`
varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec3 vL;
uniform sampler2D tMap; uniform float uAlpha; uniform float uLit; uniform vec3 uTint;
${LIGHT}
void main(){
  vec4 t = texture(tMap, vUv);
  float a = t.a * uAlpha; if (a < 0.02) discard;
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  vec3 col = mix(t.rgb * uTint, shade(vW, N, N, t.rgb * uTint, 0.0, V), uLit);
  gl_FragColor = vec4(fog(col, vW), a);
}
`;

export function makeMaterials(tex, world, quality) {
  const V3 = () => new THREE.Vector3();
  const shared = {
    uOcc: { value: world.texOcc }, uInd: { value: world.texInd }, uCell: { value: world.texCell },
    uTime: { value: 0 }, uPulse: { value: 1 }, uFrame: { value: 0 },
    uFlashPos: { value: V3() }, uFlashDir: { value: new THREE.Vector3(0, 0, -1) }, uFlash: { value: 0 },
    uRFPos: { value: [V3(), V3(), V3()] }, uRFDir: { value: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)] }, uRFOn: { value: [0, 0, 0] },
    uDark: { value: new THREE.Vector4(0, 0, 1, 0) },
    uFogCol: { value: new THREE.Vector3(0.62, 0.55, 0.3) }, uFogDen: { value: 1 / 36 },
  };
  const defines = () => ({ QUALITY: quality, SHADOW_STEPS: quality >= 2 ? 14 : 9 });
  const worldMat = new THREE.ShaderMaterial({
    vertexShader: WORLD_VS, fragmentShader: WORLD_FS, defines: defines(),
    uniforms: { ...shared, tWall: { value: tex.wall }, tWallN: { value: tex.wallN }, tCarpet: { value: tex.carpet }, tCarpetN: { value: tex.carpetN }, tCeil: { value: tex.ceil }, tCeilN: { value: tex.ceilN } },
  });
  const all = [worldMat];
  const obj = (color, o = {}) => {
    const m = new THREE.ShaderMaterial({
      vertexShader: OBJ_VS, fragmentShader: OBJ_FS, defines: defines(),
      uniforms: { ...shared, uColor: { value: new THREE.Color(color) }, uEmis: { value: new THREE.Color(o.emis || 0) }, uGloss: { value: o.gloss ?? 0.15 }, uFabric: { value: o.fabric ?? 0 }, uAlpha: { value: o.alpha ?? 1 } },
      transparent: (o.alpha ?? 1) < 1 || !!o.transparent, side: o.side || THREE.FrontSide, depthWrite: o.depthWrite ?? true,
    });
    if (o.emisScale) m.uniforms.uEmis.value.multiplyScalar(o.emisScale);
    all.push(m); return m;
  };
  const decal = (map, o = {}) => {
    const m = new THREE.ShaderMaterial({
      vertexShader: OBJ_VS, fragmentShader: DECAL_FS, defines: defines(),
      uniforms: { ...shared, tMap: { value: map }, uAlpha: { value: o.alpha ?? 1 }, uLit: { value: o.lit ?? 1 }, uTint: { value: new THREE.Color(o.tint || 0xffffff) } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    if (o.tintScale) m.uniforms.uTint.value.multiplyScalar(o.tintScale);
    all.push(m); return m;
  };
  const setQuality = (q) => { for (const m of all) { m.defines.QUALITY = q; m.defines.SHADOW_STEPS = q >= 2 ? 14 : 9; m.needsUpdate = true; } };
  return { shared, world: worldMat, obj, decal, setQuality, all };
}

// ---------- post ----------
export const POST_VS = /* glsl */`
varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const DOWN_FS = /* glsl */`
varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThresh;
void main(){
  vec3 c = texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  if (uThresh > 0.0) { float l = max(c.r, max(c.g, c.b)); c *= smoothstep(uThresh * 0.7, uThresh * 1.8, l); c = min(c, vec3(12.0)); }
  gl_FragColor = vec4(c, 1.0);
}
`;
export const UP_FS = /* glsl */`
varying vec2 vUv; uniform sampler2D tSrc; uniform sampler2D tAdd; uniform vec2 uTexel;
void main(){
  vec3 c = texture(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb
         + texture(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb;
  c = c * 0.125 + texture(tSrc, vUv).rgb * 0.5;
  gl_FragColor = vec4(c + texture(tAdd, vUv).rgb, 1.0);
}
`;
export const FINAL_FS = /* glsl */`
varying vec2 vUv;
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tBlur;
uniform vec2 uRes; uniform float uTime; uniform float uExposure; uniform float uGrain; uniform float uVisor;
uniform float uBreath; uniform float uCrack; uniform float uSanity; uniform float uDamage; uniform float uDead; uniform float uFade; uniform float uBlink;
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p){ return vec2(h21(p), h21(p + 19.19)); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fb(vec2 p){ return vn(p)*0.5 + vn(p*2.1+7.0)*0.25 + vn(p*4.3+13.0)*0.125; }
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
vec2 lens(vec2 uv, float k){ vec2 p = uv * 2.0 - 1.0; p *= 1.0 + k * dot(p, p); return p * 0.5 + 0.5; }
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float scratch(vec2 p, float ang, float dens, float seed){
  float c = cos(ang), s = sin(ang); vec2 r = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  float row = floor(r.y * dens), h = h21(vec2(row, seed));
  float on = step(0.82, h);
  float span = smoothstep(0.2, 0.0, abs(fract(r.x * 0.5 + h * 9.0) - 0.5) - 0.03 - h * 0.08);
  float line = smoothstep(0.5, 0.0, abs(fract(r.y * dens) - 0.5) / (0.035 + 0.03 * h));
  return on * span * line;
}
float cracks(vec2 p){
  vec2 g = floor(p), f = fract(p); float d1 = 9.0, d2 = 9.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 o = vec2(float(i), float(j)); vec2 q = o + h22(g + o) - f; float d = dot(q, q); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return sqrt(d2) - sqrt(d1);
}
void main(){
  float asp = uRes.x / uRes.y;
  vec2 uv = vUv;
  float ins = 1.0 - uSanity;
  uv += vec2(sin(uv.y * 17.0 + uTime * 1.7), cos(uv.x * 13.0 + uTime * 1.3)) * 0.0035 * ins * ins;
  vec2 p = uv * 2.0 - 1.0;
  vec2 pa = vec2(p.x * asp, p.y + 0.055 * p.x * p.x);
  float sd = sdBox(pa, vec2(asp * 0.955, 0.925), min(0.5, asp * 0.45));
  float inside = -sd;
  float k = 0.055 * uVisor;
  float ca = (0.0035 + 0.012 * ins * ins + 0.01 * uDamage) * dot(p, p);
  vec3 col;
  col.r = texture(tScene, lens(uv, k + ca)).r;
  col.g = texture(tScene, lens(uv, k)).g;
  col.b = texture(tScene, lens(uv, k - ca)).b;
  vec2 uvl = lens(uv, k);
  vec3 bloom = texture(tBloom, uvl).rgb;
  vec3 blur = texture(tBlur, uvl).rgb;
  col += bloom * 0.085;
  if (uVisor > 0.0) {
    
    float glare = dot(bloom, vec3(0.3)) * 0.22 + dot(blur, vec3(0.33)) * 0.05;
    vec2 sp = vec2(p.x * asp, p.y);
    float sc = scratch(sp, 0.35, 260.0, 1.0) + scratch(sp, -1.05, 220.0, 2.0) * 0.8 + scratch(sp, 1.4, 300.0, 3.0) * 0.6 + scratch(sp, 2.5, 190.0, 4.0) * 0.5;
    col += sc * glare * vec3(1.0, 0.97, 0.9) * 0.28;
    float smudge = smoothstep(0.45, 0.8, fb(sp * 1.7 + 3.0));
    col = mix(col, blur, smudge * 0.12);
    col += smudge * glare * 0.1;
    // breath on the plate: rises from the bottom, clings to the gasket
    float fogm = uBreath * smoothstep(-0.2, -1.05, p.y + (fb(sp * 2.4 + vec2(0.0, uTime * 0.03)) - 0.5) * 0.55);
    fogm += smoothstep(0.34, 0.0, inside) * (0.18 + 0.4 * uBreath);
    fogm = clamp(fogm, 0.0, 0.9);
    col = mix(col, blur * 1.04 + 0.006, fogm);
    if (uCrack > 0.0) {
      vec2 cp = sp - vec2(asp * 0.52, 0.36);
      float m = smoothstep(0.25 + uCrack * 1.5, 0.0, length(cp));
      float e = cracks(cp * 5.5 + 11.0);
      float ln = smoothstep(0.035, 0.0, e) * m;
      col += ln * (glare * 3.0 + 0.012);
      col = mix(col, blur, m * 0.25 * uCrack);
    }
  }
  col *= uExposure;
  col = aces(col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, 0.94 - 0.55 * ins - 0.6 * uDead);
  col *= vec3(1.015, 1.0, 0.9);
  col = pow(col, vec3(1.0 / 2.2));
  float vig = smoothstep(1.55, 0.35, length(p * vec2(0.9, 1.0)) + ins * 0.35);
  col *= mix(0.55, 1.0, vig);
  float g = h21(uv * uRes + fract(uTime) * 311.0) - 0.5;
  col += g * uGrain * (0.035 + 0.05 * (1.0 - l));
  if (uVisor > 0.0) {
    // the hood: soft, out of focus gasket with a thin lit lip
    float m = smoothstep(-0.012, 0.03, inside);
    float shade2 = smoothstep(0.0, 0.3, inside);
    col *= mix(0.42, 1.0, shade2);
    vec3 lip = pow(blur * uExposure, vec3(0.6)) * 0.3;
    vec3 frame = vec3(0.012, 0.011, 0.009) + lip * exp(-pow((sd - 0.014) / 0.012, 2.0)) + lip * 0.25 * exp(-pow((sd - 0.07) / 0.03, 2.0));
    frame += (h21(uv * uRes) - 0.5) * 0.006;
    col = mix(frame, col, m);
    col += vec3(0.55, 0.02, 0.0) * uDamage * smoothstep(0.55, 0.0, inside) * m;
  } else {
    col += vec3(0.4, 0.0, 0.0) * uDamage * smoothstep(0.4, 1.3, length(p));
  }
  // eyelids
  float lid = smoothstep(0.0, 0.08, abs(p.y) - (1.0 - uBlink) * 1.2);
  col *= 1.0 - lid * step(0.001, uBlink);
  col *= 1.0 - uFade;
  gl_FragColor = vec4(col, 1.0);
}
`;
