// Every WebSocket message between the browser and the server (JSON, one object per frame).
import type {
  BotDifficulty,
  BuildingKind,
  ProductionBuilding,
  StartingResources,
  UnitType,
} from './rules.ts';

// -- client → server --------------------------------------------------------------------------

export type Order =
  | { o: 'move'; blobs: number[]; to: number }
  | { o: 'stop'; blobs: number[] }
  | { o: 'split'; blob: number }
  | { o: 'merge'; blobs: number[] }
  | { o: 'build'; region: number; kind: BuildingKind }
  | { o: 'produce'; region: number; building: ProductionBuilding }
  | { o: 'repeat'; region: number; building: ProductionBuilding; on: boolean }
  | { o: 'cancel'; region: number; building: ProductionBuilding }
  /** Cancel a build (0: the one under way, 1+: waiting) and later ones of the same kind. */
  | { o: 'unbuild'; region: number; index: number }
  /** Declare war on a country. */
  | { o: 'war'; player: number }
  /** Offer peace to a country, or accept its offer. */
  | { o: 'peace'; player: number }
  /** Turn down a country's offer of peace. */
  | { o: 'refuse'; player: number };

export interface LobbySettings {
  map: string;
  /** Countries in the match, humans and bots (MIN_PLAYERS..MAX_PLAYERS). */
  size: number;
  starting: StartingResources;
  /** 'free': everyone picks a country; 'random': countries are dealt out at the start. */
  pick: 'free' | 'random';
  difficulty: BotDifficulty;
}

export type ClientMessage =
  | { t: 'hello'; name: string; token?: string }
  | { t: 'lobby.create' }
  | { t: 'lobby.join'; code: string }
  | { t: 'lobby.leave' }
  | { t: 'lobby.settings'; settings: Partial<LobbySettings> }
  | { t: 'lobby.pick'; country: string | null }
  | { t: 'lobby.start' }
  | { t: 'order'; order: Order };

// -- server → client --------------------------------------------------------------------------

export interface LobbyMember {
  id: string;
  name: string;
  country: string | null;
  connected: boolean;
}

export interface LobbyView {
  code: string;
  host: string;
  members: LobbyMember[];
  settings: LobbySettings;
  /** A game is running (joining now means watching). */
  playing: boolean;
}

export interface GamePlayer {
  id: number;
  name: string;
  country: string;
  color: string;
  /** Played by a person (even if a bot stands in while they're away). */
  human: boolean;
}

/** One blob: [id, owner, type (0 infantry, 1 tank), strength, size, training, region,
 * next region or -1, progress 0..1, entrench 0..1, supply 0..1, flags (1 hold, 2 crossed river)]. */
export type BlobRow = [number, number, number, number, number, number, number, number, number, number, number, number];

/** One region: [owner, fort, infra, flags (1 barracks, 2 factory, 4 supplied), capture by or -1,
 * capture progress 0..1, construction kind index or -1, construction progress 0..1]. */
export type RegionRow = [number, number, number, number, number, number, number, number];

export interface PlayerRow {
  alive: boolean;
  /** money, manpower, steel, oil */
  res: [number, number, number, number];
  income: [number, number, number, number];
  upkeep: number;
  broke: boolean;
  bot: boolean;
}

/** Production queues, only for the receiving player's own regions. */
export interface ProductionView {
  region: number;
  building: ProductionBuilding;
  queue: UnitType[];
  /** 0..1 on the head of the queue, or -1 while waiting to be paid for. */
  progress: number;
  repeat: boolean;
}

export type GameEvent =
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

export interface Snapshot {
  time: number;
  players: PlayerRow[];
  regions: RegionRow[];
  blobs: BlobRow[];
  production: ProductionView[];
  /** The receiving player's moving units: [blob id, ...remaining regions]. */
  routes: number[][];
  /** The receiving player's waiting builds: [region, building index...]. */
  builds: number[][];
  events: GameEvent[];
  /** Pairs of countries at war. */
  wars: Array<[number, number]>;
  /** Standing offers of peace: [from, to, seconds left]. */
  offers: Array<[number, number, number]>;
  /** Truces: [a, b, seconds left]. */
  truces: Array<[number, number, number]>;
}

export type ServerMessage =
  | { t: 'welcome'; id: string; token: string; name: string }
  | { t: 'error'; message: string }
  | { t: 'lobby'; lobby: LobbyView | null }
  | { t: 'game.start'; map: string; you: number | null; players: GamePlayer[] }
  | { t: 'snap'; snap: Snapshot }
  | { t: 'game.over'; winner: number | null };

export const BUILDING_INDEX: readonly BuildingKind[] = ['barracks', 'factory', 'fort', 'infra'];
export const UNIT_INDEX: readonly UnitType[] = ['infantry', 'tank'];
