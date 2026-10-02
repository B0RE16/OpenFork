// Small hand-made maps for the simulation tests.
import type { Country, GameMap, Region, RegionSize, Terrain, Trait } from '../shared/map.ts';
import type { BotDifficulty } from '../shared/rules.ts';
import { type PlayerSetup, Sim } from '../server/core/sim.ts';
import { World } from '../server/core/world.ts';

export interface RegionSpec {
  terrain?: Terrain;
  traits?: Trait[];
  size?: RegionSize;
  country?: string;
}

/**
 * A map from a list of regions and edges ([a, b] or [a, b, {river, dist}]). Every edge is 10
 * pixels long unless given, so one hop is exactly CROSS_SECONDS for infantry on plains.
 */
export function makeMap(
  specs: RegionSpec[],
  edges: Array<[number, number] | [number, number, { river?: boolean; dist?: number }]>,
  countries: Array<{ id: string; capital: number; playable?: boolean }> = [],
): GameMap {
  const regions: Region[] = specs.map((s, id) => ({
    id,
    name: `R${id}`,
    country: s.country ?? 'XX',
    terrain: s.terrain ?? 'plains',
    traits: s.traits ?? [],
    size: s.size ?? 'medium',
    area: 100,
    x: id * 10,
    y: 0,
    neighbors: [],
  }));
  for (const [a, b, opt] of edges) {
    const river = opt?.river ?? false;
    const dist = opt?.dist ?? 10;
    regions[a].neighbors.push({ id: b, border: 10, river, dist });
    regions[b].neighbors.push({ id: a, border: 10, river, dist });
  }
  const cs: Country[] = countries.map((c) => ({ id: c.id, name: c.id, capital: c.capital, playable: c.playable ?? true }));
  return { id: 'test', name: 'Test', width: 1, height: 1, kmPerPx: 3, regions, countries: cs, grid: '', attribution: '' };
}

/** A chain 0 - 1 - 2 - ... - (n-1). */
export function chain(n: number): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  for (let i = 0; i + 1 < n; i++) edges.push([i, i + 1]);
  return edges;
}

export function players(...countries: string[]): PlayerSetup[] {
  return countries.map((country, i) => ({
    name: `P${i}`,
    country,
    color: '#fff',
    control: 'human' as const,
    difficulty: 'normal' as BotDifficulty,
  }));
}

export function sim(map: GameMap, countries: string[]): Sim {
  return new Sim(new World(map), players(...countries));
}

/** Runs the simulation for `seconds` in TICK_MS steps. */
export function run(s: Sim, seconds: number): void {
  const steps = Math.round(seconds * 10);
  for (let i = 0; i < steps; i++) s.tick(0.1);
}

/** Removes every blob, so a test can place exactly what it needs. */
export function clearBlobs(s: Sim): void {
  s.state.blobs.clear();
}

export function place(s: Sim, owner: number, type: 'infantry' | 'tank', region: number, strength?: number) {
  const b = s.spawn(owner, type, region);
  if (strength !== undefined) {
    b.size = Math.max(b.size, strength);
    b.strength = strength;
  }
  return b;
}

/** Plenty of everything, so tests aren't about money unless they want to be. */
export function rich(s: Sim, player = 0): void {
  Object.assign(s.state.players[player].resources, { money: 1e6, manpower: 1e6, steel: 1e6, oil: 1e6 });
}
