// Bots (DESIGN.md §8). A bot plays one country through the same orders a person uses. It
// grabs neutral land, keeps its capital guarded, guards its borders, builds forts, and keeps
// its barracks and factories busy. It fights only countries it's at war with: ones that
// attacked it, or (by difficulty) a much weaker neighbour it picks on. It offers peace when
// a war goes badly or stalls. Difficulty sets how often it thinks and how bold it is.
import {
  BOT_DIPLOMACY_SECONDS,
  BOT_MIN_WAR_SECONDS,
  BOT_PEACE_STALEMATE_SECONDS,
  BOT_PEACE_WHEN_WEAKER,
  type BotDifficulty,
  OPPORTUNISM,
  type Opportunism,
  UNITS,
} from '../../shared/rules.ts';
import type { Sim } from './sim.ts';
import { type Blob, NEUTRAL, pairKey } from './state.ts';

interface Style {
  /** Seconds between decisions. */
  think: number;
  /** Attack when our strength is this many times theirs (forts counted). */
  odds: number;
  /** Highest fort level it builds on threatened borders. */
  forts: number;
  tanks: boolean;
  merges: boolean;
  /** Money it keeps back before building. */
  reserve: number;
}

const STYLES: Record<BotDifficulty, Style> = {
  easy: { think: 3, odds: 2.2, forts: 1, tanks: false, merges: false, reserve: 150 },
  normal: { think: 1.5, odds: 1.6, forts: 2, tanks: true, merges: true, reserve: 100 },
  hard: { think: 0.6, odds: 1.25, forts: 3, tanks: true, merges: true, reserve: 60 },
};

export class Bot {
  readonly player: number;
  private readonly style: Style;
  private readonly random: () => number;
  private readonly opportunism: Opportunism | null;
  private next = 0;
  private nextDiplomacy = 0;
  private heading = new Map<number, number>();
  /** Enemy → when this bot first saw the war. */
  private readonly warSince = new Map<number, number>();

  /**
   * `standIn`: playing for a person who dropped. It defends and makes peace, but never
   * starts a war on their behalf.
   */
  constructor(player: number, difficulty: BotDifficulty, random: () => number, standIn = false) {
    this.player = player;
    this.style = STYLES[difficulty];
    this.opportunism = standIn ? null : OPPORTUNISM[difficulty];
    this.random = random;
    this.next = random() * this.style.think;
    this.nextDiplomacy = BOT_DIPLOMACY_SECONDS * (0.5 + random());
  }

  act(sim: Sim): void {
    if (sim.state.time < this.next) return;
    this.next = sim.state.time + this.style.think * (0.8 + 0.4 * this.random());
    const me = sim.player(this.player);
    if (!me?.alive || sim.state.winner !== null) return;
    this.answerOffers(sim);
    if (sim.state.time >= this.nextDiplomacy) {
      this.nextDiplomacy = sim.state.time + BOT_DIPLOMACY_SECONDS * (0.8 + 0.4 * this.random());
      this.diplomacy(sim);
    }
    this.economy(sim);
    this.army(sim);
  }

  // -- diplomacy ----------------------------------------------------------------------------

  private strength(sim: Sim, owner: number): number {
    let s = 0;
    for (const b of sim.state.blobs.values()) if (b.owner === owner) s += b.strength;
    return s;
  }

  private enemies(sim: Sim): number[] {
    return sim.state.players.filter((p) => p.alive && sim.atWar(this.player, p.id)).map((p) => p.id);
  }

  /** Countries whose land touches ours. */
  private neighbours(sim: Sim): Set<number> {
    const out = new Set<number>();
    sim.state.regions.forEach((rs, i) => {
      if (rs.owner !== this.player) return;
      for (const e of sim.world.neighbors(i)) {
        const o = sim.state.regions[e.id].owner;
        if (o !== NEUTRAL && o !== this.player) out.add(o);
      }
    });
    return out;
  }

