// 8-bit sound effects, generated with WebAudio (no sound files): square and triangle tones
// with short envelopes, and noise bursts for gunfire and artillery. Muting is remembered.

type Wave = 'square' | 'triangle' | 'sawtooth' | 'sine';

const STORE = 'openfork.muted';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastAt = new Map<string, number>();
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(STORE) === '1';
    } catch {
      // storage blocked: start unmuted
    }
  }

  /** Browsers only allow audio after a user gesture: call from input handlers. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  setMuted(on: boolean): void {
    this.muted = on;
    try {
      localStorage.setItem(STORE, on ? '1' : '0');
    } catch {
      // not remembered, fine
    }
  }

  /** Skips a sound that played less than `gap` ms ago (so bursts don't pile up). */
  private gate(name: string, gap: number): boolean {
    const now = performance.now();
    if (now - (this.lastAt.get(name) ?? -Infinity) < gap) return false;
    this.lastAt.set(name, now);
    return true;
  }

  private on(): AudioContext | null {
    return this.muted || !this.ctx || !this.master ? null : this.ctx;
  }

  /** A tone: `freq` Hz (sliding to `to`), starting `at` s from now, lasting `dur` s. */
  private tone(wave: Wave, freq: number, dur: number, volume: number, at = 0, to = freq): void {
    const ctx = this.on();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, t);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master as GainNode);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A burst of filtered noise. */
  private hiss(dur: number, volume: number, filter: number, at = 0, sweepTo = filter): void {
    const ctx = this.on();
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.6 + Math.random() * 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(filter, t);
    if (sweepTo !== filter) lp.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(gain).connect(this.master as GainNode);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  // -- orders and UI -----------------------------------------------------------------------

  select(): void {
    if (this.gate('select', 60)) this.tone('square', 880, 0.04, 0.12);
  }

  /** "Roger": two quick rising blips. */
  move(): void {
    if (!this.gate('move', 120)) return;
    this.tone('square', 660, 0.05, 0.13);
    this.tone('square', 990, 0.06, 0.13, 0.06);
  }

  place(): void {
    if (!this.gate('place', 80)) return;
    this.tone('triangle', 180, 0.12, 0.3, 0, 90);
    this.hiss(0.08, 0.15, 1200);
  }

  refuse(): void {
    if (this.gate('refuse', 200)) this.tone('square', 160, 0.18, 0.14, 0, 120);
  }

  tick(): void {
    if (this.gate('tick', 45)) this.tone('square', 1400, 0.015, 0.04);
  }

  // -- combat ------------------------------------------------------------------------------

  /** Small-arms fire: two or three sharp cracks. */
  gun(volume: number): void {
    if (!this.gate('gun', 140)) return;
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) this.hiss(0.05, 0.25 * volume, 3500, i * (0.05 + Math.random() * 0.05));
  }

  /** An artillery round: a low boom with a falling rumble. */
  boom(volume: number): void {
    if (!this.gate('boom', 350)) return;
    this.hiss(0.6, 0.55 * volume, 900, 0, 120);
    this.tone('triangle', 110, 0.45, 0.35 * volume, 0, 40);
  }

  // -- events ------------------------------------------------------------------------------

  /** You took a region: a short rising fanfare. */
  captured(): void {
    if (!this.gate('captured', 400)) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone('square', f, 0.09, 0.12, i * 0.075));
  }

  /** You lost a region: a falling sting. */
  lost(): void {
    if (!this.gate('lost', 600)) return;
    [392, 311, 233].forEach((f, i) => this.tone('square', f, 0.14, 0.13, i * 0.12));
  }

  built(): void {
    if (!this.gate('built', 300)) return;
    this.tone('triangle', 1047, 0.15, 0.18);
    this.tone('triangle', 1568, 0.25, 0.14, 0.09);
  }

  /** War declared on you: an alarm. */
  alarm(): void {
    if (!this.gate('alarm', 1500)) return;
    for (let i = 0; i < 4; i++) this.tone('sawtooth', i % 2 ? 440 : 587, 0.16, 0.12, i * 0.17);
  }

  /** Peace offered to you: a bell. */
  bell(): void {
    if (!this.gate('bell', 1000)) return;
    this.tone('sine', 880, 0.9, 0.2);
    this.tone('sine', 1320, 0.7, 0.08, 0.01);
  }

  /** Victory (up) or defeat (down): a longer jingle. */
  jingle(win: boolean): void {
    const notes = win ? [523, 659, 784, 1047, 784, 1047] : [523, 466, 415, 349, 311, 262];
    notes.forEach((f, i) => this.tone('square', f, 0.18, 0.14, i * 0.16));
  }
}
