// Sessions, private lobbies and running games. No I/O: the host feeds it connections and
// messages and calls tick() every TICK_MS (see server/main.ts).
import type { GameMap } from '../../shared/map.ts';
import type { ClientMessage, LobbyMember, LobbySettings, LobbyView, ServerMessage } from '../../shared/protocol.ts';
import { MAX_PLAYERS, MIN_CAPITAL_KM, MIN_PLAYERS, PLAYER_COLORS, SNAPSHOT_EVERY_TICKS } from '../../shared/rules.ts';
import { Game, type Seat } from './game.ts';
import { parseClientMessage } from './parse.ts';
import type { Auth, Clock, ConnId, Identity, MatchLog, Transport } from './ports.ts';
import { World } from './world.ts';

/** Lobbies with nobody connected are closed after this long. */
const EMPTY_LOBBY_MS = 10 * 60_000;
/** A running game nobody is playing or watching for this long ends (no point bots playing to nobody). */
const ABANDONED_GAME_MS = 30_000;
/** People in one lobby (players and watchers). */
const MAX_MEMBERS = 16;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface Member {
  identity: Identity;
  country: string | null;
  conns: Set<ConnId>;
}

interface Lobby {
  code: string;
  host: string;
  members: Map<string, Member>;
  settings: LobbySettings;
  game: Game | null;
  emptySince: number | null;
  ticks: number;
  /** Someone gave an order: send snapshots on the next tick, not the next scheduled one. */
  urgent?: boolean;
}

export interface GameServerDeps {
  transport: Transport;
  auth: Auth;
  clock: Clock;
  maps: Map<string, GameMap>;
  random?: () => number;
  matches?: MatchLog;
  log?: (msg: string) => void;
}

export class GameServer {
  private readonly deps: GameServerDeps;
  private readonly random: () => number;
  private readonly worlds = new Map<string, World>();
  /** Per connection: who it is, and its messages handled one after another. */
  private readonly sessions = new Map<ConnId, { identity: Identity | null; chain: Promise<void> }>();
  /** identity id → lobby code */
  private readonly memberOf = new Map<string, string>();
  readonly lobbies = new Map<string, Lobby>();

  constructor(deps: GameServerDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
    for (const [id, map] of deps.maps) this.worlds.set(id, new World(map));
  }

  private send(conn: ConnId, msg: ServerMessage): void {
    this.deps.transport.send(conn, msg);
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  // -- connections ------------------------------------------------------------------------

  handleConnect(conn: ConnId): void {
    this.sessions.set(conn, { identity: null, chain: Promise.resolve() });
  }

  handleDisconnect(conn: ConnId): void {
    const s = this.sessions.get(conn);
    this.sessions.delete(conn);
    const id = s?.identity?.id;
    if (!id) return;
    const lobby = this.lobbyOf(id);
    const m = lobby?.members.get(id);
    if (!lobby || !m) return;
    m.conns.delete(conn);
    if (m.conns.size === 0) {
      lobby.game?.setConnected(id, false);
      this.broadcastLobby(lobby);
    }
  }

  /** Messages from one connection are handled in order (hello is async). */
  handleMessage(conn: ConnId, raw: unknown): Promise<void> {
    const session = this.sessions.get(conn);
    if (!session) return Promise.resolve();
    session.chain = session.chain.then(() => this.process(conn, raw)).catch((e) => this.log(`message failed: ${e}`));
    return session.chain;
  }

  private async process(conn: ConnId, raw: unknown): Promise<void> {
    const session = this.sessions.get(conn);
    if (!session) return;
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.send(conn, { t: 'error', message: 'bad message' });
      return;
    }
    if (msg.t === 'hello') {
      await this.hello(conn, msg.name, msg.token);
      return;
    }
    const me = session.identity;
    if (!me) {
      this.send(conn, { t: 'error', message: 'say hello first' });
      return;
    }
    const error = this.handle(conn, me, msg);
    if (error) this.send(conn, { t: 'error', message: error });
  }