  /** Offers of peace to us: take them when the war isn't going our way or has stalled. */
  private answerOffers(sim: Sim): void {
    for (const key of [...sim.state.peaceOffers.keys()]) {
      const [from, to] = key.split('>').map(Number);
      if (to !== this.player) continue;
      const mine = this.strength(sim, this.player);
      const theirs = this.strength(sim, from);
      const quiet = sim.state.time - (sim.state.warActivity.get(pairKey(from, to)) ?? 0) >= BOT_PEACE_STALEMATE_SECONDS;
      const fronts = this.enemies(sim).length;
      if (mine < theirs * 1.2 || quiet || fronts > 1) sim.offerPeace(this.player, from);
      else sim.refusePeace(this.player, from);
    }
  }

  private diplomacy(sim: Sim): void {
    const now = sim.state.time;
    const mine = this.strength(sim, this.player);
    const enemies = this.enemies(sim);
    for (const e of [...this.warSince.keys()]) if (!enemies.includes(e)) this.warSince.delete(e);
    // Wars going badly, or stuck: offer peace.
    for (const e of enemies) {
      if (!this.warSince.has(e)) this.warSince.set(e, now);
      if (now - (this.warSince.get(e) as number) < BOT_MIN_WAR_SECONDS) continue;
      if (sim.state.peaceOffers.has(`${this.player}>${e}`)) continue;
      const losing = mine < this.strength(sim, e) * BOT_PEACE_WHEN_WEAKER;
      const stalled = now - (sim.state.warActivity.get(pairKey(this.player, e)) ?? now) >= BOT_PEACE_STALEMATE_SECONDS;
      if (losing || stalled) sim.offerPeace(this.player, e);
    }
    // Picking on a much weaker neighbour (never on easy, rarely on normal).
    const opp = this.opportunism;
    if (!opp || now < opp.after || enemies.length >= opp.maxWars) return;
    const prey = [...this.neighbours(sim)]
      .filter((p) => !sim.atWar(this.player, p) && !sim.inTruce(this.player, p))
      .map((p) => ({ p, s: this.strength(sim, p) }))
      .filter((x) => mine >= x.s * opp.ratio)
      .sort((a, b) => a.s - b.s)[0];
    if (prey && this.random() < opp.chance) sim.declareWar(this.player, prey.p);
  }

  // -- building and production ------------------------------------------------------------

  private economy(sim: Sim): void {
    const me = sim.state.players[this.player];
    const regions = sim.state.regions;
    const mine = regions.flatMap((rs, i) => (rs.owner === this.player ? [i] : []));

    for (const r of mine) {
      const rs = regions[r];
      if (rs.barracks && rs.production.barracks.queue.length === 0) sim.produce(this.player, r, 'barracks');
      if (this.style.tanks && rs.factory && rs.production.factory.queue.length === 0) sim.produce(this.player, r, 'factory');
    }

    // Several things at once when rich; one at a time otherwise.
    const building = mine.filter((r) => regions[r].construction).length;
    const slots = 1 + Math.floor(me.resources.money / (this.style.reserve * 4));
    if (me.resources.money < this.style.reserve || building >= slots) return;

    // Forts where enemies stand next door.
    const threatened = mine
      .map((r) => ({ r, threat: this.threat(sim, r) }))
      .filter((x) => x.threat > 0 && regions[x.r].fort < this.style.forts && regions[x.r].supplied && !regions[x.r].construction)
      .sort((a, b) => b.threat - a.threat);
    if (threatened.length && sim.build(this.player, threatened[0].r, 'fort') === null) return;

    // In peacetime too: dig in on borders where a neighbour's army stands close.
    if (me.resources.money > this.style.reserve * 2) {
      const border = mine
        .filter((r) => regions[r].fort < Math.max(1, this.style.forts - 1) && regions[r].supplied && !regions[r].construction)
        .map((r) => ({ r, foreign: this.foreignNear(sim, r) }))
        .filter((x) => x.foreign > 0)
        .sort((a, b) => b.foreign - a.foreign)[0];
      if (border && sim.build(this.player, border.r, 'fort') === null) return;
    }

    // Factories once there's steel to use.
    const factories = mine.filter((r) => regions[r].factory).length;
    if (this.style.tanks && factories < 1 + Math.floor(mine.length / 30) && me.resources.steel >= 40) {
      const site = mine.find((r) => {
        const t = sim.world.regions[r].traits;
        return regions[r].supplied && !regions[r].factory && !regions[r].construction && (t.includes('industry') || t.includes('city'));
      });
      if (site !== undefined && sim.build(this.player, site, 'factory') === null) return;
    }

    // More barracks as the country grows, close to the front.
    const barracks = mine.filter((r) => regions[r].barracks).length;
    if (barracks < 1 + Math.floor(mine.length / 12)) {
      const site = mine
        .filter((r) => regions[r].supplied && !regions[r].barracks && !regions[r].construction)
        .sort((a, b) => this.frontDistance(sim, a) - this.frontDistance(sim, b))[0];
      if (site !== undefined && sim.build(this.player, site, 'barracks') === null) return;
    }

    // Infrastructure where the army is short of supply.
    const hungry = [...sim.state.blobs.values()].find(
      (b) => b.owner === this.player && b.supply < 0.8 && b.supply > 0 && regions[b.region].owner === this.player,
    );
    if (hungry && regions[hungry.region].infra < 3 && !regions[hungry.region].construction) {
      sim.build(this.player, hungry.region, 'infra');
    }
  }

