// The game simulation (DESIGN.md §3–§7). Pure: no timers, sockets or randomness. The host
// calls tick() every TICK_MS and order methods when players act; orders return an error
// string when refused, null when done.
import {
  type BotDifficulty,
  type BuildingKind,
  BASE_YIELD,
  BROKE_LOSS,
  BROKE_TRAINING,
  BUILD_QUEUE,
  buildCost,
  CAPTURE_DECAY,
  canBuildOn,
  CROSS_SECONDS,
  CUT_OFF_SECONDS,
  DAMAGE_RATE,
  DRILL_CAP,
  DRILL_RATE,
  ENEMY_LAND_MOVE,
  ENTRENCH_BONUS,
  ENTRENCH_SECONDS,
  FORT_BONUS,
  FORT_MOVE_PENALTY,
  INFRA_MOVE_BONUS,
  MAX_LEVEL,
  MAX_TRAINING,
  MERGE_PENALTY,
  MIN_STRENGTH,
  OUT_OF_SUPPLY_LOSS,
  OUT_OF_SUPPLY_TRAINING,
  PEACE_OFFER_SECONDS,
  type ProductionBuilding,
  REFILL_RATE,
  RESOURCES,
  type Resources,
  RETREAT_STRENGTH_LOSS,
  RETREAT_TRAINING_LOSS,
  RIVER_BONUS,
  START_EXTRA_REGIONS,
  START_INFANTRY,
  STARTING,
  STARTING_MULTIPLIER,
  type StartingResources,
  SUPPLY_RANGE,
  TERRAIN_MOVE,
  TICK_MS,
  TRAINING_DAMAGE,
  TRAINING_PROTECTION,
  TRUCE_SECONDS,
  TRAIT_YIELD,
  type UnitType,
  UNITS,
  VETERANCY_RATE,
} from '../../shared/rules.ts';
import {
  type Blob,
  emptyLine,
  pairKey,
  emptyRegion,
  NEUTRAL,
  type Player,
  type RegionState,
  type SimEvent,
  type SimState,
} from './state.ts';
import type { World } from './world.ts';

export interface PlayerSetup {
  name: string;
  country: string;
  color: string;
  control: 'human' | 'bot';
  difficulty: BotDifficulty;
}

/** The most production orders one building can hold. */
export const MAX_QUEUE = 5;
/** Path cost added for regions with enemy blobs in them, so routes go around fights. */
const FIGHT_PATH_PENALTY = 40;

const zero = (): Resources => ({ money: 0, manpower: 0, steel: 0, oil: 0 });

export class Sim {
  readonly world: World;
  readonly state: SimState;
  /** Things that happened since the last drain (for the UI and bots). */
  events: SimEvent[] = [];

  constructor(world: World, players: PlayerSetup[], starting: StartingResources = 'normal') {
    this.world = world;
    this.state = {
      time: 0,
      players: [],
      regions: world.regions.map(() => emptyRegion()),
      blobs: new Map(),
      nextBlobId: 1,
      winner: null,
      wars: new Set(),
      warActivity: new Map(),
      truces: new Map(),
      peaceOffers: new Map(),
    };
    const taken = new Set<number>();
    players.forEach((p, id) => {
      const country = world.map.countries.find((c) => c.id === p.country);
      if (!country || country.capital < 0) throw new Error(`country ${p.country} can't be played on ${world.map.id}`);
      const mult = STARTING_MULTIPLIER[starting];
      const player: Player = {
        id,
        name: p.name,
        country: p.country,
        color: p.color,
        control: p.control,
        difficulty: p.difficulty,
        alive: true,
        capital: country.capital,
        resources: {
          money: STARTING.money * mult,
          manpower: STARTING.manpower * mult,
          steel: STARTING.steel * mult,
          oil: STARTING.oil * mult,
        },
        broke: false,
        income: zero(),
        upkeep: 0,
      };
      this.state.players.push(player);
      taken.add(country.capital);
    });
    for (const p of this.state.players) this.setUpStart(p, taken);
    this.updateSupply();
  }

  private setUpStart(p: Player, taken: Set<number>): void {
    const owned = [p.capital];
    // The capital's neighbours: same country first, then the longest borders.
    const capital = this.world.regions[p.capital];
    const around = [...capital.neighbors]
      .filter((n) => !taken.has(n.id) && this.state.regions[n.id].owner === NEUTRAL)
      .sort((a, b) => {
        const sa = this.world.regions[a.id].country === p.country ? 1 : 0;
        const sb = this.world.regions[b.id].country === p.country ? 1 : 0;
        return sb - sa || b.border - a.border;
      });
    for (const n of around.slice(0, START_EXTRA_REGIONS)) owned.push(n.id);
    for (const r of owned) {
      this.state.regions[r].owner = p.id;
      taken.add(r);
    }
    this.state.regions[p.capital].barracks = true;
    let placed = 0;
    for (const r of owned) {
      while (placed < START_INFANTRY && this.count(p.id, r) < this.stackCap(r)) {
        this.spawn(p.id, 'infantry', r);
        placed++;
      }
    }
  }