  private async hello(conn: ConnId, name: string, token?: string): Promise<void> {
    const identity = await this.deps.auth.identify({ token, name });
    const session = this.sessions.get(conn);
    if (!session) return; // gone while identifying
    session.identity = identity;
    this.send(conn, { t: 'welcome', id: identity.id, token: identity.token, name: identity.name });
    // Back in a lobby they were in.
    const lobby = this.lobbyOf(identity.id);
    const m = lobby?.members.get(identity.id);
    if (lobby && m) {
      m.identity = identity;
      m.conns.add(conn);
      lobby.emptySince = null;
      lobby.game?.setConnected(identity.id, true);
      this.broadcastLobby(lobby);
      if (lobby.game) this.sendGameStart(lobby, conn, identity.id);
    } else {
      this.send(conn, { t: 'lobby', lobby: null });
    }
  }

  private handle(conn: ConnId, me: Identity, msg: Exclude<ClientMessage, { t: 'hello' }>): string | null {
    switch (msg.t) {
      case 'lobby.create': {
        this.leave(me.id);
        const code = this.newCode();
        const lobby: Lobby = {
          code,
          host: me.id,
          members: new Map(),
          settings: { map: 'europe', size: 6, starting: 'normal', pick: 'free', difficulty: 'normal' },
          game: null,
          emptySince: null,
          ticks: 0,
        };
        this.lobbies.set(code, lobby);
        this.join(lobby, me, conn);
        this.log(`${me.name} opened lobby ${code}`);
        return null;
      }
      case 'lobby.join': {
        const lobby = this.lobbies.get(msg.code);
        if (!lobby) return 'no lobby with that code';
        if (this.lobbyOf(me.id) === lobby) {
          lobby.members.get(me.id)?.conns.add(conn);
          this.broadcastLobby(lobby);
          if (lobby.game) this.sendGameStart(lobby, conn, me.id);
          return null;
        }
        if (lobby.members.size >= MAX_MEMBERS) return 'lobby is full';
        this.leave(me.id);
        this.join(lobby, me, conn);
        if (lobby.game) this.sendGameStart(lobby, conn, me.id);
        return null;
      }
      case 'lobby.leave':
        this.leave(me.id);
        this.send(conn, { t: 'lobby', lobby: null });
        return null;
      case 'lobby.settings': {
        const lobby = this.lobbyOf(me.id);
        if (!lobby) return 'not in a lobby';
        if (lobby.host !== me.id) return 'only the host can change settings';
        if (lobby.game && !lobby.game.over) return 'the game is running';
        const next = { ...lobby.settings, ...msg.settings };
        if (!this.worlds.has(next.map)) return 'no such map';
        lobby.settings = next;
        this.broadcastLobby(lobby);
        return null;
      }
      case 'lobby.pick': {
        const lobby = this.lobbyOf(me.id);
        if (!lobby) return 'not in a lobby';
        if (lobby.game && !lobby.game.over) return 'the game is running';
        const member = lobby.members.get(me.id) as Member;
        if (msg.country !== null) {
          const c = this.worlds.get(lobby.settings.map)?.map.countries.find((x) => x.id === msg.country);
          if (!c?.playable) return 'that country can\'t be played';
          for (const m of lobby.members.values()) if (m !== member && m.country === msg.country) return 'someone else picked it';
        }
        member.country = msg.country;
        this.broadcastLobby(lobby);
        return null;
      }
      case 'lobby.start': {
        const lobby = this.lobbyOf(me.id);
        if (!lobby) return 'not in a lobby';
        if (lobby.host !== me.id) return 'only the host can start';
        if (lobby.game && !lobby.game.over) return 'already playing';
        return this.start(lobby);
      }
      case 'order': {
        const lobby = this.lobbyOf(me.id);
        if (!lobby?.game || lobby.game.over) return 'no game running';
        lobby.urgent = true;
        return lobby.game.order(me.id, msg.order);
      }
    }
  }

  // -- lobbies ----------------------------------------------------------------------------

