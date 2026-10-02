// Everything the core needs from the outside world. The standalone server implements these
// in server/adapters; a host (e.g. the Kernel module's host) provides its own and drives
// GameServer the same way.
import type { ServerMessage } from '../../shared/protocol.ts';

/** Opaque id for one client connection, assigned by the transport. */
export type ConnId = string;

export interface Transport {
  send(conn: ConnId, msg: ServerMessage): void;
}

export interface Identity {
  id: string;
  /** Secret the client keeps to come back as the same person after a reconnect. */
  token: string;
  name: string;
}

export interface Auth {
  identify(hello: { token?: string; name: string }): Promise<Identity>;
}

export interface Clock {
  now(): number;
}

export interface MatchResult {
  map: string;
  startedAt: number;
  endedAt: number;
  players: Array<{ name: string; country: string; human: boolean; alive: boolean }>;
  winner: string | null;
}

/** Optional: told about every finished match (e.g. to keep history). */
export interface MatchLog {
  recordMatch(result: MatchResult): void;
}
