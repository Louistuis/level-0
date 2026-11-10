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
uniform vec4 uHz[12];
uniform float uHzN;
uniform float uHaze;
uniform float uHazeFlash;
uniform vec2 uFogEnd;
const float CS = 0.6;
const float MAPN = 256.0;
// warm, sodium-tinted fluorescent: whites read yellow-cream, never neutral
const vec3 LAMPCOL = vec3(1.0, 0.9, 0.55);
const vec3 FLASHCOL = vec3(0.84, 0.93, 1.0);   // cool LED, survives the warm grade as near white
#if QUALITY >= 2
#define HAZE_STEPS 10
#define HZ_MAX 12
#elif QUALITY == 1
#define HAZE_STEPS 6
#define HZ_MAX 10
#else
#define HAZE_STEPS 0
#define HZ_MAX 4
#endif
// set by the world shader before shade(): contact occlusion (1 = open) and how wet the surface is
float gAO = 1.0;
float gWet = 0.0;

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

// LED torch beam profile. r = tan of the angle off the axis, q = position in the beam's own frame
// (for the reflector cookie). Hotspot ~8 deg, a bright ring at its edge, mid field and a faint spill.
float beam(float r, vec2 q){
  float hot = exp(-r * r * 60.0);
  float mid = smoothstep(0.42, 0.15, r);
  float spill = smoothstep(0.78, 0.3, r);
  float ring = exp(-pow((r - 0.2) / 0.022, 2.0)) * 0.2 - exp(-pow((r - 0.13) / 0.03, 2.0)) * 0.08;
  float b = hot * 0.78 + mid * 0.4 + spill * 0.12 + ring;
#if QUALITY > 0
  // reflector facets and a smudge on the lens: a few percent, fixed to the torch
  float a = atan(q.y, q.x);
  b *= 1.0 + 0.05 * sin(a * 9.0 + r * 30.0) * smoothstep(0.08, 0.25, r) + 0.09 * (vnoise(q * 9.0 + 4.0) - 0.5);
#endif
  return max(b, 0.0);
}
vec3 spot(vec3 P, vec3 N, vec3 pos, vec3 dir){
  vec3 L = pos - P; float d2 = dot(L, L); vec3 Ld = L * inversesqrt(d2);
  float c = dot(-Ld, dir);
  if (c < 0.45) return vec3(0.0);
  vec3 e1 = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4)), e2 = cross(e1, dir);
  vec2 q = vec2(dot(-Ld, e1), dot(-Ld, e2)) / c;
  float cone = beam(length(q), q);
  return FLASHCOL * cone * max(dot(N, Ld), 0.0) / (1.0 + 0.085 * d2);
}