  private lobbyOf(identity: string): Lobby | undefined {
    const code = this.memberOf.get(identity);
    return code ? this.lobbies.get(code) : undefined;
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length)];
      if (!this.lobbies.has(code)) return code;
    }
  }

  private join(lobby: Lobby, identity: Identity, conn: ConnId): void {
    lobby.members.set(identity.id, { identity, country: null, conns: new Set([conn]) });
    this.memberOf.set(identity.id, lobby.code);
    lobby.emptySince = null;
    this.broadcastLobby(lobby);
  }

  private leave(identity: string): void {
    const lobby = this.lobbyOf(identity);
    if (!lobby) return;
    lobby.members.delete(identity);
    this.memberOf.delete(identity);
    lobby.game?.abandon(identity);
    if (lobby.members.size === 0) {
      this.lobbies.delete(lobby.code);
      this.log(`lobby ${lobby.code} closed`);
      return;
    }
    if (lobby.host === identity) lobby.host = [...lobby.members.keys()][0];
    this.broadcastLobby(lobby);
  }

  private view(lobby: Lobby): LobbyView {
    const members: LobbyMember[] = [...lobby.members.values()].map((m) => ({
      id: m.identity.id,
      name: m.identity.name,
      country: m.country,
      connected: m.conns.size > 0,
    }));
    return { code: lobby.code, host: lobby.host, members, settings: lobby.settings, playing: !!lobby.game && !lobby.game.over };
  }

  private broadcastLobby(lobby: Lobby): void {
    const view = this.view(lobby);
    for (const m of lobby.members.values()) for (const c of m.conns) this.send(c, { t: 'lobby', lobby: view });
  }

  /** Seats humans (their picks, or dealt out), fills the rest with bots, starts the match. */
  private start(lobby: Lobby): string | null {
    const world = this.worlds.get(lobby.settings.map);
    if (!world) return 'no such map';
    const s = lobby.settings;
    const size = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, s.size));
    const playable = world.map.countries.filter((c) => c.playable);
    const humans = [...lobby.members.values()].filter((m) => m.conns.size > 0).slice(0, size);
    const taken = new Set<string>();
    const free = () => playable.filter((c) => !taken.has(c.id)).map((c) => c.id);
    // Free picks first; everyone else is dealt a country whose capital is well away from
    // those already taken (spawn spacing).
    const country = new Map<string, string>();
    if (s.pick === 'free') {
      for (const m of humans) {
        if (m.country && !taken.has(m.country)) {
          taken.add(m.country);
          country.set(m.identity.id, m.country);
        }
      }
    }
    for (const m of humans) {
      if (country.has(m.identity.id)) continue;
      const pick = this.spacedCountry(world, free(), [...taken]);
      if (!pick) break;
      taken.add(pick);
      country.set(m.identity.id, pick);
    }
    const seats: Seat[] = humans
      .filter((m) => country.has(m.identity.id))
      .map((m) => ({
        human: m.identity.id,
        setup: { name: m.identity.name, country: country.get(m.identity.id) as string, color: '', control: 'human', difficulty: s.difficulty },
      }));
    while (seats.length < size) {
      const pick = this.spacedCountry(world, free(), [...taken]);
      if (!pick) break;
      taken.add(pick);
      const name = playable.find((c) => c.id === pick)?.name ?? pick;
      seats.push({ human: null, setup: { name: `${name} (bot)`, country: pick, color: '', control: 'bot', difficulty: s.difficulty } });
    }
    seats.forEach((seat, i) => (seat.setup.color = PLAYER_COLORS[i % PLAYER_COLORS.length]));
    lobby.game = new Game(world, seats, s.starting, s.difficulty, Math.floor(this.random() * 2 ** 31), this.deps.clock.now());
    lobby.ticks = 0;
    for (const m of lobby.members.values()) {
      if (m.conns.size === 0) lobby.game.setConnected(m.identity.id, false);
      for (const c of m.conns) this.sendGameStart(lobby, c, m.identity.id);
    }
    this.broadcastLobby(lobby);
    this.log(`lobby ${lobby.code}: game started (${seats.map((x) => x.setup.country).join(' ')})`);
    return null;
  }

  /**
   * A country whose capital is at least MIN_CAPITAL_KM from every taken one, at random; if
   * none is that far, the one farthest from its nearest taken capital.
   */
  private spacedCountry(world: World, free: string[], taken: string[]): string | null {
    if (!free.length) return null;
    const regions = world.map.regions;
    const capital = (id: string) => regions[world.map.countries.find((c) => c.id === id)?.capital ?? 0];
    const nearest = (id: string) => {
      const a = capital(id);
      let d = Infinity;
      for (const t of taken) {
        const b = capital(t);
        d = Math.min(d, Math.hypot(a.x - b.x, a.y - b.y) * world.map.kmPerPx);
      }
      return d;
    };
    const spaced = free.filter((f) => nearest(f) >= MIN_CAPITAL_KM);
    if (spaced.length) return spaced[Math.floor(this.random() * spaced.length)];
    return free.reduce((best, f) => (nearest(f) > nearest(best) ? f : best));
  }

  private sendGameStart(lobby: Lobby, conn: ConnId, identity: string): void {
    const game = lobby.game;
    if (!game) return;
    this.send(conn, { t: 'game.start', map: game.mapId, you: game.playerOf(identity), players: game.players });
    const shared = game.sharedSnapshot([]);
    const you = game.playerOf(identity);
    this.send(conn, { t: 'snap', snap: { ...shared, production: game.productionFor(you), routes: game.routesFor(you), builds: game.buildsFor(you) } });
    if (game.over) this.send(conn, { t: 'game.over', winner: game.sim.state.winner });
  }

  // -- the clock --------------------------------------------------------------------------

  tick(): void {
    const now = this.deps.clock.now();
    for (const lobby of [...this.lobbies.values()]) {
      const anyone = [...lobby.members.values()].some((m) => m.conns.size > 0);
      if (!anyone) {
        lobby.emptySince ??= now;
        if (now - lobby.emptySince > EMPTY_LOBBY_MS) {
          for (const id of lobby.members.keys()) this.memberOf.delete(id);
          this.lobbies.delete(lobby.code);
          this.log(`lobby ${lobby.code} closed (empty)`);
          continue;
        }
      }
      const game = lobby.game;
      if (!game || game.over) continue;
      if (lobby.emptySince !== null && now - lobby.emptySince > ABANDONED_GAME_MS) {
        game.end();
        this.finish(lobby, game);
        continue;
      }
      game.tick();
      lobby.ticks++;
      if (lobby.ticks % SNAPSHOT_EVERY_TICKS !== 0 && !game.over && !lobby.urgent) continue;
      lobby.urgent = false;
      const shared = game.sharedSnapshot(game.takeEvents());
      for (const m of lobby.members.values()) {
        if (m.conns.size === 0) continue;
        const you = game.playerOf(m.identity.id);
        const snap = { ...shared, production: game.productionFor(you), routes: game.routesFor(you), builds: game.buildsFor(you) };
        for (const c of m.conns) this.send(c, { t: 'snap', snap });
      }
      if (game.over) this.finish(lobby, game);
    }
  }

  private finish(lobby: Lobby, game: Game): void {
    const winner = game.sim.state.winner;
    for (const m of lobby.members.values()) for (const c of m.conns) this.send(c, { t: 'game.over', winner });
    this.broadcastLobby(lobby);
    const players = game.sim.state.players;
    this.deps.matches?.recordMatch({
      map: game.mapId,
      startedAt: game.startedAt,
      endedAt: this.deps.clock.now(),
      players: players.map((p, i) => ({ name: p.name, country: p.country, human: game.players[i].human, alive: p.alive })),
      winner: winner === null ? null : players[winner].name,
    });
    this.log(`lobby ${lobby.code}: ${winner === null ? 'game over' : `${players[winner].name} won`}`);
  }
}