  // -- queries ----------------------------------------------------------------------------

  player(id: number): Player | undefined {
    return this.state.players[id];
  }

  /** Standing blobs by region, rebuilt only after something moved, spawned or died. */
  private index: Map<number, Blob[]> | null = null;
  private indexSize = -1;

  private standing(): Map<number, Blob[]> {
    // The size check also catches blobs added or removed from outside (tests).
    if (this.index && this.indexSize === this.state.blobs.size) return this.index;
    const index = new Map<number, Blob[]>();
    for (const b of this.state.blobs.values()) {
      if (b.progress !== 0) continue;
      const list = index.get(b.region);
      if (list) list.push(b);
      else index.set(b.region, [b]);
    }
    this.index = index;
    this.indexSize = this.state.blobs.size;
    return index;
  }

  /** Call after a blob starts or stops moving between regions, or leaves the game. */
  private touch(): void {
    this.index = null;
  }

  /** Blobs standing in a region (not on the move between regions). */
  blobsIn(region: number): Blob[] {
    return [...(this.standing().get(region) ?? [])];
  }

  count(owner: number, region: number): number {
    let n = 0;
    for (const b of this.standing().get(region) ?? []) if (b.owner === owner) n++;
    return n;
  }

  stackCap(region: number): number {
    return this.world.stackCap(region, this.state.regions[region].infra);
  }

  /** Owners with blobs standing in a region. */
  ownersIn(region: number): Set<number> {
    const s = new Set<number>();
    for (const b of this.standing().get(region) ?? []) s.add(b.owner);
    return s;
  }

