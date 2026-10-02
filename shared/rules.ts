// Every gameplay number lives here (DESIGN.md has the rules in words). Rates are per second
// unless they say otherwise; the server multiplies by the tick length.
import type { Region, RegionSize, Terrain, Trait } from './map.ts';

export const TICK_MS = 100;
/** How often clients get a full state snapshot. */
export const SNAPSHOT_EVERY_TICKS = 2;

// -- units ------------------------------------------------------------------------------------

export type UnitType = 'infantry' | 'tank';
export const UNIT_TYPES: readonly UnitType[] = ['infantry', 'tank'];

export interface Resources {
  money: number;
  manpower: number;
  steel: number;
  oil: number;
}
export const RESOURCES: readonly (keyof Resources)[] = ['money', 'manpower', 'steel', 'oil'];

export interface UnitStats {
  /** Most strength one blob can have; merging stops here. */
  maxSize: number;
  /** Size of a freshly produced blob. */
  batch: number;
  /** Movement speed multiplier (1 = infantry). */
  speed: number;
  attack: number;
  defense: number;
  /** Attack multiplier by the terrain of the region the battle is in. */
  terrainAttack: Record<Terrain, number>;
  /** Cost of one batch, paid when production starts. */
  cost: Resources;
  /** Seconds to produce one batch. */
  buildTime: number;
  /** Money per second per point of size. */
  upkeep: number;
  /** What one point of strength costs to refill. */
  refillCost: Resources;
  /** How much supply one point of size needs. */
  supplyNeed: number;
  /** Building that produces it. */
  producedAt: ProductionBuilding;
}

export const UNITS: Record<UnitType, UnitStats> = {
  infantry: {
    maxSize: 20,
    batch: 10,
    speed: 1,
    attack: 1,
    defense: 1.2,
    terrainAttack: { plains: 1, forest: 1, hills: 1, mountains: 1 },
    cost: { money: 50, manpower: 40, steel: 0, oil: 0 },
    buildTime: 20,
    upkeep: 0.02,
    refillCost: { money: 1, manpower: 2, steel: 0, oil: 0 },
    supplyNeed: 1,
    producedAt: 'barracks',
  },
  tank: {
    maxSize: 10,
    batch: 5,
    speed: 1.8,
    attack: 2.5,
    defense: 1.5,
    terrainAttack: { plains: 1.2, forest: 0.6, hills: 0.7, mountains: 0.4 },
    cost: { money: 90, manpower: 12, steel: 38, oil: 18 },
    buildTime: 30,
    upkeep: 0.06,
    refillCost: { money: 3, manpower: 1, steel: 3, oil: 1 },
    supplyNeed: 2,
    producedAt: 'factory',
  },
};

// -- movement ---------------------------------------------------------------------------------

/** Seconds for a speed-1 blob to go between two regions a typical distance apart, on plains. */
export const CROSS_SECONDS = 5.5;
export const TERRAIN_MOVE: Record<Terrain, number> = { plains: 1, forest: 0.7, hills: 0.6, mountains: 0.4 };
/** Speed into enemy-owned land (zone of control), and how much each fort level there takes off. */
export const ENEMY_LAND_MOVE = 0.7;
export const FORT_MOVE_PENALTY = 0.1;
/** Speed bonus per infrastructure level when moving into your own region. */
export const INFRA_MOVE_BONUS = 0.15;
/** Leaving a battle costs this share of strength and this much training. */
export const RETREAT_STRENGTH_LOSS = 0.15;
export const RETREAT_TRAINING_LOSS = 10;

// -- capturing --------------------------------------------------------------------------------

/** Seconds to capture an empty medium plains region with untrained blobs, before modifiers. */
export const CAPTURE_SECONDS = 6.5;
export const CAPTURE_SIZE: Record<RegionSize, number> = { small: 0.7, medium: 1, large: 1.4 };
export const CAPTURE_TERRAIN: Record<Terrain, number> = { plains: 1, forest: 1.2, hills: 1.3, mountains: 1.6 };
/** Each fort level adds this share to capture time. */
export const CAPTURE_FORT = 0.5;
/** At 100 training, capture runs this much faster (1.5 = 50% faster). */
export const CAPTURE_TRAINING = 0.5;
/** Capture progress lost per second while nobody is capturing. */
export const CAPTURE_DECAY = 0.2;