  // -- the army -----------------------------------------------------------------------------

  private army(sim: Sim): void {
    const me = sim.state.players[this.player];
    const blobs = [...sim.state.blobs.values()].filter((b) => b.owner === this.player);
    if (this.style.merges) this.mergeSmall(sim, blobs);

    // Units stuck at the edge of a full region count as free again.
    const busy = (b: Blob) => (b.path.length > 0 && b.progress < 1) || (b.progress === 0 && sim.contested(b.region));
    let idle = blobs.filter((b) => sim.state.blobs.has(b.id) && !busy(b));
    // Where our units are or are heading, so we don't send more than fit.
    this.heading = new Map();
    for (const b of blobs) {
      const at = b.path.length ? b.path[b.path.length - 1] : b.region;
      this.heading.set(at, (this.heading.get(at) ?? 0) + 1);
    }
    const targeted = new Set(blobs.filter((b) => b.path.length).map((b) => b.path[b.path.length - 1]));

    // The capital always keeps a guard, two when threatened; the rest leave room for new units.
    const guards = this.threat(sim, me.capital) > 0 ? 2 : 1;
    const atCapital = idle.filter((b) => b.region === me.capital).sort((a, b) => b.strength - a.strength);
    const guard = new Set(atCapital.slice(0, guards));
    idle = idle.filter((b) => !guard.has(b));
    if (atCapital.length < guards) {
      const helper = [...idle].sort((a, b) => this.hops(sim, a.region, me.capital) - this.hops(sim, b.region, me.capital))[0];
      if (helper) {
        sim.move(this.player, [helper.id], me.capital);
        idle = idle.filter((b) => b !== helper);
      }
    }

    // Attacks: every idle unit next to a target joins in, if together they clearly win. A
    // much stronger country presses on with worse odds: it can afford the next wave.
    const strength = (owner: number) => {
      let s = 0;
      for (const b of sim.state.blobs.values()) if (b.owner === owner) s += b.strength;
      return s;
    };
    const mine = strength(this.player);
    const sent = new Set<Blob>();
    for (const t of this.targets(sim)) {
      const near = new Set(sim.world.neighbors(t).map((e) => e.id));
      const group = idle.filter((b) => !sent.has(b) && (near.has(b.region) || b.region === t));
      if (!group.length) continue;
      const terrain = sim.world.regions[t].terrain;
      const ours = group.reduce((s, b) => s + b.strength * UNITS[b.type].attack * UNITS[b.type].terrainAttack[terrain], 0);
      const odds = ours / this.defence(sim, t);
      const owner = sim.state.regions[t].owner;
      const capital = sim.state.players.some((p) => p.alive && p.capital === t && p.id !== this.player);
      const dominance = owner === NEUTRAL ? 1 : mine / Math.max(1, strength(owner));
      let need = this.style.odds;
      if (capital) need *= 0.7;
      if (dominance > 5) need *= 0.15;
      else if (dominance > 2) need *= 0.6;
      if (odds < need) continue;
      const room = sim.stackCap(t) - (this.heading.get(t) ?? 0);
      if (room <= 0) continue;
      const go = group.sort((a, b) => b.strength - a.strength).slice(0, room);
      sim.move(this.player, go.map((b) => b.id), t);
      for (const b of go) sent.add(b);
      this.heading.set(t, (this.heading.get(t) ?? 0) + go.length);
      targeted.add(t);
    }
    idle = idle.filter((b) => !sent.has(b));

    // Everyone else: grab neutral land, or else gather at the front.
    for (const b of idle) {
      if (sim.state.regions[b.region].owner === this.player && this.threat(sim, b.region) > 0 && b.region !== me.capital) {
        continue; // hold the line
      }
      const target =
        this.expandTarget(sim, b, targeted) ?? this.stagingArea(sim, b) ?? this.nearestEnemy(sim, b) ?? this.borderPost(sim, b);
      if (target === null || target === b.region) continue;
      targeted.add(target);
      sim.move(this.player, [b.id], target);
      this.heading.set(target, (this.heading.get(target) ?? 0) + 1);
    }
  }

