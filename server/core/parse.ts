// Checks untrusted client messages. Anything malformed comes back as null.
import type { ClientMessage, LobbySettings, Order } from '../../shared/protocol.ts';
import { BUILDING_KINDS, type BuildingKind, MAX_PLAYERS, MIN_PLAYERS } from '../../shared/rules.ts';

const MAX_IDS = 64;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e9;
const isIds = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.length <= MAX_IDS && v.every(isInt);
const isProd = (v: unknown): v is 'barracks' | 'factory' => v === 'barracks' || v === 'factory';

export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return name || null;
}

function order(v: unknown): Order | null {
  if (!isObj(v)) return null;
  switch (v.o) {
    case 'move':
      return isIds(v.blobs) && isInt(v.to) ? { o: 'move', blobs: v.blobs, to: v.to } : null;
    case 'stop':
      return isIds(v.blobs) ? { o: 'stop', blobs: v.blobs } : null;
    case 'split':
      return isInt(v.blob) ? { o: 'split', blob: v.blob } : null;
    case 'merge':
      return isIds(v.blobs) ? { o: 'merge', blobs: v.blobs } : null;
    case 'build':
      return isInt(v.region) && BUILDING_KINDS.includes(v.kind as BuildingKind)
        ? { o: 'build', region: v.region, kind: v.kind as BuildingKind }
        : null;
    case 'produce':
      return isInt(v.region) && isProd(v.building) ? { o: 'produce', region: v.region, building: v.building } : null;
    case 'repeat':
      return isInt(v.region) && isProd(v.building) && typeof v.on === 'boolean'
        ? { o: 'repeat', region: v.region, building: v.building, on: v.on }
        : null;
    case 'war':
    case 'peace':
    case 'refuse':
      return isInt(v.player) ? { o: v.o, player: v.player } : null;
    case 'cancel':
      return isInt(v.region) && isProd(v.building) ? { o: 'cancel', region: v.region, building: v.building } : null;
    default:
      return null;
  }
}

function settings(v: unknown): Partial<LobbySettings> | null {
  if (!isObj(v)) return null;
  const out: Partial<LobbySettings> = {};
  if (v.map !== undefined) {
    if (typeof v.map !== 'string' || !/^[a-z0-9-]{1,32}$/.test(v.map)) return null;
    out.map = v.map;
  }
  if (v.size !== undefined) {
    if (!Number.isInteger(v.size) || (v.size as number) < MIN_PLAYERS || (v.size as number) > MAX_PLAYERS) return null;
    out.size = v.size as number;
  }
  if (v.starting !== undefined) {
    if (v.starting !== 'low' && v.starting !== 'normal' && v.starting !== 'high') return null;
    out.starting = v.starting;
  }
  if (v.pick !== undefined) {
    if (v.pick !== 'free' && v.pick !== 'random') return null;
    out.pick = v.pick;
  }
  if (v.difficulty !== undefined) {
    if (v.difficulty !== 'easy' && v.difficulty !== 'normal' && v.difficulty !== 'hard') return null;
    out.difficulty = v.difficulty;
  }
  return out;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case 'hello': {
      const name = cleanName(raw.name);
      if (!name) return null;
      const token = typeof raw.token === 'string' && raw.token.length <= 64 ? raw.token : undefined;
      return { t: 'hello', name, token };
    }
    case 'lobby.create':
    case 'lobby.leave':
    case 'lobby.start':
      return { t: raw.t };
    case 'lobby.join':
      return typeof raw.code === 'string' && /^[A-Z0-9]{4,8}$/i.test(raw.code)
        ? { t: 'lobby.join', code: raw.code.toUpperCase() }
        : null;
    case 'lobby.settings': {
      const s = settings(raw.settings);
      return s ? { t: 'lobby.settings', settings: s } : null;
    }
    case 'lobby.pick':
      return raw.country === null || (typeof raw.country === 'string' && /^[A-Z]{2}$/.test(raw.country))
        ? { t: 'lobby.pick', country: raw.country as string | null }
        : null;
    case 'order': {
      const o = order(raw.order);
      return o ? { t: 'order', order: o } : null;
    }
    default:
      return null;
  }
}