// -- battles ----------------------------------------------------------------------------------

/** Strength removed per second per point of attack power. */
export const DAMAGE_RATE = 0.05;
export const FORT_BONUS = 0.5; // per fort level
export const ENTRENCH_BONUS = 0.5; // when fully dug in
export const ENTRENCH_SECONDS = 60;
export const RIVER_BONUS = 0.25;
/** At 100 training: damage dealt ×(1 + this), damage taken ×(1 - this). */
export const TRAINING_DAMAGE = 0.5;
export const TRAINING_PROTECTION = 0.33;
/** Training gained per second in battle (veterancy). */
export const VETERANCY_RATE = 0.5;
/** A blob with less strength than this is destroyed. */
export const MIN_STRENGTH = 0.05;

// -- training ---------------------------------------------------------------------------------

export const MAX_TRAINING = 100;
/** Idle, supplied blobs drill up to this; only combat goes higher. */
export const DRILL_CAP = 50;
export const DRILL_RATE = 1 / 6;
export const MERGE_PENALTY = 10;

// -- supply -----------------------------------------------------------------------------------

/** A region is supplied if a hub (capital or owned city) is at most this many owned regions away. */
export const SUPPLY_RANGE = 6;
/** Supply capacity of a region, by terrain, and what infrastructure and cities add. */
export const SUPPLY_BASE = 30;
export const SUPPLY_TERRAIN: Record<Terrain, number> = { plains: 1, forest: 0.9, hills: 0.8, mountains: 0.6 };
export const SUPPLY_PER_INFRA = 20;
export const SUPPLY_CITY = 1.5;
/** Out of supply: share of size lost per second, and training lost per second. */
export const OUT_OF_SUPPLY_LOSS = 0.005;
export const OUT_OF_SUPPLY_TRAINING = 0.2;
/** Strength refilled per second while in supply (paid with UnitStats.refillCost). */
export const REFILL_RATE = 0.15;
/** A cut-off region with none of your blobs turns neutral after this many seconds. */
export const CUT_OFF_SECONDS = 5;
/** Broke (upkeep beyond money): share of size lost per second, and training lost per second. */
export const BROKE_LOSS = 0.003;
export const BROKE_TRAINING = 0.2;

// -- stacking ---------------------------------------------------------------------------------

/** Tokens one player may have standing in a region, by size and terrain, plus one per
 * infrastructure level. Units only passing through their own land don't count. */
export const STACK_SIZE: Record<RegionSize, number> = { small: 2, medium: 3, large: 4 };
export const STACK_TERRAIN: Record<Terrain, number> = { plains: 0, forest: 0, hills: 0, mountains: -1 };
export const STACK_MIN = 2;

// -- economy ----------------------------------------------------------------------------------

export const BASE_YIELD: Resources = { money: 0.25, manpower: 0.15, steel: 0, oil: 0 };
export const TRAIT_YIELD: Record<Trait, Partial<Resources>> = {
  city: { money: 1.5, manpower: 0.3 },
  industry: { steel: 1, money: 0.3 },
  oil: { oil: 0.8 },
  farmland: { manpower: 0.35 },
};

export type StartingResources = 'low' | 'normal' | 'high';
export const STARTING: Resources = { money: 200, manpower: 120, steel: 40, oil: 20 };
export const STARTING_MULTIPLIER: Record<StartingResources, number> = { low: 0.5, normal: 1, high: 2 };

// -- buildings --------------------------------------------------------------------------------

export type ProductionBuilding = 'barracks' | 'factory';
export type BuildingKind = ProductionBuilding | 'fort' | 'infra';
export const BUILDING_KINDS: readonly BuildingKind[] = ['barracks', 'factory', 'fort', 'infra'];
export const MAX_LEVEL: Record<BuildingKind, number> = { barracks: 1, factory: 1, fort: 3, infra: 3 };
/** Builds a region can have waiting behind the one under way. */
export const BUILD_QUEUE = 3;