  /** Regions worth attacking: enemy land and enemy units, next to where we stand or own. */
  private targets(sim: Sim): number[] {
    const out = new Set<number>();
    const ours = new Set<number>();
    sim.state.regions.forEach((rs, i) => {
      if (rs.owner === this.player) ours.add(i);
    });
    for (const b of sim.state.blobs.values()) if (b.owner === this.player) ours.add(b.region);
    for (const r of ours) {
      for (const e of [{ id: r }, ...sim.world.neighbors(r)]) {
        const rs = sim.state.regions[e.id];
        if (sim.atWar(this.player, rs.owner) || sim.hostileIn(e.id, this.player)) out.add(e.id);
      }
    }
    // Weakest first.
    return [...out].sort((a, b) => this.defence(sim, a) - this.defence(sim, b));
  }

  /** What it would take to win a region: enemy strength there, forts and digging in counted. */
  private defence(sim: Sim, region: number): number {
    const rs = sim.state.regions[region];
    let d = 0.5;
    for (const x of sim.blobsIn(region)) {
      if (x.owner === this.player) continue;
      const home = x.owner === rs.owner ? 1 + 0.5 * rs.fort + 0.5 * x.entrench : 1;
      d += x.strength * UNITS[x.type].defense * home;
    }
    return d;
  }

  /** An own region at the front (next to enemy land), the nearest one. */
  private stagingArea(sim: Sim, b: Blob): number | null {
    const dist = this.bfs(sim, b.region);
    let best: number | null = null;
    let bestD = Infinity;
    sim.state.regions.forEach((rs, i) => {
      if (rs.owner !== this.player || dist[i] < 0 || dist[i] >= bestD) return;
      if ((this.heading.get(i) ?? 0) >= sim.stackCap(i)) return;
      const front = sim.world.neighbors(i).some((e) => sim.atWar(this.player, sim.state.regions[e.id].owner));
      if (front) {
        bestD = dist[i];
        best = i;
      }
    });
    return best;
  }

  /** The nearest enemy region with room for one more of ours: with no front to stage at,
   * march on them (spread out, so the roads don't jam). */
  private nearestEnemy(sim: Sim, b: Blob): number | null {
    const dist = this.bfs(sim, b.region);
    let best: number | null = null;
    let bestD = Infinity;
    sim.state.regions.forEach((rs, i) => {
      if (dist[i] < 0 || dist[i] >= bestD) return;
      if ((this.heading.get(i) ?? 0) >= sim.stackCap(i)) return;
      if (sim.atWar(this.player, rs.owner) || sim.hostileIn(i, this.player)) {
        bestD = dist[i];
        best = i;
      }
    });
    return best;
  }

