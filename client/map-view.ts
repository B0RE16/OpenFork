// Draws the map: terrain picture, territory tint and borders, region icons, unit tokens.
// Also does the camera (pan/zoom) and hit-testing for the input code.
import { decodeGrid, type GameMap, WATER } from '../shared/map.ts';
import type { BlobRow, GamePlayer, RegionRow, Snapshot } from '../shared/protocol.ts';
import { UNIT_INDEX } from '../shared/protocol.ts';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface Placed {
  id: number;
  x: number;
  y: number;
  r: number;
}

const TOKEN_R = 11;
const SNAP_MS = 200;

export class MapView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly map: GameMap;
  readonly grid: Uint8Array;
  private readonly terrain: HTMLImageElement;
  private readonly territory: HTMLCanvasElement;
  private readonly highlight: HTMLCanvasElement;
  private readonly edges: Int32Array;
  private readonly edgeOther: Uint8Array;
  private ownersKey = '';
  private highlighted = -2;
  cam: Camera = { x: 0, y: 0, scale: 1 };
  private placed: Placed[] = [];
  /** Map-space anchor of each blob in the previous and current snapshot, for smooth moves. */
  private prevPos = new Map<number, [number, number]>();
  private currPos = new Map<number, [number, number]>();
  private snapAt = 0;

  constructor(canvas: HTMLCanvasElement, map: GameMap, terrain: HTMLImageElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.map = map;
    this.terrain = terrain;
    this.grid = decodeGrid(map.grid, map.width * map.height);
    this.territory = offscreen(map.width, map.height);
    this.highlight = offscreen(map.width, map.height);
    // Border pixels never change; only who owns each side does.
    const W = map.width;
    const edges: number[] = [];
    const other: number[] = [];
    for (let i = 0; i < this.grid.length; i++) {
      const r = this.grid[i];
      if (r === WATER) continue;
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= this.grid.length) continue;
        if (this.grid[j] !== r) {
          edges.push(i);
          other.push(this.grid[j]);
          break;
        }
      }
    }
    this.edges = Int32Array.from(edges);
    this.edgeOther = Uint8Array.from(other);
  }

  // -- camera -----------------------------------------------------------------------------

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
  }

  fit(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const scale = Math.min(w / this.map.width, h / this.map.height);
    this.cam = { scale, x: (this.map.width - w / scale) / 2, y: (this.map.height - h / scale) / 2 };
  }

  /** Centres the camera on a map point, zoomed in a bit. */
  focus(mx: number, my: number, scale = Math.max(this.cam.scale, 1.2)): void {
    this.cam = { scale, x: mx - this.canvas.clientWidth / 2 / scale, y: my - this.canvas.clientHeight / 2 / scale };
  }

  pan(dx: number, dy: number): void {
    this.cam.x -= dx / this.cam.scale;
    this.cam.y -= dy / this.cam.scale;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const [mx, my] = this.toMap(sx, sy);
    this.cam.scale = Math.min(8, Math.max(0.25, this.cam.scale * factor));
    this.cam.x = mx - sx / this.cam.scale;
    this.cam.y = my - sy / this.cam.scale;
  }

  toMap(sx: number, sy: number): [number, number] {
    return [this.cam.x + sx / this.cam.scale, this.cam.y + sy / this.cam.scale];
  }

  toScreen(mx: number, my: number): [number, number] {
    return [(mx - this.cam.x) * this.cam.scale, (my - this.cam.y) * this.cam.scale];
  }

  // -- hit testing --------------------------------------------------------------------------

  regionAt(sx: number, sy: number): number {
    const [mx, my] = this.toMap(sx, sy);
    const x = Math.floor(mx);
    const y = Math.floor(my);
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return -1;
    const r = this.grid[y * this.map.width + x];
    return r === WATER ? -1 : r;
  }

  blobAt(sx: number, sy: number): number | null {
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      if ((p.x - sx) ** 2 + (p.y - sy) ** 2 <= (p.r + 2) ** 2) return p.id;
    }
    return null;
  }

  blobsIn(x0: number, y0: number, x1: number, y1: number): number[] {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    return this.placed.filter((p) => p.x >= ax && p.x <= bx && p.y >= ay && p.y <= by).map((p) => p.id);
  }

  // -- state --------------------------------------------------------------------------------

  /** A new snapshot came in: remember where every blob was, for smooth movement. */
  takeSnapshot(snap: Snapshot): void {
    this.prevPos = this.currPos;
    this.currPos = new Map();
    for (const b of snap.blobs) this.currPos.set(b[0], this.anchor(b));
    this.snapAt = performance.now();
  }

  private anchor(b: BlobRow): [number, number] {
    const from = this.map.regions[b[6]];
    if (b[7] < 0 || b[8] <= 0) return [from.x, from.y];
    const to = this.map.regions[b[7]];
    // Units waiting at a full region's edge stop short of it.
    const t = Math.min(b[8], 0.7);
    return [from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t];
  }

  private updateTerritory(regions: RegionRow[], players: GamePlayer[]): void {
    const key = regions.map((r) => `${r[0]}${r[3] & 4 ? '' : 'x'}`).join(',');
    if (key === this.ownersKey) return;
    this.ownersKey = key;
    const W = this.map.width;
    const H = this.map.height;
    const ctx = this.territory.getContext('2d') as CanvasRenderingContext2D;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const rgb = players.map((p) => hexRgb(p.color));
    for (let i = 0; i < this.grid.length; i++) {
      const r = this.grid[i];
      if (r === WATER) continue;
      const owner = regions[r][0];
      if (owner < 0) continue;
      const c = rgb[owner];
      const o = i * 4;
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
      // Out of supply shows paler.
      d[o + 3] = regions[r][3] & 4 ? 92 : 50;
    }
    for (let k = 0; k < this.edges.length; k++) {
      const i = this.edges[k];
      const r = this.grid[i];
      const other = this.edgeOther[k];
      const owner = regions[r][0];
      const otherOwner = other === WATER ? -2 : regions[other][0];
      const o = i * 4;
      if (owner >= 0 && owner !== otherOwner) {
        const c = rgb[owner];
        d[o] = c[0] * 0.75;
        d[o + 1] = c[1] * 0.75;
        d[o + 2] = c[2] * 0.75;
        d[o + 3] = 235;
      } else if (other !== WATER) {
        d[o] = 20;
        d[o + 1] = 20;
        d[o + 2] = 20;
        d[o + 3] = 70;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  private updateHighlight(region: number): void {
    if (region === this.highlighted) return;
    this.highlighted = region;
    const W = this.map.width;
    const ctx = this.highlight.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, W, this.map.height);
    if (region < 0) return;
    const img = ctx.createImageData(W, this.map.height);
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] !== region) continue;
      img.data[i * 4] = 255;
      img.data[i * 4 + 1] = 255;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = 70;
    }
    ctx.putImageData(img, 0, 0);
  }

  // -- drawing ------------------------------------------------------------------------------

  draw(
    snap: Snapshot,
    players: GamePlayer[],
    you: number | null,
    selected: Set<number>,
    selectedRegion: number,
    box: [number, number, number, number] | null,
  ): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.updateTerritory(snap.regions, players);
    this.updateHighlight(selectedRegion);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1d3550';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.scale(this.cam.scale, this.cam.scale);
    ctx.translate(-this.cam.x, -this.cam.y);
    ctx.imageSmoothingEnabled = this.cam.scale < 1;
    ctx.drawImage(this.terrain, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.territory, 0, 0);
    if (selectedRegion >= 0) ctx.drawImage(this.highlight, 0, 0);
    ctx.restore();

    this.drawRegions(snap, players, you);
    this.drawBlobs(snap, players, selected);

    if (box) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    }
  }

  private drawRegions(snap: Snapshot, players: GamePlayer[], you: number | null): void {
    const ctx = this.ctx;
    const zoom = this.cam.scale;
    const capitals = new Map<number, number>();
    players.forEach((p) => {
      const c = this.map.countries.find((x) => x.id === p.country);
      if (c && snap.players[p.id]?.alive) capitals.set(c.capital, p.id);
    });
    const contested = new Set<number>();
    const owners = new Map<number, Set<number>>();
    for (const b of snap.blobs) {
      if (b[8] > 0) continue;
      const s = owners.get(b[6]) ?? new Set();
      s.add(b[1]);
      owners.set(b[6], s);
    }
    for (const [r, s] of owners) if (s.size > 1) contested.add(r);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const region of this.map.regions) {
      const rr = snap.regions[region.id];
      const [x, y] = this.toScreen(region.x, region.y);
      if (x < -60 || y < -60 || x > this.canvas.clientWidth + 60 || y > this.canvas.clientHeight + 60) continue;

      // Name (when zoomed in enough), capital star, buildings.
      if (zoom >= 0.9) {
        ctx.font = `600 ${Math.round(10 + Math.min(4, zoom))}px system-ui, sans-serif`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.strokeText(region.name, x, y - 16);
        ctx.fillText(region.name, x, y - 16);
      }
      if (region.traits.includes('city') && !capitals.has(region.id) && zoom >= 0.55) {
        ctx.beginPath();
        ctx.arc(x, y - 5, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.stroke();
      }
      const icons: string[] = [];
      if (capitals.has(region.id)) icons.push('★');
      if (rr[1] > 0) icons.push(`⛨${rr[1]}`);
      if (rr[3] & 1) icons.push('B');
      if (rr[3] & 2) icons.push('F');
      if (rr[2] > 0) icons.push(`≡${rr[2]}`);
      if (icons.length && zoom >= 0.55) {
        ctx.font = '700 11px system-ui, sans-serif';
        const text = icons.join(' ');
        const tw = ctx.measureText(text).width + 8;
        ctx.fillStyle = 'rgba(15,20,28,0.72)';
        roundRect(ctx, x - tw / 2, y - 7 - (zoom >= 0.9 ? 0 : 10), tw, 14, 4);
        ctx.fill();
        ctx.fillStyle = capitals.has(region.id) ? colorOf(players, capitals.get(region.id) as number) : '#f2f2f2';
        ctx.fillText(text, x, y - (zoom >= 0.9 ? 0 : 10));
      } else if (capitals.has(region.id)) {
        ctx.font = '700 14px system-ui, sans-serif';
        ctx.fillStyle = colorOf(players, capitals.get(region.id) as number);
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        ctx.strokeText('★', x, y);
        ctx.fillText('★', x, y);
      }

      // Capture progress: a ring in the capturer's colour.
      if (rr[4] >= 0 && rr[5] > 0) {
        ctx.beginPath();
        ctx.arc(x, y + 14, TOKEN_R + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rr[5]);
        ctx.strokeStyle = colorOf(players, rr[4]);
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      // Construction progress: a thin bar.
      if (rr[6] >= 0 && rr[0] === you) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 14, y + 7, 28, 3);
        ctx.fillStyle = '#ffd166';
        ctx.fillRect(x - 14, y + 7, 28 * rr[7], 3);
      }
      if (contested.has(region.id)) {
        ctx.font = '700 15px system-ui, sans-serif';
        ctx.fillStyle = '#ff5a5a';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 150);
        ctx.globalAlpha = pulse;
        ctx.strokeText('⚔', x + 22, y - 2);
        ctx.fillText('⚔', x + 22, y - 2);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawBlobs(snap: Snapshot, players: GamePlayer[], selected: Set<number>): void {
    const ctx = this.ctx;
    const t = Math.min(1, (performance.now() - this.snapAt) / SNAP_MS);
    const standing = new Map<number, BlobRow[]>();
    const moving: BlobRow[] = [];
    for (const b of snap.blobs) {
      if (b[8] > 0) moving.push(b);
      else standing.set(b[6], [...(standing.get(b[6]) ?? []), b]);
    }
    const placed: Placed[] = [];
    const r = TOKEN_R * Math.min(1.3, Math.max(0.75, this.cam.scale));

    // Moving units: interpolated along their road, with a line to where they're going.
    for (const b of moving) {
      const cur = this.currPos.get(b[0]) ?? this.anchor(b);
      const prev = this.prevPos.get(b[0]) ?? cur;
      const mx = prev[0] + (cur[0] - prev[0]) * t;
      const my = prev[1] + (cur[1] - prev[1]) * t;
      const [x, y] = this.toScreen(mx, my);
      const to = this.map.regions[b[7]];
      const [tx, ty] = this.toScreen(to.x, to.y);
      ctx.strokeStyle = `${colorOf(players, b[1])}aa`;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tx, ty + 14);
      ctx.stroke();
      ctx.setLineDash([]);
      placed.push({ id: b[0], x, y, r });
    }
    // Standing units: a row under the region's label, grouped by owner.
    for (const [region, list] of standing) {
      const reg = this.map.regions[region];
      const [cx, cy] = this.toScreen(reg.x, reg.y);
      list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const step = r * 2 + 2;
      list.forEach((b, k) => {
        const x = cx + (k - (list.length - 1) / 2) * step;
        placed.push({ id: b[0], x, y: cy + 14, r });
      });
    }
    const byId = new Map(snap.blobs.map((b) => [b[0], b]));
    for (const p of placed) this.drawToken(byId.get(p.id) as BlobRow, p, players, selected.has(p.id));
    this.placed = placed;
  }

  private drawToken(b: BlobRow, p: Placed, players: GamePlayer[], selected: boolean): void {
    const ctx = this.ctx;
    const { x, y, r } = p;
    const type = UNIT_INDEX[b[2]];
    const color = colorOf(players, b[1]);
    ctx.beginPath();
    if (type === 'tank') roundRect(ctx, x - r, y - r * 0.8, r * 2, r * 1.6, 4);
    else ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.75)';
    ctx.stroke();
    // Strength left, as a dark wedge from the top.
    const lost = 1 - b[3] / Math.max(1, b[4]);
    if (lost > 0.02) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, r - 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * lost);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      ctx.fill();
      ctx.restore();
    }
    ctx.font = `700 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.fillStyle = '#fff';
    const label = String(Math.ceil(b[3]));
    ctx.strokeText(label, x, y + 0.5);
    ctx.fillText(label, x, y + 0.5);
    // Out of supply: red dot; well trained: gold pips.
    if (b[10] < 0.99) {
      ctx.beginPath();
      ctx.arc(x + r * 0.75, y - r * 0.75, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = b[10] <= 0 ? '#ff3b3b' : '#ffae3b';
      ctx.fill();
    }
    const pips = Math.floor(b[5] / 34);
    for (let i = 0; i < pips; i++) {
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(x - 5 + i * 4, y + r - 1, 3, 3);
    }
  }
}

function offscreen(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function colorOf(players: GamePlayer[], id: number): string {
  return players[id]?.color ?? '#999999';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
