import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { GameMap } from '../shared/map.ts';
import type { ServerMessage } from '../shared/protocol.ts';
import { DISCONNECT_BOT_SECONDS, MAX_PLAYERS, SNAPSHOT_EVERY_TICKS } from '../shared/rules.ts';
import { GuestAuth } from '../server/adapters/memory.ts';
import { GameServer } from '../server/core/game-server.ts';
import { parseClientMessage } from '../server/core/parse.ts';
import { mulberry32 } from '../server/core/rng.ts';
import { chain, makeMap } from './helpers.ts';

/** Ten regions in a row; five playable countries with capitals at 0, 2, 4, 6, 9. */
function testMap(): GameMap {
  const map = makeMap(
    Array.from({ length: 10 }, () => ({})),
    chain(10),
    [
      { id: 'AA', capital: 0 },
      { id: 'BB', capital: 2 },
      { id: 'CC', capital: 4 },
      { id: 'DD', capital: 6 },
      { id: 'EE', capital: 9 },
    ],
  );
  map.id = 'europe';
  return map;
}

function setup(map: GameMap = testMap(), seed = 3) {
  const inbox = new Map<string, ServerMessage[]>();
  let now = 0;
  const server = new GameServer({
    transport: { send: (conn, msg) => inbox.set(conn, [...(inbox.get(conn) ?? []), msg]) },
    auth: new GuestAuth(),
    clock: { now: () => now },
    maps: new Map([['europe', map]]),
    random: mulberry32(seed),
  });
  const last = <T extends ServerMessage['t']>(conn: string, t: T) =>
    (inbox.get(conn) ?? []).filter((m) => m.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined;
  const connect = async (conn: string, name: string, token?: string) => {
    server.handleConnect(conn);
    await server.handleMessage(conn, { t: 'hello', name, token });
    return last(conn, 'welcome');
  };
  const send = (conn: string, msg: unknown) => server.handleMessage(conn, msg);
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      now += 100;
      server.tick();
    }
  };
  return { server, inbox, last, connect, send, tick };
}

