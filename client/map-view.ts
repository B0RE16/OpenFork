// Draws the map: terrain picture, territory tint and borders, region icons, unit tokens.
// Also does the camera (pan/zoom) and hit-testing for the input code.
import { decodeGrid, type GameMap, WATER } from '../shared/map.ts';
import type { BlobRow, GamePlayer, RegionRow, Snapshot } from '../shared/protocol.ts';
import { UNIT_INDEX } from '../shared/protocol.ts';
import { UNITS } from '../shared/rules.ts';
import { blit, blitCentred, FRAME_H, FRAME_W, ICONS, INK, type Sprite, unitFrame } from './sprites.ts';

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
      const x = i % W;
      const y = (i - x) / W;
      // Out of supply: paler, with dark diagonal hatching.
      const cut = !(regions[r][3] & 4);
      if (cut && (x + y) % 6 === 0) {
        d[o] = c[0] * 0.35;
        d[o + 1] = c[1] * 0.35;
        d[o + 2] = c[2] * 0.35;
        d[o + 3] = 170;
        continue;
      }
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
      d[o + 3] = cut ? 55 : 100;
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
    // A dithered checkerboard, the pixel-art way to show a selection.
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] !== region) continue;
      const x = i % W;
      if ((x + (i - x) / W) % 2) continue;
      img.data[i * 4] = 230;
      img.data[i * 4 + 1] = 248;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = 120;
    }
    ctx.putImageData(img, 0, 0);
  }

  // -- drawing ------------------------------------------------------------------------------

  /** Screen pixels per sprite pixel: pixel art only scales in whole steps. */
  private pixel(): number {
    const z = this.cam.scale;
    return z < 0.7 ? 1 : z < 1.8 ? 2 : 3;
  }

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
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#101418';
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
    this.drawGrid(w, h);

    this.drawRegions(snap, players, you);
    this.drawBlobs(snap, players, selected);

    if (box) {
      const [x0, y0] = [Math.round(Math.min(box[0], box[2])), Math.round(Math.min(box[1], box[3]))];
      const [x1, y1] = [Math.round(Math.max(box[0], box[2])), Math.round(Math.max(box[1], box[3]))];
      ctx.fillStyle = 'rgba(79,209,255,0.08)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.fillStyle = '#4fd1ff';
      for (let x = x0; x < x1; x += 4) {
        ctx.fillRect(x, y0, 2, 1);
        ctx.fillRect(x, y1, 2, 1);
      }
      for (let y = y0; y < y1; y += 4) {
        ctx.fillRect(x0, y, 1, 2);
        ctx.fillRect(x1, y, 1, 2);
      }
    }
  }

  /** A faint map grid, like an ops overlay. */
  private drawGrid(w: number, h: number): void {
    const ctx = this.ctx;
    const step = 60; // map pixels (180 km)
    ctx.fillStyle = 'rgba(79,209,255,0.10)';
    const [mx0, my0] = this.toMap(0, 0);
    const [mx1, my1] = this.toMap(w, h);
    for (let mx = Math.ceil(mx0 / step) * step; mx <= mx1; mx += step) {
      const x = Math.round(this.toScreen(mx, 0)[0]);
      for (let y = 0; y < h; y += 6) ctx.fillRect(x, y, 1, 3);
    }
    for (let my = Math.ceil(my0 / step) * step; my <= my1; my += step) {
      const y = Math.round(this.toScreen(0, my)[1]);
      for (let x = 0; x < w; x += 6) ctx.fillRect(x, y, 3, 1);
    }
  }

  private drawRegions(snap: Snapshot, players: GamePlayer[], you: number | null): void {
    const ctx = this.ctx;
    const zoom = this.cam.scale;
    const px = this.pixel();
    const capitals = new Map<number, number>();
    players.forEach((p) => {
      const c = this.map.countries.find((x) => x.id === p.country);
      if (c && snap.players[p.id]?.alive) capitals.set(c.capital, p.id);
    });
    const owners = new Map<number, Set<number>>();
    const standing = new Map<number, number>();
    for (const b of snap.blobs) {
      if (b[8] > 0) continue;
      const s = owners.get(b[6]) ?? new Set();
      s.add(b[1]);
      owners.set(b[6], s);
      standing.set(b[6], (standing.get(b[6]) ?? 0) + 1);
    }
    const blink = Math.floor(performance.now() / 300) % 2;
    // Each region stacks, top to bottom: name, icons, units (centred 14px below the label
    // point), their numbers, then progress bars.
    const tokenTop = 14 - (FRAME_H * px) / 2;
    const below = 14 + (FRAME_H * px) / 2 + 3 * px + (px >= 2 ? 12 : 9) + 4;
    const ipx = Math.max(1, px - 1 + (zoom >= 1.2 ? 1 : 0));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const region of this.map.regions) {
      const rr = snap.regions[region.id];
      const [fx, fy] = this.toScreen(region.x, region.y);
      const x = Math.round(fx);
      const y = Math.round(fy);
      if (x < -80 || y < -80 || x > this.canvas.clientWidth + 80 || y > this.canvas.clientHeight + 80) continue;

      // Icons in a row above the units: capital/city, fort, barracks, factory, infrastructure.
      const icons: Sprite[] = [];
      if (capitals.has(region.id)) icons.push(ICONS.capital);
      else if (region.traits.includes('city')) icons.push(ICONS.city);
      if (rr[1] > 0) for (let i = 0; i < rr[1]; i++) icons.push(ICONS.fort);
      if (rr[3] & 1) icons.push(ICONS.barracks);
      if (rr[3] & 2) icons.push(ICONS.factory);
      if (rr[2] > 0) icons.push(ICONS.infra);
      const showIcons = icons.length > 0 && zoom >= 0.5;
      const iconBottom = y + tokenTop - 2;
      if (showIcons) {
        const gap = ipx;
        const total = icons.reduce((sum, i) => sum + i.width * ipx, 0) + gap * (icons.length - 1);
        let ix = Math.round(x - total / 2);
        for (const icon of icons) {
          blit(ctx, icon, ix, iconBottom - icon.height * ipx, ipx);
          ix += icon.width * ipx + gap;
        }
      } else if (capitals.has(region.id)) {
        blitCentred(ctx, ICONS.capital, x, y, 1);
      }

      // Name, in the pixel font, above everything else.
      if (zoom >= 0.9) {
        const size = zoom >= 1.8 ? 16 : 12;
        const top = showIcons ? iconBottom - 10 * ipx : y + tokenTop;
        pixelText(ctx, region.name.toUpperCase(), x, top - 3 - size / 2, size, '#e6edf2');
      }

      // Capture progress: 8 cells in the capturer's colour, under the units.
      if (rr[4] >= 0 && rr[5] > 0) cells(ctx, x, y + below, rr[5], colorOf(players, rr[4]), px);
      // Construction: 8 cells in gold, for your own regions.
      if (rr[6] >= 0 && rr[0] === you) cells(ctx, x, y + below + 4 * px, rr[7], '#f1c232', px);
      // Battles: blinking crossed swords just right of the units.
      if ((owners.get(region.id)?.size ?? 0) > 1) {
        const row = (standing.get(region.id) ?? 0) * (FRAME_W + 3) * px;
        blitCentred(ctx, ICONS.swords[blink], x + row / 2 + 6 * px, y + 14, px);
      }
    }
  }

  private drawBlobs(snap: Snapshot, players: GamePlayer[], selected: Set<number>): void {
    const ctx = this.ctx;
    const px = this.pixel();
    const t = Math.min(1, (performance.now() - this.snapAt) / SNAP_MS);
    const standing = new Map<number, BlobRow[]>();
    const moving: BlobRow[] = [];
    for (const b of snap.blobs) {
      if (b[8] > 0) moving.push(b);
      else standing.set(b[6], [...(standing.get(b[6]) ?? []), b]);
    }
    const placed: Placed[] = [];
    const r = (FRAME_W * px) / 2;

    // Moving units: along their road, with a dotted pixel line to where they're going.
    for (const b of moving) {
      const cur = this.currPos.get(b[0]) ?? this.anchor(b);
      const prev = this.prevPos.get(b[0]) ?? cur;
      const [x, y] = this.toScreen(prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t);
      const to = this.map.regions[b[7]];
      const [tx, ty] = this.toScreen(to.x, to.y);
      dottedLine(ctx, x, y, tx, ty + 14, colorOf(players, b[1]), px);
      placed.push({ id: b[0], x: Math.round(x), y: Math.round(y), r });
    }
    // Standing units: a row under the region's name, grouped by owner.
    for (const [region, list] of standing) {
      const reg = this.map.regions[region];
      const [cx, cy] = this.toScreen(reg.x, reg.y);
      list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const step = (FRAME_W + 3) * px;
      list.forEach((b, k) => {
        placed.push({ id: b[0], x: Math.round(cx + (k - (list.length - 1) / 2) * step), y: Math.round(cy + 14), r });
      });
    }
    const byId = new Map(snap.blobs.map((b) => [b[0], b]));
    for (const p of placed) this.drawToken(byId.get(p.id) as BlobRow, p, players, selected.has(p.id), px);
    this.placed = placed;
  }

  /** A NATO symbol: echelon marks, the framed branch symbol, a strength bar and number. */
  private drawToken(b: BlobRow, p: Placed, players: GamePlayer[], selected: boolean, px: number): void {
    const ctx = this.ctx;
    const type = UNIT_INDEX[b[2]];
    const color = colorOf(players, b[1]);
    const frame = unitFrame(type, b[4], UNITS[type].maxSize, color);
    const w = FRAME_W * px;
    const h = FRAME_H * px;
    const x0 = Math.round(p.x - w / 2);
    const y0 = Math.round(p.y - h / 2);
    blit(ctx, frame, x0, y0, px);

    // Strength bar under the frame: 5 cells.
    const share = b[3] / Math.max(1, b[4]);
    const by = y0 + h + px;
    ctx.fillStyle = INK;
    ctx.fillRect(x0, by - px, w, 3 * px);
    for (let i = 0; i < 5; i++) {
      const filled = share > i / 5 + 0.02;
      ctx.fillStyle = filled ? (share > 0.6 ? '#7bd389' : share > 0.3 ? '#f1c232' : '#ff5a5a') : '#2c3a44';
      ctx.fillRect(x0 + px + i * 3 * px, by, 2 * px + (i === 4 ? px : 0), px);
    }

    // Strength number on a dark plate below.
    const label = String(Math.ceil(b[3]));
    const size = px >= 2 ? 12 : 9;
    pixelText(ctx, label, p.x, by + px + 1 + size / 2, size, '#ffffff');

    // Supply: amber/red block in the top-right corner of the frame.
    if (b[10] < 0.99) {
      ctx.fillStyle = INK;
      ctx.fillRect(x0 + w - 4 * px, y0 + 3 * px, 4 * px, 4 * px);
      ctx.fillStyle = b[10] <= 0 ? '#ff5a5a' : '#ffb347';
      ctx.fillRect(x0 + w - 3 * px, y0 + 4 * px, 2 * px, 2 * px);
    }
    // Training: gold chevrons to the left of the echelon marks.
    const chevrons = Math.floor(b[5] / 34);
    for (let i = 0; i < chevrons; i++) {
      const cx = x0 + i * 4 * px;
      ctx.fillStyle = '#f1c232';
      ctx.fillRect(cx, y0 + px, px, px);
      ctx.fillRect(cx + px, y0 + 2 * px, px, px);
      ctx.fillRect(cx + 2 * px, y0 + px, px, px);
    }
    // Selected: blinking corner brackets.
    if (selected && Math.floor(performance.now() / 400) % 2 === 0) {
      ctx.fillStyle = '#ffffff';
      const l = 4 * px;
      const left = x0 - 2 * px;
      const top = y0 + 2 * px;
      const right = x0 + w + px;
      const bottom = y0 + h + 3 * px;
      for (const [cx, cy, dx, dy] of [
        [left, top, 1, 1],
        [right, top, -1, 1],
        [left, bottom, 1, -1],
        [right, bottom, -1, -1],
      ]) {
        ctx.fillRect(dx > 0 ? cx : cx - l + px, cy, l, px);
        ctx.fillRect(cx, dy > 0 ? cy : cy - l + px, px, l);
      }
    }
  }
}

