// Draws the map: terrain picture, territory tint and borders, region icons, unit tokens.
// Also does the camera (pan/zoom) and hit-testing for the input code.
import { decodeGrid, type GameMap, WATER } from '../shared/map.ts';
import type { BlobRow, GamePlayer, RegionRow, Snapshot } from '../shared/protocol.ts';
import { UNIT_INDEX } from '../shared/protocol.ts';
import { SUPPLY_RANGE, supplyCapacity, UNITS } from '../shared/rules.ts';
import { blit, blitCentred, FRAME_H, FRAME_W, ICONS, INK, pixelDigits, type Sprite, unitFrame } from './sprites.ts';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** Something drawn for one or more units, with where it was drawn (for clicks). */
interface Placed {
  ids: number[];
  x: number;
  y: number;
  r: number;
}

/** One token or stack to draw this frame. */
interface Item {
  /** Stable across frames: 'b:<unit>' for a single unit, 's:<owner>:<region>' for a stack,
   * 'm:...' for units moving together. */
  key: string;
  rows: BlobRow[];
  owner: number;
  moving: boolean;
  /** Target position in map coordinates. */
  tx: number;
  ty: number;
}

const SNAP_MS = 200;

export class MapView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly map: GameMap;
  readonly grid: Uint16Array;
  private readonly terrain: HTMLImageElement;
  private readonly territory: HTMLCanvasElement;
  private readonly highlight: HTMLCanvasElement;
  private readonly edges: Int32Array;
  private readonly edgeOther: Uint16Array;
  private ownersKey = '';
  private highlighted = -2;
  cam: Camera = { x: 0, y: 0, scale: 1 };
  /** Supply overlay on (for the player `you`). */
  overlay = false;
  private readonly supplyLayer: HTMLCanvasElement;
  private supplyKey = '';
  private supply: SupplyInfo | null = null;
  private placed: Placed[] = [];
  /** Map-space anchor of each blob in the previous and current snapshot, for smooth moves. */
  private prevPos = new Map<number, [number, number]>();
  private currPos = new Map<number, [number, number]>();
  private snapAt = 0;
  /** Eased display position of each item (map coordinates), and which item showed each unit. */
  private display = new Map<string, [number, number]>();
  private itemOf = new Map<number, string>();
  private lastFrame = performance.now();

  constructor(canvas: HTMLCanvasElement, map: GameMap, terrain: HTMLImageElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.map = map;
    this.terrain = terrain;
    this.grid = decodeGrid(map.grid, map.width * map.height);
    this.territory = offscreen(map.width, map.height);
    this.highlight = offscreen(map.width, map.height);
    this.supplyLayer = offscreen(map.width, map.height);
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
    this.edgeOther = Uint16Array.from(other);
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

  /** Keeps the view on the map: no panning off into empty space. */
  private clampCamera(w: number, h: number): void {
    const vw = w / this.cam.scale;
    const vh = h / this.cam.scale;
    const fit = (pos: number, view: number, size: number) =>
      view >= size ? (size - view) / 2 : Math.min(size - view, Math.max(0, pos));
    this.cam.x = fit(this.cam.x, vw, this.map.width);
    this.cam.y = fit(this.cam.y, vh, this.map.height);
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

  /** The units under a screen point (a stack gives all of its units), or null. */
  blobAt(sx: number, sy: number): number[] | null {
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      if ((p.x - sx) ** 2 + (p.y - sy) ** 2 <= (p.r + 2) ** 2) return p.ids;
    }
    return null;
  }

  blobsIn(x0: number, y0: number, x1: number, y1: number): number[] {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    return this.placed.filter((p) => p.x >= ax && p.x <= bx && p.y >= ay && p.y <= by).flatMap((p) => p.ids);
  }

  /** Where a unit is drawn on screen right now (for tests and the console). */
  screenOfUnit(id: number): [number, number] | null {
    const p = this.placed.find((x) => x.ids.includes(id));
    return p ? [p.x, p.y] : null;
  }

  /** Every drawn token or stack: its units and screen position (for tests). */
  drawnItems(): Array<{ ids: number[]; x: number; y: number }> {
    return this.placed.map((p) => ({ ids: p.ids, x: p.x, y: p.y }));
  }

  // -- state --------------------------------------------------------------------------------

  /** A new snapshot came in: remember where every blob was, for smooth movement. */
  takeSnapshot(snap: Snapshot): void {
    this.prevPos = this.currPos;
    this.currPos = new Map();
    for (const b of snap.blobs) this.currPos.set(b[0], this.anchor(b));
    this.snapAt = performance.now();
  }

  /** Where a unit is on its road (map coordinates). */
  private anchor(b: BlobRow): [number, number] {
    const from = this.map.regions[b[6]];
    if (b[7] < 0 || b[8] <= 0) return [from.x, from.y];
    const to = this.map.regions[b[7]];
    // Units waiting at the edge of a full region stop a little short of it.
    const t = b[8] >= 1 ? 0.85 : b[8];
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

  /** Your supply network, worked out the way the server does (DESIGN.md §7). */
  private supplyInfo(snap: Snapshot, players: GamePlayer[], you: number): SupplyInfo {
    const regions = snap.regions;
    const capital = this.map.countries.find((c) => c.id === players[you]?.country)?.capital ?? -1;
    const depth = new Map<number, number>();
    const hubs: number[] = [];
    const queue: number[] = [];
    regions.forEach((r, i) => {
      if (r[0] === you && (i === capital || this.map.regions[i].traits.includes('city'))) {
        hubs.push(i);
        depth.set(i, 0);
        queue.push(i);
      }
    });
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      const d = depth.get(u) as number;
      if (d >= SUPPLY_RANGE) continue;
      for (const n of this.map.regions[u].neighbors) {
        if (regions[n.id][0] === you && !depth.has(n.id)) {
          depth.set(n.id, d + 1);
          queue.push(n.id);
        }
      }
    }
    const need = new Map<number, number>();
    for (const b of snap.blobs) {
      if (b[1] !== you || b[8] > 0) continue;
      need.set(b[6], (need.get(b[6]) ?? 0) + b[4] * UNITS[UNIT_INDEX[b[2]]].supplyNeed);
    }
    return { depth, hubs, need };
  }

  private updateSupplyLayer(snap: Snapshot, players: GamePlayer[], you: number): void {
    const key = `${you}|${snap.regions.map((r) => r[0]).join(',')}`;
    this.supply = this.supplyInfo(snap, players, you);
    if (key === this.supplyKey) return;
    this.supplyKey = key;
    const W = this.map.width;
    const ctx = this.supplyLayer.getContext('2d') as CanvasRenderingContext2D;
    const img = ctx.createImageData(W, this.map.height);
    const d = img.data;
    const colorOfRegion = new Map<number, [number, number, number]>();
    snap.regions.forEach((r, i) => {
      if (r[0] !== you) return;
      const depth = this.supply?.depth.get(i);
      colorOfRegion.set(i, depth === undefined ? [255, 90, 90] : depth >= SUPPLY_RANGE ? [255, 179, 71] : [79, 209, 255]);
    });
    for (let i = 0; i < this.grid.length; i++) {
      const c = colorOfRegion.get(this.grid[i]);
      if (!c) continue;
      const x = i % W;
      if ((x + (i - x) / W) % 2) continue; // dithered
      d[i * 4] = c[0];
      d[i * 4 + 1] = c[1];
      d[i * 4 + 2] = c[2];
      d[i * 4 + 3] = 150;
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
    return z < 1.5 ? 1 : z < 3 ? 2 : 3;
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
    this.clampCamera(w, h);
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
    const showSupply = this.overlay && you !== null;
    if (showSupply) this.updateSupplyLayer(snap, players, you);
    ctx.globalAlpha = showSupply ? 0.35 : 1;
    ctx.drawImage(this.territory, 0, 0);
    ctx.globalAlpha = 1;
    if (showSupply) ctx.drawImage(this.supplyLayer, 0, 0);
    if (selectedRegion >= 0) ctx.drawImage(this.highlight, 0, 0);
    ctx.restore();
    this.drawGrid(w, h);

    this.drawRegions(snap, players, you);
    this.drawBlobs(snap, players, selected, you);

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
    for (const b of snap.blobs) {
      if (b[8] > 0) continue;
      const s = owners.get(b[6]) ?? new Set();
      s.add(b[1]);
      owners.set(b[6], s);
    }
    // Each region stacks, top to bottom: name, icons, units (centred 14px below the label
    // point), their numbers, then progress bars.
    const tokenTop = 14 - (FRAME_H * px) / 2;
    const below = 14 + (FRAME_H * px) / 2 + 3 * px + plateHeight(px) + 4;
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

      // Name, in the pixel font, above everything else (not over a battle unless zoomed in).
      const busy = (owners.get(region.id)?.size ?? 0) > 1;
      if (zoom >= 0.9 && (!busy || zoom >= 1.8)) {
        const size = zoom >= 1.8 ? 16 : 12;
        const top = showIcons ? iconBottom - 10 * ipx : y + tokenTop;
        pixelText(ctx, region.name.toUpperCase(), x, top - 3 - size / 2, size, '#e6edf2');
      }

      // Supply overlay: a crate on hubs, and how loaded each of your regions is.
      if (this.overlay && you !== null && rr[0] === you && this.supply) {
        if (this.supply.hubs.includes(region.id)) blitCentred(ctx, ICONS.crate, x - 12 * ipx, y + tokenTop - 6 * ipx, ipx);
        const load = (this.supply.need.get(region.id) ?? 0) / supplyCapacity(region, rr[2]);
        if (load > 0) cells(ctx, x, y + below + 8 * px, Math.min(1, load), load > 1 ? '#ff5a5a' : load > 0.75 ? '#ffb347' : '#7bd389', px);
      }

      // Capture progress: 8 cells in the capturer's colour, under the units.
      if (rr[4] >= 0 && rr[5] > 0) cells(ctx, x, y + below, rr[5], colorOf(players, rr[4]), px);
      // Construction: 8 cells in gold, for your own regions.
      if (rr[6] >= 0 && rr[0] === you) cells(ctx, x, y + below + 4 * px, rr[7], '#f1c232', px);
    }
  }

  /**
   * Units: grouped into items (single tokens, per-country stacks, units moving together),
   * eased toward where they belong so nothing ever snaps, with routes and arrows below.
   */
  private drawBlobs(snap: Snapshot, players: GamePlayer[], selected: Set<number>, you: number | null): void {
    const ctx = this.ctx;
    const now = performance.now();
    const ease = 1 - Math.exp(-Math.min(0.1, (now - this.lastFrame) / 1000) * 12);
    this.lastFrame = now;
    const px = this.pixel();
    const scale = this.cam.scale;
    const t = Math.min(1, (now - this.snapAt) / SNAP_MS);
    const atWar = (a: number, b: number) => snap.wars.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

    // Moving (or passing through a region on the way) vs standing.
    const moving: BlobRow[] = [];
    const standing = new Map<number, BlobRow[]>();
    for (const b of snap.blobs) {
      const passing = b[8] === 0 && b[7] >= 0 && !(b[11] & 1);
      if (b[8] > 0 || passing) moving.push(b);
      else standing.set(b[6], [...(standing.get(b[6]) ?? []), b]);
    }
    const road = (b: BlobRow): [number, number] => {
      const cur = this.currPos.get(b[0]) ?? this.anchor(b);
      const prev = this.prevPos.get(b[0]) ?? cur;
      return [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
    };

    const items: Item[] = [];
    // Units on the same road close together move as one item.
    const roads = new Map<string, BlobRow[]>();
    for (const b of moving) {
      const k = `${b[1]}:${b[6]}:${b[7]}`;
      roads.set(k, [...(roads.get(k) ?? []), b]);
    }
    for (const [k, list] of roads) {
      list.sort((a, b) => a[8] - b[8]);
      let group: BlobRow[] = [];
      const flush = () => {
        if (!group.length) return;
        const ps = group.map(road);
        const tx = ps.reduce((s, p) => s + p[0], 0) / ps.length;
        const ty = ps.reduce((s, p) => s + p[1], 0) / ps.length;
        const key = group.length === 1 ? `b:${group[0][0]}` : `m:${k}:${Math.min(...group.map((b) => b[0]))}`;
        items.push({ key, rows: group, owner: group[0][1], moving: true, tx, ty });
        group = [];
      };
      for (const b of list) {
        if (group.length && b[8] - group[0][8] > 0.15) flush();
        group.push(b);
      }
      flush();
    }

    // Standing units: individual tokens if zoomed in and they fit, else one stack per country.
    const step = Math.max(FRAME_W * px, PLATE_MIN_W) + 3;
    const sideGap = 14 * px;
    const swords: Array<[number, number]> = [];
    for (const [region, list] of standing) {
      const reg = this.map.regions[region];
      const byOwner = new Map<number, BlobRow[]>();
      for (const b of [...list].sort((a, b) => b[3] - a[3])) byOwner.set(b[1], [...(byOwner.get(b[1]) ?? []), b]);
      const owners = [...byOwner.keys()].sort((a, b) => (a === you ? -1 : b === you ? 1 : a - b));
      const fits = list.length * step + (owners.length - 1) * sideGap <= Math.sqrt(reg.area) * scale * 0.9;
      const single = px >= 2 && fits;
      const slots: Array<{ key: string; rows: BlobRow[]; owner: number }> = [];
      for (const o of owners) {
        const rows = byOwner.get(o) as BlobRow[];
        if (single) for (const b of rows) slots.push({ key: `b:${b[0]}`, rows: [b], owner: o });
        else slots.push({ key: `s:${o}:${region}`, rows, owner: o });
      }
      const width = slots.length * step + (owners.length - 1) * sideGap;
      let x = -width / 2 + step / 2;
      let prev = -2;
      for (const slot of slots) {
        if (prev !== -2 && slot.owner !== prev) {
          // Crossed swords between two sides at war.
          if (atWar(prev, slot.owner)) swords.push([reg.x + (x - step / 2 + sideGap / 2) / scale, reg.y + 14 / scale]);
          x += sideGap;
        }
        items.push({ key: slot.key, rows: slot.rows, owner: slot.owner, moving: false, tx: reg.x + x / scale, ty: reg.y + 14 / scale });
        x += step;
        prev = slot.owner;
      }
    }

    this.declutter(items, step, FRAME_H * px + 4 * px + plateHeight(px));

    // Ease every item toward its target; a new item starts where its units were last drawn.
    const display = new Map<string, [number, number]>();
    const itemOf = new Map<number, string>();
    for (const it of items) {
      let d = this.display.get(it.key);
      if (!d) {
        for (const b of it.rows) {
          const was = this.display.get(this.itemOf.get(b[0]) ?? '');
          if (was) {
            d = [was[0], was[1]];
            break;
          }
        }
      }
      d ??= [it.tx, it.ty];
      d[0] += (it.tx - d[0]) * ease;
      d[1] += (it.ty - d[1]) * ease;
      display.set(it.key, d);
      for (const b of it.rows) itemOf.set(b[0], it.key);
    }
    this.display = display;
    this.itemOf = itemOf;

    // Routes (yours) and next-hop arrows (everyone else's), under the tokens.
    const routes = new Map(snap.routes.map((r) => [r[0], r.slice(1)]));
    const markers = new Set<number>();
    for (const it of items) {
      const [sx, sy] = this.toScreen(...(display.get(it.key) as [number, number]));
      const color = colorOf(players, it.owner);
      if (it.owner === you) {
        const route = routes.get(it.rows[0][0]);
        if (!route?.length) continue;
        const sel = it.rows.some((b) => selected.has(b[0]));
        ctx.globalAlpha = sel ? 1 : 0.35;
        let [ax, ay] = [sx, sy];
        for (const r of route) {
          const reg = this.map.regions[r];
          const [bx, by] = this.toScreen(reg.x, reg.y);
          dottedLine(ctx, ax, ay, bx, by + 14, color, px);
          [ax, ay] = [bx, by + 14];
        }
        ctx.globalAlpha = 1;
        if (sel) markers.add(route[route.length - 1]);
      } else if (it.moving && it.rows[0][7] >= 0) {
        const next = this.map.regions[it.rows[0][7]];
        const [nx, ny] = this.toScreen(next.x, next.y + 14 / scale);
        arrow(ctx, sx, sy, nx, ny, (FRAME_W * px) / 2 + 3 * px, color, px);
      }
    }
    const blink = Math.floor(now / 300) % 2;
    for (const r of markers) {
      if (!blink) continue;
      const reg = this.map.regions[r];
      const [mx, my] = this.toScreen(reg.x, reg.y);
      brackets(ctx, Math.round(mx), Math.round(my + 14), 12 * px, '#ffffff', px);
    }
    for (const [wx, wy] of swords) {
      const [x, y] = this.toScreen(wx, wy);
      blitCentred(ctx, ICONS.swords[blink], Math.round(x), Math.round(y), px);
    }

    // Tokens and stacks.
    const placed: Placed[] = [];
    const r = (FRAME_W * px) / 2;
    for (const it of items) {
      const [x, y] = this.toScreen(...(display.get(it.key) as [number, number]));
      const p = { ids: it.rows.map((b) => b[0]), x: Math.round(x), y: Math.round(y), r };
      this.drawItem(it.rows, p, players, it.rows.some((b) => selected.has(b[0])), px);
      placed.push(p);
    }
    this.placed = placed;
  }

  /**
   * Zoomed out, neighbouring regions' units and units on the roads pile up on screen. Items
   * of one country that would overlap become one stack (the biggest one's place and key);
   * items of different countries that overlap are pushed apart.
   */
  private declutter(items: Item[], w: number, h: number): void {
    const scale = this.cam.scale;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const onScreen = items.filter((it) => {
      const [x, y] = this.toScreen(it.tx, it.ty);
      return x > -w && y > -h && x < cw + w && y < ch + h;
    });
    onScreen.sort((a, b) => Number(a.moving) - Number(b.moving) || b.rows.length - a.rows.length);
    const kept: Item[] = [];
    const gone = new Set<Item>();
    for (const it of onScreen) {
      const host = kept.find(
        (k) => k.owner === it.owner && Math.abs(k.tx - it.tx) * scale < w * 0.9 && Math.abs(k.ty - it.ty) * scale < h * 0.9,
      );
      if (host) {
        host.rows = [...host.rows, ...it.rows].sort((a, b) => b[3] - a[3]);
        host.moving &&= it.moving;
        gone.add(it);
      } else kept.push(it);
    }
    for (let i = items.length - 1; i >= 0; i--) if (gone.has(items[i])) items.splice(i, 1);

    // Different countries: a few rounds of pushing overlapping pairs apart (sideways mostly).
    for (let round = 0; round < 4; round++) {
      let moved = false;
      for (let i = 0; i < kept.length; i++) {
        for (let j = i + 1; j < kept.length; j++) {
          const a = kept[i];
          const b = kept[j];
          const dx = (b.tx - a.tx) * scale;
          const dy = (b.ty - a.ty) * scale;
          const ox = w - Math.abs(dx);
          const oy = h - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          // Push along the axis that needs the shorter move; standing items move less.
          const share = a.moving === b.moving ? 0.5 : a.moving ? 1 : 0;
          if (ox / w <= oy / h) {
            const s = (dx >= 0 ? 1 : -1) * (ox / scale);
            a.tx -= s * share;
            b.tx += s * (1 - share);
          } else {
            const s = (dy >= 0 ? 1 : -1) * (oy / scale);
            a.ty -= s * share;
            b.ty += s * (1 - share);
          }
        }
      }
      if (!moved) break;
    }
  }

  /** The minimap: the whole map small, your view as a cyan box, battles as red dots. */
  drawMinimap(mini: HTMLCanvasElement, snap: Snapshot): void {
    const ctx = mini.getContext('2d') as CanvasRenderingContext2D;
    const w = mini.width;
    const h = mini.height;
    const k = w / this.map.width;
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this.terrain, 0, 0, w, h);
    ctx.drawImage(this.territory, 0, 0, w, h);
    // Battles.
    if (Math.floor(performance.now() / 400) % 2 === 0) {
      const owners = new Map<number, Set<number>>();
      for (const b of snap.blobs) {
        if (b[8] > 0) continue;
        const s = owners.get(b[6]) ?? new Set();
        s.add(b[1]);
        owners.set(b[6], s);
      }
      ctx.fillStyle = '#ff5a5a';
      for (const [r, s] of owners) {
        if (s.size < 2) continue;
        const reg = this.map.regions[r];
        ctx.fillRect(Math.round(reg.x * k) - 2, Math.round(reg.y * k) - 2, 4, 4);
      }
    }
    // Your view.
    const vx = this.cam.x * k;
    const vy = this.cam.y * k;
    const vw = (this.canvas.clientWidth / this.cam.scale) * k;
    const vh = (this.canvas.clientHeight / this.cam.scale) * k;
    ctx.strokeStyle = '#4fd1ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(vx) + 1, Math.round(vy) + 1, Math.round(vw) - 2, Math.round(vh) - 2);
  }

  /** Moves the camera so a minimap point is in the middle of the screen. */
  focusMinimap(mini: HTMLCanvasElement, mx: number, my: number): void {
    const k = this.map.width / mini.clientWidth;
    this.focus(mx * k, my * k, this.cam.scale);
  }

  /** A NATO symbol: echelon marks, the framed branch symbol, a strength bar and number. */
  /**
   * A NATO symbol for one unit, or a stack of them: echelon marks, the framed branch symbol
   * (with a "deck" of frames behind for a stack), a strength bar, the strength number and,
   * for a stack, how many units are in it.
   */
  private drawItem(rows: BlobRow[], p: Placed, players: GamePlayer[], selected: boolean, px: number): void {
    const ctx = this.ctx;
    const color = colorOf(players, rows[0][1]);
    const byType = new Map<string, number>();
    for (const b of rows) byType.set(UNIT_INDEX[b[2]], (byType.get(UNIT_INDEX[b[2]]) ?? 0) + b[3]);
    const type = ([...byType].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'infantry') as 'infantry' | 'tank';
    const strength = rows.reduce((s, b) => s + b[3], 0);
    const size = rows.reduce((s, b) => s + b[4], 0);
    const supply = Math.min(...rows.map((b) => b[10]));
    const training = rows.reduce((s, b) => s + b[5] * b[3], 0) / Math.max(1, strength);
    const w = FRAME_W * px;
    const h = FRAME_H * px;
    const x0 = Math.round(p.x - w / 2);
    const y0 = Math.round(p.y - h / 2);

    // The deck: up to two more frames peeking out behind (other types show as themselves).
    for (let i = Math.min(2, rows.length - 1); i >= 1; i--) {
      const b = rows[i];
      const back = unitFrame(UNIT_INDEX[b[2]], b[4], UNITS[UNIT_INDEX[b[2]]].maxSize, color);
      blit(ctx, back, x0 + 2 * i * px, y0 - 2 * i * px, px);
    }
    blit(ctx, unitFrame(type, rows[0][4], UNITS[type].maxSize, color), x0, y0, px);

    // Strength bar under the frame: 5 cells.
    const share = strength / Math.max(1, size);
    const by = y0 + h + px;
    ctx.fillStyle = INK;
    ctx.fillRect(x0, by - px, w, 3 * px);
    for (let i = 0; i < 5; i++) {
      const filled = share > i / 5 + 0.02;
      ctx.fillStyle = filled ? (share > 0.6 ? '#7bd389' : share > 0.3 ? '#f1c232' : '#ff5a5a') : '#2c3a44';
      ctx.fillRect(x0 + px + i * 3 * px, by, 2 * px + (i === 4 ? px : 0), px);
    }

    // Strength number below, in pixel digits with a thin dark outline.
    outlinedDigits(ctx, String(Math.ceil(strength)), p.x, by + 2 * px + plateHeight(px) / 2, digitScale(px));

    // A stack: how many units, top right (×N).
    if (rows.length > 1) {
      const cx = x0 + w + 2 * px + 2 * px * Math.min(2, rows.length - 1);
      const cy = y0 - 2 * px * Math.min(2, rows.length - 1) + 2 * px;
      countBadge(ctx, rows.length, cx, cy, px);
    }

    // Supply: amber/red block in the top-right corner of the frame.
    if (supply < 0.99) {
      ctx.fillStyle = INK;
      ctx.fillRect(x0 + w - 4 * px, y0 + 3 * px, 4 * px, 4 * px);
      ctx.fillStyle = supply <= 0 ? '#ff5a5a' : '#ffb347';
      ctx.fillRect(x0 + w - 3 * px, y0 + 4 * px, 2 * px, 2 * px);
    }
    // Training: gold chevrons to the left of the echelon marks.
    const chevrons = Math.floor(training / 34);
    for (let i = 0; i < chevrons; i++) {
      const cx = x0 + i * 4 * px;
      ctx.fillStyle = '#f1c232';
      ctx.fillRect(cx, y0 + px, px, px);
      ctx.fillRect(cx + px, y0 + 2 * px, px, px);
      ctx.fillRect(cx + 2 * px, y0 + px, px, px);
    }
    // Selected: blinking corner brackets.
    if (selected && Math.floor(performance.now() / 400) % 2 === 0) {
      brackets(ctx, Math.round(p.x), Math.round(y0 + h / 2 + 2 * px), w / 2 + 2 * px, '#ffffff', px);
    }
  }
}

