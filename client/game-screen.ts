// The game: map view, mouse and keyboard orders, and the HUD panels.
import type { GameMap, Region } from '../shared/map.ts';
import type { BlobRow, GameEvent, GamePlayer, Order, ProductionView, Snapshot } from '../shared/protocol.ts';
import { BUILDING_INDEX, UNIT_INDEX } from '../shared/protocol.ts';
import {
  BUILD_NEEDS,
  BUILD_QUEUE,
  type BuildingKind,
  buildCost,
  canBuildOn,
  captureSeconds,
  ECON_KINDS,
  type EconKind,
  FOUND_CITY_MIN_HOPS,
  HINTERLAND_HOPS,
  MAX_CITY,
  MAX_FORT,
  RESOURCES,
  type Resources,
  slotsOf,
  stackCap,
  supplyCapacity,
  supplyReach,
  UNITS,
} from '../shared/rules.ts';
import { FrameMeter } from './fx.ts';
import { colorOf, MapView } from './map-view.ts';
import { Sfx } from './sfx.ts';
import type { Net } from './net.ts';
import { hudIcon, ICONS, spriteUrl } from './sprites.ts';
import { $, cellBar, classbar, confirmBox, el, fmt, toast } from './ui.ts';

const BUILD_LABEL: Record<BuildingKind, string> = {
  farm: 'Farm',
  mine: 'Mine',
  well: 'Oil well',
  market: 'Market',
  city: 'City',
  fort: 'Fort',
  barracks: 'Barracks',
  factory: 'Factory',
  road: 'Road',
};
/** The build bar, in groups; hotkeys 1-9 follow this order. */
const BAR: Array<{ group: string; kinds: BuildingKind[] }> = [
  { group: 'Economy', kinds: ['farm', 'mine', 'well', 'market'] },
  { group: 'City', kinds: ['city'] },
  { group: 'Military', kinds: ['fort', 'barracks', 'factory'] },
  { group: 'Logistics', kinds: ['road'] },
];
const HOTKEYS: BuildingKind[] = BAR.flatMap((g) => g.kinds);
/** Region row fields of the economic buildings. */
const ECON_FIELD: Record<EconKind, number> = { farm: 9, mine: 10, well: 11, market: 12 };
const RES_SHORT: Record<keyof Resources, string> = { money: '$', manpower: 'MP ', steel: 'ST ', oil: 'OIL ' };

export class GameScreen {
  private readonly net: Net;
  private readonly map: GameMap;
  private readonly view: MapView;
  private readonly you: number | null;
  private readonly players: GamePlayer[];
  private readonly onBack: () => void;
  private snap: Snapshot | null = null;
  private selected = new Set<number>();
  private region = -1;
  /** Placement mode: the building a click on one of your regions puts there. */
  private placing: BuildingKind | null = null;
  /** The region under the cursor. */
  private hover = -1;
  private buildbarKey = '';
  /** Where the building being placed can go: worked out once per snapshot. */
  private valid: { snap: Snapshot; kind: BuildingKind; set: Set<number> } | null = null;
  private miniSnap: Snapshot | null = null;
  private miniCam = '';
  private miniAt = 0;
  /** Road tool: the regions dragged across so far. */
  private roadPath: number[] | null = null;
  private box: [number, number, number, number] | null = null;
  private feed: Array<[string, string]> = [];
  /** Game time each region last got a supply warning. */
  private readonly supplyWarned = new Map<number, number>();
  private raf = 0;
  private keys = new Set<string>();
  private readonly cleanup: Array<() => void> = [];
  private centred = false;
  finished = false;
  private readonly minimap: HTMLCanvasElement;
  private readonly sfx = new Sfx();
  private readonly meter = new FrameMeter();
  /** The player picked full effects themselves: don't reduce them automatically again. */
  private fxChosen = false;

  constructor(net: Net, map: GameMap, terrain: HTMLImageElement, you: number | null, players: GamePlayer[], onBack: () => void) {
    this.net = net;
    this.map = map;
    this.you = you;
    this.players = players;
    this.onBack = onBack;
    this.view = new MapView($('#map') as HTMLCanvasElement, map, terrain);
    this.minimap = $('#minimap') as HTMLCanvasElement;
    this.view.sounds = { gun: (v) => this.sfx.gun(v), boom: (v) => this.sfx.boom(v) };
    this.minimap.width = 240;
    this.minimap.height = Math.round((240 * map.height) / map.width);
    this.setOverlay(false);
    $('#over').classList.add('hidden');
    $('#panel').classList.add('hidden');
    $('#feed').replaceChildren();
    $('#feed').classList.add('hidden');
    $('#over-back').onclick = () => this.onBack();
    $('#over-menu').onclick = () => this.leave();
    $('#menu').classList.add('hidden');
    $('#menu-resume').onclick = () => this.toggleMenu(false);
    $('#menu-surrender').onclick = () => void this.surrender();
    $('#menu-leave').onclick = () => void this.leaveAsked();
  }

  /** Still in the game: alive, and it isn't over. */
  private get playing(): boolean {
    return !this.finished && this.you !== null && !!this.snap?.players[this.you]?.alive;
  }

  private toggleMenu(open = $('#menu').classList.contains('hidden')): void {
    $('#menu').classList.toggle('hidden', !open);
    if (!open) return;
    const id = this.you !== null ? this.players[this.you]?.country : '';
    const country = this.map.countries.find((c) => c.id === id)?.name ?? 'your country';
    ($('#menu-surrender') as HTMLButtonElement).classList.toggle('hidden', !this.playing);
    $('#menu-note').textContent = this.playing
      ? `Leaving hands ${country} to a bot, which plays on. Surrendering ends ${country}: its land goes neutral and its units disband, and you watch the rest.`
      : 'You are watching. Leaving takes you back to the main menu.';
  }

  private async surrender(): Promise<void> {
    this.toggleMenu(false);
    if (!this.playing) return;
    const ok = await confirmBox('Surrender', 'Give up? Your land goes neutral and your units disband, as if your capital fell. You can watch the rest of the game.', 'Surrender');
    if (ok) this.send({ o: 'surrender' });
  }

  private async leaveAsked(): Promise<void> {
    this.toggleMenu(false);
    if (this.playing) {
      const ok = await confirmBox('Leave the game', 'Back to the main menu? A bot takes over your country and plays on.', 'Leave');
      if (!ok) return;
    }
    this.leave();
  }

  /** Back to the main menu: leaves the lobby (the server answers with no lobby). */
  private leave(): void {
    this.net.send({ t: 'lobby.leave' });
  }