/** Pixel-font text with a 1px dark outline, at whole pixels. */
function pixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string): void {
  ctx.font = `${size >= 12 ? 700 : 400} ${size}px "Pixelify Sans", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const rx = Math.round(x);
  const ry = Math.round(y);
  ctx.fillStyle = INK;
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [1, 1],
  ]) {
    ctx.fillText(text, rx + dx, ry + dy);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, rx, ry);
}

/** An 8-cell progress bar centred on x. */
function cells(ctx: CanvasRenderingContext2D, x: number, y: number, progress: number, color: string, px: number): void {
  const n = 8;
  const cw = 2 * px;
  const gap = px;
  const w = n * cw + (n - 1) * gap;
  const x0 = Math.round(x - w / 2);
  const y0 = Math.round(y);
  ctx.fillStyle = INK;
  ctx.fillRect(x0 - px, y0 - px, w + 2 * px, 3 * px);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = progress >= (i + 1) / n - 0.001 ? color : '#2c3a44';
    ctx.fillRect(x0 + i * (cw + gap), y0, cw, px);
  }
}

/** A dotted line made of pixel squares. */
function dottedLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, px: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const step = 4 * px;
  ctx.fillStyle = color;
  for (let d = step; d < len; d += step) {
    const x = x0 + ((x1 - x0) * d) / len;
    const y = y0 + ((y1 - y0) * d) / len;
    ctx.fillRect(Math.round(x - px / 2), Math.round(y - px / 2), px, px);
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
