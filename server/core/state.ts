// The simulation's state. Plain data, so it can be snapshotted and tested directly.
import type {
  BotDifficulty,
  BuildingKind,
  EconKind,
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
  /** The region it came into its region from (-1: it started there). A unit in a fight may
   * only retreat: back there, or to its own land. */
  from: number;
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
  /** What was paid, refunded in full if cancelled. */
  cost: Resources;
  /** A road's other end; -1 for everything else. */
  target: number;
}

export interface RegionState {
  owner: number;
  fort: number;
  /** City level (0: no city). */
  city: number;
  /** Economic buildings by kind. */
  econ: Record<EconKind, number>;
  barracks: boolean;
  factory: boolean;
  production: Record<ProductionBuilding, ProductionLine>;
  construction: Construction | null;
  /** Builds waiting behind the one under way (paid for already). */
  buildQueue: Construction[];
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
  | { kind: 'war'; a: number; b: number; by: number }
  | { kind: 'peace'; a: number; b: number }
  | { kind: 'peaceOffer'; from: number; to: number }
  | { kind: 'peaceRefused'; from: number; to: number }
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
  /** Diplomacy between players (keys from pairKey). Everyone starts at peace. */
  wars: Set<string>;
  /** Pair → sim time a war began, or the last capture between them. */
  warActivity: Map<string, number>;
  /** Pair → sim time until which neither may declare war (after making peace). */
  truces: Map<string, number>;
  /** "from>to" → sim time the offer of peace expires. */
  peaceOffers: Map<string, number>;
  /** Borders with a road (keys from pairKey on the two regions). */
  roads: Set<string>;
}

/** Key for an unordered pair (of players, or of regions for roads). */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function emptyLine(): ProductionLine {
  return { queue: [], progress: -1, repeat: false };
}

export function emptyRegion(): RegionState {
  return {
    owner: NEUTRAL,
    fort: 0,
    city: 0,
    econ: { farm: 0, mine: 0, well: 0, market: 0 },
    barracks: false,
    factory: false,
    production: { barracks: emptyLine(), factory: emptyLine() },
    construction: null,
    buildQueue: [],
    capture: null,
    supplied: false,
    cutOff: 0,
  };
}