describe('lobbies', () => {
  it('creates, joins with a code, picks countries', async () => {
    const t = setup();
    await t.connect('a', 'Ann');
    await t.connect('b', 'Bob');
    await t.send('a', { t: 'lobby.create' });
    const code = t.last('a', 'lobby')?.lobby?.code as string;
    assert.match(code, /^[A-Z0-9]{5}$/);
    await t.send('b', { t: 'lobby.join', code });
    await t.send('a', { t: 'lobby.pick', country: 'AA' });
    await t.send('b', { t: 'lobby.pick', country: 'AA' });
    assert.equal(t.last('b', 'error')?.message, 'someone else picked it');
    await t.send('b', { t: 'lobby.pick', country: 'EE' });
    const view = t.last('a', 'lobby')?.lobby;
    assert.deepEqual(
      view?.members.map((m) => [m.name, m.country]),
      [
        ['Ann', 'AA'],
        ['Bob', 'EE'],
      ],
    );
    await t.send('b', { t: 'lobby.start' });
    assert.equal(t.last('b', 'error')?.message, 'only the host can start');
  });

  it('starts with bots filling the empty seats', async () => {
    const t = setup();
    await t.connect('a', 'Ann');
    await t.send('a', { t: 'lobby.create' });
    await t.send('a', { t: 'lobby.settings', settings: { size: 4 } });
    await t.send('a', { t: 'lobby.pick', country: 'AA' });
    await t.send('a', { t: 'lobby.start' });
    const start = t.last('a', 'game.start');
    assert.ok(start);
    assert.equal(start.you, 0);
    assert.equal(start.players.length, 4);
    assert.equal(start.players[0].country, 'AA');
    assert.deepEqual(
      start.players.map((p) => p.human),
      [true, false, false, false],
    );
    // The first bot goes as far away as possible.
    assert.equal(start.players[1].country, 'EE');
    t.tick(SNAPSHOT_EVERY_TICKS);
    const snap = t.last('a', 'snap')?.snap;
    assert.ok(snap && snap.blobs.length > 0 && snap.regions.length === 10);
    assert.ok(snap.production.some((p) => p.building === 'barracks'));
  });

  it('plays up to MAX_PLAYERS countries on Europe, each with its own colour', async () => {
    const europe: GameMap = JSON.parse(readFileSync(new URL('../public/maps/europe.json', import.meta.url), 'utf8'));
    const t = setup(europe);
    await t.connect('a', 'Ann');
    await t.send('a', { t: 'lobby.create' });
    await t.send('a', { t: 'lobby.settings', settings: { size: MAX_PLAYERS } });
    await t.send('a', { t: 'lobby.start' });
    const start = t.last('a', 'game.start');
    assert.equal(start?.players.length, MAX_PLAYERS);
    assert.equal(new Set(start?.players.map((p) => p.country)).size, MAX_PLAYERS);
    assert.equal(new Set(start?.players.map((p) => p.color)).size, MAX_PLAYERS);
    t.tick(SNAPSHOT_EVERY_TICKS);
    const snap = t.last('a', 'snap')?.snap;
    for (let p = 0; p < MAX_PLAYERS; p++) assert.ok(snap?.regions.some((r) => r[0] === p), `player ${p} starts with land`);
  });

  it('pure PvP: one country per person, no bots, and at least two people', async () => {
    const t = setup();
    await t.connect('a', 'Ann');
    await t.send('a', { t: 'lobby.create' });
    await t.send('a', { t: 'lobby.settings', settings: { difficulty: 'none' } });
    assert.equal(t.last('a', 'lobby')?.lobby?.settings.difficulty, 'none');
    await t.send('a', { t: 'lobby.start' });
    assert.match(t.last('a', 'error')?.message ?? '', /at least 2 people/);
    const code = t.last('a', 'lobby')?.lobby?.code as string;
    await t.connect('b', 'Bob');
    await t.send('b', { t: 'lobby.join', code });
    await t.send('a', { t: 'lobby.start' });
    const start = t.last('a', 'game.start');
    assert.equal(start?.players.length, 2);
    assert.ok(start?.players.every((p) => p.human));
  });

  it('accepts the bot settings none, defensive, easy, normal and hard, nothing else', () => {
    for (const d of ['none', 'defensive', 'easy', 'normal', 'hard']) {
      assert.ok(parseClientMessage({ t: 'lobby.settings', settings: { difficulty: d } }), d);
    }
    assert.equal(parseClientMessage({ t: 'lobby.settings', settings: { difficulty: 'brutal' } }), null);
  });

  it('takes orders from the country\'s player only; watchers just watch', async () => {
    const t = setup();
    await t.connect('a', 'Ann');
    await t.send('a', { t: 'lobby.create' });
    await t.send('a', { t: 'lobby.start' });
    const code = t.last('a', 'lobby')?.lobby?.code as string;
    await t.connect('w', 'Watcher');
    await t.send('w', { t: 'lobby.join', code });
    assert.equal(t.last('w', 'game.start')?.you, null);
    const snap = t.last('a', 'snap')?.snap;
    const mine = snap?.blobs.find((b) => b[1] === 0);
    assert.ok(mine);
    await t.send('w', { t: 'order', order: { o: 'stop', blobs: [mine[0]] } });
    assert.equal(t.last('w', 'error')?.message, 'you are watching this game');
    const barracks = snap?.regions.findIndex((r) => r[0] === 0 && (r[3] & 1) !== 0) ?? -1;
    const errors = (t.inbox.get('a') ?? []).filter((m) => m.t === 'error').length;
    await t.send('a', { t: 'order', order: { o: 'produce', region: barracks, building: 'barracks' } });
    assert.equal((t.inbox.get('a') ?? []).filter((m) => m.t === 'error').length, errors);
  });

  it('a bot stands in for a player who drops, until they come back', async () => {
    const t = setup();
    const w = await t.connect('a', 'Ann');
    await t.send('a', { t: 'lobby.create' });
    await t.send('a', { t: 'lobby.start' });
    t.server.handleDisconnect('a');
    t.tick(DISCONNECT_BOT_SECONDS * 10 + 5);
    await t.connect('a2', 'Ann', w?.token);
    t.tick(SNAPSHOT_EVERY_TICKS);
    assert.equal(t.last('a2', 'game.start')?.you, 0);
    const snap = t.last('a2', 'snap')?.snap;
    assert.equal(snap?.players[0].bot, false);
  });

  it('surrendering knocks your country out; you keep watching', async () => {
    const t = setup();
    await t.connect('a', 'Ann');
    await t.send('a', { t: 'lobby.create' });
    await t.send('a', { t: 'lobby.start' });
    await t.send('a', { t: 'order', order: { o: 'surrender' } });
    t.tick(SNAPSHOT_EVERY_TICKS);
    const snap = t.last('a', 'snap')?.snap;
    assert.equal(snap?.players[0].alive, false);
    assert.ok(snap?.regions.every((r) => r[0] !== 0), 'the land goes neutral');
    assert.ok(snap?.blobs.every((b) => b[1] !== 0), 'the units disband');
    const events = (t.inbox.get('a') ?? []).flatMap((m) => (m.t === 'snap' ? m.snap.events : []));
    assert.ok(events.some((e) => e.kind === 'eliminated' && e.player === 0 && e.surrendered));
    await t.send('a', { t: 'order', order: { o: 'surrender' } });
    assert.equal(t.last('a', 'error')?.message, 'already out of the game');
  });

  it('a game nobody plays or watches ends after a while', async () => {
    const t = setup();
    const w = await t.connect('a', 'Ann');
    await t.send('a', { t: 'lobby.create' });
    await t.send('a', { t: 'lobby.start' });
    t.server.handleDisconnect('a');
    t.tick(20 * 10);
    await t.connect('a2', 'Ann', w?.token);
    assert.equal(t.last('a2', 'lobby')?.lobby?.playing, true, 'a quick reload keeps it going');
    t.server.handleDisconnect('a2');
    t.tick(31 * 10);
    await t.connect('a3', 'Ann', w?.token);
    assert.equal(t.last('a3', 'lobby')?.lobby?.playing, false);
  });

  it('keeps bot capitals at least MIN_CAPITAL_KM from taken ones', async () => {
    // Capitals 300 km apart per step: BB is right next to AA, the rest are spread out.
    const map = makeMap(
      Array.from({ length: 10 }, () => ({})),
      chain(10),
      [
        { id: 'AA', capital: 0 },
        { id: 'BB', capital: 1 },
        { id: 'FF', capital: 3 },
        { id: 'CC', capital: 5 },
        { id: 'DD', capital: 7 },
        { id: 'EE', capital: 9 },
      ],
    );
    map.id = 'europe';
    map.kmPerPx = 30;
    for (let seed = 0; seed < 5; seed++) {
      const t = setup(map, seed + 10);
      await t.connect('a', 'Ann');
      await t.send('a', { t: 'lobby.create' });
      await t.send('a', { t: 'lobby.settings', settings: { size: 4 } });
      await t.send('a', { t: 'lobby.pick', country: 'AA' });
      await t.send('a', { t: 'lobby.start' });
      const countries = t.last('a', 'game.start')?.players.map((p) => p.country) ?? [];
      assert.equal(countries.length, 4);
      assert.ok(!countries.includes('BB'), `BB is too close to AA: ${countries}`);
    }
  });

  it('rejects malformed messages', async () => {
    const t = setup();
    await t.connect('a', 'Ann');
    await t.send('a', { t: 'order', order: { o: 'move', blobs: 'x', to: 1 } });
    assert.equal(t.last('a', 'error')?.message, 'bad message');
  });
});
