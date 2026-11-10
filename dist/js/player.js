// First person controller on the heightfield: walking, sprinting, crouching,
// stairs, ledges, head bob and the hand-held flashlight.
import * as THREE from './three.module.min.js';
import { S, SEC_M, clamp, damp } from './util.js';

const R = 0.24, H_STAND = 1.75, H_CROUCH = 1.0, EYE_STAND = 1.62, EYE_CROUCH = 0.92;

// circle (player radius) against an oriented box { x, z, c: cos yaw, s: sin yaw, hx, hz }
function boxHit(c, x, z) {
  const dx = x - c.x, dz = z - c.z, lx = dx * c.c - dz * c.s, lz = dx * c.s + dz * c.c;
  const qx = Math.max(Math.abs(lx) - c.hx, 0), qz = Math.max(Math.abs(lz) - c.hz, 0);
  return qx * qx + qz * qz < R * R;
}

export class Player {
  constructor(world, camera) {
    this.world = world; this.cam = camera;
    this.x = 0; this.y = 0; this.z = 0; this.vy = 0;
    this.yaw = 0; this.pitch = 0;
    this.vx = 0; this.vz = 0;
    this.crouch = false; this.sprinting = false; this.onGround = true;
    this.stamina = 1; this.winded = false; this.restT = 0;
    this.eye = EYE_STAND; this.sy = 0; this.bob = 0; this.bobAmt = 0; this.roll = 0; this.kick = 0;
    this.speed = 0; this.noise = 0; this.moved = 0;
    this.keys = new Set(); this.lookX = 0; this.lookY = 0;
    this.flashOn = false; this.flashDir = new THREE.Vector3(0, 0, -1); this.flashPos = new THREE.Vector3();
    this.frozen = false;
    this.onStep = () => {};
    this.shake = 0;
    this._f = new THREE.Vector3(); this._r = new THREE.Vector3(); this._u = new THREE.Vector3();
  }
  place(x, y, z, yaw = 0) { this.x = x; this.y = y; this.z = z; this.sy = y; this.vy = 0; this.vx = this.vz = 0; this.yaw = yaw; this.pitch = 0; this.onGround = true; }

