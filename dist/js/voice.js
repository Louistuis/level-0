// Proximity voice. Opt-in, push to talk. Peer to peer WebRTC audio between players
// who are close to each other; signalling rides on the game's event channel.
// The received voice is run through the suit-radio chain in audio.js and placed in 3D.
const ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const NEAR = 30, FAR = 42, MAX = 6;

export class Voice {
  constructor(net, audio) {
    this.net = net; this.audio = audio; this.enabled = false; this.talking = false;
    this.pcs = new Map(); this.track = null; this.stream = null; this.error = null;
    net.on('rtc', (from, d) => this._signal(from, d).catch(() => {}));
  }
  async enable() {
    if (this.enabled) return true;
    try {
      if (!navigator.mediaDevices || !window.RTCPeerConnection) throw new Error('unsupported');
      const raw = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.raw = raw; this.stream = this.audio.processMic(raw) || raw;
      this.track = this.stream.getAudioTracks()[0]; this.track.enabled = false;
      this.enabled = true; this.error = null; return true;
    } catch (e) { this.error = e && e.name === 'NotAllowedError' ? 'Microphone blocked' : 'No microphone'; this.enabled = false; return false; }
  }
  disable() {
    this.enabled = false; this.talking = false;
    for (const id of [...this.pcs.keys()]) this._drop(id);
    if (this.raw) for (const t of this.raw.getTracks()) t.stop();
    this.raw = this.stream = this.track = null;
  }
  setTalking(on) { this.talking = !!on && this.enabled; if (this.track) this.track.enabled = this.talking; }

  _pc(id) {
    let e = this.pcs.get(id); if (e) return e;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    e = { pc, made: performance.now(), has: false };
    this.pcs.set(id, e);
    if (this.track) pc.addTrack(this.track, this.stream);
    pc.onicecandidate = (ev) => { if (ev.candidate) this.net.send('rtc', { ice: ev.candidate.toJSON() }, id); };
    pc.ontrack = (ev) => { const s = ev.streams[0] || new MediaStream([ev.track]); this.audio.attachVoice(id, s); e.has = true; };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._drop(id); };
    return e;
  }
  _drop(id) { const e = this.pcs.get(id); if (!e) return; try { e.pc.close(); } catch { /* closed */ } this.audio.detachVoice(id); this.pcs.delete(id); }
  async _signal(from, d) {
    if (!this.enabled) return;
    if (d.sdp) {
      const e = this._pc(from);
      await e.pc.setRemoteDescription(d.sdp);
      if (d.sdp.type === 'offer') { const a = await e.pc.createAnswer(); await e.pc.setLocalDescription(a); this.net.send('rtc', { sdp: e.pc.localDescription.toJSON() }, from); }
    } else if (d.ice) { const e = this.pcs.get(from); if (e) await e.pc.addIceCandidate(d.ice); }
    else if (d.bye) this._drop(from);
  }
  // near: [{ id, d, x, y, z, v }]  v = that player has voice switched on
  update(near) {
    if (!this.enabled) return;
    const want = near.filter((p) => p.v && p.d < NEAR).sort((a, b) => a.d - b.d).slice(0, MAX);
    for (const p of want) {
      if (this.pcs.has(p.id) || !(String(this.net.id) < String(p.id))) continue;
      const e = this._pc(p.id);
      e.pc.createOffer().then((o) => e.pc.setLocalDescription(o)).then(() => this.net.send('rtc', { sdp: e.pc.localDescription.toJSON() }, p.id)).catch(() => this._drop(p.id));
    }
    const by = new Map(near.map((p) => [p.id, p]));
    for (const [id, e] of this.pcs) {
      const p = by.get(id);
      if (!p || p.d > FAR || !p.v) { this.net.send('rtc', { bye: 1 }, id); this._drop(id); continue; }
      if (e.has) this.audio.setVoicePos(id, p.x, p.y + 1.6, p.z);
      if (!e.has && performance.now() - e.made > 20000) this._drop(id);
    }
  }
}
