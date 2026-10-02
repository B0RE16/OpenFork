// The game: map view, mouse and keyboard orders, and the HUD panels.
import type { GameMap, Region } from '../shared/map.ts';
import type { BlobRow, GameEvent, GamePlayer, Order, ProductionView, Snapshot } from '../shared/protocol.ts';
import { BUILDING_INDEX, UNIT_INDEX } from '../shared/protocol.ts';
import {
  type BuildingKind,
  buildCost,
  canBuildOn,
  captureSeconds,
  MAX_LEVEL,
  RESOURCES,
  type Resources,
  stackCap,
  supplyCapacity,
  UNITS,
} from '../shared/rules.ts';
import { colorOf, MapView } from './map-view.ts';
import type { Net } from './net.ts';
import { hudIcon } from './sprites.ts';
import { $, cellBar, classbar, el, fmt, toast } from './ui.ts';

const BUILD_LABEL: Record<BuildingKind, string> = { barracks: 'Barracks', factory: 'Factory', fort: 'Fort', infra: 'Infrastructure' };
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
  private box: [number, number, number, number] | null = null;
  private feed: Array<[string, string]> = [];
  private raf = 0;
  private keys = new Set<string>();
  private readonly cleanup: Array<() => void> = [];
  private centred = false;
  finished = false;
  private readonly minimap: HTMLCanvasElement;

  constructor(net: Net, map: GameMap, terrain: HTMLImageElement, you: number | null, players: GamePlayer[], onBack: () => void) {
    this.net = net;
    this.map = map;
    this.you = you;
    this.players = players;
    this.onBack = onBack;
    this.view = new MapView($('#map') as HTMLCanvasElement, map, terrain);
    this.minimap = $('#minimap') as HTMLCanvasElement;
    this.minimap.width = 240;
    this.minimap.height = Math.round((240 * map.height) / map.width);
    this.setOverlay(false);
    $('#over').classList.add('hidden');
    $('#panel').classList.add('hidden');
    $('#feed').replaceChildren();
    $('#feed').classList.add('hidden');
    $('#over-back').onclick = () => this.onBack();
  }

  start(): void {
    // A small handle for automated browser tests and the console.
    (window as unknown as { openfork: unknown }).openfork = {
      you: this.you,
      snap: () => this.snap,
      screenOf: (region: number) => {
        const r = this.map.regions[region];
        return this.view.toScreen(r.x, r.y);
      },
    };
    this.view.resize();
    this.view.fit();
    this.bindInput();
    const frame = () => {
      this.raf = requestAnimationFrame(frame);
      this.panWithKeys();
      if (this.snap) {
        this.view.draw(this.snap, this.players, this.you, this.selected, this.region, this.box);
        this.view.drawMinimap(this.minimap, this.snap);
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
    this.snap = snap;
    this.view.takeSnapshot(snap);
    const alive = new Set(snap.blobs.map((b) => b[0]));
    for (const id of this.selected) if (!alive.has(id)) this.selected.delete(id);
    if (!this.centred && this.you !== null) {
      this.centred = true;
      this.centreOnCapital();
    }
    for (const e of snap.events) this.addEvent(e);
    this.renderTopbar();
    this.renderPlayers();
    this.renderPanel();
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
    // Double-click: all your units standing in that region.
    on(canvas, 'dblclick', (e: MouseEvent) => {
      const [x, y] = pos(e);
      const id = this.view.blobAt(x, y);
      const region = id !== null && this.mine(id) ? (this.blob(id) as BlobRow)[6] : this.view.regionAt(x, y);
      if (region >= 0) this.selectRegionUnits(region, e.shiftKey);
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
    });
    on(window, 'mousemove', (e: MouseEvent) => {
      if (!down) return;
      const [x, y] = pos(e);
      if (Math.hypot(x - down.x, y - down.y) > 5) down.moved = true;
      if (!down.moved) return;
      if (down.button === 0) this.box = [down.x, down.y, x, y];
      else {
        this.view.pan(e.movementX, e.movementY);
      }
    });
    on(window, 'mouseup', (e: MouseEvent) => {
      if (!down) return;
      const [x, y] = pos(e);
      const d = down;
      down = null;
      if (d.button === 0) {
        if (this.box) {
          this.selectBox(this.box, e.shiftKey);
          this.box = null;
        } else this.click(x, y, e.shiftKey);
      } else if (d.button === 2 && !d.moved) {
        this.order(x, y);
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
      if (touch && !touch.moved && e.touches.length === 0) {
        const blob = this.view.blobAt(touch.x, touch.y);
        if (blob === null && this.selected.size > 0) this.order(touch.x, touch.y);
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
    const id = this.view.blobAt(x, y);
    if (id !== null) {
      const b = this.blob(id);
      if (b && this.mine(id)) {
        if (shift) {
          if (this.selected.has(id)) this.selected.delete(id);
          else this.selected.add(id);
        } else this.selected = new Set([id]);
        this.region = b[8] > 0 ? -1 : b[6];
        return;
      }
      if (b) {
        this.selected.clear();
        this.region = b[6];
        return;
      }
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

  private order(x: number, y: number): void {
    const to = this.view.regionAt(x, y);
    if (to < 0 || this.selected.size === 0) return;
    this.send({ o: 'move', blobs: [...this.selected], to });
  }

  private key(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    const sel = [...this.selected];
    if (k === 'escape') {
      this.selected.clear();
      this.region = -1;
    } else if (k === 'x' && sel.length) {
      for (const id of sel) this.send({ o: 'split', blob: id });
    } else if (k === 'g' && sel.length > 1) {
      this.mergeSelected();
    } else if (k === 'h' && sel.length) {
      this.send({ o: 'stop', blobs: sel });
    } else if (k === 'v') {
      this.setOverlay(!this.view.overlay);
    } else if (k === ' ') {
      e.preventDefault();
      this.centreOnCapital();
    } else if (['1', '2', '3', '4'].includes(k) && this.region >= 0) {
      this.send({ o: 'build', region: this.region, kind: BUILDING_INDEX[Number(k) - 1] });
    } else if (k === 'q' && this.region >= 0) {
      this.send({ o: 'produce', region: this.region, building: 'barracks' });
    } else if (k === 'e' && this.region >= 0) {
      this.send({ o: 'produce', region: this.region, building: 'factory' });
    } else return;
    this.renderPanel();
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
    if (this.you === null) {
      $('#topbar').replaceChildren(el('span', { class: 'tag' }, ['[OBSERVER]']), el('span', { class: 'clock' }, [t]));
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
        return el('div', { class: `p${row.alive ? '' : ' dead'}`, title: `${regions.get(p.id) ?? 0} regions, ${Math.round(strength.get(p.id) ?? 0)} strength` }, [
          el('span', { class: 'swatch', style: `background:${p.color}` }),
          el('span', {}, [p.name.replace(/ \(bot\)$/, '')]),
          el('span', { class: 'tag' }, [tag]),
          el('span', { class: 'num' }, [`${regions.get(p.id) ?? 0}`]),
        ]);
      }),
    );
  }

  private addEvent(e: GameEvent): void {
    const name = (id: number) => (this.players[id]?.name ?? 'Neutral').replace(/ \(bot\)$/, '');
    const region = (id: number) => this.map.regions[id]?.name ?? '?';
    let text: string | null = null;
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
        text = `${name(e.player)} knocked out by ${name(e.by)}`;
        break;
      case 'won':
        text = `${name(e.player)} wins`;
        break;
    }
    if (!text) return;
    this.feed.unshift([clock(this.snap?.time ?? 0), text]);
    this.feed.length = Math.min(this.feed.length, 8);
    $('#feed').replaceChildren(classbar('SITREP'), ...this.feed.map(([t, m]) => el('div', {}, [el('time', {}, [t]), m])));
    $('#feed').classList.toggle('hidden', this.feed.length === 0);
  }

  private renderPanel(): void {
    const panel = $('#panel');
    const snap = this.snap;
    if (!snap) return;
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
    const where = b[8] > 0 ? `→ ${this.map.regions[b[7]].name}` : this.map.regions[b[6]].name;
    const row = el('div', { class: `unit${this.selected.has(b[0]) ? ' sel' : ''}` }, [
      el('span', { class: 'swatch', style: `background:${colorOf(this.players, b[1])}` }),
      el('span', {}, [`${type === 'tank' ? 'ARM' : 'INF'} ${Math.ceil(b[3])}/${b[4]}`]),
      el('span', { class: 'meta' }, [`TRN ${b[5]} · SUP ${Math.round(b[10] * 100)}% · DUG ${Math.round(b[9] * 100)}%`, el('br'), where.toUpperCase()]),
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
      ...sel.slice(0, 30).map((b) => this.unitRow(b, true)),
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
    const myCount = here.filter((b) => b[1] === this.you).length;
    const info: Array<[string, string]> = [
      ['Owner', owner >= 0 ? (this.players[owner]?.name ?? '?') : 'Neutral'],
      ['Fort', `${rr[1]} / ${MAX_LEVEL.fort}`],
      ['Infrastructure', `${rr[2]} / ${MAX_LEVEL.infra}`],
      ['Supply', owner >= 0 ? `${rr[3] & 4 ? 'in supply' : 'CUT OFF'} · cap ${Math.round(supplyCapacity(region, rr[2]))}` : '—'],
      ['Stack', `${myCount} / ${stackCap(region, rr[2])} of yours`],
      ['Capture', `~${Math.round(captureSeconds(region, rr[1], 0))} s untrained`],
    ];
    out.push(el('div', { class: 'grid2' }, info.flatMap(([k, v]) => [el('span', {}, [k]), el('span', {}, [v])])));
    if (rr[4] >= 0) {
      out.push(el('div', {}, [`Being captured by ${this.players[rr[4]]?.name ?? '?'}`]), cellBar(rr[5]));
    }

    if (owner === this.you && this.you !== null) {
      const me = snap.players[this.you];
      const res: Resources = { money: me.res[0], manpower: me.res[1], steel: me.res[2], oil: me.res[3] };
      const building = rr[6] >= 0 ? BUILDING_INDEX[rr[6]] : null;
      out.push(el('div', { class: 'line' }, [building ? `Building: ${BUILD_LABEL[building]}` : 'Build']));
      if (building) out.push(cellBar(rr[7]));
      const levels: Record<BuildingKind, number> = { barracks: rr[3] & 1 ? 1 : 0, factory: rr[3] & 2 ? 1 : 0, fort: rr[1], infra: rr[2] };
      out.push(
        el(
          'div',
          { class: 'buttons' },
          BUILD_LABEL_KEYS.map((kind, i) => {
            const level = levels[kind] + 1;
            const maxed = level > MAX_LEVEL[kind];
            const allowed = canBuildOn(kind, region.traits);
            const { cost, seconds } = buildCost(kind, Math.min(level, MAX_LEVEL[kind]));
            const label = maxed ? `${BUILD_LABEL[kind]} ✓` : `${i + 1} ${BUILD_LABEL[kind]}${MAX_LEVEL[kind] > 1 ? ` ${level}` : ''}`;
            const b = el('button', { title: allowed ? `${costText(cost)} · ${seconds}s` : 'Needs an industry or city region' }, [label]) as HTMLButtonElement;
            b.disabled = maxed || !allowed || !!building || !afford(res, cost) || !(rr[3] & 4);
            b.onclick = () => this.send({ o: 'build', region: region.id, kind });
            return b;
          }),
        ),
      );
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

const BUILD_LABEL_KEYS: BuildingKind[] = ['barracks', 'factory', 'fort', 'infra'];

function clock(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

function afford(res: Resources, cost: Resources): boolean {
  return RESOURCES.every((k) => res[k] >= cost[k]);
}

function costText(cost: Resources): string {
  return RESOURCES.filter((k) => cost[k] > 0)
    .map((k) => `${RES_SHORT[k]}${cost[k]}`)
    .join(' ');
}
