// One running match: the simulation, the bots, who is playing which country, and the
// snapshots sent to clients.
import {
  BUILDING_INDEX,
  type BlobRow,
  type GameEvent,
  type GamePlayer,
  type Order,
  type PlayerRow,
  type ProductionView,
  type RegionRow,
  type Snapshot,
  UNIT_INDEX,
} from '../../shared/protocol.ts';
import { type BotDifficulty, DISCONNECT_BOT_SECONDS, type StartingResources, UNITS } from '../../shared/rules.ts';
import { Bot } from './bot.ts';
import { mulberry32 } from './rng.ts';
import { type PlayerSetup, Sim } from './sim.ts';
import type { World } from './world.ts';

export interface Seat {
  setup: PlayerSetup;
  /** Identity of the person playing it, or null for a bot country. */
  human: string | null;
}

const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

export class Game {
  readonly sim: Sim;
  readonly mapId: string;
  readonly players: GamePlayer[];
  readonly startedAt: number;
  /** identity id → player index */
  readonly humans = new Map<string, number>();
  private readonly bots = new Map<number, Bot>();
  /** player index → sim time they dropped */
  private readonly away = new Map<number, number>();
  private readonly difficulty: BotDifficulty;
  private readonly seed: number;
  private pending: GameEvent[] = [];
  over = false;

  constructor(world: World, seats: Seat[], starting: StartingResources, difficulty: BotDifficulty, seed: number, now: number) {
    this.mapId = world.map.id;
    this.difficulty = difficulty;
    this.seed = seed;
    this.startedAt = now;
    this.sim = new Sim(
      world,
      seats.map((s) => s.setup),
      starting,
    );
    this.players = seats.map((s, id) => ({
      id,
      name: s.setup.name,
      country: s.setup.country,
      color: s.setup.color,
      human: s.human !== null,
    }));
    seats.forEach((s, id) => {
      if (s.human) this.humans.set(s.human, id);
      else this.bots.set(id, this.makeBot(id, difficulty));
    });
  }

  private makeBot(player: number, difficulty: BotDifficulty, standIn = false): Bot {
    return new Bot(player, difficulty, mulberry32(this.seed * 31 + player), standIn);
  }

  playerOf(identity: string): number | null {
    return this.humans.get(identity) ?? null;
  }

  /** A person dropped or came back. Away too long, and a bot plays for them. */
  setConnected(identity: string, connected: boolean): void {
    const id = this.humans.get(identity);
    if (id === undefined) return;
    const p = this.sim.state.players[id];
    if (connected) {
      this.away.delete(id);
      if (p.control === 'bot') {
        this.bots.delete(id);
        p.control = 'human';
      }
    } else if (!this.away.has(id)) {
      this.away.set(id, this.sim.state.time);
    }
  }

  /** The person left the lobby for good: a bot plays their country from now on. */
  abandon(identity: string): void {
    const id = this.humans.get(identity);
    if (id === undefined) return;
    this.humans.delete(identity);
    this.away.delete(id);
    this.sim.state.players[id].control = 'bot';
    if (!this.bots.has(id)) this.bots.set(id, this.makeBot(id, this.difficulty, true));
  }

  order(identity: string, order: Order): string | null {
    const id = this.humans.get(identity);
    if (id === undefined) return 'you are watching this game';
    if (this.sim.state.players[id].control === 'bot') this.setConnected(identity, true);
    const s = this.sim;
    switch (order.o) {
      case 'move':
        return s.move(id, order.blobs, order.to);
      case 'stop':
        return s.stop(id, order.blobs);
      case 'split':
        return s.split(id, order.blob, order.amount);
      case 'merge':
        return s.merge(id, order.blobs);
      case 'build':
        return s.build(id, order.region, order.kind, order.target ?? -1);
      case 'demolish':
        return s.demolish(id, order.region, order.kind);
      case 'produce':
        return s.produce(id, order.region, order.building);
      case 'repeat':
        return s.setRepeat(id, order.region, order.building, order.on);
      case 'cancel':
        return s.cancel(id, order.region, order.building);
      case 'unbuild':
        return s.unbuild(id, order.region, order.index);
      case 'war':
        return s.declareWar(id, order.player);
      case 'peace':
        return s.offerPeace(id, order.player);
      case 'refuse':
        return s.refusePeace(id, order.player);
    }
  }

