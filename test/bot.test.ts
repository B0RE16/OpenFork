import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { GameMap } from '../shared/map.ts';
import { type BotDifficulty, PLAYER_COLORS } from '../shared/rules.ts';
import { Bot } from '../server/core/bot.ts';
import { mulberry32 } from '../server/core/rng.ts';
import { Sim } from '../server/core/sim.ts';
import { World } from '../server/core/world.ts';

const europe: GameMap = JSON.parse(readFileSync(new URL('../public/maps/europe.json', import.meta.url), 'utf8'));

function play(difficulty: BotDifficulty, seconds: number) {
  const countries = europe.countries.filter((c) => c.playable).slice(0, 8);
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

  it('hard bots pick on weaker neighbours, and fight', () => {
    const { events } = play('hard', 720);
    const war = events.find((e) => e.kind === 'war');
    assert.ok(war, 'a war started');
    assert.ok(war.at >= 180, 'not before hard bots are allowed to');
    assert.ok(events.some((e) => e.kind === 'battle'), 'and there was fighting');
  });
});