  /** Two sides at war stand in this region. */
  contested(region: number): boolean {
    const owners = [...this.ownersIn(region)];
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) if (this.atWar(owners[i], owners[j])) return true;
    }
    return false;
  }

  /** Units of someone at war with `owner` stand in this region. */
  hostileIn(region: number, owner: number): boolean {
    for (const b of this.standing().get(region) ?? []) if (this.atWar(b.owner, owner)) return true;
    return false;
  }

  // -- diplomacy --------------------------------------------------------------------------

  atWar(a: number, b: number): boolean {
    return a !== b && a >= 0 && b >= 0 && this.state.wars.has(pairKey(a, b));
  }

  /** Another player's land is closed to `owner` while they're at peace. */
  private closedTo(owner: number, region: number): boolean {
    const o = this.state.regions[region].owner;
    return o !== NEUTRAL && o !== owner && !this.atWar(o, owner);
  }

  inTruce(a: number, b: number): boolean {
    return (this.state.truces.get(pairKey(a, b)) ?? -1) > this.state.time;
  }

  /** `by` goes to war with `target` (attacking someone does this too). */
  declareWar(by: number, target: number): string | null {
    const a = this.player(by);
    const b = this.player(target);
    if (!a?.alive || !b?.alive || by === target) return 'no such country';
    if (this.atWar(by, target)) return null;
    if (this.inTruce(by, target)) return `truce with ${b.name} for ${Math.ceil((this.state.truces.get(pairKey(by, target)) ?? 0) - this.state.time)} s`;
    const key = pairKey(by, target);
    this.state.wars.add(key);
    this.state.warActivity.set(key, this.state.time);
    this.state.peaceOffers.delete(`${by}>${target}`);
    this.state.peaceOffers.delete(`${target}>${by}`);
    this.events.push({ kind: 'war', a: by, b: target, by });
    return null;
  }

  /** Offers peace, or accepts it if the other side already offered. */
  offerPeace(from: number, to: number): string | null {
    if (!this.player(from)?.alive || !this.player(to)?.alive) return 'no such country';
    if (!this.atWar(from, to)) return 'not at war';
    if (this.state.peaceOffers.has(`${to}>${from}`)) {
      this.makePeace(from, to);
      return null;
    }
    this.state.peaceOffers.set(`${from}>${to}`, this.state.time + PEACE_OFFER_SECONDS);
    this.events.push({ kind: 'peaceOffer', from, to });
    return null;
  }

  /** Turns down an offer of peace. */
  refusePeace(by: number, from: number): string | null {
    if (!this.state.peaceOffers.delete(`${from}>${by}`)) return 'no offer to refuse';
    this.events.push({ kind: 'peaceRefused', from, to: by });
    return null;
  }

  /** Ends a war: a truce starts, and each side's units in the other's land go home. */
  private makePeace(a: number, b: number): void {
    const key = pairKey(a, b);
    this.state.wars.delete(key);
    this.state.peaceOffers.delete(`${a}>${b}`);
    this.state.peaceOffers.delete(`${b}>${a}`);
    this.state.truces.set(key, this.state.time + TRUCE_SECONDS);
    this.state.regions.forEach((rs) => {
      if (rs.capture && ((rs.capture.by === a && rs.owner === b) || (rs.capture.by === b && rs.owner === a))) rs.capture = null;
    });
    for (const blob of this.state.blobs.values()) {
      const other = blob.owner === a ? b : blob.owner === b ? a : -1;
      if (other < 0) continue;
      const here = blob.progress > 0 ? blob.path[0] : blob.region;
      const inTheirs = this.state.regions[here].owner === other || blob.path.some((r) => this.state.regions[r].owner === other);
      if (!inTheirs) continue;
      if (blob.progress > 0) {
        // Turn back to where it came from.
        blob.path = [];
        blob.progress = 0;
        this.touch();
      }
      const home = this.nearestOwn(blob);
      blob.path = home === null ? [] : (this.route(blob.type, blob.owner, blob.training, blob.region, home, other) ?? []);
      blob.hold = false;
    }
    this.events.push({ kind: 'peace', a, b });
  }

  /** The nearest region its owner holds (by hops), for sending units home. */
  private nearestOwn(b: Blob): number | null {
    const seen = new Set([b.region]);
    const queue = [b.region];
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      if (this.state.regions[u].owner === b.owner) return u;
      for (const e of this.world.neighbors(u)) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          queue.push(e.id);
        }
      }
    }
    return null;
  }

  /** Seconds for a blob of `type` owned by `owner` to go from one region to its neighbour. */
  travelSeconds(type: UnitType, owner: number, from: number, to: number): number {
    const edge = this.world.edge(from, to);
    if (!edge) return Infinity;
    const dest = this.state.regions[to];
    let speed = UNITS[type].speed * TERRAIN_MOVE[this.world.regions[to].terrain];
    if (dest.owner === owner) speed *= 1 + INFRA_MOVE_BONUS * dest.infra;
    else if (this.atWar(dest.owner, owner)) speed *= Math.max(0.3, ENEMY_LAND_MOVE - FORT_MOVE_PENALTY * dest.fort);
    return (CROSS_SECONDS * (edge.dist / this.world.hop)) / speed;
  }

  /**
   * Cheapest route (excluding `from`), counting travel, captures and fights on the way.
   * Land of countries at peace with `owner` is closed, except `through`'s (going home).
   */
  route(type: UnitType, owner: number, training: number, from: number, to: number, through = -1): number[] | null {
    if (from === to) return [];
    const n = this.world.regions.length;
    const cost = new Array<number>(n).fill(Infinity);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    cost[from] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && cost[i] < Infinity && (u === -1 || cost[i] < cost[u])) u = i;
      if (u === -1 || u === to) break;
      done[u] = true;
      for (const e of this.world.neighbors(u)) {
        const v = e.id;
        if (done[v]) continue;
        const rs = this.state.regions[v];
        if (this.closedTo(owner, v) && rs.owner !== through) continue;
        let c = this.travelSeconds(type, owner, u, v);
        if (rs.owner !== owner) c += this.world.captureSeconds(v, rs.fort, training);
        if (this.hostileIn(v, owner)) c += FIGHT_PATH_PENALTY;
        if (cost[u] + c < cost[v]) {
          cost[v] = cost[u] + c;
          prev[v] = u;
        }
      }
    }
    if (cost[to] === Infinity) return null;
    const path: number[] = [];
    for (let v = to; v !== from; v = prev[v]) path.unshift(v);
    return path;
  }

  // -- orders -----------------------------------------------------------------------------

  private own(playerId: number, blobIds: number[]): Blob[] | string {
    const p = this.player(playerId);
    if (!p?.alive) return 'you are not in the game';
    const blobs: Blob[] = [];
    for (const id of new Set(blobIds)) {
      const b = this.state.blobs.get(id);
      if (!b || b.owner !== playerId) return 'not your unit';
      blobs.push(b);
    }
    return blobs.length ? blobs : 'no units';
  }

  move(playerId: number, blobIds: number[], target: number): string | null {
    const blobs = this.own(playerId, blobIds);
    if (typeof blobs === 'string') return blobs;
    if (!this.world.regions[target]) return 'no such region';
    // Sending units into a country you're at peace with is an attack: war.
    const victim = this.state.regions[target].owner;
    if (this.closedTo(playerId, target)) {
      const err = this.declareWar(playerId, victim);
      if (err) return err;
    }
    for (const b of blobs) {
      // Waiting at the edge of a full region: turn back and go from where it came.
      if (b.progress >= 1) {
        b.progress = 0;
        this.touch();
      }
      // On the move: finish the current hop, then follow the new route from there.
      const start = b.progress > 0 ? b.path[0] : b.region;
      const route = this.route(b.type, b.owner, b.training, start, target);
      if (!route) return 'no route';
      if (b.progress > 0) {
        b.path = [b.path[0], ...route];
        continue;
      }
      if (route.length && this.contested(b.region)) {
        // Leaving a battle costs.
        b.strength *= 1 - RETREAT_STRENGTH_LOSS;
        b.training = Math.max(0, b.training - RETREAT_TRAINING_LOSS);
      }
      b.path = route;
      b.hold = false;
    }
    return null;
  }

  stop(playerId: number, blobIds: number[]): string | null {
    const blobs = this.own(playerId, blobIds);
    if (typeof blobs === 'string') return blobs;
    for (const b of blobs) {
      b.path = b.progress > 0 ? [b.path[0]] : [];
      b.hold = false;
    }
    return null;
  }

  split(playerId: number, blobId: number): string | null {
    const blobs = this.own(playerId, [blobId]);
    if (typeof blobs === 'string') return blobs;
    const [b] = blobs;
    if (b.progress > 0) return 'units on the move can\'t split';
    if (b.size < 2) return 'too small to split';
    if (this.count(b.owner, b.region) >= this.stackCap(b.region)) return 'no room in this region';
    const half = Math.floor(b.size / 2);
    const share = half / b.size;
    const other = this.spawn(b.owner, b.type, b.region);
    other.size = half;
    other.strength = b.strength * share;
    other.training = b.training;
    other.entrench = b.entrench;
    other.supply = b.supply;
    b.size -= half;
    b.strength -= other.strength;
    return null;
  }

  merge(playerId: number, blobIds: number[]): string | null {
    const blobs = this.own(playerId, blobIds);
    if (typeof blobs === 'string') return blobs;
    if (blobs.length < 2) return 'pick at least two units';
    const [into, ...rest] = blobs;
    for (const b of rest) {
      if (b.type !== into.type) return 'only units of the same type merge';
      if (b.region !== into.region || b.progress > 0 || into.progress > 0) return 'units must be in the same region';
    }
    const max = UNITS[into.type].maxSize;
    for (const b of rest) {
      const room = max - into.size;
      if (room <= 0) break;
      const take = Math.min(room, b.size);
      const share = take / b.size;
      const str = b.strength * share;
      into.training = Math.max(
        0,
        (into.training * into.strength + b.training * str) / Math.max(MIN_STRENGTH, into.strength + str) - MERGE_PENALTY,
      );
      into.size += take;
      into.strength += str;
      into.entrench = Math.min(into.entrench, b.entrench);
      b.size -= take;
      b.strength -= str;
      if (b.size <= 0 || b.strength < MIN_STRENGTH) this.remove(b.id);
    }
    return null;
  }

  build(playerId: number, region: number, kind: BuildingKind): string | null {
    const p = this.player(playerId);
    const rs = this.state.regions[region];
    if (!p?.alive) return 'you are not in the game';
    if (!rs || rs.owner !== playerId) return 'not your region';
    if (!rs.supplied) return 'region is out of supply';
    if (!canBuildOn(kind, this.world.regions[region].traits)) return `can't build a ${kind} here`;
    const level = this.nextLevel(rs, kind);
    if (level > MAX_LEVEL[kind]) return 'already at the highest level';
    if (rs.construction && rs.buildQueue.length >= BUILD_QUEUE) return 'build queue is full';
    const { cost, seconds } = buildCost(kind, level);
    if (!this.pay(p, cost)) return 'not enough resources';
    const c = { kind, level, progress: 0, seconds, cost };
    if (rs.construction) rs.buildQueue.push(c);
    else rs.construction = c;
    return null;
  }

  /** The level the next build of `kind` in a region would reach, counting queued ones. */
  nextLevel(rs: RegionState, kind: BuildingKind): number {
    const pending = [rs.construction, ...rs.buildQueue].filter((c) => c?.kind === kind).length;
    return this.levelOf(rs, kind) + pending + 1;
  }

  /**
   * Cancels a build (0: the one under way, 1+: waiting) and every later build of the same
   * kind, whose levels depended on it. Everything cancelled is refunded in full.
   */
  unbuild(playerId: number, region: number, index: number): string | null {
    const rs = this.state.regions[region];
    if (!this.player(playerId)?.alive) return 'you are not in the game';
    if (!rs || rs.owner !== playerId) return 'not your region';
    const all = rs.construction ? [rs.construction, ...rs.buildQueue] : [];
    const target = all[index];
    if (!target) return 'nothing to cancel';
    const drop = new Set(all.filter((c, i) => i >= index && c.kind === target.kind));
    for (const c of drop) this.refund(this.state.players[playerId], c.cost);
    const keep = all.filter((c) => !drop.has(c));
    if (rs.construction && drop.has(rs.construction)) {
      rs.construction = keep.shift() ?? null;
      if (rs.construction) rs.construction.progress = 0;
    } else keep.shift();
    rs.buildQueue = keep;
    return null;
  }

  levelOf(rs: RegionState, kind: BuildingKind): number {
    if (kind === 'fort') return rs.fort;
    if (kind === 'infra') return rs.infra;
    return rs[kind] ? 1 : 0;
  }

  produce(playerId: number, region: number, building: ProductionBuilding): string | null {
    const rs = this.state.regions[region];
    if (!this.player(playerId)?.alive) return 'you are not in the game';
    if (!rs || rs.owner !== playerId) return 'not your region';
    if (!rs[building]) return `no ${building} here`;
    const line = rs.production[building];
    if (line.queue.length >= MAX_QUEUE) return 'queue is full';
    line.queue.push(building === 'barracks' ? 'infantry' : 'tank');
    return null;
  }

  setRepeat(playerId: number, region: number, building: ProductionBuilding, repeat: boolean): string | null {
    const rs = this.state.regions[region];
    if (!rs || rs.owner !== playerId) return 'not your region';
    rs.production[building].repeat = repeat;
    return null;
  }

  /** Removes the last order in a building's queue, refunding it if it was paid for. */
  cancel(playerId: number, region: number, building: ProductionBuilding): string | null {
    const rs = this.state.regions[region];
    if (!rs || rs.owner !== playerId) return 'not your region';
    const line = rs.production[building];
    const type = line.queue.pop();
    if (!type) return 'nothing queued';
    if (line.queue.length === 0 && line.progress >= 0) {
      this.refund(this.state.players[playerId], UNITS[type].cost);
      line.progress = -1;
    }
    return null;
  }

  // -- the tick ---------------------------------------------------------------------------

  tick(dt = TICK_MS / 1000): void {
    if (this.state.winner !== null) return;
    this.state.time += dt;
    for (const [key, until] of this.state.peaceOffers) if (until <= this.state.time) this.state.peaceOffers.delete(key);
    this.updateSupply();
    this.moveBlobs(dt);
    const fighting = this.battles(dt);
    this.captures(dt);
    this.economy(dt);
    this.blobUpkeep(dt, fighting);
    this.cutOffRegions(dt);
  }

  // -- supply -----------------------------------------------------------------------------

  private updateSupply(): void {
    const regions = this.state.regions;
    for (const rs of regions) rs.supplied = false;
    for (const p of this.state.players) {
      if (!p.alive) continue;
      const depth = new Map<number, number>();
      const queue: number[] = [];
      regions.forEach((rs, i) => {
        if (rs.owner === p.id && (i === p.capital || this.world.regions[i].traits.includes('city'))) {
          depth.set(i, 0);
          queue.push(i);
        }
      });
      for (let q = 0; q < queue.length; q++) {
        const u = queue[q];
        const d = depth.get(u) as number;
        regions[u].supplied = true;
        if (d >= SUPPLY_RANGE) continue;
        for (const e of this.world.neighbors(u)) {
          if (regions[e.id].owner === p.id && !depth.has(e.id)) {
            depth.set(e.id, d + 1);
            queue.push(e.id);
          }
        }
      }
    }
    // Supply level per region: capacity over what the blobs standing there need.
    const need = new Map<string, number>();
    for (const b of this.state.blobs.values()) {
      if (b.progress > 0) continue;
      const k = `${b.owner}:${b.region}`;
      need.set(k, (need.get(k) ?? 0) + b.size * UNITS[b.type].supplyNeed);
    }
    const level = (owner: number, r: number): number => {
      const rs = regions[r];
      if (rs.owner !== owner || !rs.supplied) return 0;
      const n = need.get(`${owner}:${r}`) ?? 0;
      return n <= 0 ? 1 : Math.min(1, this.world.supplyCapacity(r, rs.infra) / n);
    };
    for (const b of this.state.blobs.values()) {
      if (regions[b.region].owner === b.owner) {
        b.supply = level(b.owner, b.region);
      } else {
        // In foreign land: supplied from the best of its owner's neighbouring regions.
        let best = 0;
        for (const e of this.world.neighbors(b.region)) best = Math.max(best, level(b.owner, e.id));
        b.supply = best;
      }
    }
  }

  private cutOffRegions(dt: number): void {
    this.state.regions.forEach((rs, i) => {
      if (rs.owner === NEUTRAL || rs.supplied || this.count(rs.owner, i) > 0) {
        rs.cutOff = 0;
        return;
      }
      rs.cutOff += dt;
      if (rs.cutOff >= CUT_OFF_SECONDS) this.setOwner(i, NEUTRAL);
    });
  }

  // -- movement ---------------------------------------------------------------------------

  private moveBlobs(dt: number): void {
    for (const b of this.state.blobs.values()) {
      if (b.path.length === 0) continue;
      if (b.progress === 0) {
        // Holding: must win and take this region before going on.
        if (b.hold) {
          if (this.state.regions[b.region].owner !== b.owner || this.hostileIn(b.region, b.owner)) continue;
          b.hold = false;
        }
        b.entrench = 0;
      }
      const next = b.path[0];
      if (b.progress === 0) this.touch(); // leaving its region
      if (b.progress < 1) {
        b.progress = Math.min(1, b.progress + dt / this.travelSeconds(b.type, b.owner, b.region, next));
      }
      if (b.progress >= 1) {
        this.arrive(b);
        // Only passing through its own land: keep going this tick, no stop in the region.
        if (b.progress === 0 && b.path.length && !b.hold) {
          b.progress = Math.min(1, dt / this.travelSeconds(b.type, b.owner, b.region, b.path[0]));
          b.entrench = 0;
          this.touch();
        }
      }
    }
  }

  private arrive(b: Blob): void {
    const to = b.path[0];
    const edge = this.world.edge(b.region, to);
    const rs = this.state.regions[to];
    if (this.closedTo(b.owner, to)) {
      // Peace was made on the way: stay out of their land.
      b.path = [];
      b.progress = 0;
      this.touch();
      return;
    }
    const hostile = this.hostileIn(to, b.owner);
    // A full region: wait at its edge until there's room, unless just passing through own land.
    const passing = b.path.length > 1 && rs.owner === b.owner && !hostile;
    if (!passing && this.count(b.owner, to) >= this.stackCap(to)) return;
    b.path.shift();
    b.region = to;
    b.progress = 0;
    this.touch();
    b.entrench = 0;
    b.crossedRiver = !!edge?.river && rs.owner !== b.owner;
    b.hold = b.path.length > 0 && (rs.owner !== b.owner || hostile);
    if (hostile) {
      this.events.push({ kind: 'battle', region: to, sides: [...this.ownersIn(to)] });
    }
  }

  // -- battles ----------------------------------------------------------------------------

  /** Runs every contested region's fight; returns the ids of blobs that fought. */
  private battles(dt: number): Set<number> {
    const fighting = new Set<number>();
    const byRegion = new Map<number, Blob[]>();
    for (const b of this.state.blobs.values()) {
      if (b.progress > 0) continue;
      const list = byRegion.get(b.region);
      if (list) list.push(b);
      else byRegion.set(b.region, [b]);
    }
    const damage = new Map<Blob, number>();
    for (const [region, blobs] of byRegion) {
      const sides = new Map<number, Blob[]>();
      for (const b of blobs) sides.set(b.owner, [...(sides.get(b.owner) ?? []), b]);
      if (sides.size < 2) continue;
      const foes = (s: number) => [...sides.keys()].filter((t) => this.atWar(s, t));
      if (![...sides.keys()].some((s) => foes(s).length)) continue;
      const rs = this.state.regions[region];
      const terrain = this.world.regions[region].terrain;
      const strengthOf = (list: Blob[]) => list.reduce((s, b) => s + b.strength, 0);
      for (const [s, attackers] of sides) {
        const power =
          DAMAGE_RATE *
          attackers.reduce(
            (sum, b) =>
              sum +
              b.strength *
                UNITS[b.type].attack *
                UNITS[b.type].terrainAttack[terrain] *
                (1 + (TRAINING_DAMAGE * b.training) / MAX_TRAINING) *
                (0.5 + 0.5 * b.supply),
            0,
          );
        const total = attackers.reduce((sum, b) => sum + b.strength, 0);
        const riverShare = total > 0 ? attackers.filter((b) => b.crossedRiver).reduce((x, b) => x + b.strength, 0) / total : 0;
        const mine = foes(s);
        let enemies = 0;
        for (const t of mine) enemies += strengthOf(sides.get(t) as Blob[]);
        for (const t of mine) {
          const defenders = sides.get(t) as Blob[];
          if (enemies <= 0) continue;
          const st = strengthOf(defenders);
          const share = (power * dt * st) / enemies;
          for (const d of defenders) {
            let taken = (share * d.strength) / st / UNITS[d.type].defense;
            taken *= 1 - (TRAINING_PROTECTION * d.training) / MAX_TRAINING;
            if (rs.owner === t) taken /= 1 + FORT_BONUS * rs.fort + ENTRENCH_BONUS * d.entrench + RIVER_BONUS * riverShare;
            damage.set(d, (damage.get(d) ?? 0) + taken);
          }
        }
      }
      for (const [s, list] of sides) if (foes(s).length) for (const b of list) fighting.add(b.id);
    }
    for (const [b, d] of damage) b.strength -= d;
    for (const id of fighting) {
      const b = this.state.blobs.get(id) as Blob;
      b.training = Math.min(MAX_TRAINING, b.training + VETERANCY_RATE * dt);
    }
    return fighting;
  }

  // -- capturing --------------------------------------------------------------------------

  private captures(dt: number): void {
    this.state.regions.forEach((rs, i) => {
      if (this.contested(i)) return; // fighting: capture waits
      // Who could take it: anyone there who isn't the owner (peaceful neighbours share
      // neutral land; whoever started capturing first keeps going).
      const takers = [...this.ownersIn(i)].filter((o) => o !== rs.owner && (rs.owner === NEUTRAL || this.atWar(o, rs.owner)));
      const by = rs.capture && takers.includes(rs.capture.by) ? rs.capture.by : takers.sort((a, b) => a - b)[0];
      if (by === undefined) {
        if (rs.capture) {
          rs.capture.progress -= CAPTURE_DECAY * dt;
          if (rs.capture.progress <= 0) rs.capture = null;
        }
        return;
      }
      if (!rs.capture || rs.capture.by !== by) rs.capture = { by, progress: 0 };
      const training = Math.max(...this.blobsIn(i).filter((b) => b.owner === by).map((b) => b.training));
      rs.capture.progress += dt / this.world.captureSeconds(i, rs.fort, training);
      if (rs.capture.progress >= 1) {
        const from = rs.owner;
        if (from !== NEUTRAL) this.state.warActivity.set(pairKey(by, from), this.state.time);
        this.setOwner(i, by);
        this.events.push({ kind: 'captured', region: i, by, from });
        const lost = this.state.players.find((p) => p.alive && p.capital === i && p.id !== by);
        if (lost) this.eliminate(lost.id, by);
      }
    });
  }

  /** Hands a region over. Buildings stay; queued work belonged to the old owner. */
  private setOwner(region: number, owner: number): void {
    const rs = this.state.regions[region];
    rs.owner = owner;
    rs.capture = null;
    rs.cutOff = 0;
    rs.construction = null;
    rs.buildQueue = [];
    rs.production = { barracks: emptyLine(), factory: emptyLine() };
  }

  private eliminate(playerId: number, by: number): void {
    const p = this.state.players[playerId];
    p.alive = false;
    this.state.regions.forEach((rs, i) => {
      if (rs.owner === playerId) this.setOwner(i, NEUTRAL);
    });
    for (const b of [...this.state.blobs.values()]) if (b.owner === playerId) this.remove(b.id);
    for (const key of [...this.state.wars]) if (key.split(':').map(Number).includes(playerId)) this.state.wars.delete(key);
    for (const key of [...this.state.peaceOffers.keys()]) if (key.split('>').map(Number).includes(playerId)) this.state.peaceOffers.delete(key);
    this.events.push({ kind: 'eliminated', player: playerId, by });
    const alive = this.state.players.filter((x) => x.alive);
    if (alive.length === 1) {
      this.state.winner = alive[0].id;
      this.events.push({ kind: 'won', player: alive[0].id });
    }
  }

  // -- economy ----------------------------------------------------------------------------

  private economy(dt: number): void {
    const players = this.state.players;
    for (const p of players) {
      p.income = zero();
      p.upkeep = 0;
    }
    this.state.regions.forEach((rs, i) => {
      if (rs.owner === NEUTRAL || !rs.supplied || this.hostileIn(i, rs.owner)) return;
      const p = players[rs.owner];
      add(p.income, BASE_YIELD);
      for (const t of this.world.regions[i].traits) add(p.income, TRAIT_YIELD[t]);
    });
    for (const b of this.state.blobs.values()) players[b.owner].upkeep += b.size * UNITS[b.type].upkeep;
    for (const p of players) {
      if (!p.alive) continue;
      for (const k of RESOURCES) p.resources[k] += p.income[k] * dt;
      p.resources.money -= p.upkeep * dt;
      p.broke = p.resources.money < 0;
      if (p.broke) p.resources.money = 0;
    }
    this.state.regions.forEach((rs, i) => {
      if (rs.owner === NEUTRAL || !rs.supplied || this.hostileIn(i, rs.owner)) return;
      this.construct(rs, i, dt);
      this.produceIn(rs, i, 'barracks', dt);
      this.produceIn(rs, i, 'factory', dt);
    });
  }

  private construct(rs: RegionState, region: number, dt: number): void {
    const c = rs.construction;
    if (!c) return;
    c.progress += dt;
    if (c.progress < c.seconds) return;
    if (c.kind === 'fort') rs.fort = c.level;
    else if (c.kind === 'infra') rs.infra = c.level;
    else rs[c.kind] = true;
    rs.construction = rs.buildQueue.shift() ?? null;
    this.events.push({ kind: 'built', region, owner: rs.owner, building: c.kind, level: c.level });
  }

  private produceIn(rs: RegionState, region: number, building: ProductionBuilding, dt: number): void {
    const line = rs.production[building];
    if (!rs[building] || line.queue.length === 0) return;
    const type = line.queue[0];
    const p = this.state.players[rs.owner];
    if (line.progress < 0) {
      if (!this.pay(p, UNITS[type].cost)) return;
      line.progress = 0;
    }
    line.progress = Math.min(UNITS[type].buildTime, line.progress + dt);
    if (line.progress < UNITS[type].buildTime) return;
    if (this.count(rs.owner, region) >= this.stackCap(region)) return; // done, waiting for room
    this.spawn(rs.owner, type, region);
    this.events.push({ kind: 'produced', region, owner: rs.owner, type });
    line.queue.shift();
    line.progress = -1;
    if (line.repeat) line.queue.push(type);
  }

  // -- blobs over time --------------------------------------------------------------------

  private blobUpkeep(dt: number, fighting: Set<number>): void {
    for (const b of [...this.state.blobs.values()]) {
      const p = this.state.players[b.owner];
      const still = b.progress === 0 && b.path.length === 0;
      const inBattle = fighting.has(b.id);
      if (b.progress === 0 && this.state.regions[b.region].owner === b.owner && (still || b.hold)) {
        b.entrench = Math.min(1, b.entrench + dt / ENTRENCH_SECONDS);
      }
      if (!inBattle && b.supply > 0) {
        if (still && b.training < DRILL_CAP) b.training = Math.min(DRILL_CAP, b.training + DRILL_RATE * dt * b.supply);
        const want = Math.min(b.size - b.strength, REFILL_RATE * dt * b.supply);
        if (want > 0) {
          const cost = UNITS[b.type].refillCost;
          if (this.pay(p, { money: cost.money * want, manpower: cost.manpower * want, steel: cost.steel * want, oil: cost.oil * want })) {
            b.strength += want;
          }
        }
      }
      if (b.supply < 1) {
        b.strength -= (1 - b.supply) * OUT_OF_SUPPLY_LOSS * b.size * dt;
        b.training = Math.max(0, b.training - (1 - b.supply) * OUT_OF_SUPPLY_TRAINING * dt);
      }
      if (p.broke) {
        b.strength -= BROKE_LOSS * b.size * dt;
        b.training = Math.max(0, b.training - BROKE_TRAINING * dt);
      }
      if (b.strength < MIN_STRENGTH) this.remove(b.id);
    }
  }

  // -- helpers ----------------------------------------------------------------------------

  spawn(owner: number, type: UnitType, region: number): Blob {
    const b: Blob = {
      id: this.state.nextBlobId++,
      owner,
      type,
      strength: UNITS[type].batch,
      size: UNITS[type].batch,
      training: 0,
      region,
      path: [],
      progress: 0,
      entrench: 0,
      crossedRiver: false,
      supply: 1,
      hold: false,
    };
    this.state.blobs.set(b.id, b);
    this.touch();
    return b;
  }

  private remove(id: number): void {
    this.state.blobs.delete(id);
    this.touch();
  }

  canAfford(p: Player, cost: Resources): boolean {
    return RESOURCES.every((k) => p.resources[k] >= cost[k]);
  }

  private pay(p: Player, cost: Resources): boolean {
    if (!this.canAfford(p, cost)) return false;
    for (const k of RESOURCES) p.resources[k] -= cost[k];
    return true;
  }

  private refund(p: Player, cost: Resources): void {
    for (const k of RESOURCES) p.resources[k] += cost[k];
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}

function add(into: Resources, from: Partial<Resources>): void {
  for (const k of RESOURCES) into[k] += from[k] ?? 0;
}