  /** In peacetime: an own region bordering another country, with room (stronger ones first). */
  private borderPost(sim: Sim, b: Blob): number | null {
    if (sim.state.regions[b.region].owner === this.player && this.bordersCountry(sim, b.region)) return null; // already on guard
    const dist = this.bfs(sim, b.region);
    let best: number | null = null;
    let bestScore = Infinity;
    sim.state.regions.forEach((rs, i) => {
      if (rs.owner !== this.player || dist[i] < 0 || !this.bordersCountry(sim, i)) return;
      if ((this.heading.get(i) ?? 0) >= Math.max(1, sim.stackCap(i) - 1)) return;
      const score = dist[i] + (this.heading.get(i) ?? 0) * 3;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  private bordersCountry(sim: Sim, region: number): boolean {
    return sim.world.neighbors(region).some((e) => {
      const o = sim.state.regions[e.id].owner;
      return o !== NEUTRAL && o !== this.player;
    });
  }

  /** Nearest neutral region nobody of ours is already heading for. */
  private expandTarget(sim: Sim, b: Blob, targeted: Set<number>): number | null {
    const dist = this.bfs(sim, b.region);
    let best: number | null = null;
    let bestScore = Infinity;
    sim.state.regions.forEach((rs, i) => {
      if (rs.owner !== NEUTRAL || targeted.has(i) || dist[i] < 0 || sim.hostileIn(i, this.player)) return;
      const traits = sim.world.regions[i].traits.length;
      const score = dist[i] - 0.3 * traits + this.random() * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  private mergeSmall(sim: Sim, blobs: Blob[]): void {
    const groups = new Map<string, Blob[]>();
    for (const b of blobs) {
      if (b.progress > 0 || b.path.length) continue;
      const k = `${b.region}:${b.type}`;
      groups.set(k, [...(groups.get(k) ?? []), b]);
    }
    for (const list of groups.values()) {
      const small = list.filter((b) => b.size < UNITS[b.type].maxSize).sort((a, b) => b.size - a.size);
      if (small.length >= 2) sim.merge(this.player, small.map((b) => b.id));
    }
  }

  /** Other countries' units standing next to a region (at war or not). */
  private foreignNear(sim: Sim, region: number): number {
    let t = 0;
    for (const e of sim.world.neighbors(region)) {
      for (const b of sim.blobsIn(e.id)) if (b.owner !== this.player) t += b.strength;
    }
    return t;
  }

  /** Enemy strength standing next to (or in) a region. */
  private threat(sim: Sim, region: number): number {
    let t = 0;
    for (const r of [region, ...sim.world.neighbors(region).map((n) => n.id)]) {
      for (const b of sim.blobsIn(r)) if (sim.atWar(this.player, b.owner)) t += b.strength;
    }
    return t;
  }

  private frontDistance(sim: Sim, region: number): number {
    const dist = this.bfs(sim, region);
    let best = Infinity;
    sim.state.regions.forEach((rs, i) => {
      if (rs.owner !== this.player && rs.owner !== NEUTRAL && dist[i] >= 0) best = Math.min(best, dist[i] - (sim.atWar(this.player, rs.owner) ? 0.5 : 0));
    });
    return best;
  }

  private hops(sim: Sim, from: number, to: number): number {
    const d = this.bfs(sim, from)[to];
    return d < 0 ? Infinity : d;
  }

  /** Hops from a region, not through land of countries we're at peace with (it's closed). */
  private bfs(sim: Sim, from: number): number[] {
    const dist = new Array<number>(sim.world.regions.length).fill(-1);
    dist[from] = 0;
    const queue = [from];
    const closed = (r: number) => {
      const o = sim.state.regions[r].owner;
      return o !== NEUTRAL && o !== this.player && !sim.atWar(this.player, o);
    };
    for (let q = 0; q < queue.length; q++) {
      for (const e of sim.world.neighbors(queue[q])) {
        if (dist[e.id] < 0 && !closed(e.id)) {
          dist[e.id] = dist[queue[q]] + 1;
          queue.push(e.id);
        }
      }
    }
    return dist;
  }
}