/** Room under each unit for its number; units in a row are at least this far apart. */
const PLATE_MIN_W = 22;
const digitScale = (px: number) => (px >= 2 ? 3 : 2);
const plateHeight = (px: number) => 5 * digitScale(px) + 5;

export interface SupplyInfo {
  /** Hops from the nearest hub, for your regions in reach. */
  depth: Map<number, number>;
  hubs: number[];
  /** Supply your units standing in each region need. */
  need: Map<number, number>;
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

/** Pixel digits, white with a thin dark outline. */
function outlinedDigits(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number): void {
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    pixelDigits(ctx, text, x + dx, y + dy, scale, INK);
  }
  pixelDigits(ctx, text, x, y, scale, '#ffffff');
}

/** "×N" on a dark chip, its left edge at x, centred on y. */
function countBadge(ctx: CanvasRenderingContext2D, n: number, x: number, y: number, px: number): void {
  const text = String(n);
  const w = 4 * px + text.length * 4 * px + px;
  const h = 7 * px;
  const x0 = Math.round(x);
  const y0 = Math.round(y - h / 2);
  ctx.fillStyle = INK;
  ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = '#ffffff';
  // a 3×3 ×
  for (const [dx, dy] of [
    [0, 0],
    [2, 0],
    [1, 1],
    [0, 2],
    [2, 2],
  ]) {
    ctx.fillRect(x0 + px + dx * px, y0 + 2 * px + dy * px, px, px);
  }
  pixelDigits(ctx, text, x0 + 4 * px + (text.length * 4 * px - px) / 2 + px, y0 + h / 2, px, '#ffffff');
}

/** Four corner brackets around (x, y), `half` pixels out. */
function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, half: number, color: string, px: number): void {
  ctx.fillStyle = color;
  const l = 4 * px;
  const left = Math.round(x - half);
  const right = Math.round(x + half);
  const top = Math.round(y - half);
  const bottom = Math.round(y + half);
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

/** Three pixel dots, growing, pointing from (x0, y0) toward (x1, y1), starting `skip` out. */
function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, skip: number, color: string, px: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < skip + 6 * px) return;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  for (let i = 0; i < 3; i++) {
    const d = skip + i * 4 * px;
    const s = (i + 1) * px;
    const x = Math.round(x0 + ux * d - s / 2);
    const y = Math.round(y0 + uy * d - s / 2);
    ctx.fillStyle = INK;
    ctx.fillRect(x - px, y - px, s + 2 * px, s + 2 * px);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, s, s);
  }
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
