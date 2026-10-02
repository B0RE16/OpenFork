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
import { $, el, fmt, toast } from './ui.ts';

const BUILD_LABEL: Record<BuildingKind, string> = { barracks: 'Barracks', factory: 'Factory', fort: 'Fort', infra: 'Infrastructure' };
const RES_ICON: Record<keyof Resources, string> = { money: '$', manpower: '👥', steel: '⚙', oil: '🛢' };

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
  private feed: string[] = [];
  private raf = 0;
  private keys = new Set<string>();
  private readonly cleanup: Array<() => void> = [];
  private centred = false;
  finished = false;

  constructor(net: Net, map: GameMap, terrain: HTMLImageElement, you: number | null, players: GamePlayer[], onBack: () => void) {
    this.net = net;
    this.map = map;
    this.you = you;
    this.players = players;
    this.onBack = onBack;
    this.view = new MapView($('#map') as HTMLCanvasElement, map, terrain);
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
      if (this.snap) this.view.draw(this.snap, this.players, this.you, this.selected, this.region, this.box);
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
    const t = `${Math.floor(snap.time / 60)}:${String(Math.floor(snap.time % 60)).padStart(2, '0')}`;
    if (this.you === null) {
      $('#topbar').replaceChildren(el('span', {}, ['👁 Watching']), el('span', {}, [t]));
      return;
    }
    const p = snap.players[this.you];
    const parts: HTMLElement[] = RESOURCES.map((k, i) => {
      let rate = p.income[i];
      if (k === 'money') rate -= p.upkeep;
      return el('span', { class: 'res', title: k }, [
        `${RES_ICON[k]} `,
        el('b', {}, [fmt(p.res[i])]),
        el('small', { class: rate < 0 ? 'neg' : '' }, [`${rate >= 0 ? '+' : ''}${rate.toFixed(1)}/s`]),
      ]);
    });
    if (p.broke) parts.push(el('span', { class: 'broke' }, ['BROKE: units are withering']));
    if (!p.alive) parts.push(el('span', { class: 'broke' }, ['Eliminated — watching']));
    parts.push(el('span', {}, [t]));
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
      ...this.players.map((p) => {
        const row = snap.players[p.id];
        const tag = p.human ? (row.bot ? ' (away)' : '') : '';
        return el('div', { class: `p${row.alive ? '' : ' dead'}`, title: `${regions.get(p.id) ?? 0} regions, ${Math.round(strength.get(p.id) ?? 0)} strength` }, [
          el('span', { class: 'swatch', style: `background:${p.color}` }),
          el('span', {}, [`${p.name}${p.id === this.you ? ' (you)' : ''}${tag}`]),
          el('span', { class: 'num' }, [`${regions.get(p.id) ?? 0}`]),
        ]);
      }),
    );
  }

  private addEvent(e: GameEvent): void {
    const name = (id: number) => this.players[id]?.name ?? 'Neutral';
    const region = (id: number) => this.map.regions[id]?.name ?? '?';
    let text: string | null = null;
    switch (e.kind) {
      case 'battle':
        if (this.you !== null && e.sides.includes(this.you)) text = `⚔ Battle at ${region(e.region)}`;
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
        text = `☠ ${name(e.player)} was knocked out by ${name(e.by)}`;
        break;
      case 'won':
        text = `🏆 ${name(e.player)} wins`;
        break;
    }
    if (!text) return;
    this.feed.unshift(text);
    this.feed.length = Math.min(this.feed.length, 8);
    $('#feed').replaceChildren(...this.feed.map((t) => el('div', {}, [t])));
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
      el('span', {}, [`${type === 'tank' ? 'Tanks' : 'Infantry'} ${Math.ceil(b[3])}/${b[4]}`]),
      el('span', { class: 'meta' }, [`trn ${b[5]} · sup ${Math.round(b[10] * 100)}% · dig ${Math.round(b[9] * 100)}% · ${where}`]),
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
      el('h4', {}, [`${sel.length} unit${sel.length > 1 ? 's' : ''} selected`]),
      el('div', { class: 'sub' }, [`Strength ${Math.round(strength)} · right-click a region to send them`]),
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
      el('h4', {}, [region.name]),
      el('div', { class: 'sub' }, [`${country} · ${region.terrain} · ${region.size}${region.traits.length ? ` · ${region.traits.join(', ')}` : ''}`]),
    ];
    const here = snap.blobs.filter((b) => b[6] === region.id && b[8] === 0);
    const myCount = here.filter((b) => b[1] === this.you).length;
    const info: Array<[string, string]> = [
      ['Owner', owner >= 0 ? (this.players[owner]?.name ?? '?') : 'Neutral'],
      ['Fort', `${rr[1]} / ${MAX_LEVEL.fort}`],
      ['Infrastructure', `${rr[2]} / ${MAX_LEVEL.infra}`],
      ['Supply', owner >= 0 ? `${rr[3] & 4 ? 'in supply' : 'CUT OFF'} · capacity ${Math.round(supplyCapacity(region, rr[2]))}` : '—'],
      ['Stack', `${myCount} / ${stackCap(region, rr[2])} of yours`],
      ['Capture', `~${Math.round(captureSeconds(region, rr[1], 0))} s untrained`],
    ];
    out.push(el('div', { class: 'grid2' }, info.flatMap(([k, v]) => [el('span', {}, [k]), el('span', {}, [v])])));
    if (rr[4] >= 0) {
      out.push(el('div', {}, [`Being captured by ${this.players[rr[4]]?.name ?? '?'}`]), bar(rr[5]));
    }

    if (owner === this.you && this.you !== null) {
      const me = snap.players[this.you];
      const res: Resources = { money: me.res[0], manpower: me.res[1], steel: me.res[2], oil: me.res[3] };
      const building = rr[6] >= 0 ? BUILDING_INDEX[rr[6]] : null;
      out.push(el('div', { class: 'line' }, [building ? `Building: ${BUILD_LABEL[building]}` : 'Build']));
      if (building) out.push(bar(rr[7]));
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
    const repeat = el('button', { title: 'Keep producing' }, [line.repeat ? '⟳ Repeat on' : '⟳ Repeat off']);
    repeat.onclick = () => this.send({ o: 'repeat', region: line.region, building: line.building, on: !line.repeat });
    const cancel = el('button', {}, ['✕']) as HTMLButtonElement;
    cancel.disabled = line.queue.length === 0;
    cancel.onclick = () => this.send({ o: 'cancel', region: line.region, building: line.building });
    const status = line.queue.length
      ? `${line.queue.length} queued${line.progress < 0 ? ' — waiting for resources' : ''}`
      : 'idle';
    return [
      el('div', { class: 'line' }, [`${line.building === 'barracks' ? 'Barracks' : 'Factory'}: ${status}`]),
      bar(Math.max(0, line.progress)),
      el('div', { class: 'buttons' }, [add, repeat, cancel]),
    ];
  }
}

const BUILD_LABEL_KEYS: BuildingKind[] = ['barracks', 'factory', 'fort', 'infra'];

function bar(v: number): HTMLElement {
  return el('div', { class: 'bar' }, [el('i', { style: `width:${Math.round(Math.min(1, Math.max(0, v)) * 100)}%` })]);
}

function afford(res: Resources, cost: Resources): boolean {
  return RESOURCES.every((k) => res[k] >= cost[k]);
}

function costText(cost: Resources): string {
  return RESOURCES.filter((k) => cost[k] > 0)
    .map((k) => `${RES_ICON[k]}${cost[k]}`)
    .join(' ');
}
