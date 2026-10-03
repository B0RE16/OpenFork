// Draws the map: terrain picture, territory tint and borders, region icons, unit tokens.
// Also does the camera (pan/zoom) and hit-testing for the input code.
import { decodeGrid, type GameMap, WATER } from '../shared/map.ts';
import type { BlobRow, GamePlayer, Snapshot } from '../shared/protocol.ts';
import { UNIT_INDEX } from '../shared/protocol.ts';
import { BUILDING_KINDS, type BuildingKind, ROAD_SUPPLY_HOP, supplyCapacity, supplyReach, UNITS } from '../shared/rules.ts';
import { Fx } from './fx.ts';
import { art, blit, blitCentred, FRAME_H, FRAME_W, ICONS, INK, MAP_ART, pixelDigits, ROAD_COLOR, ROAD_SHADE, shade, type Sprite, unitFrame } from './sprites.ts';

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
  /** The stack this belongs to ('s:…' or 't:…'), also for its single tokens. */
  group: string;
  /** Drawn as a stack of several units (a click expands it). */
  stack: boolean;
}

/** One token or stack to draw this frame. */
interface Item {
  /** 'b:<unit>' for a single unit, 's:<owner>:<region>' for a stack of parked units,
   * 't:<owner>:<region>:<next>' for a stack on the move. */
  key: string;
  rows: BlobRow[];
  owner: number;
  /** On the move (travelling to the next region or passing through). */
  moving: boolean;
  /** The stack key these units belong to. */
  group: string;
  /** Part of the expanded stack: never merged or pushed, drawn on top. */
  pinned?: boolean;
  /** Defenders under attack: what helps them hold (shown as a shield badge). */
  shield?: { fort: number; dug: boolean; river: boolean };
  /** Position in map coordinates. */
  tx: number;
  ty: number;
}

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
  /** Each region's land pixels, the border pixels touching it (indexes into `edges`), and
   * its bounding box: so a change of hands repaints only that region. */
  private readonly regionPixels: Int32Array[];
  private readonly regionEdges: Int32Array[];
  private readonly regionBox: Int32Array;
  /** What the territory layer shows now, per region (owner, cut off). */
  private readonly shownOwner: Int16Array;
  private readonly shownCut: Uint8Array;
  private territoryImg: ImageData | null = null;
  private territoryRgb: Array<[number, number, number]> | null = null;
  /** Captures being swept in: pixel order (nearest the taker first) and how far it got. */
  private readonly sweeps = new Map<number, { order: Int32Array; done: number; start: number }>();
  private territorySnap: Snapshot | null = null;
  private highlighted = -2;
  cam: Camera = { x: 0, y: 0, scale: 1 };
  /** Supply overlay on (for the player `you`). */
  overlay = false;
  private readonly supplyLayer: HTMLCanvasElement;
  private supplySnap: Snapshot | null = null;
  private supplyImg: ImageData | null = null;
  private shownSupply = new Uint8Array(0);
  private supply: SupplyInfo | null = null;
  private placed: Placed[] = [];
  /** The stack shown as single tokens after a click on it, or null. */
  expanded: string | null = null;
  /** Placement mode: where the building can go, and the region under the cursor. */
  placement: { valid: Set<number>; hover: number } | null = null;
  /** Orders sent but not yet in a snapshot, drawn at once so input feels instant. */
  readonly pending: {
    move: { ids: number[]; to: number; since: number } | null;
    builds: Array<{ region: number; kind: BuildingKind; since: number }>;
  } = { move: null, builds: [] };
  /** Effects under the tokens (smoke, flashes, dust) and over them (loss numbers). */
  readonly fx = new Fx();
  /** Hooks for sound, set by the game screen. */
  sounds: { gun(volume: number): void; boom(volume: number): void } | null = null;
  /** Hops: where each unit was last drawn and in which region, and glides under way. */
  private lastDrawn = new Map<number, [number, number]>();
  private lastRegion = new Map<number, number>();
  private readonly glides = new Map<number, { x: number; y: number; start: number }>();
  /** Units hit recently (shake until). */
  private readonly shaking = new Map<number, number>();
  private frameAt = performance.now();
  /** Road tool: the regions dragged across so far, drawn as a dashed line. */
  roadPreview: number[] | null = null;
  private readonly placeLayer: HTMLCanvasElement;
  /** Front lines: borders between countries at war, as two-colour seams. */
  private readonly frontLayer: HTMLCanvasElement;
  private frontImg: ImageData | null = null;
  private frontPix: number[] = [];
  private frontKey = '';
  private frontSnap: Snapshot | null = null;
  private placeImg: ImageData | null = null;
  private shownValid = new Uint8Array(0);
  /** Towns, buildings and roads, painted at map resolution (they zoom with the terrain). */
  private readonly developLayer: HTMLCanvasElement;
  private developKey = '';
  private developSnap: Snapshot | null = null;
  /** Per region: free spots for building sprites, nearest the label point first. */
  private readonly spots = new Map<number, Array<[number, number]>>();

  constructor(canvas: HTMLCanvasElement, map: GameMap, terrain: HTMLImageElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.map = map;
    this.terrain = terrain;
    this.grid = decodeGrid(map.grid, map.width * map.height);
    this.territory = offscreen(map.width, map.height);
    this.highlight = offscreen(map.width, map.height);
    this.supplyLayer = offscreen(map.width, map.height);
    this.placeLayer = offscreen(map.width, map.height);
    this.frontLayer = offscreen(map.width, map.height);
    this.developLayer = offscreen(map.width, map.height);
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

    const R = map.regions.length;
    const count = new Int32Array(R);
    const box = new Int32Array(R * 4);
    for (let r = 0; r < R; r++) box.set([W, map.height, -1, -1], r * 4);
    for (let i = 0; i < this.grid.length; i++) {
      const r = this.grid[i];
      if (r === WATER) continue;
      count[r]++;
      const x = i % W;
      const y = (i - x) / W;
      const o = r * 4;
      if (x < box[o]) box[o] = x;
      if (y < box[o + 1]) box[o + 1] = y;
      if (x > box[o + 2]) box[o + 2] = x;
      if (y > box[o + 3]) box[o + 3] = y;
    }
    this.regionBox = box;
    this.regionPixels = Array.from({ length: R }, (_, r) => new Int32Array(count[r]));
    const fill = new Int32Array(R);
    for (let i = 0; i < this.grid.length; i++) {
      const r = this.grid[i];
      if (r !== WATER) this.regionPixels[r][fill[r]++] = i;
    }
    const touching: number[][] = Array.from({ length: R }, () => []);
    for (let k = 0; k < this.edges.length; k++) {
      touching[this.grid[this.edges[k]]].push(k);
      if (this.edgeOther[k] !== WATER) touching[this.edgeOther[k]].push(k);
    }
    this.regionEdges = touching.map((t) => Int32Array.from(t));
    this.shownOwner = new Int16Array(R).fill(-3);
    this.shownSupply = new Uint8Array(R);
    this.shownValid = new Uint8Array(R);
    this.shownCut = new Uint8Array(R);
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
  drawnItems(): Array<{ ids: number[]; x: number; y: number; group: string; stack: boolean }> {
    return this.placed.map((p) => ({ ids: p.ids, x: p.x, y: p.y, group: p.group, stack: p.stack }));
  }

  /** Painted town/building/road pixels that sit on water or another region (for tests). */
  artOffLand(): { water: number; total: number } {
    const W = this.map.width;
    const data = (this.developLayer.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, W, this.map.height).data;
    let water = 0;
    let total = 0;
    for (let i = 0; i < this.grid.length; i++) {
      if (data[i * 4 + 3] === 0) continue;
      total++;
      if (this.grid[i] === WATER) water++;
    }
    return { water, total };
  }

  /** The token or stack under a screen point, or null. */
  itemAt(sx: number, sy: number): { ids: number[]; group: string; stack: boolean } | null {
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      if ((p.x - sx) ** 2 + (p.y - sy) ** 2 <= (p.r + 2) ** 2) return p;
    }
    return null;
  }

  /** Every unit drawn under a stack key this frame (its stack, or its expanded tokens). */
  groupIds(group: string): number[] {
    return this.placed.filter((p) => p.group === group).flatMap((p) => p.ids);
  }

  // -- state --------------------------------------------------------------------------------

  /** Repaints the territory tint for regions that changed hands or supply (only those). A
   * region that changed hands fills with its new colour from the attacked border instead. */
  private updateTerritory(snap: Snapshot, players: GamePlayer[]): void {
    if (snap === this.territorySnap) return;
    this.territorySnap = snap;
    this.territoryRgb ??= players.map((p) => hexRgb(p.color));
    const regions = snap.regions;
    const dirty: number[] = [];
    const now = performance.now();
    for (let r = 0; r < regions.length; r++) {
      const owner = regions[r][0];
      const cut = regions[r][3] & 4 ? 0 : 1;
      const was = this.shownOwner[r];
      if (owner === was && cut === this.shownCut[r]) continue;
      this.shownOwner[r] = owner;
      this.shownCut[r] = cut;
      if (owner !== was && was !== -3 && owner >= 0) {
        // Taken: sweep the new colour across from the border with the taker's land.
        this.sweeps.set(r, { order: this.sweepOrder(r, owner, snap), done: 0, start: now });
        continue;
      }
      if (this.sweeps.has(r)) continue; // repainted whole when its sweep ends
      dirty.push(r);
    }
    if (dirty.length) this.repaintRegions(dirty);
  }

  /** The order a captured region's pixels change colour in: nearest the taker's land first. */
  private sweepOrder(r: number, owner: number, snap: Snapshot): Int32Array {
    const W = this.map.width;
    const pix = this.regionPixels[r];
    const dist = new Map<number, number>();
    const queue: number[] = [];
    for (const i of pix) {
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= this.grid.length) continue;
        const o = this.grid[j];
        if (o !== WATER && o !== r && snap.regions[o][0] === owner) {
          dist.set(i, 0);
          queue.push(i);
          break;
        }
      }
    }
    if (!queue.length) {
      // No land of theirs next to it: from the middle.
      const reg = this.map.regions[r];
      let best = pix[0];
      let bestD = Infinity;
      for (const i of pix) {
        const d = Math.abs((i % W) - reg.x) + Math.abs(Math.floor(i / W) - reg.y);
        if (d < bestD) [best, bestD] = [i, d];
      }
      dist.set(best, 0);
      queue.push(best);
    }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= this.grid.length || this.grid[j] !== r || dist.has(j)) continue;
        dist.set(j, (dist.get(i) as number) + 1);
        queue.push(j);
      }
    }
    return Int32Array.from(queue);
  }

  /** Captures in progress: more of the region takes the new colour each frame (~1 s). */
  private animateSweeps(now: number): void {
    if (!this.sweeps.size || !this.territorySnap || !this.territoryImg) return;
    const ctx = this.territory.getContext('2d') as CanvasRenderingContext2D;
    for (const [r, sw] of [...this.sweeps]) {
      const t = Math.min(1, (now - sw.start) / SWEEP_MS);
      const upto = Math.floor(sw.order.length * (1 - (1 - t) ** 2));
      for (let k = sw.done; k < upto; k++) this.fillPixel(sw.order[k]);
      sw.done = upto;
      const o = r * 4;
      const box = this.regionBox;
      if (t >= 1) {
        this.sweeps.delete(r);
        this.repaintRegions([r]);
        // A bright edge around the region as it settles.
        const W = this.map.width;
        for (const k of this.regionEdges[r]) {
          if (Math.random() > 0.25) continue;
          const i = this.edges[k];
          this.fx.add({ kind: 'spark', x: i % W, y: Math.floor(i / W), vx: 0, vy: 0, life: 450, size: 1, color: '#ffffff' });
        }
      } else {
        ctx.putImageData(this.territoryImg, 0, 0, box[o], box[o + 1], box[o + 2] - box[o] + 1, box[o + 3] - box[o + 1] + 1);
      }
    }
  }

  /** One pixel of the territory tint, from the latest snapshot. */
  private fillPixel(i: number): void {
    const d = (this.territoryImg as ImageData).data;
    const regions = (this.territorySnap as Snapshot).regions;
    const W = this.map.width;
    const r = this.grid[i];
    const o = i * 4;
    const owner = regions[r][0];
    if (owner < 0) {
      d[o + 3] = 0;
      return;
    }
    const c = (this.territoryRgb as Array<[number, number, number]>)[owner];
    const x = i % W;
    const y = (i - x) / W;
    // Out of supply: paler, with dark diagonal hatching.
    const cut = !(regions[r][3] & 4);
    if (cut && (x + y) % 6 === 0) {
      d[o] = c[0] * 0.35;
      d[o + 1] = c[1] * 0.35;
      d[o + 2] = c[2] * 0.35;
      d[o + 3] = 170;
      return;
    }
    d[o] = c[0];
    d[o + 1] = c[1];
    d[o + 2] = c[2];
    d[o + 3] = cut ? 55 : 100;
  }

  /** Repaints whole regions (and the borders they touch) at once. */
  private repaintRegions(dirty: number[]): void {
    const W = this.map.width;
    const ctx = this.territory.getContext('2d') as CanvasRenderingContext2D;
    this.territoryImg ??= ctx.createImageData(W, this.map.height);
    const d = this.territoryImg.data;
    const regions = (this.territorySnap as Snapshot).regions;
    const rgb = this.territoryRgb as Array<[number, number, number]>;
    let [x0, y0, x1, y1] = [W, this.map.height, -1, -1];
    const grow = (r: number) => {
      const o = r * 4;
      x0 = Math.min(x0, this.regionBox[o]);
      y0 = Math.min(y0, this.regionBox[o + 1]);
      x1 = Math.max(x1, this.regionBox[o + 2]);
      y1 = Math.max(y1, this.regionBox[o + 3]);
    };
    for (const r of dirty) {
      for (const i of this.regionPixels[r]) this.fillPixel(i);
      grow(r);
    }
    // Borders: on both sides of every border a changed region touches.
    for (const r of dirty) {
      for (const k of this.regionEdges[r]) {
        const i = this.edges[k];
        const own = this.grid[i];
        if (own !== r) grow(own);
        this.fillPixel(i);
        const other = this.edgeOther[k];
        const owner = regions[own][0];
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
    }
    if (x1 >= x0) ctx.putImageData(this.territoryImg, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  /** Your supply network, worked out the way the server does (DESIGN.md §7). */
  private supplyInfo(snap: Snapshot, _players: GamePlayer[], you: number): SupplyInfo {
    const regions = snap.regions;
    const roads = new Set(snap.roads.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
    // Every city of yours reaches 3 + its level hops; a road border is half a hop. In half hops.
    const left = new Map<number, number>();
    const hubs: number[] = [];
    const buckets: number[][] = [];
    regions.forEach((r, i) => {
      if (r[0] !== you || r[2] <= 0) return;
      hubs.push(i);
      const reach = supplyReach(r[2]) * 2;
      if (reach > (left.get(i) ?? -1)) {
        left.set(i, reach);
        (buckets[reach] ??= []).push(i);
      }
    });
    for (let h = buckets.length - 1; h >= 0; h--) {
      for (const u of buckets[h] ?? []) {
        if (left.get(u) !== h) continue;
        for (const n of this.map.regions[u].neighbors) {
          if (regions[n.id][0] !== you) continue;
          const next = h - (roads.has(`${Math.min(u, n.id)}:${Math.max(u, n.id)}`) ? ROAD_SUPPLY_HOP * 2 : 2);
          if (next >= 0 && next > (left.get(n.id) ?? -1)) {
            left.set(n.id, next);
            (buckets[next] ??= []).push(n.id);
          }
        }
      }
    }
    const need = new Map<number, number>();
    for (const b of snap.blobs) {
      if (b[1] !== you || b[8] > 0) continue;
      need.set(b[6], (need.get(b[6]) ?? 0) + b[4] * UNITS[UNIT_INDEX[b[2]]].supplyNeed);
    }
    return { left, hubs, need };
  }

  /** Supply overlay: worked out once per snapshot; only regions whose state changed repaint. */
  private updateSupplyLayer(snap: Snapshot, players: GamePlayer[], you: number): void {
    if (snap === this.supplySnap) return;
    this.supplySnap = snap;
    this.supply = this.supplyInfo(snap, players, you);
    const W = this.map.width;
    const ctx = this.supplyLayer.getContext('2d') as CanvasRenderingContext2D;
    this.supplyImg ??= ctx.createImageData(W, this.map.height);
    const d = this.supplyImg.data;
    const COLORS: Array<[number, number, number] | null> = [null, [79, 209, 255], [255, 179, 71], [255, 90, 90]];
    let [x0, y0, x1, y1] = [W, this.map.height, -1, -1];
    snap.regions.forEach((r, i) => {
      // 0: not yours, 1: in supply, 2: at the edge of reach, 3: cut off.
      const left = this.supply?.left.get(i);
      const state = r[0] !== you ? 0 : left === undefined ? 3 : left < 2 ? 2 : 1;
      if (state === this.shownSupply[i]) return;
      this.shownSupply[i] = state;
      const c = COLORS[state];
      for (const p of this.regionPixels[i]) {
        const x = p % W;
        if (!c || (x + (p - x) / W) % 2) {
          d[p * 4 + 3] = 0; // dithered
          continue;
        }
        d[p * 4] = c[0];
        d[p * 4 + 1] = c[1];
        d[p * 4 + 2] = c[2];
        d[p * 4 + 3] = 150;
      }
      const o = i * 4;
      x0 = Math.min(x0, this.regionBox[o]);
      y0 = Math.min(y0, this.regionBox[o + 1]);
      x1 = Math.max(x1, this.regionBox[o + 2]);
      y1 = Math.max(y1, this.regionBox[o + 3]);
    });
    if (x1 >= x0) ctx.putImageData(this.supplyImg, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  /** Repaints the front lines when owners or wars changed (once per snapshot at most). */
  private updateFrontLayer(snap: Snapshot, players: GamePlayer[]): void {
    if (snap === this.frontSnap) return;
    this.frontSnap = snap;
    const key = `${JSON.stringify(snap.wars)}|${snap.regions.map((r) => r[0]).join(',')}`;
    if (key === this.frontKey) return;
    this.frontKey = key;
    const W = this.map.width;
    const ctx = this.frontLayer.getContext('2d') as CanvasRenderingContext2D;
    this.frontImg ??= ctx.createImageData(W, this.map.height);
    const d = this.frontImg.data;
    for (const i of this.frontPix) d[i * 4 + 3] = 0;
    const wars = new Set(snap.wars.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
    const rgb = players.map((p) => hexRgb(p.color));
    const painted: number[] = [];
    for (let k = 0; k < this.edges.length; k++) {
      const other = this.edgeOther[k];
      if (other === WATER) continue;
      const i = this.edges[k];
      const a = snap.regions[this.grid[i]][0];
      const b = snap.regions[other][0];
      if (a < 0 || b < 0 || a === b || !wars.has(`${Math.min(a, b)}:${Math.max(a, b)}`)) continue;
      const x = i % W;
      const y = (i - x) / W;
      // Dashed: bright and dark stretches in each side's own colour.
      const c = rgb[a];
      const k2 = ((x + y) >> 1) % 2 ? 1 : 0.55;
      d[i * 4] = Math.min(255, c[0] * k2 + (k2 === 1 ? 40 : 0));
      d[i * 4 + 1] = Math.min(255, c[1] * k2 + (k2 === 1 ? 40 : 0));
      d[i * 4 + 2] = Math.min(255, c[2] * k2 + (k2 === 1 ? 40 : 0));
      d[i * 4 + 3] = 255;
      painted.push(i);
    }
    // Repaint the area old and new seams cover.
    let [x0, y0, x1, y1] = [W, this.map.height, -1, -1];
    for (const i of [...this.frontPix, ...painted]) {
      const x = i % W;
      const y = (i - x) / W;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    this.frontPix = painted;
    if (x1 >= x0) ctx.putImageData(this.frontImg, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  /** Where a region's town (or the hub of its roads) is: the real city, else the label point. */
  private townAt(region: number): [number, number] {
    const r = this.map.regions[region];
    return r.cityAt ?? [r.x, r.y];
  }

  private landOf(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return WATER;
    return this.grid[y * this.map.width + x];
  }

  /** Whether a w×h box at (x, y) lies wholly on a region's land. */
  private within(region: number, x: number, y: number, w: number, h: number): boolean {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) if (this.landOf(x + dx, y + dy) !== region) return false;
    return true;
  }

  /** Spots in a region where a 6×5 sprite fits on its own land, clear of the town. */
  private spotsIn(region: number): Array<[number, number]> {
    let list = this.spots.get(region);
    if (list) return list;
    const r = this.map.regions[region];
    const [tx, ty] = this.townAt(region);
    const out: Array<[number, number, number]> = [];
    const fits = (x: number, y: number) => {
      for (let dy = -1; dy <= 5; dy++) for (let dx = -1; dx <= 6; dx++) if (this.landOf(x + dx, y + dy) !== region) return false;
      return true;
    };
    for (let y = r.y - 60; y <= r.y + 60; y += 7) {
      for (let x = r.x - 60; x <= r.x + 60; x += 8) {
        // A little seeded jitter so fields don't sit on a perfect grid.
        const j = (x * 73856093) ^ (y * 19349663);
        const px = x + (j & 3) - 1;
        const py = y + ((j >> 2) & 3) - 1;
        if (Math.hypot(px + 3 - tx, py + 2 - ty) < 14) continue;
        if (Math.abs(px + 3 - r.x) < 22 && Math.abs(py + 2 - r.y) < 6) continue; // the name
        if (fits(px, py)) out.push([px, py, Math.hypot(px - r.x, py - r.y)]);
      }
    }
    out.sort((a, b) => a[2] - b[2]);
    list = out.map(([x, y]) => [x, y]);
    this.spots.set(region, list);
    return list;
  }

  /** Repaints towns, economic buildings and roads when any of them changed. */
  private updateDevelopLayer(snap: Snapshot): void {
    if (snap === this.developSnap) return;
    this.developSnap = snap;
    let key = `${snap.roads.length}|`;
    for (const r of snap.regions) key += `${r[2]}${r[9]}${r[10]}${r[11]}${r[12]},`;
    if (key === this.developKey) return;
    this.developKey = key;
    const ctx = this.developLayer.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, this.map.width, this.map.height);
    ctx.imageSmoothingEnabled = false;

    // Roads: a pixel line between the two towns, with a darker edge under it.
    for (const [a, b] of snap.roads) {
      const [x0, y0] = this.townAt(a);
      const [x1, y1] = this.townAt(b);
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= n; i++) {
        const x = Math.round(x0 + ((x1 - x0) * i) / n);
        const y = Math.round(y0 + ((y1 - y0) * i) / n);
        if (this.landOf(x, y) === WATER) continue;
        ctx.fillStyle = ROAD_SHADE;
        if (this.landOf(x, y + 1) !== WATER) ctx.fillRect(x, y + 1, 1, 1);
        ctx.fillStyle = ROAD_COLOR;
        ctx.fillRect(x, y, 1, 1);
      }
    }

    snap.regions.forEach((r, i) => {
      // Economic buildings, nearest the middle of the region first.
      const sprites: Sprite[] = [];
      for (let k = 0; k < r[9]; k++) sprites.push(MAP_ART.farm);
      for (let k = 0; k < r[10]; k++) sprites.push(MAP_ART.mine);
      for (let k = 0; k < r[11]; k++) sprites.push(MAP_ART.well);
      for (let k = 0; k < r[12]; k++) sprites.push(MAP_ART.market);
      if (sprites.length) {
        const spots = this.spotsIn(i);
        sprites.forEach((sprite, k) => {
          const spot = spots[k];
          if (spot) ctx.drawImage(sprite, spot[0], spot[1]);
        });
      }
      // The town: houses spiralling out from the real city, towers in the middle of big ones.
      const level = r[2];
      if (level <= 0) return;
      const [cx, cy] = this.townAt(i);
      const houses = 2 + 3 * level;
      let placed = 0;
      let [gx, gy, dx, dy, leg, steps, turns] = [0, 0, 1, 0, 1, 0, 0];
      for (let guard = 0; placed < houses && guard < 400; guard++) {
        const x = cx + gx * 4 - 1;
        const y = cy + gy * 4 - 1;
        const tall = level >= 3 && placed < level - 1;
        const sprite = tall ? MAP_ART.tower : MAP_ART.houses[(gx * 7 + gy * 3 + 99) % MAP_ART.houses.length];
        const top = tall ? y - 2 : y;
        // Every pixel of it on this region's land: nothing out on the sea or over a border.
        if (this.within(i, x, top, sprite.width, sprite.height)) {
          ctx.drawImage(sprite, x, top);
          placed++;
        }
        gx += dx;
        gy += dy;
        if (++steps === leg) {
          steps = 0;
          [dx, dy] = [-dy, dx];
          if (++turns % 2 === 0) leg++;
        }
      }
    });
  }

  /** The middle of the border between two regions, on region `r`'s side (map pixels). */
  private readonly borderPoints = new Map<number, [number, number]>();
  borderPoint(r: number, o: number): [number, number] {
    const key = r * 65536 + o;
    let p = this.borderPoints.get(key);
    if (p) return p;
    const W = this.map.width;
    const pix: number[] = [];
    for (const k of this.regionEdges[r]) {
      const i = this.edges[k];
      if ((this.grid[i] === r && this.edgeOther[k] === o) || (this.grid[i] === o && this.edgeOther[k] === r)) pix.push(i);
    }
    if (!pix.length) {
      const a = this.map.regions[r];
      const b = this.map.regions[o];
      p = [(a.x * 2 + b.x) / 3, (a.y * 2 + b.y) / 3];
    } else {
      // The centroid, snapped onto the border itself (a curvy border's centroid can be off it).
      const cx = pix.reduce((sum, i) => sum + (i % W), 0) / pix.length;
      const cy = pix.reduce((sum, i) => sum + Math.floor(i / W), 0) / pix.length;
      let best = pix[0];
      let bestD = Infinity;
      for (const i of pix) {
        const d = (i % W - cx) ** 2 + (Math.floor(i / W) - cy) ** 2;
        if (d < bestD) [best, bestD] = [i, d];
      }
      p = [best % W, Math.floor(best / W)];
    }
    this.borderPoints.set(key, p);
    return p;
  }

  /** The border a unit standing in someone else's region attacks from (-1: none, middle). */
  private sideOf(b: BlobRow, region: number, snap: Snapshot): number {
    const nb = this.map.regions[region].neighbors;
    if (b[12] >= 0 && nb.some((n) => n.id === b[12])) return b[12];
    let best = -1;
    let border = 0;
    for (const n of nb) {
      if (snap.regions[n.id][0] === b[1] && n.border > border) [best, border] = [n.id, n.border];
    }
    return best;
  }

  /** Which way an attack across the border from `side` into `region` points (unit vector). */
  private attackDir(region: number, side: number): [number, number] {
    const reg = this.map.regions[region];
    const [bx, by] = this.borderPoint(region, side);
    let [dx, dy] = [reg.x - bx, reg.y - by];
    if (Math.hypot(dx, dy) < 2) {
      // The border runs through the middle: point away from the side region instead.
      const from = this.map.regions[side];
      [dx, dy] = [reg.x - from.x, reg.y - from.y];
    }
    const d = Math.hypot(dx, dy) || 1;
    return [dx / d, dy / d];
  }

  /** Where a building of this kind in this region stands (or will), in map pixels. */
  private siteOf(region: number, kind: BuildingKind, row: Snapshot['regions'][number], done: boolean): [number, number] {
    const r = this.map.regions[region];
    if (kind === 'farm' || kind === 'mine' || kind === 'well' || kind === 'market') {
      const n = row[9] + row[10] + row[11] + row[12] - (done ? 1 : 0);
      const spot = this.spotsIn(region)[Math.max(0, n)];
      if (spot) return [spot[0] + 1, spot[1]];
    }
    if (kind === 'city') {
      const [tx, ty] = this.townAt(region);
      return [tx + 7, ty - 4];
    }
    // Forts, barracks, factories, roads: the next free spot, clear of the unit tokens.
    const spot = this.spotsIn(region)[row[9] + row[10] + row[11] + row[12]];
    return spot ? [spot[0] + 1, spot[1]] : [r.x + 9, r.y - 8];
  }

  /** Construction sites: scaffolding where the building goes, the crane swinging. */
  private drawSites(snap: Snapshot): void {
    const ctx = this.ctx;
    const [mx0, my0] = this.toMap(-40, -40);
    const [mx1, my1] = this.toMap(this.canvas.clientWidth + 40, this.canvas.clientHeight + 40);
    const frame = Math.floor(performance.now() / 500) % 2;
    snap.regions.forEach((row, i) => {
      if (row[6] < 0) return;
      const r = this.map.regions[i];
      if (r.x < mx0 || r.x > mx1 || r.y < my0 || r.y > my1) return;
      const [x, y] = this.siteOf(i, BUILDING_KINDS[row[6]], row, false);
      ctx.drawImage(MAP_ART.scaffold[frame], x - 3, y - 4);
    });
  }

  /** Sea pixels that glint (x, y, phase), picked once from the terrain picture. */
  private glints: Float32Array | null = null;
  private clouds: Array<{ sprite: HTMLCanvasElement; x: number; y: number }> = [];
  private ambientAt = performance.now();

  private initAmbient(): void {
    const W = this.map.width;
    const H = this.map.height;
    const c = offscreen(W, H);
    const cx = c.getContext('2d') as CanvasRenderingContext2D;
    cx.drawImage(this.terrain, 0, 0);
    const img = cx.getImageData(0, 0, W, H).data;
    const pts: number[] = [];
    for (let tries = 0; pts.length < 700 * 3 && tries < 200000; tries++) {
      const i = Math.floor(Math.random() * W * H);
      const [r, g, b] = [img[i * 4], img[i * 4 + 1], img[i * 4 + 2]];
      if (this.grid[i] === WATER && b > r + 25 && b > g) pts.push(i % W, Math.floor(i / W), Math.random() * Math.PI * 2);
    }
    this.glints = Float32Array.from(pts);
    // Soft, dithered cloud shadows, a few across the map.
    for (let k = 0; k < 6; k++) {
      const w = 90 + Math.floor(Math.random() * 70);
      const h = 34 + Math.floor(Math.random() * 20);
      const sprite = offscreen(w, h);
      const sx = sprite.getContext('2d') as CanvasRenderingContext2D;
      sx.fillStyle = '#0b0f13';
      const blobs = Array.from({ length: 5 }, () => [w * (0.2 + Math.random() * 0.6), h * (0.3 + Math.random() * 0.4), h * (0.25 + Math.random() * 0.25)]);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if ((x + y) % 2) continue;
          if (blobs.some(([bx, by, br]) => (x - bx) ** 2 / 1.8 + (y - by) ** 2 < br * br)) sx.fillRect(x, y, 1, 1);
        }
      }
      this.clouds.push({ sprite, x: Math.random() * W, y: Math.random() * H });
    }
  }

  /** The living map: glinting water, cloud shadows, traffic on roads, smoke from chimneys. */
  private drawAmbient(snap: Snapshot): void {
    if (!this.glints) this.initAmbient();
    const ctx = this.ctx;
    const now = performance.now();
    const dt = Math.min(100, now - this.ambientAt) / 1000;
    this.ambientAt = now;
    const [mx0, my0] = this.toMap(0, 0);
    const [mx1, my1] = this.toMap(this.canvas.clientWidth, this.canvas.clientHeight);
    const seen = (x: number, y: number, m = 0) => x >= mx0 - m && x <= mx1 + m && y >= my0 - m && y <= my1 + m;

    // Water: a few pixels catch the light now and then.
    const g = this.glints as Float32Array;
    ctx.fillStyle = '#d6ecff';
    for (let k = 0; k < g.length; k += 3) {
      if (!seen(g[k], g[k + 1])) continue;
      const a = Math.sin(now / 700 + g[k + 2]);
      if (a < 0.6) continue;
      ctx.globalAlpha = (a - 0.6) * 1.6;
      ctx.fillRect(g[k], g[k + 1], 1, 1);
    }

    // Cloud shadows drifting east.
    const W = this.map.width;
    ctx.globalAlpha = 0.13;
    for (const c of this.clouds) {
      const x = ((c.x + now / 1000) % (W + 300)) - 150;
      if (seen(x + c.sprite.width / 2, c.y + c.sprite.height / 2, 120)) ctx.drawImage(c.sprite, Math.round(x), Math.round(c.y));
    }
    ctx.globalAlpha = 1;

    // Traffic: little carts shuttling along supplied roads.
    for (const [a, b] of snap.roads) {
      if (!(snap.regions[a][3] & 4) || !(snap.regions[b][3] & 4)) continue;
      const [x0, y0] = this.townAt(a);
      const [x1, y1] = this.townAt(b);
      if (!seen((x0 + x1) / 2, (y0 + y1) / 2, 60)) continue;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const carts = snap.regions[a][2] > 0 && snap.regions[b][2] > 0 ? 3 : 1 + ((a + b) % 2);
      for (let k = 0; k < carts; k++) {
        const t = ((now / 1000) * (5 / len) + k / carts + (a * 0.37 + b * 0.11)) % 2;
        const f = t < 1 ? t : 2 - t;
        const x = Math.round(x0 + (x1 - x0) * f);
        const y = Math.round(y0 + (y1 - y0) * f);
        if (this.landOf(x, y) === WATER) continue;
        ctx.fillStyle = '#2f2a24';
        ctx.fillRect(x - 1, y - 1, 2, 1);
        ctx.fillStyle = k % 2 ? '#d9a441' : '#e8e1d0';
        ctx.fillRect(x, y - 1, 1, 1);
      }
    }

    // Chimneys: factories, mines and towns smoke a little.
    const smoke = (x: number, y: number, rate: number) => {
      if (Math.random() < dt * rate) this.fx.add({ kind: 'puff', x, y, vx: 1.5, vy: -4, life: 2600, size: 2, color: '#d0d4d6', ambient: true });
    };
    snap.regions.forEach((row, i) => {
      const r = this.map.regions[i];
      if (!seen(r.x, r.y, 40)) return;
      if (row[3] & 2) smoke(r.x + 6, r.y - 2, 0.8);
      if (row[2] >= 2) {
        const [tx, ty] = this.townAt(i);
        smoke(tx, ty - 2, 0.25 * row[2]);
      }
      if (row[10] > 0) {
        const spots = this.spotsIn(i);
        const n = row[9];
        for (let k = 0; k < row[10]; k++) {
          const spot = spots[n + k];
          if (spot) smoke(spot[0] + 2, spot[1] - 1, 0.5);
        }
      }
    });
  }

  /** A building finished: a flash and a puff of dust where it stands. */
  built(region: number, kind: BuildingKind, row: Snapshot['regions'][number]): void {
    const [x, y] = this.siteOf(region, kind, row, true);
    this.fx.add({ kind: 'flash', x: x + 2, y: y - 1, vx: 0, vy: 0, life: 350, size: 6, color: '#ffffff' });
    for (let k = 0; k < 6; k++) {
      this.fx.add({ kind: 'dust', x: x + Math.random() * 5, y: y + 2, vx: (Math.random() - 0.5) * 8, vy: -2 - Math.random() * 3, life: 700, size: 1, color: '#c8b892' });
    }
  }

  /** Placement: valid regions tinted green, everything else dimmed (changed regions only). */
  private updatePlaceLayer(valid: Set<number>): void {
    const W = this.map.width;
    const ctx = this.placeLayer.getContext('2d') as CanvasRenderingContext2D;
    if (!this.placeImg) {
      // Everything starts dimmed, water included.
      this.placeImg = ctx.createImageData(W, this.map.height);
      const d = this.placeImg.data;
      for (let o = 0; o < d.length; o += 4) d.set([8, 11, 14, 140], o);
      ctx.putImageData(this.placeImg, 0, 0);
    }
    const d = this.placeImg.data;
    let [x0, y0, x1, y1] = [W, this.map.height, -1, -1];
    for (let r = 0; r < this.shownValid.length; r++) {
      const on = valid.has(r) ? 1 : 0;
      if (on === this.shownValid[r]) continue;
      this.shownValid[r] = on;
      for (const p of this.regionPixels[r]) d.set(on ? [70, 220, 100, 120] : [8, 11, 14, 140], p * 4);
      const o = r * 4;
      x0 = Math.min(x0, this.regionBox[o]);
      y0 = Math.min(y0, this.regionBox[o + 1]);
      x1 = Math.max(x1, this.regionBox[o + 2]);
      y1 = Math.max(y1, this.regionBox[o + 3]);
    }
    if (x1 >= x0) ctx.putImageData(this.placeImg, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
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
    this.updateTerritory(snap, players);
    this.animateSweeps(performance.now());
    const place = this.placement;
    const lit = place ? (place.valid.has(place.hover) ? place.hover : -1) : selectedRegion;
    this.updateHighlight(lit);

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
    this.updateDevelopLayer(snap);
    ctx.imageSmoothingEnabled = this.cam.scale < 1;
    ctx.drawImage(this.developLayer, 0, 0);
    ctx.imageSmoothingEnabled = false;
    this.updateFrontLayer(snap, players);
    ctx.drawImage(this.frontLayer, 0, 0);
    this.drawSites(snap);
    if (this.fx.level === 'full') this.drawAmbient(snap);
    if (showSupply) ctx.drawImage(this.supplyLayer, 0, 0);
    if (place) {
      this.updatePlaceLayer(place.valid);
      ctx.drawImage(this.placeLayer, 0, 0);
    }
    if (lit >= 0) ctx.drawImage(this.highlight, 0, 0);
    ctx.restore();
    this.drawGrid(w, h);

    this.drawRegions(snap, players, you);
    if (this.roadPreview && this.roadPreview.length > 1) {
      const px = this.pixel();
      const pts = this.roadPreview.map((r) => this.toScreen(...this.townAt(r)));
      for (let i = 0; i + 1 < pts.length; i++) {
        dottedLine(ctx, pts[i][0], pts[i][1] + px, pts[i + 1][0], pts[i + 1][1] + px, INK, px + 1);
        dottedLine(ctx, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], ROAD_COLOR, px + 1);
      }
    }
    this.drawBlobs(snap, players, selected, you);
    this.drawPending(players, you);

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
    const [mx0, my0] = this.toMap(0, 0);
    const [mx1, my1] = this.toMap(w, h);
    // Dotted lines: two stroked paths, not one rectangle per dot.
    ctx.save();
    ctx.strokeStyle = 'rgba(79,209,255,0.10)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let mx = Math.ceil(mx0 / step) * step; mx <= mx1; mx += step) {
      const x = Math.round(this.toScreen(mx, 0)[0]) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let my = Math.ceil(my0 / step) * step; my <= my1; my += step) {
      const y = Math.round(this.toScreen(0, my)[1]) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.restore();
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

      // Icons in a row above the units: capital, fort, barracks, factory (towns are on the map).
      const icons: Sprite[] = [];
      if (capitals.has(region.id)) icons.push(ICONS.capital);
      if (rr[1] > 0) for (let i = 0; i < rr[1]; i++) icons.push(ICONS.fort);
      if (rr[3] & 1) icons.push(ICONS.barracks);
      if (rr[3] & 2) icons.push(ICONS.factory);
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
   * Units: grouped into items (single tokens or per-country stacks) laid out under each
   * region's label. Units on the move stay in their region (with a progress bar) until they
   * hop to the next one; nothing slides. Routes and arrows are drawn under the tokens.
   */
  private drawBlobs(snap: Snapshot, players: GamePlayer[], selected: Set<number>, you: number | null): void {
    const ctx = this.ctx;
    const now = performance.now();
    const px = this.pixel();
    const scale = this.cam.scale;
    const atWar = (a: number, b: number) => snap.wars.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    // On the move: travelling to the next region, or passing through on the way.
    const transit = (b: BlobRow) => b[8] > 0 || (b[7] >= 0 && !(b[11] & 1));

    const byRegion = new Map<number, BlobRow[]>();
    for (const b of snap.blobs) byRegion.set(b[6], [...(byRegion.get(b[6]) ?? []), b]);

    // Individual tokens if zoomed in and they fit, else stacks. A region's own units (and units
    // on their way out) stand in the middle; units in a region their country doesn't hold are
    // attacking or taking it, and stand on the border they crossed, one group per border.
    const items: Item[] = [];
    const step = Math.max(FRAME_W * px, PLATE_MIN_W) + 3;
    const sideGap = 14 * px;
    const swords: Array<[number, number]> = [];
    const attacks: Array<{ owner: number; region: number; side: number; items: Item[]; swords?: boolean }> = [];
    const slot = (key: string, rows: BlobRow[], owner: number, moving: boolean, group: string, single: boolean) => {
      const pinned = group === this.expanded;
      if (single || pinned || rows.length === 1) return rows.map((b) => ({ key: `b:${b[0]}`, rows: [b], owner, moving, group, pinned }));
      return [{ key, rows, owner, moving, group, pinned: false }];
    };
    for (const [region, list] of byRegion) {
      const reg = this.map.regions[region];
      const holder = snap.regions[region][0];
      const fits = list.length * step <= Math.sqrt(reg.area) * scale * 0.9;
      const single = px >= 2 && fits;
      const sorted = [...list].sort((a, b) => b[3] - a[3]);
      // The middle: the holder's units, and anyone's units on their way out.
      const middle: Array<{ key: string; rows: BlobRow[]; owner: number; moving: boolean; group: string; pinned?: boolean }> = [];
      const attackers = new Map<string, { owner: number; side: number; rows: BlobRow[] }>();
      const owners = [...new Set(sorted.map((b) => b[1]))].sort((a, b) => (a === you ? -1 : b === you ? 1 : a - b));
      for (const o of owners) {
        const rows = sorted.filter((b) => b[1] === o);
        const parked = rows.filter((b) => !transit(b));
        const going = new Map<number, BlobRow[]>();
        for (const b of rows) if (transit(b)) going.set(b[7], [...(going.get(b[7]) ?? []), b]);
        if (o === holder) {
          if (parked.length) middle.push(...slot(`s:${o}:${region}`, parked, o, false, `s:${o}:${region}`, single));
        } else {
          for (const b of parked) {
            const side = this.sideOf(b, region, snap);
            if (side < 0) {
              middle.push(...slot(`s:${o}:${region}`, [b], o, false, `s:${o}:${region}`, single));
              continue;
            }
            const k = `${o}:${side}`;
            const g = attackers.get(k) ?? { owner: o, side, rows: [] };
            g.rows.push(b);
            attackers.set(k, g);
          }
        }
        for (const [next, g] of going) middle.push(...slot(`t:${o}:${region}:${next}`, g, o, true, `t:${o}:${region}:${next}`, single));
      }
      // Defenders under attack carry a shield with what helps them hold.
      const besieged = sorted.some((b) => b[1] !== holder && !transit(b) && holder >= 0 && atWar(b[1], holder));
      if (besieged) {
        const river = sorted.some((b) => b[1] !== holder && (b[11] & 2) !== 0);
        for (const sl of middle) {
          if (sl.owner === holder && !sl.moving) {
            (sl as Item).shield = { fort: snap.regions[region][1], dug: sl.rows.some((b) => b[9] >= 0.5), river };
          }
        }
      }
      // Lay out the middle row under the label.
      let width = middle.length * step;
      for (let i = 1; i < middle.length; i++) if (middle[i].owner !== middle[i - 1].owner) width += sideGap;
      let x = -width / 2 + step / 2;
      let prev = -2;
      for (const sl of middle) {
        if (prev !== -2 && sl.owner !== prev) x += sideGap;
        items.push({ ...sl, tx: reg.x + x / scale, ty: reg.y + 14 / scale });
        x += step;
        prev = sl.owner;
      }
      // Each attacking group on its border.
      const hasMiddle = middle.some((sl) => !sl.moving);
      // One crossed swords per fight: beside the arrow of the biggest attack on defenders,
      // or between two warring groups over land nobody here holds.
      let fight: [number, number] | null = null;
      let biggest: (typeof attacks)[number] | null = null;
      let fightBy = 0;
      for (const g of attackers.values()) {
        // The arrow straddles the border; the group stands on its own side, behind the tail.
        const [bx0, by0] = this.borderPoint(region, g.side);
        const [ux, uy] = this.attackDir(region, g.side);
        const group = `a:${g.owner}:${region}:${g.side}`;
        const slots = slot(group, g.rows, g.owner, false, group, single);
        const w = slots.length * step;
        const back = (ARROW_LEN * px) / 2 + Math.abs(ux) * ((FRAME_W * px) / 2 + (w - step) / 2) + Math.abs(uy) * FRAME_H * px * 0.8 + 2 * px;
        const [bx, by] = [bx0 - (ux * back) / scale, by0 - (uy * back) / scale];
        const made: Item[] = [];
        slots.forEach((sl, i) => {
          const it = { ...sl, tx: bx + (-w / 2 + step / 2 + i * step) / scale, ty: by };
          items.push(it);
          made.push(it);
        });
        const at = { owner: g.owner, region, side: g.side, items: made };
        attacks.push(at);
        const defended = middle.some((sl) => !sl.moving && atWar(sl.owner, g.owner));
        if (hasMiddle && defended && g.rows.length > fightBy) [fightBy, biggest] = [g.rows.length, at];
      }
      if (biggest) biggest.swords = true;
      // Fights over land nobody here holds: swords between two warring border groups.
      const groups = [...attackers.values()];
      for (let i = 0; i < groups.length && !fight && !biggest; i++) {
        for (let j = i + 1; j < groups.length && !fight; j++) {
          if (!atWar(groups[i].owner, groups[j].owner)) continue;
          const [ax, ay] = this.borderPoint(region, groups[i].side);
          const [cx, cy] = this.borderPoint(region, groups[j].side);
          fight = [(ax + cx) / 2, (ay + cy) / 2];
        }
      }
      if (fight) swords.push(this.toScreen(...fight));
    }

    this.declutter(items, step, FRAME_H * px + 4 * px + plateHeight(px));
    if (this.expanded !== null && !items.some((it) => it.group === this.expanded)) this.expanded = null;
    // The expanded stack goes on top.
    items.sort((a, b) => Number(a.pinned ?? false) - Number(b.pinned ?? false));

    // Hops: a unit that just entered the next region glides there quickly from where it was.
    for (const it of items) {
      let glide: { x: number; y: number; start: number } | undefined;
      for (const b of it.rows) {
        const was = this.lastRegion.get(b[0]);
        const from = this.lastDrawn.get(b[0]);
        if (was !== undefined && was !== b[6] && from) this.glides.set(b[0], { x: from[0], y: from[1], start: now });
        glide ??= this.glides.get(b[0]);
      }
      if (!glide) continue;
      const t = (now - glide.start) / GLIDE_MS;
      if (t >= 1) {
        for (const b of it.rows) this.glides.delete(b[0]);
        // Landing: a little dust.
        const foot = (FRAME_H * px) / 2 / scale;
        for (let i = 0; i < 4; i++) {
          this.fx.add({ kind: 'dust', x: it.tx + (Math.random() - 0.5) * (FRAME_W * px) / scale, y: it.ty + foot, vx: (Math.random() - 0.5) * 6, vy: -2, life: 450, size: 1, color: '#b8a98a' });
        }
        continue;
      }
      const e = 1 - (1 - t) ** 3;
      it.tx = glide.x + (it.tx - glide.x) * e;
      it.ty = glide.y + (it.ty - glide.y) * e;
    }
    this.lastRegion = new Map(snap.blobs.map((b) => [b[0], b[6]]));
    const drawn = new Map<number, [number, number]>();
    for (const it of items) for (const b of it.rows) drawn.set(b[0], [it.tx, it.ty]);
    this.lastDrawn = drawn;
    const phase = now / 60;

    // Routes (yours) and next-hop arrows (everyone else's), under the tokens.
    const routes = new Map(snap.routes.map((r) => [r[0], r.slice(1)]));
    /** Destination region → heading there with a selected unit. */
    const destinations = new Map<number, boolean>();
    // Regions with a fight in them (units of two sides at war standing there).
    const contested = new Set<number>();
    {
      const standing = new Map<number, Set<number>>();
      for (const b of snap.blobs) if (!transit(b)) standing.set(b[6], (standing.get(b[6]) ?? new Set()).add(b[1]));
      for (const [r, o] of standing) {
        const list = [...o];
        if (list.some((a) => list.some((c) => a !== c && atWar(a, c)))) contested.add(r);
      }
    }
    for (const it of items) {
      if (!it.moving) continue;
      const [sx, sy] = this.toScreen(it.tx, it.ty);
      const color = colorOf(players, it.owner);
      // Pulling out of a fight, back to its own land or the way it came: a grey retreat arrow.
      const b0 = it.rows[0];
      if (contested.has(b0[6]) && b0[7] >= 0 && (snap.regions[b0[7]][0] === it.owner || b0[7] === b0[12])) {
        const [nx, ny] = this.toScreen(...this.borderPoint(b0[6], b0[7]));
        const d = Math.hypot(nx - sx, ny - sy);
        if (d > 4 * px) {
          const ux = (nx - sx) / d;
          const uy = (ny - sy) / d;
          const st = (FRAME_W * px) / 2 + 2 * px;
          drawArrow(ctx, sx + ux * st, sy + uy * st, ux, uy, '#9aa3a9', px, 0.75);
        }
        if (it.owner !== you) continue;
      }
      if (it.owner === you) {
        const sel = it.rows.some((b) => selected.has(b[0]));
        const drawn = new Set<string>();
        for (const b of it.rows) {
          const route = routes.get(b[0]);
          if (!route?.length) continue;
          const dest = route[route.length - 1];
          destinations.set(dest, (destinations.get(dest) ?? false) || selected.has(b[0]));
          if (drawn.has(route.join())) continue;
          drawn.add(route.join());
          ctx.globalAlpha = sel ? 1 : 0.35;
          let [ax, ay] = [sx, sy];
          for (const r of route) {
            const reg = this.map.regions[r];
            const [bx, by] = this.toScreen(reg.x, reg.y);
            dottedLine(ctx, ax, ay, bx, by + 14, color, px, phase);
            [ax, ay] = [bx, by + 14];
          }
          ctx.globalAlpha = 1;
        }
      } else if (it.rows[0][7] >= 0) {
        const next = this.map.regions[it.rows[0][7]];
        const [nx, ny] = this.toScreen(next.x, next.y + 14 / scale);
        arrow(ctx, sx, sy, nx, ny, (FRAME_W * px) / 2 + 3 * px, color, px);
      }
    }
    // A down arrow over each place your units are heading: bright if a selected unit is.
    if (you !== null) {
      const color = colorOf(players, you);
      for (const [r, sel] of destinations) {
        const reg = this.map.regions[r];
        const [mx, my] = this.toScreen(reg.x, reg.y);
        ctx.globalAlpha = sel ? 1 : 0.35;
        destArrow(ctx, Math.round(mx), Math.round(my + 14 - (FRAME_H * px) / 2 - 2 * px), color, px + 1);
        ctx.globalAlpha = 1;
      }
    }
    // Attack arrows: halfway across the border each attack crossed, pointing in. They stay on
    // the border even if a crowded screen pushed the group aside.
    const shown = new Set(items);
    for (const at of attacks) {
      if (!at.items.some((it) => shown.has(it))) continue;
      const [bx, by] = this.toScreen(...this.borderPoint(at.region, at.side));
      const [ux, uy] = this.attackDir(at.region, at.side);
      const half = (ARROW_LEN * px) / 2;
      drawArrow(ctx, bx - ux * half, by - uy * half, ux, uy, colorOf(players, at.owner), px);
      if (at.swords) {
        // Beside the arrow, on its upper side, clear of the head.
        const [nx, ny] = ux >= 0 ? [uy, -ux] : [-uy, ux];
        const off = 13 * px;
        swords.push([bx + nx * off, by + ny * off]);
      }
    }
    const blink = Math.floor(now / 300) % 2;
    for (const [x, y] of swords) {
      blitCentred(ctx, ICONS.swords[blink], Math.round(x), Math.round(y), px);
    }

    this.battleEffects(snap, items, now, px);
    const toScreen = (x: number, y: number) => this.toScreen(x, y);
    this.fx.draw(ctx, toScreen, px, now);

    // Tokens and stacks.
    const placed: Placed[] = [];
    const r = (FRAME_W * px) / 2;
    for (const it of items) {
      const [x, y] = this.toScreen(it.tx, it.ty);
      // Just took losses: a short shake.
      const shake = it.rows.some((b) => (this.shaking.get(b[0]) ?? 0) > now) ? (Math.floor(now / 40) % 2 ? px : -px) : 0;
      const p = { ids: it.rows.map((b) => b[0]), x: Math.round(x) + shake, y: Math.round(y), r, group: it.group, stack: it.rows.length > 1 };
      this.drawItem(it, p, players, it.rows.some((b) => selected.has(b[0])), px, now);
      placed.push(p);
    }
    this.placed = placed;
  }

  /** When each fight on screen fires its next artillery round. */
  private readonly nextBoom = new Map<number, number>();

  /** Fights on screen: tracers, muzzle flashes, smoke and artillery. */
  private battleEffects(snap: Snapshot, items: Item[], now: number, px: number): void {
    const dt = Math.min(100, now - this.frameAt) / 1000;
    this.frameAt = now;
    const scale = this.cam.scale;
    const atWar = (a: number, b: number) => snap.wars.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    const byRegion = new Map<number, Item[]>();
    for (const it of items) {
      if (it.moving) continue;
      const r = it.rows[0][6];
      byRegion.set(r, [...(byRegion.get(r) ?? []), it]);
    }
    const W = this.map.width;
    const cw = this.canvas.clientWidth;
    const chh = this.canvas.clientHeight;
    const rand = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
    let fights = 0;
    for (const [r, list] of byRegion) {
      const owners = [...new Set(list.map((it) => it.owner))];
      const pairs: Array<[Item, Item]> = [];
      for (const a of list) for (const b of list) if (a.owner < b.owner && atWar(a.owner, b.owner)) pairs.push([a, b]);
      if (!pairs.length || owners.length < 2) continue;
      const pts = list.map((it) => this.toScreen(it.tx, it.ty));
      const minX = Math.min(...pts.map((p) => p[0]));
      const maxX = Math.max(...pts.map((p) => p[0]));
      const minY = Math.min(...pts.map((p) => p[1]));
      const maxY = Math.max(...pts.map((p) => p[1]));
      const cy = (minY + maxY) / 2;
      const cx = (minX + maxX) / 2;
      if (cx < -80 || cy < -80 || cx > cw + 80 || cy > chh + 80) continue;
      fights++;

      // Tracers between the sides, muzzle flashes and gun smoke.
      if (Math.random() < dt / 0.25) {
        const [a, b] = rand(pairs);
        const [from, to] = Math.random() < 0.5 ? [a, b] : [b, a];
        this.fx.add({ kind: 'tracer', x: from.tx, y: from.ty, x2: to.tx, y2: to.ty, vx: 0, vy: 0, life: 260, size: 1, color: '#fff1a8' });
      }
      if (Math.random() < dt * 10 && this.fx.allow()) {
        const it = rand(list);
        const jx = ((Math.random() - 0.5) * FRAME_W * px * 1.8) / scale;
        const jy = ((Math.random() - 0.5) * FRAME_H * px * 1.2) / scale;
        this.fx.add({ kind: 'spark', x: it.tx + jx, y: it.ty + jy, vx: 0, vy: 0, life: 130, size: 2, color: Math.random() < 0.5 ? '#fff3a0' : '#ffffff' });
      }
      if (Math.random() < dt * 2.5 && this.fx.allow()) {
        const it = rand(list);
        this.fx.add({ kind: 'smoke', x: it.tx + ((Math.random() - 0.5) * 24 * px) / scale, y: it.ty - (8 * px) / scale, vx: 3, vy: -6, life: 1900, size: 3, color: '#a3a9ad' });
      }
      // Artillery: now and then a shell lands somewhere in the region.
      const due = this.nextBoom.get(r) ?? now + 600 + Math.random() * 1800;
      if (now >= due) {
        const pix = this.regionPixels[r];
        const i = pix[Math.floor(Math.random() * pix.length)];
        const x = i % W;
        const y = (i - x) / W;
        this.fx.add({ kind: 'boom', x, y, vx: 0, vy: 0, life: 560, size: 7, color: '#ff9a3c' });
        for (let k = 0; k < 3; k++) {
          this.fx.add({ kind: 'smoke', x: x + (Math.random() - 0.5) * 2, y, vx: 1 + Math.random() * 2, vy: -3 - Math.random() * 3, born: now + 120 + k * 90, life: 2100, size: 4, color: '#5a5f63' });
        }
        this.sounds?.boom(Math.min(1, scale / 2));
        this.nextBoom.set(r, now + 2000 + Math.random() * 2000);
      } else this.nextBoom.set(r, due);
    }
    // Small-arms fire for the fights on screen, a few crackles a second at most.
    if (fights && Math.random() < dt * Math.min(6, 2 * fights)) this.sounds?.gun(Math.min(1, 0.35 + 0.1 * fights) * Math.min(1, scale / 1.5));
  }

  /** Losses since the last snapshot: the unit shakes. */
  noteLosses(prev: Snapshot, next: Snapshot): void {
    const before = new Map(prev.blobs.map((b) => [b[0], b[3]]));
    const owners = new Map<number, Set<number>>();
    for (const b of next.blobs) if (b[8] === 0) owners.set(b[6], (owners.get(b[6]) ?? new Set()).add(b[1]));
    const now = performance.now();
    for (const b of next.blobs) {
      const was = before.get(b[0]);
      if (was === undefined || (owners.get(b[6])?.size ?? 0) < 2 || was - b[3] <= 0) continue;
      this.shaking.set(b[0], now + 300);
    }
  }

  /**
   * Zoomed out, neighbouring regions' units pile up on screen. Items of one country that
   * would overlap become one stack (parked and moving units never mix); items of different
   * countries that overlap are pushed apart.
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
        (k) =>
          !k.pinned &&
          !it.pinned &&
          k.owner === it.owner &&
          k.moving === it.moving &&
          // An attack never folds into a stack elsewhere (its arrow would go with it).
          k.group.startsWith('a:') === it.group.startsWith('a:') &&
          Math.abs(k.tx - it.tx) * scale < w * 0.9 &&
          Math.abs(k.ty - it.ty) * scale < h * 0.9,
      );
      if (host) {
        host.rows = [...host.rows, ...it.rows].sort((a, b) => b[3] - a[3]);
        gone.add(it);
      } else kept.push(it);
    }
    for (let i = items.length - 1; i >= 0; i--) if (gone.has(items[i])) items.splice(i, 1);

    // Different countries: a few rounds of pushing overlapping pairs apart (sideways mostly).
    for (let round = 0; round < 12; round++) {
      let moved = false;
      for (let i = 0; i < kept.length; i++) {
        for (let j = i + 1; j < kept.length; j++) {
          const a = kept[i];
          const b = kept[j];
          if (a.pinned && b.pinned) continue;
          const dx = (b.tx - a.tx) * scale;
          const dy = (b.ty - a.ty) * scale;
          const ox = w - Math.abs(dx);
          const oy = h - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          // Push along the axis that needs the shorter move; standing items move less.
          // The expanded stack's tokens never move.
          const share = a.pinned ? 0 : b.pinned ? 1 : a.moving === b.moving ? 0.5 : a.moving ? 1 : 0;
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

  /** Stand-ins for orders on their way to the server: a route line and building ghosts. */
  private drawPending(players: GamePlayer[], you: number | null): void {
    const ctx = this.ctx;
    const px = this.pixel();
    const color = you === null ? '#ffffff' : colorOf(players, you);
    const move = this.pending.move;
    if (move) {
      const [tx, ty] = this.toScreen(...this.townAt(move.to));
      for (const id of move.ids) {
        const at = this.screenOfUnit(id);
        if (at) dottedLine(ctx, at[0], at[1], tx, ty + 14, color, px);
      }
      destArrow(ctx, Math.round(tx), Math.round(ty + 14 - (FRAME_H * px) / 2 - 2 * px), color, px + 1);
    }
    ctx.globalAlpha = 0.6;
    for (const b of this.pending.builds) {
      const r = this.map.regions[b.region];
      const [x, y] = this.toScreen(r.x, r.y);
      blitCentred(ctx, ICONS[b.kind], Math.round(x), Math.round(y - 10 * px), px + 1);
    }
    ctx.globalAlpha = 1;
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
  private drawItem(it: Item, p: Placed, players: GamePlayer[], selected: boolean, px: number, now: number): void {
    const ctx = this.ctx;
    const rows = it.rows;
    const color = colorOf(players, rows[0][1]);
    const w = FRAME_W * px;
    const h = FRAME_H * px;
    const x0 = Math.round(p.x - w / 2);
    const y0 = Math.round(p.y - h / 2);
    // Everything but the live bits comes from a cached bitmap: one drawImage per token.
    // Idle motion: the pennant flutters (and a supply warning blinks) on each unit's own beat.
    const beat = Math.floor((now + rows[0][0] * 137) / 700) % 2;
    const token = tokenSprite(rows, color, px, beat);
    ctx.drawImage(token, p.x - TOKEN_AX * px, p.y - TOKEN_AY * px);
    // On the move: a bar of 5 cells left of the frame fills up until the hop to the next region.
    if (it.moving) {
      const progress = Math.min(1, Math.max(...rows.map((b) => b[8])));
      const bx = x0 - 3 * px;
      ctx.fillStyle = INK;
      ctx.fillRect(bx - px, y0, 3 * px, h);
      const cell = (h - 2 * px) / 5;
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = progress > i / 5 + 0.02 ? '#ffffff' : '#2c3a44';
        ctx.fillRect(bx, Math.round(y0 + h - px - (i + 1) * cell), px, Math.max(px, Math.round(cell) - px));
      }
    }
    // Defenders under attack: a shield with fort level, dug in and river.
    if (it.shield && !it.moving) {
      const sh = shieldSprite(it.shield.fort, it.shield.dug, it.shield.river);
      blit(ctx, sh, x0 - (sh.width + 1) * px, y0 + px, px);
    }
    // Selected: blinking corner brackets.
    if (selected && Math.floor(performance.now() / 400) % 2 === 0) {
      brackets(ctx, Math.round(p.x), Math.round(y0 + h / 2 + 2 * px), w / 2 + 2 * px, '#ffffff', px);
    }
  }
}

const shieldCache = new Map<string, HTMLCanvasElement>();
/** A defender's shield: fort pips at the top, a blue wave for a river, a brown bar if dug in. */
function shieldSprite(fort: number, dug: boolean, river: boolean): HTMLCanvasElement {
  const key = `${fort}${dug}${river}`;
  let c = shieldCache.get(key);
  if (c) return c;
  const rows = ['OOOOOOO', 'OGGGGGO', 'OGGGGGO', 'OGGGGGO', 'OGGGGGO', 'OGGGGGO', '.OGGGO.', '..OGO..', '...O...'].map((r) => r.split(''));
  for (let i = 0; i < Math.min(3, fort); i++) rows[2][1 + i * 2] = 'K';
  if (river) {
    rows[4][1] = 'B';
    rows[4][3] = 'B';
    rows[4][5] = 'B';
    rows[3][2] = 'B';
    rows[3][4] = 'B';
  }
  if (dug) for (let x = 2; x <= 4; x++) rows[6][x] = 'D';
  c = art(
    rows.map((r) => r.join('')),
    { G: '#c9d1d6', K: '#3b4248', B: '#4fa3e0', D: '#8a6a3d' },
  );
  shieldCache.set(key, c);
  return c;
}

/** A hop's quick glide into the next region. */
const GLIDE_MS = 300;
/** A captured region filling with its new colour. */
const SWEEP_MS = 1000;

/** Token bitmaps: the anchor (the token's centre) sits at (TOKEN_AX, TOKEN_AY) × px. */
const TOKEN_AX = 40;
const TOKEN_AY = 24;
const tokenCache = new Map<string, HTMLCanvasElement>();

/**
 * A NATO symbol for one unit or a stack, drawn once and cached: the deck of frames behind,
 * the framed branch symbol, a strength bar, the strength number, the ×N count for a stack,
 * the supply mark and training chevrons.
 */
function tokenSprite(rows: BlobRow[], color: string, px: number, beat: number): HTMLCanvasElement {
  const byType = new Map<string, number>();
  for (const b of rows) byType.set(UNIT_INDEX[b[2]], (byType.get(UNIT_INDEX[b[2]]) ?? 0) + b[3]);
  const type = ([...byType].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'infantry') as 'infantry' | 'tank';
  const strength = rows.reduce((s, b) => s + b[3], 0);
  const size = rows.reduce((s, b) => s + b[4], 0);
  const supply = Math.min(...rows.map((b) => b[10]));
  const training = rows.reduce((s, b) => s + b[5] * b[3], 0) / Math.max(1, strength);
  const share = strength / Math.max(1, size);
  const cellsOn = [0, 1, 2, 3, 4].filter((i) => share > i / 5 + 0.02).length;
  const barColor = share > 0.6 ? '#7bd389' : share > 0.3 ? '#f1c232' : '#ff5a5a';
  const supplyMark = supply >= 0.99 ? '' : supply <= 0 ? '#ff5a5a' : '#ffb347';
  const chevrons = Math.floor(training / 34);
  const deck = rows.slice(1, 3).map((b) => `${b[2]}.${b[4]}`).join(',');
  const label = String(Math.ceil(strength));
  const key = `${type}|${rows[0][4]}|${deck}|${color}|${label}|${rows.length}|${supplyMark}|${chevrons}|${cellsOn}${barColor}|${px}|${beat}`;
  let c = tokenCache.get(key);
  if (c) return c;
  if (tokenCache.size > 1500) tokenCache.clear();
  c = offscreen(TOKEN_AX * 2 * px, (TOKEN_AY + 36) * px);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  const cx = TOKEN_AX * px;
  const cy = TOKEN_AY * px;
  const w = FRAME_W * px;
  const h = FRAME_H * px;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - h / 2);

  // The deck: up to two more frames peeking out behind (other types show as themselves).
  for (let i = Math.min(2, rows.length - 1); i >= 1; i--) {
    const b = rows[i];
    const back = unitFrame(UNIT_INDEX[b[2]], b[4], UNITS[UNIT_INDEX[b[2]]].maxSize, color);
    blit(ctx, back, x0 + 2 * i * px, y0 - 2 * i * px, px);
  }
  blit(ctx, unitFrame(type, rows[0][4], UNITS[type].maxSize, color), x0, y0, px);

  // Strength bar under the frame: 5 cells.
  const by = y0 + h + px;
  ctx.fillStyle = INK;
  ctx.fillRect(x0, by - px, w, 3 * px);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i < cellsOn ? barColor : '#2c3a44';
    ctx.fillRect(x0 + px + i * 3 * px, by, 2 * px + (i === 4 ? px : 0), px);
  }

  // Strength number below, in pixel digits with a thin dark outline.
  outlinedDigits(ctx, label, cx, by + 2 * px + plateHeight(px) / 2, digitScale(px));

  // A stack: how many units, top right (×N).
  if (rows.length > 1) {
    const bx = x0 + w + 2 * px + 2 * px * Math.min(2, rows.length - 1);
    const bcy = y0 - 2 * px * Math.min(2, rows.length - 1) + 2 * px;
    countBadge(ctx, rows.length, bx, bcy, px);
  }

  // Supply: amber/red block in the top-right corner of the frame (blinking).
  if (supplyMark) {
    ctx.fillStyle = INK;
    ctx.fillRect(x0 + w - 4 * px, y0 + 3 * px, 4 * px, 4 * px);
    ctx.fillStyle = beat ? shade(supplyMark, 0.55) : supplyMark;
    ctx.fillRect(x0 + w - 3 * px, y0 + 4 * px, 2 * px, 2 * px);
  }
  // A small pennant on a staff at the top right, fluttering between two shapes.
  ctx.fillStyle = INK;
  ctx.fillRect(x0 + w - px, y0 - 3 * px, px, 4 * px);
  ctx.fillStyle = shade(color, 1.3);
  if (beat) {
    ctx.fillRect(x0 + w, y0 - 3 * px, 2 * px, px);
    ctx.fillRect(x0 + w + px, y0 - 2 * px, 2 * px, px);
  } else {
    ctx.fillRect(x0 + w, y0 - 3 * px, 3 * px, 2 * px);
  }
  // Training: gold chevrons to the left of the echelon marks.
  for (let i = 0; i < chevrons; i++) {
    const chx = x0 + i * 4 * px;
    ctx.fillStyle = '#f1c232';
    ctx.fillRect(chx, y0 + px, px, px);
    ctx.fillRect(chx + px, y0 + 2 * px, px, px);
    ctx.fillRect(chx + 2 * px, y0 + px, px, px);
  }
  tokenCache.set(key, c);
  return c;
}

/** Room under each unit for its number; units in a row are at least this far apart. */
const PLATE_MIN_W = 22;
const digitScale = (px: number) => (px >= 2 ? 3 : 2);
const plateHeight = (px: number) => 5 * digitScale(px) + 5;

export interface SupplyInfo {
  /** Reach left (in half hops) in each of your regions a hub supplies. */
  left: Map<number, number>;
  hubs: number[];
  /** Supply your units standing in each region need. */
  need: Map<number, number>;
}

/** Pixel-font text with a 1px dark outline, at whole pixels. */
const textCache = new Map<string, HTMLCanvasElement>();

function pixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string): void {
  const font = `${size >= 12 ? 700 : 400} ${size}px "Pixelify Sans", monospace`;
  const key = `${font}|${color}|${text}`;
  let c = textCache.get(key);
  if (!c) {
    // Until the pixel font has loaded, draw straight away (and don't cache the fallback).
    if (!document.fonts.check(font)) {
      paintText(ctx, font, text, Math.round(x), Math.round(y), color);
      return;
    }
    if (textCache.size > 2000) textCache.clear();
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 6;
    const h = Math.ceil(size * 1.6) + 4;
    c = offscreen(w, h);
    paintText(c.getContext('2d') as CanvasRenderingContext2D, font, text, Math.round(w / 2), Math.round(h / 2), color);
    textCache.set(key, c);
  }
  ctx.drawImage(c, Math.round(x) - Math.round(c.width / 2), Math.round(y) - Math.round(c.height / 2));
}

/** Pixel-font text with a 1px dark outline, centred on (x, y). */
function paintText(ctx: CanvasRenderingContext2D, font: string, text: string, x: number, y: number, color: string): void {
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [1, 1],
  ]) {
    ctx.fillText(text, x + dx, y + dy);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
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

/**
 * The attack arrow: one hand-drawn pixel sprite pointing right (an ink outline, the body lit
 * on top and shaded underneath), turned whole to any angle when drawn, so every arrow has
 * the same pixels.
 */
const ARROW_ROWS = [
  '.................O.......',
  '................OLO......',
  '................OCLO.....',
  '................OCCLO....',
  '.OOOOOOOOOOOOOOOOCCCLO...',
  'OLLLLLLLLLLLLLLLLCCCCLO..',
  'OCCCCCCCCCCCCCCCCCCCCCLO.',
  'OCCCCCCCCCCCCCCCCCCCCCCLO',
  'OCCCCCCCCCCCCCCCCCCCCCDO.',
  'ODDDDDDDDDDDDDDDDCCCCDO..',
  '.OOOOOOOOOOOOOOOOCCCDO...',
  '................OCCDO....',
  '................OCDO.....',
  '................ODO......',
  '.................O.......',
];
const ARROW_LEN = ARROW_ROWS[0].length;
const arrowCache = new Map<string, HTMLCanvasElement>();

function arrowSprite(color: string): HTMLCanvasElement {
  let c = arrowCache.get(color);
  if (!c) {
    c = color === 'shadow'
      ? art(ARROW_ROWS.map((r) => r.replace(/[LCD]/g, 'O')), { O: 'rgba(0,0,0,0.3)' })
      : art(ARROW_ROWS, { L: shade(color, 1.4), C: color, D: shade(color, 0.7) });
    arrowCache.set(color, c);
  }
  return c;
}

/** Draws the attack arrow with its tail at (x, y), pointing along (ux, uy), `s` px per pixel. */
function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, ux: number, uy: number, color: string, s: number, alpha = 1): void {
  const w = ARROW_LEN * s;
  const h = ARROW_ROWS.length * s;
  const angle = Math.atan2(uy, ux);
  ctx.globalAlpha = alpha;
  // The shadow first, falling down and to the right whatever the arrow's angle.
  for (const [sprite, dx, dy] of [
    [arrowSprite('shadow'), s, s],
    [arrowSprite(color), 0, 0],
  ] as const) {
    ctx.save();
    ctx.translate(x + (ux * w) / 2 + dx, y + (uy * w) / 2 + dy);
    ctx.rotate(angle);
    ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/** A pixel arrow pointing down, its tip at (x, y): where your units are heading. */
function destArrow(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, px: number): void {
  // Rows from the top: a 3-wide shaft, then the head narrowing to the tip.
  const widths = [3, 3, 3, 7, 5, 3, 1];
  const top = y - widths.length * px;
  ctx.fillStyle = INK;
  widths.forEach((w, i) => ctx.fillRect(x - Math.floor((w + 2) / 2) * px, top + (i - 1) * px, (w + 2) * px, 3 * px));
  ctx.fillStyle = color;
  widths.forEach((w, i) => ctx.fillRect(x - Math.floor(w / 2) * px, top + i * px, w * px, px));
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
/** Dots along a line; `phase` (in pixels) makes them march from (x0, y0) toward (x1, y1). */
function dottedLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, px: number, phase = 0): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const step = 4 * px;
  ctx.fillStyle = color;
  for (let d = step - ((phase * px) % step); d < len; d += step) {
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
