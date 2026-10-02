// The simulation's state. Plain data, so it can be snapshotted and tested directly.
import type {
  BotDifficulty,
  BuildingKind,
  ProductionBuilding,
  Resources,
  UnitType,
} from '../../shared/rules.ts';

export const NEUTRAL = -1;

export interface Blob {
  id: number;
  owner: number;
  type: UnitType;
  /** Current strength; at most `size`. */
  strength: number;
  /** Establishment: what refills aim for and upkeep is paid on. */
  size: number;
  training: number;
  /** Region it is in, or is leaving while on the move. */
  region: number;
  /** Regions still to go to, next first. Empty when not moving. */
  path: number[];
  /** 0..1 along the edge from `region` to `path[0]`; 0 while waiting in a region. */
  progress: number;
  /** 0..1, grows while it holds still in its own region. */
  entrench: number;
  /** Must win and take its region before going on along its path. */
  hold: boolean;
  /** Came into its region across a river (the defender there gets the river bonus). */
  crossedRiver: boolean;
  /** 0..1, set by the supply pass. */
  supply: number;
}

export interface ProductionLine {
  queue: UnitType[];
  /** Seconds done on the head of the queue; -1 until it is paid for. */
  progress: number;
  repeat: boolean;
}

export interface Construction {
  kind: BuildingKind;
  level: number;
  progress: number;
  seconds: number;
}

export interface RegionState {
  owner: number;
  fort: number;
  infra: number;
  barracks: boolean;
  factory: boolean;
  production: Record<ProductionBuilding, ProductionLine>;
  construction: Construction | null;
  capture: { by: number; progress: number } | null;
  /** In supply for its owner (set by the supply pass). */
  supplied: boolean;
  /** Seconds it has been cut off with none of its owner's blobs in it. */
  cutOff: number;
}

export interface Player {
  id: number;
  name: string;
  country: string;
  color: string;
  /** Who is playing it right now. A human's country is played by a bot while they're away. */
  control: 'human' | 'bot';
  /** Bot strength when control is 'bot'. */
  difficulty: BotDifficulty;
  alive: boolean;
  capital: number;
  resources: Resources;
  broke: boolean;
  /** Per-second rates, for the HUD. */
  income: Resources;
  upkeep: number;
}

export type SimEvent =
  | { kind: 'battle'; region: number; sides: number[] }
  | { kind: 'captured'; region: number; by: number; from: number }
  | { kind: 'built'; region: number; owner: number; building: BuildingKind; level: number }
  | { kind: 'produced'; region: number; owner: number; type: UnitType }
  | { kind: 'eliminated'; player: number; by: number }
  | { kind: 'won'; player: number };

export interface SimState {
  /** Seconds since the start. */
  time: number;
  players: Player[];
  regions: RegionState[];
  blobs: Map<number, Blob>;
  nextBlobId: number;
  winner: number | null;
}

export function emptyLine(): ProductionLine {
  return { queue: [], progress: -1, repeat: false };
}

export function emptyRegion(): RegionState {
  return {
    owner: NEUTRAL,
    fort: 0,
    infra: 0,
    barracks: false,
    factory: false,
    production: { barracks: emptyLine(), factory: emptyLine() },
    construction: null,
    capture: null,
    supplied: false,
    cutOff: 0,
  };
}
