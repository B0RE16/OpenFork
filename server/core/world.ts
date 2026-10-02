// The map as the simulation sees it: regions, neighbours and the per-region numbers from
// the rules (stack caps, supply capacity, capture times).
import type { GameMap, Neighbor, Region } from '../../shared/map.ts';
import { captureSeconds, stackCap, supplyCapacity } from '../../shared/rules.ts';

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

  stackCap(id: number, city: number, fort: number): number {
    return stackCap(this.regions[id], city, fort);
  }

  supplyCapacity(id: number, city: number): number {
    return supplyCapacity(this.regions[id], city);
  }

  captureSeconds(id: number, fort: number, training: number): number {
    return captureSeconds(this.regions[id], fort, training);
  }
}
