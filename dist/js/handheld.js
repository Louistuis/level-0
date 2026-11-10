// The handheld: a battered survey unit you hold up while you walk. Left, a scrap of the map
// turned the way you are facing. Right, an analog radar: a sweeping trace on slow phosphor
// that picks up people nearby, and sometimes things that are not people. It glitches.
import { clamp } from './util.js';

const RANGE = 60;          // metres shown on the scope
const SWEEP = 2.6;         // seconds per revolution
const W = 380, H = 214;    // design size of the unit, scaled to the screen
const FONT = '"Troffer Sign", "Helvetica Neue", Helvetica, Arial, sans-serif';

export function createHandheld(o) {
  const cv = document.createElement('canvas');
  cv.id = 'handheld'; cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:fixed;z-index:3;pointer-events:none;right:max(8.5%,env(safe-area-inset-right));bottom:calc(max(11%,env(safe-area-inset-bottom)) + 58px);transform-origin:100% 100%;will-change:transform,opacity;opacity:0';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const scope = document.createElement('canvas'), sx = scope.getContext('2d');   // phosphor: never fully cleared
  const mini = document.createElement('canvas'), mx = mini.getContext('2d');
  let on = false, raise = 0, t = 0, acc = 0, ang = 0, scale = 1, dpr = 1, glitch = 0, nextGlitch = 6, tear = 0, bob = 0, seen = 0, miniT = 9;
  const tags = new Map();   // call signs of the units that answered on the last pass
  const R = 83, SR = 256;   // scope radius on the unit, phosphor buffer size
  scope.width = scope.height = SR; mini.width = mini.height = 300;
  sx.fillStyle = '#020a05'; sx.fillRect(0, 0, SR, SR);
  try { on = localStorage.getItem('level0.hand') === '1'; } catch (e) { /* no storage */ }

  function fit() {
    const touch = o.isTouch && o.isTouch();
    scale = clamp(Math.min(innerWidth / 1180, innerHeight / 720), touch ? 0.8 : 0.6, 1.3) * (touch ? 0.72 : 1);
    if (touch) {   // stay clear of the touch buttons; small landscape phones get a smaller unit
      let maxW = innerWidth - 2 * Math.max(innerWidth * 0.085, 12) - 56;
      if (innerWidth > innerHeight && innerWidth < 740) maxW = Math.min(maxW, 220);
      scale = Math.min(scale, maxW / W);
    }
    dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(W * scale * dpr); cv.height = Math.round(H * scale * dpr);
    cv.style.width = W * scale + 'px'; cv.style.height = H * scale + 'px';
    // on touch screens the right corner belongs to the buttons: hold it top left instead
    if (touch) { cv.style.right = 'auto'; cv.style.bottom = 'auto'; cv.style.left = 'max(8.5%,env(safe-area-inset-left))'; cv.style.top = 'calc(max(11%,env(safe-area-inset-top)) + 96px)'; cv.style.transformOrigin = '0 0'; }
    else { cv.style.left = 'auto'; cv.style.top = 'auto'; cv.style.right = 'max(8.5%,env(safe-area-inset-right))'; cv.style.bottom = 'calc(max(11%,env(safe-area-inset-bottom)) + 58px)'; cv.style.transformOrigin = '100% 100%'; }
  }
  addEventListener('resize', fit); fit();

  const rr = (c, x, y, w, h, r) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };

  // one phosphor step: decay, advance the trace, paint whatever it crosses
  function sweepStep(dt, me, s) {
    const c = SR / 2, rad = SR / 2 - 6;
    sx.globalCompositeOperation = 'source-over';
    sx.fillStyle = `rgba(2,10,5,${clamp(dt * 0.8, 0.018, 0.4)})`;   // slow phosphor: an echo lasts about one sweep sx.fillRect(0, 0, SR, SR);
    const a0 = ang; let da = (dt / SWEEP) * Math.PI * 2;
    if (glitch > 0) da *= Math.random() < 0.12 ? -0.4 : 0.5 + Math.random() * 0.8;   // the motor stutters
    ang = (ang + da + Math.PI * 2) % (Math.PI * 2);
    if (ang < a0 && da > 0) o.sound && o.sound('radarSweep');
    sx.globalCompositeOperation = 'lighter';
    // the trace itself, with a little ground clutter along it
    // what the beam has just passed over glows as a wedge and fades; the bright edge is drawn live in draw()
    if (Math.abs(da) > 1e-4) { sx.fillStyle = 'rgba(70,235,130,.038)'; sx.beginPath(); sx.moveTo(c, c); sx.arc(c, c, rad, a0 - Math.PI / 2, a0 + da - Math.PI / 2, da < 0); sx.closePath(); sx.fill(); }
    for (let i = 0; i < 2; i++) { const r = Math.random() * rad, n = ang + (Math.random() - 0.5) * 0.03; sx.fillStyle = `rgba(110,255,160,${0.03 + Math.random() * 0.05})`; sx.fillRect(c + Math.sin(n) * r, c - Math.cos(n) * r, 1.6, 1.6); }
    if (!me) return;
    const hit = (b) => { let d = (b - a0 + Math.PI * 4) % (Math.PI * 2); return d < Math.abs(da) + 0.001 || (da < 0 && (a0 - b + Math.PI * 4) % (Math.PI * 2) < -da); };
    const paint = (x, z, kind, name) => {
      const dx = x - me.x, dz = z - me.z, d = Math.hypot(dx, dz);
      if (d > RANGE || d < 0.6) return;
      // bearing relative to where you face: up on the scope is straight ahead
      let b = Math.atan2(dx, -dz) + me.yaw; b = (b % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      if (!hit(b)) return;
      const far = d / RANGE, wob = (kind === 'thing' ? 0.08 : 0.004 + far * 0.012) * (1 + s.unease * 2);
      if (kind === 'thing' && Math.random() < 0.45) return;                          // it does not always answer
      const bb = b + (Math.random() - 0.5) * wob, r = (d / RANGE) * rad * (1 + (Math.random() - 0.5) * wob);
      const px = c + Math.sin(bb) * r, py = c - Math.cos(bb) * r, str = kind === 'thing' ? 0.55 : 1 - far * 0.45;
      const gr = sx.createRadialGradient(px, py, 0, px, py, kind === 'thing' ? 11 : 9);
      gr.addColorStop(0, `rgba(215,255,225,${str})`); gr.addColorStop(0.35, `rgba(90,255,150,${str * 0.6})`); gr.addColorStop(1, 'rgba(40,200,100,0)');
      sx.fillStyle = gr; sx.beginPath(); sx.arc(px, py, kind === 'thing' ? 11 : 9, 0, 6.3); sx.fill(); sx.fillStyle = `rgba(240,255,245,${Math.min(1, str + 0.25)})`; sx.beginPath(); sx.arc(px, py, kind === 'thing' ? 2.6 : 3.6, 0, 6.3); sx.fill();
      if (kind === 'thing') { sx.fillStyle = `rgba(90,255,150,${0.25 + Math.random() * 0.2})`; sx.fillRect(px - 10 + Math.random() * 6, py + (Math.random() - 0.5) * 8, 14, 1.4); o.sound && o.sound('radarGhost', { vol: 0.5 }); }
      else {
        // a friendly unit answers: bracket and call sign burn in with the blip
        sx.strokeStyle = `rgba(150,255,190,${str * 0.8})`; sx.lineWidth = 1.2; sx.beginPath(); sx.moveTo(px - 9, py - 5); sx.lineTo(px - 9, py - 9); sx.lineTo(px - 5, py - 9); sx.moveTo(px + 9, py + 5); sx.lineTo(px + 9, py + 9); sx.lineTo(px + 5, py + 9); sx.stroke();
        tags.set(String(name || '?'), { x: px / SR, y: py / SR, t });
        o.sound && o.sound('radarBlip', { vol: 0.5 + (1 - far) * 0.4, pitch: 1 - far }); seen++;
      }
    };
    for (const p of (o.getPeers && o.getPeers()) || []) if (Number.isFinite(p.x)) paint(p.x, p.z, 'friend', p.name);
    for (const e of (o.getThings && o.getThings()) || []) if (Number.isFinite(e.x)) paint(e.x, e.z, 'thing');
    // when your head is going, the scope starts finding people who are not there
    if ((glitch > 0 && Math.random() < 0.35) || Math.random() < s.unease * 0.012) { const r = Math.random() * rad; sx.fillStyle = `rgba(160,255,200,${0.2 + Math.random() * 0.4})`; sx.beginPath(); sx.arc(c + Math.sin(ang) * r, c - Math.cos(ang) * r, 2 + Math.random() * 4, 0, 6.3); sx.fill(); }
  }

  function draw(me, s) {
    const k = scale * dpr; ctx.setTransform(k, 0, 0, k, 0, 0); ctx.clearRect(0, 0, W, H);
    // the case: rubberised olive housing, worn at the edges
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 10;
    const body = ctx.createLinearGradient(0, 0, 0, H); body.addColorStop(0, '#3b3d2c'); body.addColorStop(0.5, '#2c2e21'); body.addColorStop(1, '#1d1e16');
    ctx.fillStyle = body; rr(ctx, 6, 8, W - 12, H - 16, 16); ctx.fill(); ctx.restore();
    ctx.strokeStyle = 'rgba(255,245,200,.1)'; ctx.lineWidth = 1; rr(ctx, 7.5, 9.5, W - 15, H - 19, 15); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; rr(ctx, 12, 14, W - 24, H - 28, 11); ctx.stroke();
    for (const [x, y] of [[20, 22], [W - 20, 22], [20, H - 22], [W - 20, H - 22]]) { ctx.fillStyle = '#14150f'; ctx.beginPath(); ctx.arc(x, y, 3.4, 0, 6.3); ctx.fill(); ctx.strokeStyle = 'rgba(255,245,200,.16)'; ctx.beginPath(); ctx.moveTo(x - 2, y - 1); ctx.lineTo(x + 2, y + 1); ctx.stroke(); }

    // left: the map scrap under a clip, turned to face the way you face
    const mxw = 150, mxh = 150, mX = 30, mY = 36;
    ctx.save(); ctx.translate(mX + mxw / 2, mY + mxh / 2); ctx.rotate(-0.025); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#e7dfc6'; ctx.fillRect(-mxw / 2, -mxh / 2, mxw, mxh); ctx.shadowColor = 'transparent';
    ctx.drawImage(mini, -mxw / 2, -mxh / 2, mxw, mxh);
    ctx.strokeStyle = '#a8281c'; ctx.fillStyle = '#a8281c'; ctx.lineWidth = 1.6;      // you, always in the middle, always pointing up
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(5.5, 6); ctx.lineTo(0, 2.5); ctx.lineTo(-5.5, 6); ctx.closePath(); ctx.fill();
    const g2 = ctx.createLinearGradient(0, -mxh / 2, 0, mxh / 2); g2.addColorStop(0, 'rgba(60,45,10,.22)'); g2.addColorStop(0.3, 'rgba(60,45,10,0)'); g2.addColorStop(1, 'rgba(60,45,10,.16)');
    ctx.fillStyle = g2; ctx.fillRect(-mxw / 2, -mxh / 2, mxw, mxh);
    ctx.restore();
    ctx.fillStyle = '#8d8f86'; rr(ctx, mX + 52, 26, 46, 18, 3); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(mX + 55, 28, 40, 2); ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(mX + 52, 41, 46, 3);
    if (me) {   // north, so the scrap can be read against the big sheet
      const nx = mX + mxw - 14, ny = mY + 16; ctx.save(); ctx.translate(nx, ny); ctx.rotate(me.yaw); ctx.strokeStyle = '#1b2230'; ctx.fillStyle = '#1b2230'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(0, 7); ctx.lineTo(0, -7); ctx.lineTo(-3, -2); ctx.moveTo(0, -7); ctx.lineTo(3, -2); ctx.stroke(); ctx.font = `700 8px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('N', 0, -9); ctx.restore();
    }

    // right: the scope
    const cx = W - 104, cy = H / 2 + 1;
    ctx.fillStyle = '#0d0e0a'; ctx.beginPath(); ctx.arc(cx, cy, R + 11, 0, 6.3); ctx.fill();
    const bz = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R); bz.addColorStop(0, '#5b5d52'); bz.addColorStop(0.5, '#25261f'); bz.addColorStop(1, '#4a4c42');
    ctx.strokeStyle = bz; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(cx, cy, R + 6, 0, 6.3); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.3); ctx.clip();
    const flick = glitch > 0 ? 0.78 + Math.random() * 0.26 : 0.97 + Math.random() * 0.03;
    ctx.globalAlpha = flick; ctx.drawImage(scope, cx - R, cy - R + (glitch > 0 ? (Math.random() - 0.5) * 3 : 0), R * 2, R * 2); ctx.globalAlpha = 1;
    if (tear > 0) { const ty = cy - R + Math.random() * R * 2, th = 3 + Math.random() * 9; ctx.drawImage(cv, (cx - R) * k, ty * k, R * 2 * k, th * k, cx - R + (Math.random() - 0.5) * 12, ty, R * 2, th); }
    // the beam's leading edge, and the call signs that answered it
    if (glitch <= 0 || Math.random() < 0.5) { ctx.strokeStyle = 'rgba(190,255,215,.75)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(ang) * R, cy - Math.cos(ang) * R); ctx.stroke(); }
    ctx.font = `700 10.5px ${FONT}`;
    for (const [nm, g] of tags) {
      const age = (t - g.t) / (SWEEP * 1.15); if (age > 1 || age < 0) { tags.delete(nm); continue; }
      const px = cx - R + g.x * R * 2, py = cy - R + g.y * R * 2;
      const txt = nm.replace(/^@/, '').slice(0, 8).toUpperCase(), tw = ctx.measureText(txt).width, right = px > cx, tx = px + (right ? -9 : 9), a = Math.min(1, (1 - age) * 1.6);
      ctx.fillStyle = `rgba(2,12,6,${a * 0.72})`; ctx.fillRect(right ? tx - tw - 3 : tx - 3, py - 15, tw + 6, 13);
      ctx.fillStyle = `rgba(205,255,225,${a})`; ctx.textAlign = right ? 'right' : 'left'; ctx.fillText(txt, tx, py - 5);
    }
    // graticule etched on the glass
    ctx.strokeStyle = 'rgba(130,255,180,.34)'; ctx.lineWidth = 0.9;
    for (const f of [1 / 3, 2 / 3, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f - 1, 0, 6.3); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    for (let i = 0; i < 36; i++) { const a = (i / 36) * 6.283, r0 = R - (i % 3 ? 4 : 8); ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0); ctx.lineTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R); ctx.stroke(); }
    ctx.fillStyle = 'rgba(150,255,190,.8)'; ctx.beginPath(); ctx.moveTo(cx, cy - 5); ctx.lineTo(cx + 3.5, cy + 4); ctx.lineTo(cx - 3.5, cy + 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(160,255,200,.85)'; ctx.font = `700 9.5px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText('20', cx + 3, cy - R / 3 + 9); ctx.fillText('40', cx + 3, cy - (R * 2) / 3 + 9); ctx.fillText('60 M', cx + 3, cy - R + 11);
    // scan lines, and the curve of the tube
    ctx.fillStyle = 'rgba(0,0,0,.07)'; for (let y = cy - R; y < cy + R; y += 3) ctx.fillRect(cx - R, y, R * 2, 1);
    const gl = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.45, 4, cx, cy, R); gl.addColorStop(0, 'rgba(255,255,255,.13)'); gl.addColorStop(0.3, 'rgba(255,255,255,.02)'); gl.addColorStop(0.75, 'rgba(0,0,0,0)'); gl.addColorStop(1, 'rgba(0,0,0,.38)');
    ctx.fillStyle = gl; ctx.fillRect(cx - R, cy - R, R * 2, R * 2); ctx.restore();

    // lamp and legend
    const blink = glitch > 0 ? Math.random() < 0.5 : (t % 1.3) < 0.65;
    ctx.fillStyle = blink ? '#ff5a3c' : '#3a120c'; ctx.beginPath(); ctx.arc(W - 30, 30, 3.2, 0, 6.3); ctx.fill();
    if (blink) { ctx.fillStyle = 'rgba(255,90,60,.25)'; ctx.beginPath(); ctx.arc(W - 30, 30, 7, 0, 6.3); ctx.fill(); }
    ctx.fillStyle = 'rgba(231,223,198,.62)'; ctx.font = `700 8.5px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText(glitch > 0 ? 'NO SIGNAL' : 'SCAN', W - 38, 33);
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(231,223,198,.5)'; ctx.fillText('SURVEY UNIT 0', 30, H - 20);
    ctx.textAlign = 'right'; ctx.fillText(o.hint || '', W - 24, H - 20);
  }

  const api = {
    get on() { return on; },
    set(v) { v = !!v; if (v === on) return; on = v; try { localStorage.setItem('level0.hand', on ? '1' : '0'); } catch (e) { /* no storage */ } o.sound && o.sound(on ? 'radarOn' : 'radarOff'); if (on) fit(); },
    toggle() { api.set(!on); },
    // every frame from the game loop. s: { show, sanity (1 = fine), fear, speed }
    update(dt, s = {}) {
      const want = on && s.show ? 1 : 0;
      raise += (want - raise) * clamp(dt * 9, 0, 1);
      if (raise < 0.01 && !want) { if (cv.style.opacity !== '0') cv.style.opacity = '0'; return; }
      t += dt; acc += dt; miniT += dt;
      const unease = clamp((1 - (s.sanity ?? 1)) * 0.8 + (s.fear || 0) * 0.6, 0, 1);
      nextGlitch -= dt * (1 + unease * 3);
      if (nextGlitch <= 0) { glitch = 0.12 + Math.random() * (0.22 + unease * 0.5); nextGlitch = 9 + Math.random() * 21; }
      if (glitch > 0) { glitch -= dt; tear = Math.random() < 0.45 ? 1 : 0; } else tear = Math.random() < 0.0012 + unease * 0.012 ? 1 : 0;
      bob += dt * (2 + (s.speed || 0) * 3.2);
      const sway = Math.min(1, (s.speed || 0) / 3), touch = o.isTouch && o.isTouch();
      const drop = (1 - raise) * (touch ? -70 : 70);
      cv.style.opacity = String(clamp(raise * 1.4, 0, 1));
      cv.style.transform = `translate3d(${(Math.sin(bob * 0.5) * 5 * sway).toFixed(1)}px,${(drop + Math.abs(Math.cos(bob * 0.5)) * 7 * sway).toFixed(1)}px,0) rotate(${(-2.2 + Math.sin(bob * 0.5) * 0.7 * sway + (1 - raise) * 8).toFixed(2)}deg)`;
      if (acc < 1 / 24) return;                       // the unit redraws at film rate; that is plenty and it looks right
      const me = o.getPlayer && o.getPlayer(), step = acc; acc = 0;
      sweepStep(step, me, { unease });
      if (me && miniT > 0.2 && o.map && o.map.mini) { miniT = 0; try { o.map.mini(mx, 300, 300, 5, me); } catch (e) { /* map not ready */ } }
      draw(me, { unease });
    },
    redraw() { fit(); },
  };
  return api;
}
