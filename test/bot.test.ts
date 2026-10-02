import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { GameMap } from '../shared/map.ts';
import { PLAYER_COLORS } from '../shared/rules.ts';
import { Bot } from '../server/core/bot.ts';
import { mulberry32 } from '../server/core/rng.ts';
import { Sim } from '../server/core/sim.ts';
import { World } from '../server/core/world.ts';

const europe: GameMap = JSON.parse(readFileSync(new URL('../public/maps/europe.json', import.meta.url), 'utf8'));

describe('bots on Europe', () => {
  it('expand, build and fight in the first five minutes', () => {
    const countries = europe.countries.filter((c) => c.playable).slice(0, 8);
    const sim = new Sim(
      new World(europe),
      countries.map((c, i) => ({ name: c.name, country: c.id, color: PLAYER_COLORS[i], control: 'bot', difficulty: 'normal' })),
    );
    const bots = sim.state.players.map((p) => new Bot(p.id, 'normal', mulberry32(p.id + 1)));
    const kinds = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      for (const b of bots) b.act(sim);
      sim.tick();
      for (const e of sim.drainEvents()) kinds.add(e.kind);
    }
    const owned = sim.state.regions.filter((r) => r.owner >= 0).length;
    assert.ok(owned >= sim.state.regions.length / 2, `bots own only ${owned} regions`);
    for (const k of ['captured', 'produced', 'built', 'battle']) assert.ok(kinds.has(k), `no ${k} events`);
  });
});
