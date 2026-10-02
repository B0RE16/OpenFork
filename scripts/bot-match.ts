// Plays a whole match of bots on a map, headless, and reports how it went.
// Usage: node scripts/bot-match.ts [seed] [players] [difficulty]
import { readFileSync } from 'node:fs';
import type { GameMap } from '../shared/map.ts';
import { type BotDifficulty, PLAYER_COLORS } from '../shared/rules.ts';
import { Bot } from '../server/core/bot.ts';
import { mulberry32 } from '../server/core/rng.ts';
import { Sim } from '../server/core/sim.ts';
import { World } from '../server/core/world.ts';

const seed = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 8);
const difficulty = (process.argv[4] ?? 'normal') as BotDifficulty;
const map: GameMap = JSON.parse(readFileSync(new URL('../public/maps/europe.json', import.meta.url), 'utf8'));
const random = mulberry32(seed);
const playable = map.countries.filter((c) => c.playable).sort(() => random() - 0.5).slice(0, count);
const sim = new Sim(
  new World(map),
  playable.map((c, i) => ({ name: c.name, country: c.id, color: PLAYER_COLORS[i], control: 'bot', difficulty })),
);
const bots = sim.state.players.map((p) => new Bot(p.id, difficulty, mulberry32(seed * 100 + p.id)));
const t0 = performance.now();
let lastReport = 0;
while (sim.state.winner === null && sim.state.time < 3600) {
  for (const b of bots) b.act(sim);
  sim.tick();
  for (const e of sim.drainEvents()) {
    if (e.kind === 'eliminated') console.log(`${fmt(sim.state.time)} ${sim.state.players[e.player].name} eliminated by ${sim.state.players[e.by]?.name ?? '?'}`);
    if (e.kind === 'won') console.log(`${fmt(sim.state.time)} ${sim.state.players[e.player].name} wins`);
    const name = (id: number) => sim.state.players[id].country;
    if (e.kind === 'war') console.log(`${fmt(sim.state.time)} war: ${name(e.by)} attacks ${name(e.by === e.a ? e.b : e.a)}`);
    if (e.kind === 'peace') console.log(`${fmt(sim.state.time)} peace: ${name(e.a)} + ${name(e.b)}`);
  }
  if (sim.state.time - lastReport >= 300) {
    lastReport = sim.state.time;
    const line = sim.state.players
      .filter((p) => p.alive)
      .map((p) => {
        const regions = sim.state.regions.filter((r) => r.owner === p.id).length;
        const army = [...sim.state.blobs.values()].filter((b) => b.owner === p.id);
        const str = army.reduce((s, b) => s + b.strength, 0);
        return `${p.country}:${regions}r/${army.length}b/${Math.round(str)}s/$${Math.round(p.resources.money)}`;
      })
      .join(' ');
    console.log(`${fmt(sim.state.time)} ${line}`);
  }
}
console.log(`simulated ${fmt(sim.state.time)} in ${((performance.now() - t0) / 1000).toFixed(1)}s; winner: ${sim.state.winner === null ? 'none' : sim.state.players[sim.state.winner].name}`);

function fmt(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}
if (process.env.DEBUG) {
  for (const p of sim.state.players.filter((x) => x.alive)) {
    const cap = p.capital;
    const rs = sim.state.regions[cap];
    console.log(`${p.name}: capital ${map.regions[cap].name} owner ${rs.owner} fort ${rs.fort} supplied ${rs.supplied}`);
    for (const r of [cap, ...map.regions[cap].neighbors.map((n) => n.id)]) {
      const here = sim.blobsIn(r).map((b) => `${sim.state.players[b.owner].country}:${b.type[0]}${b.strength.toFixed(0)}/${b.size}${b.path.length ? `>${b.path.at(-1)}` : ''}${b.hold ? 'H' : ''}`);
      const moving = [...sim.state.blobs.values()].filter((b) => b.progress > 0 && (b.region === r || b.path[0] === r)).length;
      console.log(`  ${r} ${map.regions[r].name} (${sim.state.regions[r].owner}, cap ${sim.stackCap(r)}, fort ${sim.state.regions[r].fort}): ${here.join(' ')} moving:${moving}`);
    }
  }
}
