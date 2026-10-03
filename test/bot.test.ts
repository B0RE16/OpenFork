import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { GameMap } from '../shared/map.ts';
import { type BotDifficulty, PLAYER_COLORS } from '../shared/rules.ts';
import { Bot } from '../server/core/bot.ts';
import { mulberry32 } from '../server/core/rng.ts';
import { Sim } from '../server/core/sim.ts';
import { World } from '../server/core/world.ts';
import { chain, clearBlobs, makeMap, place, sim } from './helpers.ts';

const europe: GameMap = JSON.parse(readFileSync(new URL('../public/maps/europe.json', import.meta.url), 'utf8'));

function play(difficulty: BotDifficulty, seconds: number) {
  // A fixed eight (the map's first playable ones before more were added), so the numbers
  // below don't shift when the map gains countries.
  const picks = ['BY', 'FI', 'FR', 'DE', 'GR', 'IT', 'NO', 'PL'];
  const countries = europe.countries.filter((c) => c.playable && picks.includes(c.id));
  const sim = new Sim(
    new World(europe),
    countries.map((c, i) => ({ name: c.name, country: c.id, color: PLAYER_COLORS[i], control: 'bot', difficulty })),
  );
  const bots = sim.state.players.map((p) => new Bot(p.id, difficulty, mulberry32(p.id + 1)));
  const events: Array<{ kind: string; at: number }> = [];
  for (let i = 0; i < seconds * 10; i++) {
    for (const b of bots) b.act(sim);
    sim.tick();
    for (const e of sim.drainEvents()) events.push({ kind: e.kind, at: sim.state.time });
  }
  return { sim, events };
}

describe('bots on Europe', () => {
  it('normal bots expand and build, and start no wars in the first five minutes', () => {
    const { sim, events } = play('normal', 300);
    const owned = sim.state.regions.filter((r) => r.owner >= 0).length;
    assert.ok(owned >= sim.state.regions.length / 4, `bots own only ${owned} regions`);
    for (const k of ['captured', 'produced', 'built']) assert.ok(events.some((e) => e.kind === k), `no ${k} events`);
    assert.ok(!events.some((e) => e.kind === 'war'), 'nobody was provoked, and normal bots wait 5 minutes');
  });

  it('normal bots develop: economic buildings, bigger cities and roads', () => {
    const { sim } = play('normal', 600);
    const econ = sim.state.regions.reduce((n, r) => n + (r.owner >= 0 ? r.econ.farm + r.econ.mine + r.econ.well + r.econ.market : 0), 0);
    const grown = sim.state.players.filter((p) => sim.state.regions[p.capital].city > 3).length;
    assert.ok(econ >= sim.state.players.length, `only ${econ} economic buildings`);
    assert.ok(grown >= 1, 'no capital grew');
    assert.ok(sim.state.roads.size >= sim.state.players.length, `only ${sim.state.roads.size} roads`);
  });

  it('hard bots pick on weaker neighbours, and fight', () => {
    const { events } = play('hard', 720);
    const war = events.find((e) => e.kind === 'war');
    assert.ok(war, 'a war started');
    assert.ok(war.at >= 180, 'not before hard bots are allowed to');
    assert.ok(events.some((e) => e.kind === 'battle'), 'and there was fighting');
  });
});

describe('defensive bots', () => {
  it('stay home: no new land, no wars, no new units, but they build', () => {
    const start = play('defensive', 1);
    const owned = (sim: Sim) => sim.state.regions.filter((r) => r.owner >= 0).length;
    const before = owned(start.sim);
    const { sim, events } = play('defensive', 300);
    assert.equal(owned(sim), before, 'no new land');
    assert.ok(!events.some((e) => e.kind === 'war' || e.kind === 'produced' || e.kind === 'captured'));
    assert.ok(events.some((e) => e.kind === 'built'), 'they still develop');
  });

  it('at war, take back their own lost land but never push into the enemy\'s', () => {
    // A: 0..3, B (defensive bot): 4..7, capital 7.
    const map = makeMap(
      Array.from({ length: 8 }, (_, i) => ({ country: i < 4 ? 'A' : 'B' })),
      chain(8),
      [
        { id: 'A', capital: 0 },
        { id: 'B', capital: 7 },
      ],
    );
    const s = sim(map, ['A', 'B']);
    clearBlobs(s);
    s.state.regions.forEach((r, i) => (r.owner = i < 4 ? 0 : 1));
    place(s, 1, 'infantry', 7, 20); // the capital's guard
    for (let i = 0; i < 2; i++) place(s, 1, 'infantry', 5, 20);
    const bot = new Bot(1, 'defensive', mulberry32(5));
    bot.act(s); // learns its home: 4..7
    s.declareWar(0, 1);
    s.state.regions[4].owner = 0; // lost, and left empty
    for (let i = 0; i < 1200; i++) {
      bot.act(s);
      s.tick();
    }
    assert.equal(s.state.regions[4].owner, 1, 'took its region back');
    assert.equal(s.state.regions[3].owner, 0, 'and went no further');
    assert.ok([...s.state.blobs.values()].every((b) => b.owner !== 1 || b.region >= 4));
  });
});