  // Ground height if a body of height h fits at (x, z) with feet at `feet`, else null.
  fits(x, z, feet, h) {
    const w = this.world;
    const x0 = Math.floor((x - R) / S), x1 = Math.floor((x + R) / S), z0 = Math.floor((z - R) / S), z1 = Math.floor((z + R) / S);
    let g = -1e9;
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      if (w.solid(cx, cz)) return null;
      const f = w.floorC(cx, cz), c = w.ceilC(cx, cz);
      if (f > feet + 0.36) return null;
      if (c - Math.max(f, feet) < h) return null;
      if (f > g) g = f;
    }
    if (this.blocked(x, z)) return null;
    return g;
  }
  // furniture from the model pack: oriented boxes in SectorProps.colliders (one we already overlap is ignored)
  blocked(x, z) {
    const w = this.world; if (!w.sec) return false;
    const sx0 = Math.floor((x - R) / SEC_M), sx1 = Math.floor((x + R) / SEC_M), sz0 = Math.floor((z - R) / SEC_M), sz1 = Math.floor((z + R) / SEC_M);
    for (let sz = sz0; sz <= sz1; sz++) for (let sx = sx0; sx <= sx1; sx++) {
      const s = w.sec(sx, sz), cl = s && s.props && s.props.colliders;
      if (!cl) continue;
      for (const c of cl) if (boxHit(c, x, z) && !boxHit(c, this.x, this.z)) return true;
    }
    return false;
  }

  update(dt, inp, set) {
    const sens = 0.0021 * (set.sens || 1);
    this.yaw -= this.lookX * sens; this.pitch -= this.lookY * sens * (set.invertY ? -1 : 1);
    this.lookX = this.lookY = 0;
    this.pitch = clamp(this.pitch, -1.5, 1.5);
    let mx = inp.mx, mz = inp.my;
    if (this.frozen) { mx = 0; mz = 0; }
    const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
    const moving = len > 0.05;
    // crouch
    const wantCrouch = inp.crouch && !this.frozen;
    if (wantCrouch) this.crouch = true;
    else if (this.crouch && this.fits(this.x, this.z, this.y, H_STAND) !== null) this.crouch = false;
    const h = this.crouch ? H_CROUCH : H_STAND;
    // sprint and stamina
    const wantSprint = inp.sprint && moving && mz > 0.2 && !this.crouch && !this.winded;
    this.sprinting = wantSprint;
    if (wantSprint) { this.stamina = Math.max(0, this.stamina - dt / 7.5); this.restT = 0; if (this.stamina <= 0) this.winded = true; }
    else { this.restT += dt; if (this.restT > 0.9) this.stamina = Math.min(1, this.stamina + dt / (moving ? 13 : 8)); if (this.stamina > 0.3) this.winded = false; }
    const top = this.crouch ? 1.05 : (wantSprint ? 4.7 : 2.15) * (this.winded ? 0.85 : 1);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const tx = (-sy * mz + cy * mx) * top, tz = (-cy * mz - sy * mx) * top;
    const acc = this.onGround ? 11 : 2;
    this.vx = damp(this.vx, tx, acc, dt); this.vz = damp(this.vz, tz, acc, dt);
    // horizontal move with sliding
    const nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
    let g = this.fits(nx, nz, this.y, h);
    if (g !== null) { this.x = nx; this.z = nz; }
    else {
      g = this.fits(nx, this.z, this.y, h);
      if (g !== null) { this.x = nx; this.vz *= 0.5; }
      else { g = this.fits(this.x, nz, this.y, h); if (g !== null) { this.z = nz; this.vx *= 0.5; } else { this.vx = this.vz = 0; } }
    }
    g = this.fits(this.x, this.z, this.y, h);
    if (g === null) g = this.world.floorAt(this.x, this.z);
    // vertical
    if (g > this.y) { this.y = g; this.vy = 0; this.onGround = true; }
    else if (g < this.y - 0.001) {
      if (this.onGround && this.y - g <= 0.37) { this.y = g; }
      else {
        this.onGround = false; this.vy -= 19 * dt; this.y += this.vy * dt;
        if (this.y <= g) { const hit = -this.vy; this.y = g; this.vy = 0; this.onGround = true; if (hit > 3) { this.onStep('land', clamp(hit / 9, 0.3, 1)); this.kick = clamp(hit / 14, 0, 0.6); } }
      }
    } else this.onGround = true;
    this.speed = Math.hypot(this.vx, this.vz);
    // steps
    const stride = this.crouch ? 0.55 : (this.sprinting ? 1.02 : 0.74);
    if (this.onGround && this.speed > 0.4) {
      this.moved += this.speed * dt; this.bob += (this.speed * dt) / stride;
      if (this.moved >= stride) {
        this.moved -= stride;
        const stair = Math.abs(this.world.floorAt(this.x + this.vx * 0.2, this.z + this.vz * 0.2) - this.y) > 0.1;
        this.onStep(this.crouch ? 'crouch' : (stair ? 'stair' : 'carpet'), this.sprinting ? 1 : (this.crouch ? 0.25 : 0.55));
      }
    }
    this.noise = !this.onGround ? 0.2 : this.speed < 0.4 ? 0 : this.crouch ? 0.1 : this.sprinting ? 1 : 0.42;
    // camera
    this.sy = damp(this.sy, this.y, 16, dt);
    if (Math.abs(this.sy - this.y) > 1.2) this.sy = this.y;
    this.eye = damp(this.eye, this.crouch ? EYE_CROUCH : EYE_STAND, 10, dt);
    this.bobAmt = damp(this.bobAmt, this.onGround ? clamp(this.speed / 2.2, 0, 1.7) : 0, 8, dt);
    this.kick = damp(this.kick, 0, 7, dt);
    const hb = set.headbob === false ? 0.25 : 1;
    const by = Math.sin(this.bob * Math.PI * 2) * 0.03 * this.bobAmt * hb - this.kick * 0.25;
    const bx = Math.cos(this.bob * Math.PI) * 0.022 * this.bobAmt * hb;
    this.roll = damp(this.roll, -mx * 0.014 * (moving ? 1 : 0), 6, dt);
    const sh = this.shake;
    const c = this.cam;
    c.rotation.order = 'YXZ';
    c.rotation.set(this.pitch + by * 0.25 + (Math.random() - 0.5) * sh * 0.03, this.yaw + (Math.random() - 0.5) * sh * 0.03, this.roll + bx * 0.35);
    c.position.set(this.x + cy * bx, this.sy + this.eye + by, this.z - sy * bx);
    c.updateMatrixWorld();
    // flashlight trails the view a little, like a hand does
    c.getWorldDirection(this._f);
    this.flashDir.lerp(this._f, 1 - Math.exp(-13 * dt)).normalize();
    this._r.set(cy, 0, -sy);
    this.flashPos.copy(c.position).addScaledVector(this._r, 0.17).addScaledVector(this._f, 0.1); this.flashPos.y -= 0.2;
  }
}
