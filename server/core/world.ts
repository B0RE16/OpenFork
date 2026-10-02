// The map as the simulation sees it: regions, neighbours and the per-region numbers that
// follow from the rules (stack caps, supply capacity, capture times).
import type { GameMap, Neighbor, Region } from '../../shared/map.ts';
import {
  CAPTURE_FORT,
  CAPTURE_SECONDS,
  CAPTURE_SIZE,
  CAPTURE_TERRAIN,
  CAPTURE_TRAINING,
  MAX_TRAINING,
  STACK_MIN,
  STACK_SIZE,
  STACK_TERRAIN,
  SUPPLY_BASE,
  SUPPLY_CITY,
  SUPPLY_PER_INFRA,
  SUPPLY_TERRAIN,
} from '../../shared/rules.ts';

export class World {
  readonly map: GameMap;
  readonly regions: Region[];
  /** Typical distance between neighbouring label points; one CROSS_SECONDS hop. */
  readonly hop: number;
  private readonly edges: Map<number, Neighbor>[];

  constructor(map: GameMap) {
    this.map = map;
    this.regions = map.regions;
    this.edges = map.regions.map((r) => new Map(r.neighbors.map((n) => [n.id, n])));
    const d = map.regions.flatMap((r) => r.neighbors.map((n) => n.dist)).sort((a, b) => a - b);
    this.hop = d.length ? d[Math.floor(d.length / 2)] : 1;
  }

  edge(from: number, to: number): Neighbor | undefined {
    return this.edges[from]?.get(to);
  }

  neighbors(id: number): Neighbor[] {
    return this.regions[id].neighbors;
  }

  stackCap(id: number, infra: number): number {
    const r = this.regions[id];
    return Math.max(STACK_MIN, STACK_SIZE[r.size] + STACK_TERRAIN[r.terrain]) + infra;
  }

  supplyCapacity(id: number, infra: number): number {
    const r = this.regions[id];
    const base = (SUPPLY_BASE + SUPPLY_PER_INFRA * infra) * SUPPLY_TERRAIN[r.terrain];
    return r.traits.includes('city') ? base * SUPPLY_CITY : base;
  }

  /** Seconds to capture region `id` with blobs of the given (best) training. */
  captureSeconds(id: number, fort: number, training: number): number {
    const r = this.regions[id];
    const base = CAPTURE_SECONDS * CAPTURE_SIZE[r.size] * CAPTURE_TERRAIN[r.terrain] * (1 + CAPTURE_FORT * fort);
    return base / (1 + (CAPTURE_TRAINING * training) / MAX_TRAINING);
  }
}