vec3 shade(vec3 P, vec3 N, vec3 Ng, vec3 alb, float gloss, vec3 V){
  float jit = ign(gl_FragCoord.xy);
  vec3 Po = P + Ng * 0.3;
  vec2 base = floor((P.xz / CS - 3.5) / 6.0 + 0.5);
  float dif = 0.0, sp = 0.0, sw = 0.0;
  float ndv = max(dot(N, V), 0.0);
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
    // prismatic troffer: mostly straight down, a soft shoulder, almost nothing sideways
    float cy = max(Ld.y, 0.0);
    // (tight enough that each lamp leaves a pool on the carpet and the gaps between fall off)
    float emit = pow(cy, 2.4) * 1.1 + 0.035;
    float a = lampFlicker(info.r, info.b) * dk(Lp.xz) * w * ndl * emit / (d2 + 0.7);
    if (a < 0.0012) continue;
    a *= occl(Po, Lp, jit);
    dif += a;
    vec3 H = normalize(Ld + V);
    float nh = max(dot(N, H), 0.0);
    sp += a * pow(nh, 22.0);
    sw += a * pow(nh, 160.0);
  }
  // direct light keeps a little of the contact shadow, bounce light keeps all of it
  float aoD = mix(1.0, gAO, 0.45);
  vec3 col = (alb * dif * aoD + gloss * sp * 0.16) * LAMPCOL * (9.5 * uPulse);
  // wet carpet: a sharp, grazing sheen of every lamp
  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  col += gWet * sw * fres * LAMPCOL * (9.5 * uPulse) * 2.4;
  float ind = texture(uInd, (Po.xz / CS) / MAPN).r; ind *= ind * 2.5;
  // bounce: the walls are yellow, so light that has bounced in a corner comes back yellower
  vec3 bounceCol = mix(vec3(1.0, 0.86, 0.46), vec3(1.0, 0.82, 0.36), (1.0 - gAO) * 0.8);
  col += alb * ind * bounceCol * (0.1 * uPulse) * dk(P.xz) * (N.y < -0.5 ? 1.9 : 1.0) * gAO;
  col += alb * vec3(0.0055, 0.005, 0.004) * gAO;
  if (uFlash > 0.001) {
    vec3 f = spot(P, N, uFlashPos, uFlashDir);
    if (f.g > 0.0003) {
      vec3 Hf = normalize(normalize(uFlashPos - P) + V);
      float spf = pow(max(dot(N, Hf), 0.0), 40.0) * (gloss * 0.6 + gWet * 3.0 * fres);
      col += (alb + spf) * f * (uFlash * 1.9) * occl(Po, uFlashPos, jit);
    }
    // the lit patch in front of the torch throws a little light back round the room
    vec3 Bp = uFlashPos + uFlashDir * 1.6;
    vec3 Lb = Bp - P; float db = dot(Lb, Lb);
    col += alb * FLASHCOL * uFlash * 0.05 * (0.4 + 0.6 * max(dot(N, Lb * inversesqrt(db + 1e-4)), 0.0)) / (1.0 + db * 0.35) * gAO;
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
// Light scattered towards the eye by dusty air between the camera and P: every lamp near the
// player as a point source, integrated in closed form along the ray, plus the torch beam marched.
vec3 haze(vec3 P){
  vec3 C = cameraPosition; vec3 rd = P - C; float D = length(rd); rd /= max(D, 1e-4);
  float acc = 0.0;
  for (int k = 0; k < HZ_MAX; k++) {
    if (float(k) >= uHzN) break;
    vec4 L = uHz[k];
    float ty = floor(L.w);
    float I = lampFlicker(ty, fract(L.w) / 0.999);
    if (I < 0.01) continue;
    vec3 oc = L.xyz - C; float b = dot(oc, rd);
    float h = sqrt(max(dot(oc, oc) - b * b, 0.12));
    float s = (atan((D - b) / h) - atan(-b / h)) / h;
    // the panel lights the air below it; a little range limit like the surface lights
    acc += I * dk(L.xz) * s * clamp(1.0 - (dot(oc, oc)) / 170.0, 0.0, 1.0);
  }
  vec3 sc = acc * LAMPCOL * uPulse * uHaze * 0.0075;
#if HAZE_STEPS > 0
  if (uFlash > 0.001) {
    float Dm = min(D, 11.0), j = ign(gl_FragCoord.xy + 17.0), fb = 0.0;
    vec3 e1 = normalize(cross(uFlashDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4)), e2 = cross(e1, uFlashDir);
    for (int i = 0; i < HAZE_STEPS; i++) {
      float t = (float(i) + j) / float(HAZE_STEPS);
      t = t * t * Dm;   // denser near the eye, where the beam is brightest
      vec3 X = C + rd * t;
      vec3 Lf = X - uFlashPos; float d2 = dot(Lf, Lf); vec3 Ld = Lf * inversesqrt(d2 + 1e-5);
      float c = dot(Ld, uFlashDir);
      if (c < 0.6) continue;
      vec2 q = vec2(dot(Ld, e1), dot(Ld, e2)) / c;
      fb += beam(length(q), q) / (1.0 + 0.085 * d2) * 2.0 * sqrt(t / Dm + 1e-3);
    }
    sc += FLASHCOL * fb * (Dm / float(HAZE_STEPS)) * uFlash * uHazeFlash * 0.016;
  }
#endif
  return sc;
}
// The colour the air has looking towards P: lit yellow where the rooms along the way are lit,
// dark only where they really are dark. Averaged along the far part of the ray so a corridor
// dissolves smoothly instead of taking the colour of whatever single cell it ends on.
vec3 fogColor(vec3 P, float d){
  vec2 C = cameraPosition.xz, D = P.xz - C;
  float a = 0.0;
  a += texture(uInd, ((C + D * 0.45) / CS) / MAPN).r;
  a += texture(uInd, ((C + D * 0.7) / CS) / MAPN).r;
  a += texture(uInd, ((C + D * 0.88) / CS) / MAPN).r;
  a += texture(uInd, (P.xz / CS) / MAPN).r;
  a *= 0.25;
  return uFogCol * (0.015 + a * a * 2.1) * uPulse * dk(P.xz);
}
vec3 fog(vec3 col, vec3 P){
  float d = distance(P, cameraPosition);
  float f = 1.0 - exp(-pow(d * uFogDen, 1.5));
  // fully opaque a few metres before the streaming range (uFogEnd, set per tier by World.setRange)
  f = max(f, smoothstep(uFogEnd.x, uFogEnd.y, d));
  return mix(col, fogColor(P, d), f) + haze(P);
}
`;

const WORLD_VS = /* glsl */`
attribute vec4 aMat;
varying vec3 vW; varying vec3 vN; varying vec4 vMat;
void main(){ vW = position; vN = normal; vMat = aMat; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }
`;
// aMat: x = material (see World._mesh), y = extra, zw = 0..1 across the quad
const WORLD_FS = /* glsl */`
varying vec3 vW; varying vec3 vN; varying vec4 vMat;
uniform sampler2D tWall; uniform sampler2D tWallN; uniform sampler2D tCarpet; uniform sampler2D tCarpetN; uniform sampler2D tCeil; uniform sampler2D tCeilN; uniform sampler2D tNoise;
${LIGHT}
vec4 cellAt(vec2 c){ return texelFetch(uCell, ivec2(mod(c, MAPN)), 0); }
float contact(float d, float r){ float x = clamp(d / r, 0.0, 1.0); return (1.0 - x) * (1.0 - x); }
// is cell n a wall at height y? (solid cells carry floor 50 / ceiling -50)
float blockedAt(vec4 n, float y){ return (n.a > y + 0.02 || n.g < y - 0.02) ? 1.0 : 0.0; }
// Contact shadow from the cell grid: how close P is to the walls, steps and bulkheads around it.
// edge = 0 in open floor, 1 right against a wall.
float worldAO(vec3 P, vec3 Ng, out float edge){
  float ao = 1.0; edge = 0.0;
  const float R = 0.48;
  if (abs(Ng.y) > 0.5) {
    vec2 g = P.xz / CS, c = floor(g), f = g - c;
    float y = P.y + Ng.y * 0.03;
    float bxp = blockedAt(cellAt(c + vec2(1.0, 0.0)), y), bxn = blockedAt(cellAt(c - vec2(1.0, 0.0)), y);
    float bzp = blockedAt(cellAt(c + vec2(0.0, 1.0)), y), bzn = blockedAt(cellAt(c - vec2(0.0, 1.0)), y);
    vec4 k = vec4(bxp * contact((1.0 - f.x) * CS, R), bxn * contact(f.x * CS, R), bzp * contact((1.0 - f.y) * CS, R), bzn * contact(f.y * CS, R));
    ao = (1.0 - 0.5 * k.x) * (1.0 - 0.5 * k.y) * (1.0 - 0.5 * k.z) * (1.0 - 0.5 * k.w);
    edge = max(max(k.x, k.y), max(k.z, k.w));
#if QUALITY > 0
    // outside corners of a pillar or wall end: only where neither edge already counted it
    for (int q = 0; q < 4; q++) {
      vec2 o = vec2(q == 0 || q == 2 ? 1.0 : -1.0, q < 2 ? 1.0 : -1.0);
      float ex = o.x > 0.0 ? bxp : bxn, ez = o.y > 0.0 ? bzp : bzn;
      if (ex + ez > 0.5) continue;
      float bd = blockedAt(cellAt(c + o), y);
      vec2 cp = vec2(o.x > 0.0 ? 1.0 - f.x : f.x, o.y > 0.0 ? 1.0 - f.y : f.y) * CS;
      float kk = bd * contact(length(cp), R);
      ao *= 1.0 - 0.45 * kk; edge = max(edge, kk);
    }
#endif
  } else {
    vec2 n2 = Ng.xz / max(length(Ng.xz), 1e-4);
    vec2 c = floor(P.xz / CS + n2 * 0.5);
    vec4 me = cellAt(c);
    float kb = contact(P.y - me.a, R);
    ao *= (1.0 - 0.45 * kb) * (1.0 - 0.32 * contact(me.g - P.y, R * 0.75));
    edge = kb;
#if QUALITY > 0
    vec2 ax = abs(n2.yx);
    float fa = dot(fract(P.xz / CS), ax);
    ao *= 1.0 - 0.45 * blockedAt(cellAt(c + ax), P.y) * contact((1.0 - fa) * CS, R);
    ao *= 1.0 - 0.45 * blockedAt(cellAt(c - ax), P.y) * contact(fa * CS, R);
#endif
  }
  return ao;
}
float aaFade(vec2 p){ vec2 w = fwidth(p); return clamp(1.5 - 2.0 * max(w.x, w.y), 0.0, 1.0); }
void main(){
  vec3 Ng = normalize(vN); float mat = vMat.x;
  vec3 V = normalize(cameraPosition - vW);
  bool vert = abs(Ng.y) < 0.5;
  vec3 alb; vec3 tn = vec3(0.0, 0.0, 1.0); float gloss = 0.0; vec3 emis = vec3(0.0);
  vec3 T = vert ? (abs(Ng.x) > 0.5 ? vec3(0, 0, 1) : vec3(1, 0, 0)) : vec3(1, 0, 0);
  vec3 B = vert ? vec3(0, 1, 0) : vec3(0, 0, 1);
  float u = abs(Ng.x) > 0.5 ? vW.z : vW.x;
  float edge;
  gAO = worldAO(vW, Ng, edge);
  if (mat < 0.5 || (mat > 2.5 && mat < 3.5)) {
    // ---- carpet: worn, damp commercial loop pile ----
    bool fl = mat < 0.5;
    vec2 wp = fl ? vW.xz : vec2(u, vW.y);
    vec4 n0 = texture(tNoise, wp * 0.045), n1 = texture(tNoise, wp * 0.19 + 0.31);
    // two rotated samples blended by a noise mask, so the repeat never lines up
    vec2 uv = wp / 1.5, uv2 = mat2(0.8, -0.6, 0.6, 0.8) * wp / 1.37 + 0.5;
    float bl = smoothstep(0.35, 0.65, n1.g);
    alb = mix(texture(tCarpet, uv).rgb, texture(tCarpet, uv2).rgb, bl);
    tn = mix(texture(tCarpetN, uv).xyz, texture(tCarpetN, uv2).xyz, bl) * 2.0 - 1.0;
    alb *= 0.74 + 0.5 * n0.r;
    // traffic: out in the open the pile is flattened and greyed, along the walls it stays fluffy
    float soil = (1.0 - edge) * smoothstep(0.25, 0.7, n1.r);
    alb = mix(alb, alb * vec3(0.84, 0.82, 0.8), soil * 0.7);
    tn.xy *= 1.0 - 0.35 * soil;
    // damp patches: darker and browner, a tide line where they dried, and a wet sheen
    // round blotches, torn up by mid and fine noise so no two look alike
    float dm = n0.b + (n1.g - 0.5) * 0.4 + (n1.a - 0.5) * 0.12;
    dm += (texture(tNoise, wp * 0.9).a - 0.5) * 0.08;
    float damp = smoothstep(0.66, 0.76, dm) * (fl ? 1.0 : 0.6);
    float tide = smoothstep(0.6, 0.65, dm) * (1.0 - smoothstep(0.65, 0.7, dm));
    alb *= mix(1.0, 0.64, damp); alb = mix(alb, alb * vec3(0.92, 0.84, 0.68), damp * 0.7); alb *= 1.0 - 0.16 * tide;
    tn.xy *= 1.0 - 0.55 * damp;
    gloss = damp * 0.3; gWet = fl ? damp * 0.85 : 0.0;
    if (!fl) alb *= 0.78;
  } else if (mat < 1.5) {
    // ---- ceiling: mineral fibre tiles in a grid, or the lens of a troffer ----
    vec2 cellc = floor(vW.xz / CS), f = fract(vW.xz / CS);
    vec4 info = cellAt(cellc);
    if (info.r > 0.5) {
      bool second = info.r > 7.5;
      float type = second ? info.r - 8.0 : info.r;
      float pv = second ? f.y + 1.0 : f.y;
      float ex = min(f.x, 1.0 - f.x) * CS, ez = min(pv, 2.0 - pv) * CS;
      float lensM = smoothstep(0.03, 0.036, ex) * smoothstep(0.03, 0.036, ez);
      float I = type > 3.5 ? 0.0 : lampFlicker(type, info.b) * dk(vW.xz) * uPulse;
      // three tubes behind a prismatic lens; holders darken the ends
      float tubes = exp(-pow((f.x - 0.27) / 0.085, 2.0)) + exp(-pow((f.x - 0.5) / 0.085, 2.0)) + exp(-pow((f.x - 0.73) / 0.085, 2.0));
      vec2 pp = vec2(f.x, pv) * 110.0;
      vec2 pf = abs(fract(pp) - 0.5);
      float prism = 1.0 + 0.16 * aaFade(pp) * (0.5 - 2.0 * max(pf.x, pf.y));
      float along = ez / CS;
      float glow = (1.55 + 3.7 * tubes) * mix(0.62, 1.0, smoothstep(0.03, 0.3, along));
      vec3 tint = vec3(1.0);
      if (type > 2.5 && type < 3.5) { glow *= smoothstep(0.04, 0.55, along); tint = vec3(1.0, 0.84, 0.62); }
      emis = lensM * I * LAMPCOL * tint * glow * prism;
      // unlit lens: milky, the tubes show as grey bars, dust and dead flies lie along the bottom
      vec2 bc = floor(vec2(f.x, pv) * vec2(36.0, 70.0));
      float bugs = step(0.955, hash21(bc + cellc * 3.1)) * (1.0 - smoothstep(0.0, 0.45, along)) * (type > 3.5 ? 1.0 : 0.5);
      vec3 lens = vec3(0.58, 0.57, 0.52) * (1.0 - 0.2 * tubes) * (1.0 - 0.7 * bugs);
      alb = mix(vec3(0.62, 0.61, 0.57), lens, lensM);
      gloss = 0.35;
    } else {
      float h = hash21(cellc), h2 = hash21(cellc + 3.7), h3 = hash21(cellc + 9.1);
      // four different tiles in the texture, each flipped either way: sixteen looks
      vec2 fl2 = vec2(step(0.5, h2), step(0.5, h3));
      vec2 tf = mix(f, 1.0 - f, fl2);
      vec2 quad = floor(vec2(h * 2.0, fract(h * 7.0) * 2.0));
      vec2 uv = (tf * 0.96 + 0.02 + quad) * 0.5;
      alb = texture(tCeil, uv).rgb; tn = texture(tCeilN, uv).xyz * 2.0 - 1.0;
      tn.xy *= mix(vec2(0.55), vec2(-0.55), fl2);
      vec4 n0 = texture(tNoise, vW.xz * 0.06 + 0.2);
      alb *= (0.86 + 0.12 * h2) * (0.9 + 0.2 * n0.r);
      // tile edge: a cut, slightly dirtier bevel where it rests on the bars
      float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * CS;
      alb *= 0.86 + 0.14 * smoothstep(0.004, 0.02, e);
      float v = vMat.y;
      if (v > 0.5 && v < 1.5) {
        // a leak: brown stain with tide rings
        vec2 sc = vec2(hash21(cellc + 1.3), hash21(cellc + 2.9)) * 0.5 + 0.25;
        float r = distance(f, sc) + (texture(tNoise, vW.xz * 0.8).g - 0.5) * 0.28;
        float R0 = 0.24 + 0.22 * h3;
        float st = 1.0 - smoothstep(R0 - 0.08, R0, r);
        float ring = exp(-pow((r - R0) / 0.018, 2.0)) + 0.7 * exp(-pow((r - R0 * 0.62) / 0.014, 2.0));
        alb = mix(alb, alb * vec3(0.8, 0.62, 0.36), st * 0.75); alb *= 1.0 - 0.32 * ring;
      } else if (v > 1.5) {
        // return-air grille: a frame and a perforated face
        float ee = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
        vec2 gp = f * 16.0, g2 = abs(fract(gp) - 0.5);
        float hole = step(max(g2.x, g2.y), 0.31) * step(0.07, ee);
        float a = aaFade(gp);
        alb = vec3(0.6, 0.59, 0.55) * mix(1.0 - 0.45 * step(0.07, ee), 1.0 - 0.95 * hole, a);
        tn = vec3(0.0, 0.0, 1.0); gloss = 0.25;
        if (ee < 0.07) tn.xy = (ee < 0.035 ? 0.4 : -0.4) * sign(f - 0.5) * vec2(step(abs(f.y - 0.5), abs(f.x - 0.5)), step(abs(f.x - 0.5), abs(f.y - 0.5)));
      }
    }
  } else if (mat < 2.5) {
    // ---- wallpaper: hung in 0.6 m strips, each a touch off from the last ----
    float su = (u + 0.17) / 0.6, sid = floor(su), sf = fract(su);
    float hs = hash21(vec2(sid, Ng.x * 3.0 + Ng.z * 7.0 + 11.0));
    vec2 uv = vec2(u, vW.y + (hs - 0.5) * 0.035) / 1.2;
    alb = texture(tWall, uv).rgb; tn = texture(tWallN, uv).xyz * 2.0 - 1.0;
    vec4 me = cellAt(floor(vW.xz / CS + Ng.xz * 0.5));
    float hb = vW.y - (vMat.y > -900.0 ? vMat.y : me.a), hc = me.g - vW.y;
    vec4 n0 = texture(tNoise, vec2(u * 0.05, vW.y * 0.09)), n1 = texture(tNoise, vec2(u * 0.21, vW.y * 0.33) + 0.5);
    alb *= 0.8 + 0.34 * n0.r + 0.1 * (hs - 0.5);
    // seams: a dark hairline and a lifted edge that catches the light
    float ds = min(sf, 1.0 - sf) * 0.6;
    float sgn = sf < 0.5 ? 1.0 : -1.0;
    alb *= 1.0 - 0.32 * smoothstep(0.0013, 0.0, ds);
    tn.x += sgn * smoothstep(0.005, 0.0, ds) * 0.45;
    gloss = 0.1;
    // some seams have let go at the top or the bottom and curl back
    if (hs < 0.075) {
      float along = hs < 0.03 ? hc : hb;
      float w = 0.05 * (1.0 - smoothstep(0.0, 0.25 + hs * 6.0, along)) * (0.6 + 0.8 * n1.g);
      if (ds < w) {
        float cu = ds / w;
        alb = mix(vec3(0.42, 0.38, 0.27), vec3(0.34, 0.3, 0.2), cu) * (0.85 + 0.3 * n1.a);
        tn = normalize(vec3(-sgn * 0.8 * (1.0 - cu), 0.0, 1.0)); gloss = 0.02;
      } else alb *= 1.0 - 0.45 * smoothstep(w + 0.014, w, ds) * step(0.002, w);
    }
    // rising damp with a tide mark, and leaks running down from the ceiling
    float rise = 0.1 + 0.32 * n0.g + 0.07 * n1.r;
    float damp = 1.0 - smoothstep(rise - 0.05, rise, hb);
    float tideL = exp(-pow((hb - rise) / 0.02, 2.0));
    alb *= mix(1.0, 0.74, damp); alb = mix(alb, alb * vec3(0.93, 0.83, 0.6), damp * 0.6); alb *= 1.0 - 0.25 * tideL;
    float leak = smoothstep(0.6, 0.8, texture(tNoise, vec2(u * 0.7, 0.37)).g) * smoothstep(1.7, 0.0, hc) * (0.55 + 0.45 * n1.b);
    leak *= smoothstep(0.25, 0.55, texture(tNoise, vec2(u * 3.0, vW.y * 0.15)).a + 0.25);
    alb *= 1.0 - 0.32 * leak; alb = mix(alb, alb * vec3(0.9, 0.74, 0.48), leak * 0.55);
    // scuffs from carts and boots, low down
    float sc = smoothstep(0.8, 0.9, texture(tNoise, vec2(u * 2.3, hb * 4.0)).a) * smoothstep(0.7, 0.12, hb);
    alb *= 1.0 - 0.28 * sc;
    gloss += 0.12 * damp;
  } else if (mat < 4.5) {
    // ---- skirting: painted vinyl, rounded top, knocked about ----
    vec4 n0 = texture(tNoise, vec2(u, vW.y) * 1.3);
    alb = vec3(0.26, 0.215, 0.135) * (0.82 + 0.3 * n0.g);
    alb *= 1.0 - 0.3 * smoothstep(0.82, 0.92, n0.a);
    gloss = 0.32;
    if (vert) tn = normalize(vec3(0.0, smoothstep(0.7, 1.0, vMat.w) * 0.9, 1.0));
  } else if (mat < 5.5) {
    // ---- the grid: enamelled steel ----
    vec4 n0 = texture(tNoise, vW.xz * 0.5 + vW.y);
    alb = vec3(0.54, 0.525, 0.48) * (0.82 + 0.26 * n0.r); gloss = 0.4;
  } else if (mat < 6.5) {
    // ---- void above a missing tile ----
    vec4 n0 = texture(tNoise, vW.xz * 0.8 + vW.y * 0.5);
    alb = vec3(0.04, 0.037, 0.03) * (0.5 + n0.r);
  } else if (mat < 7.5) {
    // ---- troffer housing: white sheet metal lit from inside ----
    vec4 info = cellAt(floor(vW.xz / CS + Ng.xz * 0.5));
    float type = mod(info.r, 8.0);
    float I = (type > 0.5 && type < 3.5) ? lampFlicker(type, info.b) * dk(vW.xz) * uPulse : 0.0;
    alb = vec3(0.6, 0.6, 0.57); gloss = 0.3;
    emis = I * LAMPCOL * (0.35 + 1.1 * vMat.w * vMat.w);
  } else if (mat < 8.5) {
    // ---- plates: outlet, switch, wall grille ----
    vec2 q = vMat.zw;
    alb = vec3(0.62, 0.6, 0.52); gloss = 0.35;
    float k = vMat.y;
    if (k < 0.5) {
      vec2 o = vec2(abs(q.x - 0.5), abs(fract(q.y * 2.0) - 0.5));
      float slot = step(abs(o.x - 0.13), 0.035) * step(o.y, 0.12) + step(length(vec2(q.x - 0.5, (fract(q.y * 2.0) - 0.5) + 0.2)), 0.05);
      float face = step(length((vec2(q.x, fract(q.y * 2.0)) - 0.5) * vec2(1.0, 1.25)), 0.36);
      alb *= 0.9 + 0.1 * face; alb = mix(alb, vec3(0.03), clamp(slot, 0.0, 1.0) * face);
    } else if (k < 1.5) {
      vec2 o = abs(q - 0.5);
      float rocker = step(o.x, 0.13) * step(o.y, 0.22);
      alb *= 1.0 - 0.15 * rocker; tn = vec3(0.0, (q.y - 0.5) * 2.0 * rocker, 1.0);
    } else {
      float frame = step(0.1, q.x) * step(q.x, 0.9) * step(0.12, q.y) * step(q.y, 0.88);
      float slat = fract(q.y * 9.0);
      alb = mix(vec3(0.6, 0.59, 0.55), vec3(0.6, 0.59, 0.55) * mix(1.0, 0.06, smoothstep(0.55, 0.75, slat)), frame);
      tn = vec3(0.0, frame * (slat - 0.5) * 1.2, 1.0);
    }
    alb *= 0.85 + 0.15 * texture(tNoise, q * 0.3 + vW.xz).a;
  } else {
    // ---- door casing: painted timber, grubby where hands and boots go ----
    vec4 n0 = texture(tNoise, vec2(u, vW.y) * 0.9);
    float hb = vW.y - vMat.y;
    alb = vec3(0.46, 0.39, 0.23) * (0.86 + 0.24 * n0.r);
    alb *= mix(0.72, 1.0, smoothstep(0.0, 0.35, hb)) * (1.0 - 0.18 * smoothstep(1.4, 1.1, abs(hb - 1.15)) * n0.g);
    gloss = 0.22;
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
// ---- obj: props, creatures and suits ----
// Optional per-vertex surface (define VCOL): aCol = albedo rgb + grime, aSurf = gloss, sheen, subsurface, emissive.
// Skinned meshes work too (three adds USE_SKINNING). vL / vLN stay in the rest pose so the detail map sticks to cloth and skin.
// Per-material: tAtlas (printed surfaces, sampled by uv), tDetail (tiling grime / bump / streak map),
// uBump, uDetScale, uSheen (wet / PVC reflection), uSss + uSssCol (light through thin skin), uEmisK.
const OBJ2_VS = /* glsl */`
#include <skinning_pars_vertex>
varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec3 vL; varying vec3 vLN;
#ifdef VCOL
attribute vec4 aCol; attribute vec4 aSurf;
varying vec4 vCol; varying vec4 vSurf;
#endif
void main(){
  vec3 transformed = position; vec3 objectNormal = normal;
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <skinning_vertex>
  vec4 w = modelMatrix * vec4(transformed, 1.0);
  vW = w.xyz; vL = position; vLN = normal; vN = normalize(mat3(modelMatrix) * objectNormal); vUv = uv;
#ifdef VCOL
  vCol = aCol; vSurf = aSurf;
#endif
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const OBJ_FS = /* glsl */`
varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec3 vL; varying vec3 vLN;
#ifdef VCOL
varying vec4 vCol; varying vec4 vSurf;
uniform sampler2D tAtlas;
#endif
uniform sampler2D tDetail;
uniform vec3 uColor; uniform vec3 uEmis; uniform float uGloss; uniform float uFabric; uniform float uAlpha;
uniform float uBump; uniform float uDetScale; uniform float uSheen; uniform float uSss; uniform vec3 uSssCol; uniform float uEmisK;
#ifdef MAP
uniform sampler2D tMap; uniform vec4 uMapK; uniform vec3 uMapTint;
#endif
${LIGHT}
void main(){
  vec3 Ng = normalize(vN); if (!gl_FrontFacing) Ng = -Ng;
  vec3 V = normalize(cameraPosition - vW);
  vec3 alb = uColor; float gloss = uGloss, sheen = uSheen, sss = uSss; vec3 emis = uEmis;
  // object-space planar projection on the dominant rest-pose axis
  vec3 an = abs(vLN);
  vec2 duv = (an.x > an.y && an.x > an.z) ? vL.zy : (an.y > an.z ? vL.xz : vL.xy);
  vec4 dt = texture(tDetail, duv * uDetScale);
  float grime = uFabric;
#ifdef VCOL
  vec3 base = vCol.rgb * texture(tAtlas, vUv).rgb;
  alb *= base; grime = vCol.a; gloss *= vSurf.x; sheen *= vSurf.y; sss *= vSurf.z;
  emis += base * vSurf.w * uEmisK;
#endif
#ifdef MAP
  {
    // baked-lit source textures (sRGB, decoded to linear by the sampler): keep the colour and pattern,
    // flatten most of the baked light (luminance l -> l^flat), cool the warm cast, so our own lighting does the work
    vec3 m = texture(tMap, vUv).rgb; float l = dot(m, vec3(0.2126, 0.7152, 0.0722));
    m = mix(vec3(l), m, uMapK.x) * pow(max(l, 1e-4), uMapK.y - 1.0) / uMapTint;
    alb *= m * uMapK.z; emis += m * uMapK.w * uEmisK;
  }
#endif
  vec4 db = texture(tDetail, duv * uDetScale * 0.21 + 0.37);
  // fade the detail out where the projection changes axis (rounded edges), so it leaves no seam
  float m1 = max(an.x, max(an.y, an.z)), m3 = min(an.x, min(an.y, an.z));
  float seam = smoothstep(0.03, 0.22, m1 - (an.x + an.y + an.z - m1 - m3));
  alb *= mix(1.0, mix(0.82, (0.5 + 0.75 * db.r) * (1.0 - 0.35 * dt.b), seam), grime);
  alb *= 0.9 + 0.2 * mix(0.5, dt.g, seam) * grime;
  gloss *= mix(1.0, mix(0.9, 0.45 + 0.9 * db.r, seam), grime * 0.8);
  vec3 N = Ng;
#if QUALITY > 0
  float bump = uBump * seam;
#ifdef VCOL
  bump *= clamp(2.2 - vSurf.x, 0.0, 1.0); // polished surfaces (gloss >= 2.2: lenses, glass, chrome) stay smooth
#endif
  {
    // Bump without screen derivatives (those break up into blocks and sparkle on skinned,
    // magnified surfaces): height slope from texel differences along the projection axes in
    // rest space, then turned from the rest normal onto the current (skinned, world) normal.
    vec2 uvD = duv * uDetScale; const float E = 1.0 / 256.0;
    float h0 = dt.g;
    vec2 g = vec2(texture(tDetail, uvD + vec2(E, 0.0)).g - h0, texture(tDetail, uvD + vec2(0.0, E)).g - h0) * (256.0 * uDetScale * bump);
    vec3 A = (an.x > an.y && an.x > an.z) ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 B = (an.x > an.y && an.x > an.z) ? vec3(0.0, 1.0, 0.0) : (an.y > an.z ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0));
    vec3 n0 = normalize(vLN);
    vec3 d = -(g.x * (A - n0 * dot(A, n0)) + g.y * (B - n0 * dot(B, n0)));
    if (!gl_FrontFacing) d = -d;
    // rotate the offset by the shortest arc from the rest normal to the shaded normal
    vec3 nr = gl_FrontFacing ? n0 : -n0;
    vec3 k = cross(nr, Ng); float s = length(k), c = dot(nr, Ng);
    if (s > 1e-4) { k /= s; d = d * c + cross(k, d) * s + k * dot(k, d) * (1.0 - c); }
    N = normalize(Ng + d);
  }
#endif
  vec3 col = shade(vW, N, Ng, alb, gloss, V);
  float ndv = max(dot(N, V), 0.0);
  float rim = pow(1.0 - ndv, 3.0);
  float ind = texture(uInd, (vW.xz / CS) / MAPN).r;
  float amb = ind * ind * 2.5 * uPulse * dk(vW.xz);
  col += rim * gloss * amb * vec3(0.5, 0.45, 0.3) * 0.1;
  // wet skin / PVC: reflect the lit ceiling, and the flashlight as a tight highlight
  // reflections use a calmer normal than diffuse: the full bump makes them glitter
  vec3 Ns = normalize(mix(Ng, N, 0.3));
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(Ns, V), 0.0), 5.0);
  if (sheen > 0.001) {
    vec3 R = reflect(-V, Ns);
    float sky = smoothstep(-0.15, 0.85, R.y);
    col += sheen * fres * sky * amb * vec3(1.0, 0.93, 0.72) * 0.13;
  }
  if (uFlash > 0.001) {
    vec3 L = uFlashPos - vW; float d2 = dot(L, L); vec3 Ld = L * inversesqrt(d2);
    float c = dot(-Ld, uFlashDir);
    float cone = (smoothstep(0.84, 0.95, c) * 0.5 + smoothstep(0.955, 0.992, c) * 0.8) * uFlash / (1.0 + 0.085 * d2);
    if (sheen > 0.001) {
      float s = pow(max(dot(Ns, normalize(Ld + V)), 0.0), 48.0) * (0.2 + fres * 2.5);
      col += vec3(0.92, 0.96, 1.0) * cone * s * sheen * 1.2;
    }
    if (sss > 0.001) {
      float wrap = max(0.0, dot(Ng, Ld) * 0.5 + 0.5) - max(dot(Ng, Ld), 0.0);
      col += alb * uSssCol * sss * cone * (wrap * 1.6 + pow(1.0 - ndv, 2.0) * 0.6);
    }
  }
  if (sss > 0.001) col += alb * uSssCol * sss * amb * 0.05;
#ifdef FLICK
  { // lit signs: hum with the lamps, brief stutters now and then, dark in blackouts and near the dark thing
    float ph = hash21(floor(vW.xz / 2.4));
    emis *= lampFlicker(1.0, ph) * mix(1.0, step(0.5, hash11(floor(uTime * 13.0 + ph * 77.0))), step(0.93, hash11(floor(uTime * 0.6 + ph * 31.0)))) * max(uPulse, 0.03) * dk(vW.xz);
  }
#endif
  col += emis;
  gl_FragColor = vec4(fog(col, vW), uAlpha);
}
`;
const BACKDROP_VS = /* glsl */`
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const BACKDROP_FS = /* glsl */`
varying vec3 vW;
${LIGHT}
void main(){
  vec3 dir = normalize(vW - cameraPosition);
  float d = uFogEnd.y + 2.0;
  vec3 P = cameraPosition + dir * d;
  P.y = clamp(P.y, cameraPosition.y - 1.6, cameraPosition.y + 1.2);
  gl_FragColor = vec4(fogColor(P, d) + haze(P), 1.0);
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
    uFogCol: { value: new THREE.Vector3(0.62, 0.53, 0.25) }, uFogDen: { value: 1 / 36 },
    // haze: lamps near the player (filled by World), overall air density, torch beam strength
    uHz: { value: world.hz }, uHzN: world.hzN, uHaze: { value: 1 }, uHazeFlash: { value: 1 }, uFogEnd: world.fogEnd,
  };
  const defines = () => ({ QUALITY: quality, SHADOW_STEPS: quality >= 2 ? 14 : 9 });
  const worldMat = new THREE.ShaderMaterial({
    vertexShader: WORLD_VS, fragmentShader: WORLD_FS, defines: defines(),
    uniforms: { ...shared, tWall: { value: tex.wall }, tWallN: { value: tex.wallN }, tCarpet: { value: tex.carpet }, tCarpetN: { value: tex.carpetN }, tCeil: { value: tex.ceil }, tCeilN: { value: tex.ceilN }, tNoise: { value: tex.noise } },
  });
  // fog-coloured backdrop behind all geometry (see World.setBackdrop)
  const backdrop = new THREE.ShaderMaterial({
    vertexShader: BACKDROP_VS, fragmentShader: BACKDROP_FS, defines: defines(), uniforms: { ...shared },
    side: THREE.BackSide, depthTest: false, depthWrite: false,
  });
  if (world.setBackdrop) world.setBackdrop(backdrop);
  const all = [worldMat, backdrop];
  // obj(color, { gloss, fabric (= grime amount without VCOL), emis, emisScale, alpha, side,
  //   vtx: true (per-vertex aCol/aSurf + atlas), atlas, detail, bump, detScale, sheen, sss, sssCol, emisK,
  //   map (sRGB baked texture) + mapSat, mapFlat, mapGain, mapEmis, mapTint, flicker (emissive follows the lamps) })
  const obj = (color, o = {}) => {
    const d = defines(); if (o.vtx) d.VCOL = 1; if (o.map) d.MAP = 1; if (o.flicker) d.FLICK = 1;
    const m = new THREE.ShaderMaterial({
      vertexShader: OBJ2_VS, fragmentShader: OBJ_FS, defines: d,
      uniforms: {
        ...shared, uColor: { value: new THREE.Color(color) }, uEmis: { value: new THREE.Color(o.emis || 0) }, uGloss: { value: o.gloss ?? 0.15 }, uFabric: { value: o.fabric ?? 0 }, uAlpha: { value: o.alpha ?? 1 },
        tAtlas: { value: o.atlas || null }, tDetail: { value: o.detail || null }, uBump: { value: o.bump ?? 0 }, uDetScale: { value: o.detScale ?? 6 },
        uSheen: { value: o.sheen ?? 0 }, uSss: { value: o.sss ?? 0 }, uSssCol: { value: new THREE.Color(o.sssCol ?? 0xff5030) }, uEmisK: { value: o.emisK ?? 1 },
        // map: baked source texture; mapSat (colour kept), mapFlat (baked light kept, 1 = all), mapGain, mapEmis, mapTint (cast to divide out)
        tMap: { value: o.map || null }, uMapK: { value: new THREE.Vector4(o.mapSat ?? 0.85, o.mapFlat ?? 0.7, o.mapGain ?? 1, o.mapEmis ?? 0) }, uMapTint: { value: new THREE.Color(o.mapTint ?? 0xffffff) },
      },
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
  const setQuality = (q) => {
    for (const m of all) { m.defines.QUALITY = q; m.defines.SHADOW_STEPS = q >= 2 ? 14 : 9; m.needsUpdate = true; }
    // draw distance and fog follow the tier: low keeps the old 46 m, medium and high see to 57 m
    if (world.setRange) world.setRange(q);
    shared.uFogDen.value = q > 0 ? 1 / 44 : 1 / 36;
  };
  setQuality(quality);
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
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tBlur; uniform sampler2D tHalo;
uniform vec2 uSrcTexel; uniform float uSharpen; uniform float uPostQ;
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
// condensation on the plate: out-of-focus droplets. m = coverage, n = slope (for refraction)
// (one drop per cell, kept inside its cell so a single lookup is enough)
float drops(vec2 p, out vec2 n){
  vec2 g = floor(p), f = fract(p);
  float hh = h21(g + 5.3);
  float rr = 0.08 + 0.24 * hh * hh;
  vec2 c = 0.5 + (h22(g) - 0.5) * (1.0 - 2.0 * rr) - f;
  float d = length(c) / rr;
  n = -c / rr;
  return hh < 0.3 ? 0.0 : max(1.0 - d * d, 0.0);
}
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
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
  // contrast-adaptive sharpen: the scene is rendered below the output size
  if (uSharpen > 0.0) {
    vec3 a1 = texture(tScene, uvl + vec2(uSrcTexel.x, 0.0)).rgb, a2 = texture(tScene, uvl - vec2(uSrcTexel.x, 0.0)).rgb;
    vec3 a3 = texture(tScene, uvl + vec2(0.0, uSrcTexel.y)).rgb, a4 = texture(tScene, uvl - vec2(0.0, uSrcTexel.y)).rgb;
    float l0 = luma(col), l1 = luma(a1), l2 = luma(a2), l3 = luma(a3), l4 = luma(a4);
    // compare in a compressed space so bright lamps do not dominate
    float c0 = l0 / (1.0 + l0), c1 = l1 / (1.0 + l1), c2 = l2 / (1.0 + l2), c3 = l3 / (1.0 + l3), c4 = l4 / (1.0 + l4);
    float mn = min(c0, min(min(c1, c2), min(c3, c4))), mx = max(c0, max(max(c1, c2), max(c3, c4)));
    float amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
    float w = -amp * mix(0.0, 0.2, uSharpen);
    col = max((col + w * (a1 + a2 + a3 + a4)) / (1.0 + 4.0 * w), 0.0);
  }
  vec3 bloom = texture(tBloom, uvl).rgb;
  vec3 blur = texture(tBlur, uvl).rgb;
  vec3 halo = texture(tHalo, uvl).rgb;
  col += bloom * 0.08;
  // halation: the widest glow round the lamps picks up a warm red edge
  col += halo * vec3(1.0, 0.42, 0.18) * 0.035;
  if (uVisor > 0.0) {
    float glare = dot(bloom, vec3(0.3)) * 0.22 + dot(blur, vec3(0.33)) * 0.05;
    float glareW = dot(halo, vec3(0.33));
    vec2 sp = vec2(p.x * asp, p.y);
    float sc = scratch(sp, 0.35, 260.0, 1.0) + scratch(sp, -1.05, 220.0, 2.0) * 0.8 + scratch(sp, 1.4, 300.0, 3.0) * 0.6 + scratch(sp, 2.5, 190.0, 4.0) * 0.5;
    col += sc * glare * vec3(1.0, 0.97, 0.9) * 0.3;
    // smudges and specks on the plate only show when light is behind them
    float smudge = smoothstep(0.45, 0.8, fb(sp * 1.7 + 3.0));
    float speck = step(0.985, h21(floor(sp * 70.0))) * 0.6 + step(0.96, h21(floor(sp * 23.0) + 4.0)) * 0.3;
    float lit = clamp(glare * 3.0 + glareW * 1.5, 0.0, 1.0);
    col = mix(col, blur, smudge * 0.12 * lit);
    col += (smudge * 0.12 * (glare + glareW * 0.6) + speck * 0.25 * glare) * vec3(1.0, 0.96, 0.86);
    // condensation: droplets gather along the gasket and where the breath fogs the plate
    if (uPostQ > 0.5) {
      float region = smoothstep(0.3, 0.06, inside) + uBreath * smoothstep(-0.35, -0.95, p.y);
      if (region > 0.02) {
        vec2 dn; float m = drops(sp * 16.0 + vec2(3.1, 7.7), dn);
        if (m <= 0.0) { m = drops(sp * 31.0 + vec2(11.0, 2.0), dn) * 0.8; }
        // out of focus: soft edged, they mostly bend and soften what is behind them
        float dm = smoothstep(0.0, 0.8, m) * clamp(region, 0.0, 1.0);
        vec3 refr = texture(tBlur, uvl - dn * 0.025).rgb;
        col = mix(col, refr, dm * 0.3);
        col += dm * pow(clamp(dn.y * 0.5 + 0.5, 0.0, 1.0), 6.0) * glare * 0.2;
      }
    }
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
  // grade: saturated mono-yellow (a touch of extra red keeps dark yellows off olive / green)
  col = max(mix(vec3(l), col, 1.06 - 0.58 * ins - 0.62 * uDead), 0.0);
  col *= vec3(1.06, 0.99, 0.8);
  col = pow(col, vec3(1.0 / 2.2));
  float vig = smoothstep(1.55, 0.35, length(p * vec2(0.9, 1.0)) + ins * 0.35);
  col *= mix(0.64, 1.0, vig);
  // grain: strongest in the mid tones like film, a floor of sensor noise in the dark
  float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float g = h21(uv * uRes + fract(uTime) * 311.0) - 0.5;
  float gc = h21(uv * uRes * 0.5 + fract(uTime * 1.7) * 217.0) - 0.5;
  col += (g + vec3(gc, 0.0, -gc) * 0.25 * (1.0 - l2)) * uGrain * (0.022 + 0.12 * l2 * (1.0 - l2));
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
