// Short-lived visual effects drawn over the map: smoke, flashes, dust, sparks and floating
// numbers. They live in map coordinates (so they stay put while you pan) and are drawn at
// the same whole-pixel scale as the unit tokens.
import { INK, pixelDigits } from './sprites.ts';

export type FxKind = 'smoke' | 'flash' | 'dust' | 'spark' | 'number' | 'boom' | 'puff' | 'tracer';

export interface Particle {
  kind: FxKind;
  /** Map coordinates at birth, and drift in map pixels per second. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** performance.now() at birth, and life in ms. */
  born: number;
  life: number;
  /** Size in sprite pixels (scaled by the pixel scale). */
  size: number;
  color: string;
  text?: string;
  /** A tracer's far end (map coordinates). */
  x2?: number;
  y2?: number;
  /** Ambient effects are dropped first and not made at all in reduced mode. */
  ambient?: boolean;
}

const MAX_PARTICLES = 400;

export class Fx {
  level: 'full' | 'reduced' = 'full';
  private parts: Particle[] = [];

  add(p: Omit<Particle, 'born'> & { born?: number }): void {
    if (this.level === 'reduced' && p.ambient) return;
    this.parts.push({ born: performance.now(), ...p });
    if (this.parts.length > MAX_PARTICLES) {
      // Shed ambient ones first, then the oldest.
      const i = this.parts.findIndex((q) => q.ambient);
      this.parts.splice(i >= 0 ? i : 0, 1);
    }
  }

  /** In reduced mode, only every other non-essential effect is made. */
  allow(): boolean {
    return this.level === 'full' || Math.random() < 0.5;
  }

  get count(): number {
    return this.parts.length;
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, now: number): void {
    const keep: Particle[] = [];
    for (const p of this.parts) {
      const age = (now - p.born) / p.life;
      if (age >= 1) continue;
      keep.push(p);
      if (age < 0) continue;
      const t = (now - p.born) / 1000;
      const [sx, sy] = toScreen(p.x + p.vx * t, p.y + p.vy * t);
      const x = Math.round(sx);
      const y = Math.round(sy);
      switch (p.kind) {
        case 'smoke':
        case 'puff': {
          // Grows and thins out.
          const s = Math.max(1, Math.round((p.size + age * p.size) * px));
          ctx.globalAlpha = (1 - age) * (p.kind === 'puff' ? 0.35 : 0.55);
          ctx.fillStyle = p.color;
          ctx.fillRect(x - (s >> 1), y - (s >> 1), s, s);
          break;
        }
        case 'flash':
        case 'spark': {
          const s = Math.max(1, Math.round(p.size * px * (p.kind === 'flash' ? 1 - age * 0.5 : 1)));
          ctx.globalAlpha = 1 - age;
          ctx.fillStyle = p.color;
          ctx.fillRect(x - (s >> 1), y - (s >> 1), s, s);
          break;
        }
        case 'boom': {
          // An artillery burst: a bright core, then a ring of fire that fades.
          const s = Math.max(2, Math.round(p.size * px * (0.6 + age)));
          ctx.globalAlpha = 1 - age;
          ctx.fillStyle = age < 0.25 ? '#fff3c4' : p.color;
          ctx.fillRect(x - (s >> 1), y - (s >> 1), s, s);
          ctx.fillStyle = INK;
          ctx.globalAlpha = (1 - age) * 0.5;
          ctx.fillRect(x - (s >> 2), y - (s >> 2), s >> 1, s >> 1);
          break;
        }
        case 'dust': {
          const s = Math.max(1, Math.round(p.size * px));
          ctx.globalAlpha = (1 - age) * 0.7;
          ctx.fillStyle = p.color;
          ctx.fillRect(x, y, s, s);
          break;
        }
        case 'tracer': {
          // A burst of fire crossing from one side to the other: a short bright streak.
          const [ex, ey] = toScreen(p.x2 ?? p.x, p.y2 ?? p.y);
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = p.color;
          const s = Math.max(1, Math.round(px));
          for (let k = 0; k < 3; k++) {
            const f = Math.max(0, age - k * 0.06);
            ctx.fillRect(Math.round(x + (ex - x) * f), Math.round(y + (ey - y) * f), s, s);
          }
          break;
        }
        case 'number': {
          // Losses: a red number rising and fading, with a dark edge.
          ctx.globalAlpha = 1 - age * age;
          const scale = Math.max(1, px);
          for (const [dx, dy] of [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
          ]) {
            pixelDigits(ctx, p.text ?? '', x + dx, y + dy, scale, INK);
          }
          pixelDigits(ctx, p.text ?? '', x, y, scale, p.color);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
    this.parts = keep;
  }
}

/** Watches frame times; tells when the machine struggles (for auto-reducing effects). */
export class FrameMeter {
  private last = performance.now();
  private avg = 16.7;
  private since = performance.now();

  /** Call once a frame; true once frames have averaged over 22 ms for 2 s. */
  tick(now: number): boolean {
    const dt = Math.min(100, now - this.last);
    this.last = now;
    this.avg = this.avg * 0.95 + dt * 0.05;
    if (this.avg < 22) this.since = now;
    return now - this.since > 2000;
  }
}