  start(): void {
    // A small handle for automated browser tests and the console.
    (window as unknown as { openfork: unknown }).openfork = {
      you: this.you,
      snap: () => this.snap,
      unitAt: (id: number) => this.view.screenOfUnit(id),
      items: () => this.view.drawnItems(),
      artOffLand: () => this.view.artOffLand(),
      screenOf: (region: number) => {
        const r = this.map.regions[region];
        return this.view.toScreen(r.x, r.y);
      },
      focus: (region: number) => {
        const r = this.map.regions[region];
        this.view.focus(r.x, r.y, 1.3);
      },
    };
    this.view.resize();
    this.view.fit();
    this.bindInput();
    const frame = () => {
      this.raf = requestAnimationFrame(frame);
      this.panWithKeys();
      // A struggling machine: drop the ambient effects (once, unless the player chose them).
      if (this.meter.tick(performance.now()) && this.view.fx.level === 'full' && !this.fxChosen) {
        this.setEffects('reduced');
        toast('Effects reduced to keep the game smooth (FX in the top bar)', 'info');
      }
      if (this.snap) {
        this.view.placement = this.placing ? { valid: this.validFor(this.placing), hover: this.hover } : null;
        this.view.draw(this.snap, this.players, this.you, this.selected, this.region, this.box);
        // The minimap: on news or a camera move, at most 5 times a second.
        const cam = `${this.view.cam.x}|${this.view.cam.y}|${this.view.cam.scale}`;
        const now = performance.now();
        if ((this.snap !== this.miniSnap || cam !== this.miniCam) && now - this.miniAt > 200) {
          this.view.drawMinimap(this.minimap, this.snap);
          this.miniSnap = this.snap;
          this.miniCam = cam;
          this.miniAt = now;
        }
      }
    };
    frame();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanup) c();
  }

  private send(order: Order): void {
    this.net.send({ t: 'order', order });
  }

  // -- server updates -----------------------------------------------------------------------

  onSnapshot(snap: Snapshot): void {
    if (this.snap) this.view.noteLosses(this.snap, snap);
    this.snap = snap;
    this.warnSupply(snap);
    // Stand-ins for orders on their way: gone once the server's routes show, or after half a second.
    const p = this.view.pending;
    const routed = new Set(snap.routes.map((r) => r[0]));
    if (p.move && (p.move.ids.some((id) => routed.has(id)) || snap.time > p.move.since + 0.5)) p.move = null;
    p.builds = p.builds.filter((b) => snap.time <= b.since + 0.5);
    const alive = new Set(snap.blobs.map((b) => b[0]));
    for (const id of this.selected) if (!alive.has(id)) this.selected.delete(id);
    if (!this.centred && this.you !== null) {
      this.centred = true;
      this.centreOnCapital();
    }
    for (const e of snap.events) this.addEvent(e);
    this.renderTopbar();
    this.renderPlayers();
    this.renderOffers();
    this.renderPanel();
    this.renderBuildbar();
  }

  onOver(winner: number | null): void {
    this.finished = true;
    const name = winner === null ? 'Nobody' : this.players[winner]?.name;
    $('#over-title').textContent = winner === this.you ? 'Victory! Every capital is yours.' : `${name} wins.`;
    $('#over').classList.remove('hidden');
  }

  private centreOnCapital(): void {
    if (this.you === null) return;
    const c = this.map.countries.find((x) => x.id === this.players[this.you as number].country);
    if (!c) return;
    const r = this.map.regions[c.capital];
    this.view.focus(r.x, r.y, 1.3);
  }

  // -- input ----------------------------------------------------------------------------------

  private bindInput(): void {
    const canvas = this.view.canvas;
    let down: { x: number; y: number; button: number; moved: boolean } | null = null;
    const pos = (e: MouseEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const on = <K extends keyof WindowEventMap>(target: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
    };

    on(canvas, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    // Audio may only start after a gesture.
    on(window, 'pointerdown', () => this.sfx.unlock());
    on(window, 'keydown', () => this.sfx.unlock());
    for (const sel of ['#buildbar', '#topbar', '#players']) {
      on($(sel), 'pointerover', (e: PointerEvent) => {
        if ((e.target as HTMLElement).closest('button')) this.sfx.tick();
      });
    }
    // Diplomacy buttons (ORBAT, peace offers): act on press, see diplomacyAction.
    for (const sel of ['#players', '#offers']) {
      on($(sel), 'pointerdown', (e: PointerEvent) => {
        const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
        if (!b) return;
        e.preventDefault();
        void this.diplomacyAction(b.dataset.act as string, Number(b.dataset.player));
      });
    }
    // Build bar and the region panel's cancel buttons: also act on press (redrawn often).
    on($('#buildbar'), 'pointerdown', (e: PointerEvent) => {
      const b = (e.target as HTMLElement).closest('[data-kind]') as HTMLElement | null;
      if (!b) return;
      e.preventDefault();
      this.setPlacing(b.dataset.kind as BuildingKind);
    });
    on($('#panel'), 'pointerdown', (e: PointerEvent) => {
      const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!b) return;
      e.preventDefault();
      const region = Number(b.dataset.region);
      if (b.dataset.act === 'unbuild') this.send({ o: 'unbuild', region, index: Number(b.dataset.index) });
      else if (b.dataset.act === 'demolish') {
        const kind = b.dataset.kind as BuildingKind;
        void confirmBox('Demolish', `Knock down the ${BUILD_LABEL[kind].toLowerCase()} in ${this.map.regions[region].name}? Its slot is freed at once; nothing is refunded.`, 'Demolish').then(
          (ok) => ok && this.send({ o: 'demolish', region, kind }),
        );
      }
    });
    on(canvas, 'mousemove', (e: MouseEvent) => {
      const [x, y] = pos(e);
      const r = this.view.regionAt(x, y);
      if (r !== this.hover) {
        this.hover = r;
        this.renderBuildbar();
      }
    });
    // Double-click: a stack of yours (or one of its units) selects the whole stack; elsewhere,
    // all your units standing in that region.
    on(canvas, 'dblclick', (e: MouseEvent) => {
      if (this.placing) return;
      const [x, y] = pos(e);
      const item = this.view.itemAt(x, y);
      if (item && this.mine(item.ids[0])) {
        if (!e.shiftKey) this.selected.clear();
        for (const id of this.view.groupIds(item.group)) this.selected.add(id);
        this.view.expanded = null;
        this.region = -1;
      } else {
        const region = this.view.regionAt(x, y);
        if (region >= 0) this.selectRegionUnits(region, e.shiftKey);
      }
      this.renderPanel();
    });
    // Minimap: click or drag to move the camera.
    let miniDown = false;
    const miniJump = (e: MouseEvent) => {
      const r = this.minimap.getBoundingClientRect();
      this.view.focusMinimap(this.minimap, e.clientX - r.left, e.clientY - r.top);
    };
    on(this.minimap, 'mousedown', (e: MouseEvent) => {
      miniDown = true;
      miniJump(e);
    });
    on(window, 'mousemove', (e: MouseEvent) => {
      if (miniDown) miniJump(e);
    });
    on(window, 'mouseup', () => {
      miniDown = false;
    });
    on(canvas, 'mousedown', (e: MouseEvent) => {
      const [x, y] = pos(e);
      down = { x, y, button: e.button, moved: false };
      if (this.placing === 'road' && e.button === 0) this.roadAt(x, y, true);
    });
    on(window, 'mousemove', (e: MouseEvent) => {
      if (!down) return;
      const [x, y] = pos(e);
      if (Math.hypot(x - down.x, y - down.y) > 5) down.moved = true;
      if (this.placing === 'road' && down.button === 0) this.roadAt(x, y, false);
      if (!down.moved) return;
      if (down.button === 0) {
        if (!this.placing) this.box = [down.x, down.y, x, y];
      }
      else {
        this.view.pan(e.movementX, e.movementY);
      }
    });
    on(window, 'mouseup', (e: MouseEvent) => {
      if (!down) return;
      const [x, y] = pos(e);
      const d = down;
      down = null;
      if (this.placing === 'road' && d.button === 0) {
        this.finishRoad(e.shiftKey);
      } else if (this.placing) {
        if (d.button === 0 && !d.moved) this.place(x, y, e.shiftKey);
        else if (d.button === 2 && !d.moved) this.setPlacing(null);
      } else if (d.button === 0) {
        if (this.box) {
          this.selectBox(this.box, e.shiftKey);
          this.box = null;
        } else this.click(x, y, e.shiftKey);
      } else if (d.button === 2 && !d.moved) {
        void this.order(x, y);
      }
      this.renderPanel();
    });
    on(
      canvas,
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        const [x, y] = pos(e);
        this.view.zoomAt(x, y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      },
      { passive: false },
    );
    on(window, 'resize', () => this.view.resize());
    on(window, 'keydown', (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.key.toLowerCase());
      this.key(e);
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());

    // Touch: one finger taps/pans, two fingers zoom. Tap a unit, then tap a region to send it.
    let touch: { x: number; y: number; dist: number; moved: boolean } | null = null;
    on(
      canvas,
      'touchstart',
      (e: TouchEvent) => {
        e.preventDefault();
        const t = e.touches;
        const r = canvas.getBoundingClientRect();
        const x = t[0].clientX - r.left;
        const y = t[0].clientY - r.top;
        const dist = t.length > 1 ? Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) : 0;
        touch = { x, y, dist, moved: false };
      },
      { passive: false },
    );
    on(
      canvas,
      'touchmove',
      (e: TouchEvent) => {
        e.preventDefault();
        if (!touch) return;
        const t = e.touches;
        const r = canvas.getBoundingClientRect();
        const x = t[0].clientX - r.left;
        const y = t[0].clientY - r.top;
        if (t.length > 1) {
          const dist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
          if (touch.dist > 0) this.view.zoomAt(x, y, dist / touch.dist);
          touch.dist = dist;
        } else {
          this.view.pan(x - touch.x, y - touch.y);
        }
        if (Math.hypot(x - touch.x, y - touch.y) > 4) touch.moved = true;
        touch.x = x;
        touch.y = y;
      },
      { passive: false },
    );
    on(canvas, 'touchend', (e: TouchEvent) => {
      if (touch && !touch.moved && e.touches.length === 0 && this.placing) {
        this.place(touch.x, touch.y, false);
      } else if (touch && !touch.moved && e.touches.length === 0) {
        const blob = this.view.blobAt(touch.x, touch.y);
        if (blob === null && this.selected.size > 0) void this.order(touch.x, touch.y);
        else this.click(touch.x, touch.y, false);
        this.renderPanel();
      }
      if (e.touches.length === 0) touch = null;
    });
  }

  private panWithKeys(): void {
    const k = this.keys;
    const step = 12;
    const dx = (k.has('a') || k.has('arrowleft') ? step : 0) - (k.has('d') || k.has('arrowright') ? step : 0);
    const dy = (k.has('w') || k.has('arrowup') ? step : 0) - (k.has('s') || k.has('arrowdown') ? step : 0);
    if (dx || dy) this.view.pan(dx, dy);
  }

  private blob(id: number): BlobRow | undefined {
    return this.snap?.blobs.find((b) => b[0] === id);
  }

  private mine(id: number): boolean {
    return this.you !== null && this.blob(id)?.[1] === this.you;
  }

  private click(x: number, y: number, shift: boolean): void {
    const item = this.view.itemAt(x, y);
    // Anywhere but the expanded stack's own tokens closes it.
    if (item?.group !== this.view.expanded || item?.stack) this.view.expanded = null;
    const b = item ? this.blob(item.ids[0]) : undefined;
    if (item && b) {
      // A stack (anyone's) opens up into its units; the selection stays as it is.
      if (item.stack) {
        this.view.expanded = item.group;
        this.region = b[6];
        return;
      }
      // One of your units: select it (Shift adds or removes it).
      if (this.mine(b[0])) {
        this.sfx.select();
        if (!shift) this.selected = new Set([b[0]]);
        else if (this.selected.has(b[0])) this.selected.delete(b[0]);
        else this.selected.add(b[0]);
        this.region = b[8] > 0 ? -1 : b[6];
        return;
      }
      // Someone else's: show where it is.
      this.region = b[6];
      return;
    }
    if (!shift) this.selected.clear();
    this.region = this.view.regionAt(x, y);
  }

  private selectBox(box: [number, number, number, number], shift: boolean): void {
    const ids = this.view.blobsIn(...box).filter((id) => this.mine(id));
    if (!shift) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    if (ids.length) this.region = -1;
  }

  private async order(x: number, y: number): Promise<void> {
    const to = this.view.regionAt(x, y);
    if (to < 0 || this.selected.size === 0) return;
    const blobs = [...this.selected];
    const owner = this.snap?.regions[to][0] ?? -1;
    if (this.you !== null && owner >= 0 && owner !== this.you && !this.atWar(this.you, owner)) {
      const truce = this.truceLeft(this.you, owner);
      if (truce > 0) {
        toast(`Truce with ${this.nameOf(owner)} for ${truce} s`);
        return;
      }
      const ok = await confirmBox('Act of war', `${this.map.regions[to].name} belongs to ${this.nameOf(owner)}. Sending units in declares war on them.`, 'Attack');
      if (!ok) return;
    }
    this.send({ o: 'move', blobs, to });
    this.sfx.move();
    // Shown at once, until the server's routes for them arrive.
    this.view.pending.move = { ids: blobs, to, since: this.snap?.time ?? 0 };
  }

  // -- diplomacy ------------------------------------------------------------------------------

  private nameOf(id: number): string {
    return (this.players[id]?.name ?? 'Neutral').replace(/ \(bot\)$/, '');
  }

  private atWar(a: number, b: number): boolean {
    return !!this.snap?.wars.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  private truceLeft(a: number, b: number): number {
    const t = this.snap?.truces.find(([x, y]) => (x === a && y === b) || (x === b && y === a));
    return t ? t[2] : 0;
  }

  /** ORBAT and offer buttons act on press: those panels are redrawn several times a second. */
  private async diplomacyAction(action: string, player: number): Promise<void> {
    if (action === 'war') {
      const ok = await confirmBox('Declaration of war', `Declare war on ${this.nameOf(player)}? Your units may then enter their land and fight theirs.`, 'Declare war');
      if (ok) this.send({ o: 'war', player });
    } else if (action === 'peace') {
      this.send({ o: 'peace', player });
    } else if (action === 'refuse') {
      this.send({ o: 'refuse', player });
    }
  }

  private renderOffers(): void {
    const snap = this.snap;
    const box = $('#offers');
    const mine = this.you === null ? [] : (snap?.offers ?? []).filter(([, to]) => to === this.you);
    box.classList.toggle('hidden', mine.length === 0);
    if (!mine.length) return;
    box.replaceChildren(
      classbar('Flash // Peace offer'),
      ...mine.map(([from, , left]) =>
        el('div', { class: 'offer' }, [
          el('span', {}, [`${this.nameOf(from)} offers peace (${left} s)`]),
          el('div', { class: 'row' }, [
            el('button', { class: 'primary', 'data-act': 'peace', 'data-player': String(from) }, ['Accept']),
            el('button', { 'data-act': 'refuse', 'data-player': String(from) }, ['Refuse']),
          ]),
        ]),
      ),
    );
  }

  private key(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    const sel = [...this.selected];
    if (k === 'escape' && !$('#menu').classList.contains('hidden')) {
      this.toggleMenu(false);
    } else if (k === 'escape' && this.placing) {
      this.setPlacing(null);
    } else if (k === 'escape' && (this.selected.size || this.region >= 0 || this.view.expanded !== null)) {
      this.selected.clear();
      this.region = -1;
      this.view.expanded = null;
    } else if (k === 'escape') {
      this.toggleMenu(true);
    } else if (k === 'x' && sel.length) {
      for (const id of sel) this.send({ o: 'split', blob: id });
    } else if (k === 'g' && sel.length > 1) {
      this.mergeSelected();
    } else if (k === 'h' && sel.length) {
      this.send({ o: 'stop', blobs: sel });
    } else if (k === 'm') {
      this.setMuted(!this.sfx.muted);
    } else if (k === 'v') {
      this.setOverlay(!this.view.overlay);
    } else if (k === ' ') {
      e.preventDefault();
      this.centreOnCapital();
    } else if (k >= '1' && k <= '9' && k.length === 1) {
      this.setPlacing(HOTKEYS[Number(k) - 1]);
    } else if (k === 'q' && this.region >= 0) {
      this.send({ o: 'produce', region: this.region, building: 'barracks' });
    } else if (k === 'e' && this.region >= 0) {
      this.send({ o: 'produce', region: this.region, building: 'factory' });
    } else return;
    this.renderPanel();
  }

  /** The server turned an order down (its message is already on screen). */
  onRefused(): void {
    this.sfx.refuse();
  }

  private setEffects(level: 'full' | 'reduced'): void {
    this.view.fx.level = level;
    this.renderTopbar();
  }

  private setMuted(on: boolean): void {
    this.sfx.setMuted(on);
    this.renderTopbar();
  }

  // -- placement mode ---------------------------------------------------------------------------

  /** Enters placement mode for a building, or leaves it (same building again, or null). */
  private setPlacing(kind: BuildingKind | null): void {
    this.placing = kind === this.placing ? null : kind;
    if (this.placing && this.you === null) this.placing = null;
    this.roadPath = null;
    this.view.roadPreview = null;
    this.view.canvas.classList.toggle('placing', this.placing !== null);
    this.renderBuildbar();
  }

  /** A click in placement mode: build there (Shift keeps placing). */
  private place(x: number, y: number, shift: boolean): void {
    const kind = this.placing;
    if (!kind || kind === 'road') return;
    const region = this.view.regionAt(x, y);
    const why = this.whyNot(kind, region);
    if (why) {
      toast(why);
      this.sfx.refuse();
      return;
    }
    this.send({ o: 'build', region, kind });
    this.sfx.place();
    this.view.pending.builds.push({ region, kind, since: this.snap?.time ?? 0 });
    if (!shift) this.setPlacing(null);
  }

  /** Road tool: pressing starts a path in one of your regions; dragging adds neighbours. */
  private roadAt(x: number, y: number, start: boolean): void {
    const r = this.view.regionAt(x, y);
    if (start) this.roadPath = r >= 0 && this.snap?.regions[r][0] === this.you ? [r] : null;
    const path = this.roadPath;
    if (!path || r < 0 || r === path[path.length - 1]) return;
    const last = path[path.length - 1];
    if (!this.map.regions[last].neighbors.some((n) => n.id === r)) return;
    path.push(r);
    this.view.roadPreview = [...path];
  }

  /** Road tool released: one road per border crossed (Shift keeps the tool). */
  private finishRoad(shift: boolean): void {
    const path = this.roadPath;
    this.roadPath = null;
    this.view.roadPreview = null;
    if (!path || path.length < 2) {
      if (path) toast('drag across your regions to lay a road');
      return;
    }
    let sent = 0;
    let why = '';
    for (let i = 0; i + 1 < path.length; i++) {
      const reason = this.whyNot('road', path[i], path[i + 1]);
      if (reason) why ||= reason;
      else {
        this.send({ o: 'build', region: path[i], kind: 'road', target: path[i + 1] });
        sent++;
      }
    }
    toast(sent ? `${sent} road${sent > 1 ? 's' : ''} queued${why ? ` (some skipped: ${why})` : ''}` : why, sent ? 'info' : 'error');
    if (sent) this.sfx.place();
    else this.sfx.refuse();
    if (!shift && sent) this.setPlacing(null);
  }

  /** A region's builds: the one under way, then the waiting ones, as [kind, road target]. */
  private pending(region: number): Array<[BuildingKind, number]> {
    const rr = (this.snap as Snapshot).regions[region];
    const out: Array<[BuildingKind, number]> = rr[6] >= 0 ? [[BUILDING_INDEX[rr[6]], rr[8]]] : [];
    const row = this.snap?.builds.find((b) => b[0] === region);
    if (row) for (let i = 1; i + 1 < row.length; i += 2) out.push([BUILDING_INDEX[row[i]], row[i + 1]]);
    return out;
  }

  /** Slots taken in a region, counting builds under way and waiting (mirrors Sim.slotsUsed). */
  private slotsUsed(region: number): number {
    const rr = (this.snap as Snapshot).regions[region];
    let n = rr[9] + rr[10] + rr[11] + rr[12] + (rr[1] > 0 ? 1 : 0) + (rr[3] & 1 ? 1 : 0) + (rr[3] & 2 ? 1 : 0);
    let fort = rr[1] > 0;
    for (const [kind] of this.pending(region)) {
      if (kind === 'fort') {
        if (!fort) n++;
        fort = true;
      } else if (kind !== 'city' && kind !== 'road') n++;
    }
    return n;
  }

  /** The level the next fort or city build would reach, counting queued ones. */
  private nextLevel(kind: BuildingKind, region: number): number {
    const rr = (this.snap as Snapshot).regions[region];
    const pending = this.pending(region).filter(([k]) => k === kind).length;
    if (kind === 'fort') return rr[1] + pending + 1;
    if (kind === 'city') return rr[2] + pending + 1;
    return 1;
  }

  /** Regions within `hops` of a region (itself included). */
  private near(region: number, hops: number): number[] {
    const seen = new Map([[region, 0]]);
    const queue = [region];
    for (let q = 0; q < queue.length; q++) {
      const d = seen.get(queue[q]) as number;
      if (d >= hops) continue;
      for (const n of this.map.regions[queue[q]].neighbors) {
        if (!seen.has(n.id)) {
          seen.set(n.id, d + 1);
          queue.push(n.id);
        }
      }
    }
    return queue;
  }

  private resources(): Resources {
    const me = (this.snap as Snapshot).players[this.you as number];
    return { money: me.res[0], manpower: me.res[1], steel: me.res[2], oil: me.res[3] };
  }

  /** Why `kind` can't be built in a region right now, or null if it can (mirrors Sim.whyNotBuild). */
  private whyNot(kind: BuildingKind, region: number, target = -1): string | null {
    const snap = this.snap;
    if (!snap || this.you === null) return 'you are not playing';
    if (region < 0) return 'pick one of your regions';
    const rr = snap.regions[region];
    const map = this.map.regions[region];
    if (rr[0] !== this.you) return 'not your region';
    if (!(rr[3] & 4)) return 'region is out of supply';
    if (!canBuildOn(kind, map, rr[2])) return `a ${BUILD_LABEL[kind].toLowerCase()} needs ${BUILD_NEEDS[kind]}`;
    const pending = this.pending(region);
    if (ECON_KINDS.includes(kind as EconKind) && !this.near(region, HINTERLAND_HOPS).some((r) => snap.regions[r][0] === this.you && snap.regions[r][2] > 0)) {
      return `only within ${HINTERLAND_HOPS} regions of one of your cities`;
    }
    if (kind === 'fort' && this.nextLevel(kind, region) > MAX_FORT) return 'the fort is at its highest level';
    if ((kind === 'barracks' || kind === 'factory') && (rr[3] & (kind === 'barracks' ? 1 : 2) || pending.some(([k]) => k === kind))) {
      return `already has a ${kind}`;
    }
    if (kind === 'city') {
      const level = this.nextLevel(kind, region);
      if (level > MAX_CITY) return 'the city is at its highest level';
      if (level === 1 && this.near(region, FOUND_CITY_MIN_HOPS - 1).some((r) => r !== region && snap.regions[r][2] > 0)) return 'too close to another city';
    }
    if (kind === 'road' && target >= 0) {
      if (!map.neighbors.some((n) => n.id === target)) return 'a road needs a neighbouring region';
      if (snap.regions[target][0] !== this.you) return 'roads join two of your regions';
      const has = snap.roads.some(([a, b]) => (a === region && b === target) || (a === target && b === region));
      const queued = this.pending(region).some(([k, t]) => k === 'road' && t === target) || this.pending(target).some(([k, t]) => k === 'road' && t === region);
      if (has || queued) return 'there is a road already';
    }
    const needsSlot = kind !== 'city' && kind !== 'road' && !(kind === 'fort' && (rr[1] > 0 || pending.some(([k]) => k === 'fort')));
    if (needsSlot && this.slotsUsed(region) >= slotsOf(map, rr[2])) return 'no free slot';
    if (rr[6] >= 0 && pending.length - 1 >= BUILD_QUEUE) return 'build queue is full';
    if (!afford(this.resources(), buildCost(kind, this.nextLevel(kind, region)).cost)) return 'not enough resources';
    return null;
  }

  private validFor(kind: BuildingKind): Set<number> {
    const snap = this.snap as Snapshot;
    if (this.valid?.snap !== snap || this.valid.kind !== kind) this.valid = { snap, kind, set: this.validRegions(kind) };
    return this.valid.set;
  }

  private validRegions(kind: BuildingKind): Set<number> {
    const out = new Set<number>();
    const regions = this.snap?.regions ?? [];
    for (let i = 0; i < regions.length; i++) {
      if (regions[i][0] !== this.you) continue;
      const ok = kind === 'road' ? this.map.regions[i].neighbors.some((n) => !this.whyNot('road', i, n.id)) : !this.whyNot(kind, i);
      if (ok) out.add(i);
    }
    return out;
  }

  /** What a building is called on the bar, for the region under the cursor. */
  private barName(kind: BuildingKind, region: number): string {
    if (kind === 'city') {
      if (region < 0) return 'City';
      const level = this.nextLevel(kind, region);
      return level === 1 ? 'Found city' : `City ${level}`;
    }
    if (kind === 'fort' && region >= 0) return `Fort ${this.nextLevel(kind, region)}`;
    return BUILD_LABEL[kind];
  }

  /** The build bar: groups of buttons with costs, exact for the region under the cursor. */
  private renderBuildbar(): void {
    const bar = $('#buildbar');
    const snap = this.snap;
    bar.classList.toggle('hidden', !snap || this.you === null || !snap.players[this.you]?.alive);
    if (!snap || this.you === null || !snap.players[this.you]?.alive) return;
    const res = this.resources();
    const mine = this.hover >= 0 && snap.regions[this.hover][0] === this.you ? this.hover : -1;
    const cell = (kind: BuildingKind) => {
      const level = mine >= 0 ? this.nextLevel(kind, mine) : kind === 'city' ? 2 : 1;
      const maxed = (kind === 'fort' && level > MAX_FORT) || (kind === 'city' && level > MAX_CITY);
      const allowed = mine < 0 || canBuildOn(kind, this.map.regions[mine], snap.regions[mine][2]);
      const { cost, seconds } = buildCost(kind, level);
      const name = this.barName(kind, mine);
      const price = maxed ? 'MAX' : !allowed ? `needs ${BUILD_NEEDS[kind]}` : `${costText(cost)} · ${seconds}s`;
      const poor = !maxed && allowed && !afford(res, cost);
      return { kind, n: HOTKEYS.indexOf(kind) + 1, name, price, poor };
    };
    const groups = BAR.map((g) => ({ group: g.group, cells: g.kinds.map(cell) }));
    const slots = mine >= 0 ? `${this.map.regions[mine].name}: slots ${this.slotsUsed(mine)}/${slotsOf(this.map.regions[mine], snap.regions[mine][2])}` : '';
    const hint = this.placing === 'road' ? 'drag across your regions · shift: more · esc' : this.placing ? 'click a region · shift: more · esc' : '1-9';
    const key = `${this.placing}|${slots}|${JSON.stringify(groups)}`;
    if (key === this.buildbarKey) return;
    this.buildbarKey = key;
    bar.replaceChildren(
      classbar(slots ? `Build // ${slots}` : 'Build', hint),
      el(
        'div',
        { class: 'groups' },
        groups.map((g) =>
          el('div', { class: 'group' }, [
            el('div', { class: 'gname' }, [g.group]),
            el(
              'div',
              { class: 'slots' },
              g.cells.map((c) =>
                el('button', { class: `slot${this.placing === c.kind ? ' active' : ''}${c.poor ? ' poor' : ''}`, 'data-kind': c.kind }, [
                  el('img', { src: buildingIcon(c.kind), alt: '' }),
                  el('span', { class: 'name' }, [el('b', {}, [String(c.n)]), ` ${c.name}`]),
                  el('span', { class: 'price' }, [c.price]),
                ]),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  /** Selects all your units standing in a region (Shift adds to the selection). */
  private selectRegionUnits(region: number, add: boolean): void {
    if (!add) this.selected.clear();
    for (const b of this.snap?.blobs ?? []) {
      if (b[1] === this.you && b[6] === region && b[8] === 0) this.selected.add(b[0]);
    }
    if (this.selected.size) this.region = -1;
  }

  private setOverlay(on: boolean): void {
    this.view.overlay = on && this.you !== null;
    $('#legend').classList.toggle('hidden', !this.view.overlay);
    this.renderTopbar();
  }

  /** Merges selected units of the same type that stand in the same region. */
  private mergeSelected(): void {
    const groups = new Map<string, number[]>();
    for (const id of this.selected) {
      const b = this.blob(id);
      if (!b || b[8] > 0) continue;
      const k = `${b[6]}:${b[2]}`;
      groups.set(k, [...(groups.get(k) ?? []), id]);
    }
    let any = false;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      any = true;
      ids.sort((a, b) => (this.blob(b)?.[4] ?? 0) - (this.blob(a)?.[4] ?? 0));
      this.send({ o: 'merge', blobs: ids });
    }
    if (!any) toast('Select units of the same type in the same region');
  }

  // -- HUD ------------------------------------------------------------------------------------

  private renderTopbar(): void {
    const snap = this.snap;
    if (!snap) return;
    const t = `T+${clock(snap.time)}`;
    const menu = el('button', { class: 'toggle', title: 'Menu: surrender, leave (Esc)' }, ['Menu']);
    menu.onclick = () => this.toggleMenu(true);
    if (this.you === null) {
      $('#topbar').replaceChildren(el('span', { class: 'tag' }, ['[OBSERVER]']), menu, el('span', { class: 'clock' }, [t]));
      return;
    }
    const p = snap.players[this.you];
    const parts: HTMLElement[] = RESOURCES.map((k, i) => {
      let rate = p.income[i];
      if (k === 'money') rate -= p.upkeep;
      return el('span', { class: 'res', title: k }, [
        el('img', { src: hudIcon(k), alt: k }),
        el('b', {}, [fmt(p.res[i])]),
        el('small', { class: rate < 0 ? 'neg' : '' }, [`${rate >= 0 ? '+' : ''}${rate.toFixed(1)}/s`]),
      ]);
    });
    if (p.broke) parts.push(el('span', { class: 'broke' }, ['BROKE: UNITS WITHERING']));
    if (!p.alive) parts.push(el('span', { class: 'broke' }, ['ELIMINATED // OBSERVING']));
    const supply = el('button', { class: `toggle${this.view.overlay ? ' on' : ''}`, title: 'Supply overlay (V)' }, ['Supply']);
    supply.onclick = () => this.setOverlay(!this.view.overlay);
    parts.push(supply);
    const sound = el('button', { class: `toggle${this.sfx.muted ? '' : ' on'}`, title: 'Sound on/off (M)' }, [this.sfx.muted ? 'Muted' : 'Sound']);
    sound.onclick = () => this.setMuted(!this.sfx.muted);
    const fx = el('button', { class: `toggle${this.view.fx.level === 'full' ? ' on' : ''}`, title: 'Effects: full / reduced' }, [this.view.fx.level === 'full' ? 'FX' : 'FX low']);
    fx.onclick = () => {
      this.fxChosen = true;
      this.setEffects(this.view.fx.level === 'full' ? 'reduced' : 'full');
    };
    parts.push(sound, fx, menu);
    parts.push(el('span', { class: 'clock' }, [t]));
    $('#topbar').replaceChildren(...parts);
  }

  private renderPlayers(): void {
    const snap = this.snap;
    if (!snap) return;
    const regions = new Map<number, number>();
    for (const r of snap.regions) if (r[0] >= 0) regions.set(r[0], (regions.get(r[0]) ?? 0) + 1);
    const strength = new Map<number, number>();
    for (const b of snap.blobs) strength.set(b[1], (strength.get(b[1]) ?? 0) + b[3]);
    $('#players').replaceChildren(
      classbar('ORBAT', 'Regions'),
      ...this.players.map((p) => {
        const row = snap.players[p.id];
        const tag = !row.alive ? '[KIA]' : p.id === this.you ? '[YOU]' : !p.human ? '[BOT]' : row.bot ? '[AWAY]' : '';
        const me = this.you;
        const other = me !== null && p.id !== me && row.alive && snap.players[me]?.alive;
        const war = other && this.atWar(me, p.id);
        const truce = other ? this.truceLeft(me, p.id) : 0;
        const offered = other && snap.offers.some(([f, t]) => f === p.id && t === me);
        const pending = other && snap.offers.some(([f, t]) => f === me && t === p.id);
        let act: HTMLElement | string = '';
        if (other && war && !pending) {
          act = el('button', { class: 'act peace', 'data-act': 'peace', 'data-player': String(p.id), title: offered ? 'Accept their offer of peace' : 'Offer peace' }, [offered ? 'Accept' : 'Peace']);
        } else if (other && !war && truce === 0) {
          act = el('button', { class: 'act war', 'data-act': 'war', 'data-player': String(p.id), title: 'Declare war' }, ['War']);
        }
        const rel = war ? el('span', { class: 'tag war' }, [pending ? '[WAR · OFFERED]' : '[WAR]']) : truce > 0 ? el('span', { class: 'tag truce' }, [`[TRUCE ${truce}s]`]) : '';
        return el('div', { class: `p${row.alive ? '' : ' dead'}`, title: `${regions.get(p.id) ?? 0} regions, ${Math.round(strength.get(p.id) ?? 0)} strength` }, [
          el('span', { class: 'swatch', style: `background:${p.color}` }),
          el('span', {}, [p.name.replace(/ \(bot\)$/, '')]),
          el('span', { class: 'tag' }, [tag]),
          rel,
          el('span', { class: 'num' }, [`${regions.get(p.id) ?? 0}`]),
          act,
        ]);
      }),
    );
  }

  private addEvent(e: GameEvent): void {
    const name = (id: number) => (this.players[id]?.name ?? 'Neutral').replace(/ \(bot\)$/, '');
    const region = (id: number) => this.map.regions[id]?.name ?? '?';
    let text: string | null = null;
    // Effects and sounds first (they don't depend on the feed).
    switch (e.kind) {
      case 'built': {
        const row = this.snap?.regions[e.region];
        if (row) this.view.built(e.region, e.building, row);
        if (e.owner === this.you) this.sfx.built();
        break;
      }
      case 'captured':
        if (e.by === this.you) this.sfx.captured();
        else if (e.from === this.you) this.sfx.lost();
        break;
      case 'war':
        if (e.by !== this.you && (e.a === this.you || e.b === this.you)) this.sfx.alarm();
        break;
      case 'peaceOffer':
        if (e.to === this.you) this.sfx.bell();
        break;
      case 'eliminated':
        if (e.player === this.you) this.sfx.jingle(false);
        break;
      case 'won':
        if (this.you !== null) this.sfx.jingle(e.player === this.you);
        break;
    }
    switch (e.kind) {
      case 'battle':
        if (this.you !== null && e.sides.includes(this.you)) text = `CONTACT at ${region(e.region)}`;
        break;
      case 'captured':
        if (e.by === this.you || e.from === this.you || e.from >= 0) {
          text = `${name(e.by)} took ${region(e.region)}${e.from >= 0 ? ` from ${name(e.from)}` : ''}`;
        }
        break;
      case 'built':
        if (e.owner === this.you) text = `${BUILD_LABEL[e.building]}${e.level > 1 ? ` ${e.level}` : ''} finished at ${region(e.region)}`;
        break;
      case 'eliminated':
        text = e.surrendered ? `${name(e.player)} surrendered` : `${name(e.player)} knocked out by ${name(e.by)}`;
        break;
      case 'war': {
        const target = e.by === e.a ? e.b : e.a;
        text = target === this.you ? `!! ${name(e.by)} DECLARED WAR ON YOU` : `${name(e.by)} declared war on ${name(target)}`;
        break;
      }
      case 'peace':
        text = `Peace: ${name(e.a)} and ${name(e.b)}`;
        break;
      case 'peaceOffer':
        if (e.to === this.you) text = `${name(e.from)} offers peace`;
        break;
      case 'peaceRefused':
        if (e.from === this.you) text = `${name(e.to)} refused peace`;
        break;
      case 'won':
        text = `${name(e.player)} wins`;
        break;
    }
    if (text) this.say(text);
  }

  /** Your troops in a region against what it can feed (only your own regions feed them). */
  private load(region: number): { load: number; cap: number } {
    const snap = this.snap as Snapshot;
    let load = 0;
    for (const b of snap.blobs) if (b[1] === this.you && b[6] === region && b[8] === 0) load += b[4] * UNITS[UNIT_INDEX[b[2]]].supplyNeed;
    return { load, cap: supplyCapacity(this.map.regions[region], snap.regions[region][2]) };
  }

  /** The region panel's supply line: reach, and for your regions your load against capacity. */
  private supplyLine(region: number): string {
    const row = (this.snap as Snapshot).regions[region];
    if (!(row[3] & 4)) return 'CUT OFF';
    const { load, cap } = this.load(region);
    if (row[0] !== this.you) return `in supply · feeds ${Math.round(cap)}`;
    return `in supply · load ${Math.round(load)} / ${Math.round(cap)}${load > cap ? ' OVERLOADED' : ''}`;
  }

  /** Why a unit is short of supply ('' if it isn't). */
  private supplyWhy(b: BlobRow): string {
    if (b[10] >= 0.99 || !this.snap) return '';
    const row = this.snap.regions[b[6]];
    if (row[0] !== b[1]) return 'short in foreign land';
    if (!(row[3] & 4)) return 'cut off';
    const { load, cap } = this.load(b[6]);
    return `overloaded ${Math.round(load)}/${Math.round(cap)}`;
  }

  /** Units losing strength to supply: say where and why, once a minute per region. */
  private warnSupply(snap: Snapshot): void {
    if (this.you === null || !snap.players[this.you]?.alive) return;
    const short = new Map<number, string>();
    for (const b of snap.blobs) {
      if (b[1] !== this.you || b[8] > 0 || b[10] >= 0.99) continue;
      if (!short.has(b[6])) short.set(b[6], this.supplyWhy(b));
    }
    for (const [region, why] of short) {
      const last = this.supplyWarned.get(region) ?? -Infinity;
      if (snap.time - last < 60) continue;
      this.supplyWarned.set(region, snap.time);
      const name = this.map.regions[region].name;
      this.say(
        why.startsWith('overloaded')
          ? `Too many troops at ${name} (${why.slice(11)} supply): they wither. Spread out or build a city.`
          : why === 'cut off'
            ? `${name} is CUT OFF: units there wither`
            : `Troops at ${name} are short of supply (from your land next door)`,
      );
    }
  }

  /** A line in the sitrep feed. */
  private say(text: string): void {
    this.feed.unshift([clock(this.snap?.time ?? 0), text]);
    this.feed.length = Math.min(this.feed.length, 8);
    $('#feed').replaceChildren(classbar('SITREP'), ...this.feed.map(([t, m]) => el('div', {}, [el('time', {}, [t]), m])));
    $('#feed').classList.toggle('hidden', this.feed.length === 0);
  }

  private renderPanel(): void {
    const panel = $('#panel');
    const snap = this.snap;
    if (!snap) return;
    // Typing a split amount: leave the panel alone until the field loses focus.
    if (document.activeElement?.id === 'split-amount' && panel.contains(document.activeElement)) return;
    const sel = [...this.selected].map((id) => this.blob(id)).filter((b): b is BlobRow => !!b);
    if (sel.length) {
      panel.replaceChildren(...this.unitsPanel(sel));
      panel.classList.remove('hidden');
    } else if (this.region >= 0) {
      panel.replaceChildren(...this.regionPanel(this.map.regions[this.region]));
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }

  private unitRow(b: BlobRow, selectable: boolean): HTMLElement {
    const type = UNIT_INDEX[b[2]];
    const where =
      b[8] > 0 ? `→ ${this.map.regions[b[7]].name}` : b[11] & 4 && b[7] >= 0 ? `attacking ${this.map.regions[b[7]].name}` : this.map.regions[b[6]].name;
    const row = el('div', { class: `unit${this.selected.has(b[0]) ? ' sel' : ''}` }, [
      el('span', { class: 'swatch', style: `background:${colorOf(this.players, b[1])}` }),
      el('span', {}, [`${type === 'tank' ? 'ARM' : 'INF'} ${Math.ceil(b[3])}/${b[4]}`]),
      el('span', { class: 'meta' }, [
        `TRN ${b[5]} · SUP ${Math.round(b[10] * 100)}%${this.supplyWhy(b) ? ` (${this.supplyWhy(b).toUpperCase()})` : ''} · DUG ${Math.round(b[9] * 100)}%`,
        el('br'),
        where.toUpperCase(),
      ]),
    ]);
    if (selectable) {
      row.onclick = (e) => {
        if (e.shiftKey) this.selected.add(b[0]);
        else this.selected = new Set([b[0]]);
        this.renderPanel();
      };
    }
    return row;
  }

  private unitsPanel(sel: BlobRow[]): HTMLElement[] {
    const strength = sel.reduce((s, b) => s + b[3], 0);
    const btn = (label: string, fn: () => void, title = '') => {
      const b = el('button', { title }, [label]);
      b.onclick = () => {
        fn();
        this.renderPanel();
      };
      return b;
    };
    return [
      classbar('Units selected', `${sel.length}`),
      el('div', { class: 'sub' }, [`Strength ${Math.round(strength)} · right-click a region to send`]),
      el('div', { class: 'buttons' }, [
        btn('Split (X)', () => sel.forEach((b) => this.send({ o: 'split', blob: b[0] })), 'Halve each unit; both halves keep their training'),
        btn('Merge (G)', () => this.mergeSelected(), 'Same type, same region; costs some training'),
        btn('Halt (H)', () => this.send({ o: 'stop', blobs: sel.map((b) => b[0]) })),
      ]),
      ...this.splitRow(sel, btn),
      ...sel.slice(0, 30).map((b) => this.unitRow(b, true)),
    ];
  }

  /** One unit standing still: split off a batch, half, or any amount. */
  private splitRow(sel: BlobRow[], btn: (label: string, fn: () => void, title?: string) => HTMLElement): HTMLElement[] {
    if (sel.length !== 1 || sel[0][8] > 0 || sel[0][4] < 2) return [];
    const b = sel[0];
    const size = b[4];
    const batch = UNITS[UNIT_INDEX[b[2]]].batch;
    const split = (amount: number) => this.send({ o: 'split', blob: b[0], amount: Math.max(1, Math.min(size - 1, Math.floor(amount))) });
    const field = el('input', { id: 'split-amount', type: 'number', min: '1', max: String(size - 1), value: String(Math.min(batch, size - 1)) }) as HTMLInputElement;
    field.onkeydown = (e) => {
      if (e.key === 'Enter') {
        split(Number(field.value));
        field.blur();
        this.renderPanel();
      } else if (e.key === 'Escape') field.blur();
    };
    return [
      el('div', { class: 'buttons split' }, [
        el('span', { class: 'label' }, ['Split off']),
        ...(size > batch ? [btn(String(batch), () => split(batch), `Split off one batch (${batch})`)] : []),
        btn('½', () => split(size / 2), 'Split off half'),
        field,
        btn('Split', () => split(Number(field.value)), 'Split off this many'),
      ]),
    ];
  }

  private regionPanel(region: Region): HTMLElement[] {
    const snap = this.snap as Snapshot;
    const rr = snap.regions[region.id];
    const owner = rr[0];
    const country = this.map.countries.find((c) => c.id === region.country)?.name ?? region.country;
    const out: HTMLElement[] = [
      classbar('Intel // Region', owner === this.you && this.you !== null ? 'Friendly' : owner >= 0 ? 'Hostile' : 'Neutral'),
      el('h4', {}, [region.name]),
      el('div', { class: 'sub' }, [`${country} · ${region.terrain} · ${region.size}${region.traits.length ? ` · ${region.traits.join(', ')}` : ''}`]),
    ];
    const here = snap.blobs.filter((b) => b[6] === region.id && b[8] === 0);
    // The stack cap counts every token in the region, moving out or waiting included.
    const myCount = snap.blobs.filter((b) => b[6] === region.id && b[1] === this.you).length;
    const used = rr[9] + rr[10] + rr[11] + rr[12] + (rr[1] > 0 ? 1 : 0) + (rr[3] & 1 ? 1 : 0) + (rr[3] & 2 ? 1 : 0);
    const info: Array<[string, string]> = [
      ['Owner', owner >= 0 ? (this.players[owner]?.name ?? '?') : 'Neutral'],
      ['City', rr[2] > 0 ? `level ${rr[2]} / ${MAX_CITY} · supplies ${supplyReach(rr[2])} regions out` : 'none'],
      ['Slots', `${used} / ${slotsOf(region, rr[2])} built`],
      ['Fort', `${rr[1]} / ${MAX_FORT}`],
      ['Supply', owner >= 0 ? this.supplyLine(region.id) : '—'],
      ['Stack', `${myCount} / ${stackCap(region, rr[2], rr[1])} of yours`],
      ['Capture', `~${Math.round(captureSeconds(region, rr[1], 0))} s untrained`],
    ];
    out.push(el('div', { class: 'grid2' }, info.flatMap(([k, v]) => [el('span', {}, [k]), el('span', {}, [v])])));
    if (rr[4] >= 0) {
      out.push(el('div', {}, [`Being captured by ${this.players[rr[4]]?.name ?? '?'}`]), cellBar(rr[5]));
    }

    if (owner === this.you && this.you !== null) {
      const me = snap.players[this.you];
      const res: Resources = { money: me.res[0], manpower: me.res[1], steel: me.res[2], oil: me.res[3] };
      // What's built (each can be knocked down to free its slot).
      const built: Array<[BuildingKind, string]> = [];
      for (const k of ECON_KINDS) for (let i = 0; i < rr[ECON_FIELD[k]]; i++) built.push([k, BUILD_LABEL[k]]);
      if (rr[1] > 0) built.push(['fort', `Fort ${rr[1]}`]);
      if (rr[3] & 1) built.push(['barracks', 'Barracks']);
      if (rr[3] & 2) built.push(['factory', 'Factory']);
      const knock = (kind: BuildingKind) =>
        el('button', { class: 'x', 'data-act': 'demolish', 'data-region': String(region.id), 'data-kind': kind, title: 'Demolish (no refund)' }, ['✕']);
      if (built.length) {
        out.push(el('div', { class: 'line' }, ['Buildings']));
        for (const [kind, name] of built) out.push(el('div', { class: 'line build queued' }, [el('span', {}, [name]), knock(kind)]));
      }
      const pending = this.pending(region.id);
      if (pending.length) {
        // Under way, then what waits behind it; levels count up per kind.
        const levels = { fort: rr[1], city: rr[2] };
        const label = ([kind, target]: [BuildingKind, number]) => {
          if (kind === 'fort' || kind === 'city') {
            levels[kind] += 1;
            return kind === 'city' && levels.city === 1 ? 'Found city' : `${BUILD_LABEL[kind]} ${levels[kind]}`;
          }
          return kind === 'road' ? `Road → ${this.map.regions[target]?.name ?? '?'}` : BUILD_LABEL[kind];
        };
        const cancel = (index: number) =>
          el('button', { class: 'x', 'data-act': 'unbuild', 'data-region': String(region.id), 'data-index': String(index), title: 'Cancel (full refund)' }, ['✕']);
        pending.forEach((p, i) => {
          out.push(el('div', { class: `line build${i ? ' queued' : ''}` }, [el('span', {}, [`${i ? 'Next' : 'Building'}: ${label(p)}`]), cancel(i)]));
          if (i === 0) out.push(cellBar(rr[7]));
        });
      } else {
        out.push(el('div', { class: 'sub' }, ['Build: pick something in the build bar (1-9), then click here']));
      }
      for (const line of snap.production.filter((p) => p.region === region.id)) out.push(...this.productionLine(line, res));
    }

    if (here.length) {
      out.push(el('div', { class: 'line' }, ['Units here']));
      for (const b of here) out.push(this.unitRow(b, b[1] === this.you));
    }
    return out;
  }

  private productionLine(line: ProductionView, res: Resources): HTMLElement[] {
    const type = line.building === 'barracks' ? 'infantry' : 'tank';
    const stats = UNITS[type];
    const add = el('button', { title: `${costText(stats.cost)} · ${stats.buildTime}s · size ${stats.batch}` }, [
      `${line.building === 'barracks' ? 'Q' : 'E'} + ${type === 'tank' ? 'Tanks' : 'Infantry'}`,
    ]) as HTMLButtonElement;
    add.disabled = line.queue.length >= 5;
    if (!afford(res, stats.cost) && line.queue.length === 0) add.title += ' (not enough resources yet)';
    add.onclick = () => this.send({ o: 'produce', region: line.region, building: line.building });
    const repeat = el('button', { title: 'Keep producing' }, [line.repeat ? 'Repeat: on' : 'Repeat: off']);
    repeat.onclick = () => this.send({ o: 'repeat', region: line.region, building: line.building, on: !line.repeat });
    const cancel = el('button', { title: 'Cancel the last order' }, ['X']) as HTMLButtonElement;
    cancel.disabled = line.queue.length === 0;
    cancel.onclick = () => this.send({ o: 'cancel', region: line.region, building: line.building });
    const status = line.queue.length
      ? `${line.queue.length} queued${line.progress < 0 ? ' // awaiting resources' : ''}`
      : 'idle';
    return [
      el('div', { class: 'line' }, [`${line.building === 'barracks' ? 'Barracks' : 'Factory'}: ${status}`]),
      cellBar(Math.max(0, line.progress)),
      el('div', { class: 'buttons' }, [add, repeat, cancel]),
    ];
  }
}


function clock(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

function afford(res: Resources, cost: Resources): boolean {
  return RESOURCES.every((k) => res[k] >= cost[k]);
}

const buildingIcons = new Map<BuildingKind, string>();
function buildingIcon(kind: BuildingKind): string {
  let url = buildingIcons.get(kind);
  if (!url) {
    url = spriteUrl(ICONS[kind], 2);
    buildingIcons.set(kind, url);
  }
  return url;
}

function costText(cost: Resources): string {
  return RESOURCES.filter((k) => cost[k] > 0)
    .map((k) => `${RES_SHORT[k]}${cost[k]}`)
    .join(' ');
}