  tick(): void {
    if (this.over) return;
    for (const [id, since] of this.away) {
      const p = this.sim.state.players[id];
      if (p.control === 'human' && this.sim.state.time - since >= DISCONNECT_BOT_SECONDS) {
        p.control = 'bot';
        this.bots.set(id, this.makeBot(id, 'normal', true));
      }
    }
    for (const bot of this.bots.values()) bot.act(this.sim);
    this.sim.tick();
    this.pending.push(...this.sim.drainEvents());
    if (this.sim.state.winner !== null) this.over = true;
  }

  /** Events since the last call (they go out with the next snapshots). */
  takeEvents(): GameEvent[] {
    const e = this.pending;
    this.pending = [];
    return e;
  }

  /** The parts of a snapshot that are the same for everyone. */
  sharedSnapshot(events: GameEvent[]): Omit<Snapshot, 'production' | 'routes' | 'builds'> {
    const st = this.sim.state;
    const players: PlayerRow[] = st.players.map((p) => ({
      alive: p.alive,
      res: [round(p.resources.money, 1), round(p.resources.manpower, 1), round(p.resources.steel, 1), round(p.resources.oil, 1)],
      income: [round(p.income.money, 2), round(p.income.manpower, 2), round(p.income.steel, 2), round(p.income.oil, 2)],
      upkeep: round(p.upkeep, 2),
      broke: p.broke,
      bot: p.control === 'bot',
    }));
    const regions: RegionRow[] = st.regions.map((r) => [
      r.owner,
      r.fort,
      r.city,
      (r.barracks ? 1 : 0) | (r.factory ? 2 : 0) | (r.supplied ? 4 : 0),
      r.capture ? r.capture.by : -1,
      r.capture ? round(r.capture.progress, 2) : 0,
      r.construction ? BUILDING_INDEX.indexOf(r.construction.kind) : -1,
      r.construction ? round(r.construction.progress / r.construction.seconds, 2) : 0,
      r.construction ? r.construction.target : -1,
      r.econ.farm,
      r.econ.mine,
      r.econ.well,
      r.econ.market,
    ]);
    const blobs: BlobRow[] = [];
    for (const b of st.blobs.values()) {
      blobs.push([
        b.id,
        b.owner,
        UNIT_INDEX.indexOf(b.type),
        round(b.strength, 1),
        b.size,
        Math.round(b.training),
        b.region,
        b.path.length ? b.path[0] : -1,
        round(b.progress, 3),
        round(b.entrench, 2),
        round(b.supply, 2),
        (b.hold ? 1 : 0) | (b.crossedRiver ? 2 : 0),
        b.from,
      ]);
    }
    const pair = (key: string, sep: string) => key.split(sep).map(Number) as [number, number];
    const wars = [...st.wars].map((k) => pair(k, ':'));
    const offers = [...st.peaceOffers].map(([k, until]) => [...pair(k, '>'), Math.ceil(until - st.time)] as [number, number, number]);
    const truces = [...st.truces]
      .filter(([, until]) => until > st.time)
      .map(([k, until]) => [...pair(k, ':'), Math.ceil(until - st.time)] as [number, number, number]);
    const roads = [...st.roads].map((k) => pair(k, ':'));
    return { time: round(st.time, 1), players, regions, blobs, events, wars, offers, truces, roads };
  }

  /** The remaining route of each of `player`'s moving units: [blob id, ...regions]. */
  routesFor(player: number | null): number[][] {
    if (player === null) return [];
    const out: number[][] = [];
    for (const b of this.sim.state.blobs.values()) if (b.owner === player && b.path.length) out.push([b.id, ...b.path]);
    return out;
  }

  /** The builds waiting in each of `player`'s regions: [region, building index...]. */
  buildsFor(player: number | null): number[][] {
    if (player === null) return [];
    const out: number[][] = [];
    this.sim.state.regions.forEach((r, i) => {
      if (r.owner === player && r.buildQueue.length) out.push([i, ...r.buildQueue.flatMap((c) => [BUILDING_INDEX.indexOf(c.kind), c.target])]);
    });
    return out;
  }

  productionFor(player: number | null): ProductionView[] {
    if (player === null) return [];
    const out: ProductionView[] = [];
    this.sim.state.regions.forEach((r, i) => {
      if (r.owner !== player) return;
      for (const building of ['barracks', 'factory'] as const) {
        if (!r[building]) continue;
        const line = r.production[building];
        const head = line.queue[0];
        out.push({
          region: i,
          building,
          queue: [...line.queue],
          progress: head && line.progress >= 0 ? round(line.progress / UNITS[head].buildTime, 2) : -1,
          repeat: line.repeat,
        });
      }
    });
    return out;
  }
}