/** Cost and build time of reaching `level` (1-based). */
export function buildCost(kind: BuildingKind, level: number): { cost: Resources; seconds: number } {
  switch (kind) {
    case 'barracks':
      return { cost: { money: 80, manpower: 0, steel: 0, oil: 0 }, seconds: 20 };
    case 'factory':
      return { cost: { money: 150, manpower: 0, steel: 40, oil: 0 }, seconds: 40 };
    case 'fort':
      return { cost: { money: 60 * level, manpower: 0, steel: 10 * level, oil: 0 }, seconds: 20 * level };
    case 'infra':
      return { cost: { money: 50 * level, manpower: 0, steel: 15 * level, oil: 0 }, seconds: 25 * level };
  }
}

/** Where a building may go (region traits limit some). */
export function canBuildOn(kind: BuildingKind, traits: readonly Trait[]): boolean {
  if (kind === 'factory') return traits.includes('industry') || traits.includes('city');
  return true;
}

// -- the start --------------------------------------------------------------------------------

/** Regions around the capital owned at the start (besides the capital). */
export const START_EXTRA_REGIONS = 4;
export const START_INFANTRY = 3;

// -- diplomacy --------------------------------------------------------------------------------

/** After making peace, neither side may declare war for this long. */
export const TRUCE_SECONDS = 180;
/** A peace offer stands this long. */
export const PEACE_OFFER_SECONDS = 30;

/** When bots start wars nobody provoked: against a bordering country this much weaker. */
export interface Opportunism {
  /** Not before this many seconds into the match. */
  after: number;
  /** Our strength must be at least this many times theirs. */
  ratio: number;
  /** Chance per diplomacy check (every BOT_DIPLOMACY_SECONDS) that it acts on it. */
  chance: number;
  /** Wars it will fight at once (it never starts one beyond this). */
  maxWars: number;
}
export const OPPORTUNISM: Record<BotDifficulty, Opportunism | null> = {
  easy: null,
  normal: { after: 300, ratio: 2, chance: 0.15, maxWars: 1 },
  hard: { after: 180, ratio: 1.6, chance: 0.35, maxWars: 2 },
};
export const BOT_DIPLOMACY_SECONDS = 45;
/** Bots offer peace when they're this much weaker than the enemy, or after a long stalemate. */
export const BOT_PEACE_WHEN_WEAKER = 0.7;
export const BOT_PEACE_STALEMATE_SECONDS = 240;
/** Wars last at least this long before a bot offers peace. */
export const BOT_MIN_WAR_SECONDS = 180;

// -- lobby ------------------------------------------------------------------------------------

/** Bot fill and random deals keep capitals at least this far apart (spawn spacing). */
export const MIN_CAPITAL_KM = 600;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 8;
export type BotDifficulty = 'easy' | 'normal' | 'hard';
/** A human who drops is replaced by a bot after this many seconds (until they come back). */
export const DISCONNECT_BOT_SECONDS = 10;

/** Muted military colours, one per country, picked to stay apart on the terrain. */
export const PLAYER_COLORS = ['#c0504d', '#4f81bd', '#9bbb59', '#e0a33a', '#8064a2', '#4bacc6', '#d46f3b', '#2f6b5a'];

// -- per-region numbers -----------------------------------------------------------------------

export function stackCap(region: Region, infra: number): number {
  return Math.max(STACK_MIN, STACK_SIZE[region.size] + STACK_TERRAIN[region.terrain]) + infra;
}

export function supplyCapacity(region: Region, infra: number): number {
  const base = (SUPPLY_BASE + SUPPLY_PER_INFRA * infra) * SUPPLY_TERRAIN[region.terrain];
  return region.traits.includes('city') ? base * SUPPLY_CITY : base;
}

/** Seconds to capture a region with blobs of the given (best) training. */
export function captureSeconds(region: Region, fort: number, training: number): number {
  const base = CAPTURE_SECONDS * CAPTURE_SIZE[region.size] * CAPTURE_TERRAIN[region.terrain] * (1 + CAPTURE_FORT * fort);
  return base / (1 + (CAPTURE_TRAINING * training) / MAX_TRAINING);
}
