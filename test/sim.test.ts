import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCost,
  CROSS_SECONDS,
  CUT_OFF_SECONDS,
  DRILL_CAP,
  ENTRENCH_SECONDS,
  MERGE_PENALTY,
  RETREAT_STRENGTH_LOSS,
  START_INFANTRY,
  START_CAPITAL_LEVEL,
  supplyReach,
  UNITS,
} from '../shared/rules.ts';
import { type Blob, NEUTRAL } from '../server/core/state.ts';
import { chain, clearBlobs, makeMap, place, rich, run, sim } from './helpers.ts';

/** A: capital 0; B: capital 7; a chain of 8 plains regions in between. */
function duel() {
  const map = makeMap(
    Array.from({ length: 8 }, (_, i) => ({ country: i < 4 ? 'A' : 'B' })),
    chain(8),
    [
      { id: 'A', capital: 0 },
      { id: 'B', capital: 7 },
    ],
  );
  return sim(map, ['A', 'B']);
}

describe('the start', () => {
  it('gives each country its capital, neighbours, a barracks and infantry', () => {
    const s = duel();
    const [a, b] = s.state.players;
    assert.equal(a.capital, 0);
    assert.equal(b.capital, 7);
    assert.equal(s.state.regions[0].owner, 0);
    assert.equal(s.state.regions[1].owner, 0); // the only neighbour of 0
    assert.equal(s.state.regions[7].owner, 1);
    assert.equal(s.state.regions[6].owner, 1);
    assert.equal(s.state.regions[3].owner, NEUTRAL);
    assert.ok(s.state.regions[0].barracks);
    const mine = [...s.state.blobs.values()].filter((x) => x.owner === 0);
    assert.equal(mine.length, START_INFANTRY);
    assert.ok(mine.every((x) => x.type === 'infantry'));
  });
});

describe('movement', () => {
  it('takes CROSS_SECONDS per plains hop for infantry, faster for tanks', () => {
    const s = duel();
    clearBlobs(s);
    const inf = place(s, 0, 'infantry', 0);
    const tank = place(s, 0, 'tank', 0);
    assert.equal(s.move(0, [inf.id, tank.id], 1), null);
    run(s, CROSS_SECONDS / UNITS.tank.speed + 0.2);
    assert.equal(tank.region, 1);
    assert.equal(inf.region, 0);
    run(s, CROSS_SECONDS - CROSS_SECONDS / UNITS.tank.speed);
    assert.equal(inf.region, 1);
  });

  it('is slower into forest, and into enemy land with forts', () => {
    const map = makeMap([{}, { terrain: 'forest' }, {}, {}], chain(4), [
      { id: 'A', capital: 0 },
      { id: 'B', capital: 3 },
    ]);
    const s = sim(map, ['A', 'B']);
    const plains = s.travelSeconds('infantry', 0, 0, 1);
    assert.ok(plains > CROSS_SECONDS, 'forest is slower than plains');
    s.state.regions[2].owner = NEUTRAL;
    const t0 = s.travelSeconds('infantry', 0, 1, 2);
    s.state.regions[2].owner = 1; // B's
    assert.equal(s.travelSeconds('infantry', 0, 1, 2), t0, 'zones of control only at war');
    s.declareWar(0, 1);
    const enemy = s.travelSeconds('infantry', 0, 1, 2);
    s.state.regions[2].fort = 2;
    const forted = s.travelSeconds('infantry', 0, 1, 2);
    assert.ok(enemy > t0 && forted > enemy);
  });

  it('captures neutral regions on the way, then goes on', () => {
    const s = duel();
    clearBlobs(s);
    const b = place(s, 0, 'infantry', 1);
    s.move(0, [b.id], 4);
    run(s, CROSS_SECONDS + 0.2);
    assert.equal(b.region, 2);
    assert.equal(s.state.regions[2].owner, NEUTRAL);
    run(s, 3);
    assert.equal(b.region, 2, 'waits to capture');
    run(s, 4);
    assert.equal(s.state.regions[2].owner, 0);
    run(s, 40);
    assert.equal(b.region, 4);
    assert.equal(s.state.regions[3].owner, 0);
    assert.equal(s.state.regions[4].owner, 0);
  });

  it('turns back mid-hop at once instead of finishing the hop', () => {
    const s = duel();
    clearBlobs(s);
    for (const r of [1, 2, 3]) s.state.regions[r].owner = 0;
    const b = place(s, 0, 'infantry', 2);
    s.move(0, [b.id], 3);
    run(s, CROSS_SECONDS / 2);
    assert.equal(b.region, 2);
    assert.ok(b.progress > 0.3 && b.progress < 0.7);
    // Back where it is: it just stops.
    assert.equal(s.move(0, [b.id], 2), null);
    assert.equal(b.progress, 0);
    assert.deepEqual(b.path, []);
    // The other way: it heads there without stepping into 3 first.
    s.move(0, [b.id], 3);
    run(s, CROSS_SECONDS / 2);
    s.move(0, [b.id], 1);
    assert.equal(b.progress, 0);
    run(s, CROSS_SECONDS * 1.5);
    assert.equal(b.region, 1);
    assert.equal(b.from, 2, 'came straight from 2, never via 3');
  });

  it('a new route the same way keeps the hop going; halting stops mid-hop', () => {
    const s = duel();
    clearBlobs(s);
    for (const r of [1, 2, 3]) s.state.regions[r].owner = 0;
    const b = place(s, 0, 'infantry', 1);
    s.move(0, [b.id], 2);
    run(s, CROSS_SECONDS / 2);
    const p = b.progress;
    s.move(0, [b.id], 3);
    assert.equal(b.progress, p);
    assert.deepEqual(b.path, [2, 3]);
    assert.equal(s.stop(0, [b.id]), null);
    assert.equal(b.region, 1);
    assert.equal(b.progress, 0);
    assert.deepEqual(b.path, []);
  });

  it('waits at the edge of a full region', () => {
    const s = duel();
    clearBlobs(s);
    const cap = s.stackCap(1);
    for (let i = 0; i < cap; i++) place(s, 0, 'infantry', 1);
    const late = place(s, 0, 'infantry', 0);
    s.move(0, [late.id], 1);
    run(s, CROSS_SECONDS * 2);
    assert.equal(late.region, 0);
    assert.equal(late.progress, 1);
  });

  it('every token counts toward the cap: passing through a full region of your own waits too', () => {
    const s = duel();
    clearBlobs(s);
    for (const r of [1, 2]) s.state.regions[r].owner = 0;
    const cap = s.stackCap(1);
    for (let i = 0; i < cap; i++) place(s, 0, 'infantry', 1);
    const late = place(s, 0, 'infantry', 0);
    s.move(0, [late.id], 2);
    run(s, CROSS_SECONDS * 3);
    assert.equal(late.region, 0, 'no slipping through a full region');
    // Waiting at the edge, it still takes a place where it is.
    assert.equal(s.count(0, 0), 1);
  });

  it('a unit waiting to leave still counts, so the region has no room for more', () => {
    const s = duel();
    clearBlobs(s);
    s.state.regions[1].owner = 0;
    s.state.regions[2].owner = 0;
    const cap = s.stackCap(2);
    for (let i = 0; i < cap; i++) place(s, 0, 'infantry', 2);
    for (let i = 0; i < s.stackCap(1); i++) place(s, 0, 'infantry', 1);
    const [leaving, other] = [...s.state.blobs.values()].filter((b) => b.region === 1);
    s.move(0, [leaving.id], 2);
    run(s, CROSS_SECONDS * 2);
    assert.equal(leaving.region, 1);
    assert.equal(leaving.progress, 1);
    assert.match(s.split(0, other.id) ?? '', /no room/);
  });

  it('full regions swapping units do not jam', () => {
    const s = duel();
    clearBlobs(s);
    s.state.regions[1].owner = 0;
    s.state.regions[2].owner = 0;
    for (let i = 0; i < s.stackCap(1); i++) place(s, 0, 'infantry', 1);
    for (let i = 0; i < s.stackCap(2); i++) place(s, 0, 'infantry', 2);
    const a = [...s.state.blobs.values()].find((b) => b.region === 1) as Blob;
    const b = [...s.state.blobs.values()].find((x) => x.region === 2) as Blob;
    s.move(0, [a.id], 2);
    s.move(0, [b.id], 1);
    run(s, CROSS_SECONDS * 2);
    assert.equal(a.region, 2);
    assert.equal(b.region, 1);
  });
});

describe('surrender', () => {
  it('ends the country like a fallen capital; the last one standing wins', () => {
    const s = duel();
    assert.equal(s.surrender(0), null);
    assert.equal(s.state.players[0].alive, false);
    assert.ok(s.state.regions.every((r) => r.owner !== 0));
    assert.ok([...s.state.blobs.values()].every((b) => b.owner !== 0));
    assert.equal(s.state.winner, 1);
    assert.ok(s.drainEvents().some((e) => e.kind === 'eliminated' && e.player === 0 && e.surrendered));
    assert.match(s.surrender(0) ?? '', /already out/);
  });
});

describe('battles', () => {
  it('units in a fight can only retreat, never slip past the enemy', () => {
    const s = duel();
    clearBlobs(s);
    s.declareWar(1, 0);
    s.state.regions[2].owner = 0;
    s.state.regions[3].owner = 1;
    place(s, 0, 'infantry', 2);
    const attacker = place(s, 1, 'infantry', 2);
    attacker.from = 3;
    assert.ok(s.contested(2));
    assert.match(s.move(1, [attacker.id], 0) ?? '', /only retreat/);
    assert.deepEqual(attacker.path, [], 'it stays and fights');
    const before = attacker.strength;
    assert.equal(s.move(1, [attacker.id], 3), null, 'back the way it came');
    assert.deepEqual(attacker.path, [3]);
    assert.ok(attacker.strength < before, 'retreating costs');
  });

  it('a unit pulling out of a fight can change its way out, but not turn forward', () => {
    const s = duel();
    clearBlobs(s);
    s.declareWar(1, 0);
    s.state.regions[2].owner = 0;
    s.state.regions[3].owner = 1;
    place(s, 0, 'infantry', 2);
    const attacker = place(s, 1, 'infantry', 2);
    attacker.from = 3;
    assert.equal(s.move(1, [attacker.id], 3), null);
    run(s, 0.5);
    assert.ok(attacker.progress > 0);
    assert.match(s.move(1, [attacker.id], 0) ?? '', /only retreat/);
    assert.deepEqual(attacker.path, [3], 'still pulling out');
    assert.ok(attacker.progress > 0);
  });

  it('a fort lets an equal defender win', () => {
    const s = duel();
    clearBlobs(s);
    for (const r of [3, 4, 5]) s.state.regions[r].owner = 1; // supplied from B's capital
    s.state.regions[3].fort = 2;
    const def = place(s, 1, 'infantry', 3);
    const att = place(s, 0, 'infantry', 2);
    s.state.regions[2].owner = 0;
    s.move(0, [att.id], 3);
    run(s, 120);
    assert.ok(!s.state.blobs.has(att.id), 'attacker destroyed');
    assert.ok(s.state.blobs.has(def.id));
    assert.equal(s.state.regions[3].owner, 1);
  });

  it('the winner captures the region afterwards', () => {
    const s = duel();
    clearBlobs(s);
    s.state.regions[3].owner = 1;
    const def = place(s, 1, 'infantry', 3, 4);
    const att = place(s, 0, 'infantry', 2, 20);
    s.state.regions[2].owner = 0;
    s.move(0, [att.id], 3);
    run(s, 90);
    assert.ok(!s.state.blobs.has(def.id));
    assert.equal(s.state.regions[3].owner, 0);
  });

  it('defenders behind a river take less damage', () => {
    const lose = (river: boolean) => {
      const map = makeMap([{}, {}], [[0, 1, { river }]], [{ id: 'A', capital: 0 }, { id: 'B', capital: 1 }]);
      const s = sim(map, ['A', 'B']);
      clearBlobs(s);
      const def = place(s, 1, 'infantry', 1, 10);
      const att = place(s, 0, 'infantry', 0, 10);
      s.move(0, [att.id], 1);
      run(s, CROSS_SECONDS + 5);
      return def.size - def.strength;
    };
    assert.ok(lose(true) < lose(false));
  });

  it('three sides spread their damage by strength', () => {
    const map = makeMap([{}], [], [{ id: 'A', capital: 0 }]);
    const s = sim(map, ['A']);
    clearBlobs(s);
    // Owners 0, 1, 2 (only 0 is a set-up player; the rules don't care for damage).
    s.state.players.push({ ...s.state.players[0], id: 1 }, { ...s.state.players[0], id: 2 });
    s.state.regions[0].owner = NEUTRAL;
    s.declareWar(0, 1);
    s.declareWar(0, 2);
    s.declareWar(1, 2);
    const a = place(s, 0, 'infantry', 0, 10);
    const b = place(s, 1, 'infantry', 0, 20);
    const c = place(s, 2, 'infantry', 0, 10);
    for (const x of [a, b, c]) x.supply = 1;
    // Damage only (no supply effects): run the battle step directly.
    (s as unknown as { battles(dt: number): void }).battles(0.1);
    const lossA = 10 - a.strength;
    const lossB = 20 - b.strength;
    const lossC = 10 - c.strength;
    // b is hit by a and c, which each send 2/3 of their damage to it (20 of 30 enemy strength).
    assert.ok(lossB > lossA && lossB > lossC);
    assert.ok(Math.abs(lossA - lossC) < 1e-9);
  });

  it('retreating costs strength', () => {
    const s = duel();
    clearBlobs(s);
    s.state.regions[3].owner = 1;
    s.declareWar(0, 1);
    place(s, 1, 'infantry', 3);
    const att = place(s, 0, 'infantry', 3);
    att.from = 2;
    s.tick(0.1);
    const before = att.strength;
    assert.equal(s.move(0, [att.id], 2), null);
    assert.ok(att.strength <= before * (1 - RETREAT_STRENGTH_LOSS) + 1e-9);
  });
});

describe('training, digging in, merging', () => {
  it('idle supplied blobs drill up to the cap and dig in', () => {
    const s = duel();
    clearBlobs(s);
    const b = place(s, 0, 'infantry', 0);
    run(s, ENTRENCH_SECONDS);
    assert.ok(b.entrench > 0.99);
    run(s, DRILL_CAP * 6 + 10);
    assert.equal(b.training, DRILL_CAP);
    s.move(0, [b.id], 1);
    s.tick(0.1);
    assert.equal(b.entrench, 0);
  });

  it('merging averages training by strength, minus a penalty, up to the size cap', () => {
    const s = duel();
    clearBlobs(s);
    const a = place(s, 0, 'infantry', 0, 10);
    const b = place(s, 0, 'infantry', 0, 15);
    a.training = 40;
    b.training = 20;
    assert.equal(s.merge(0, [a.id, b.id]), null);
    assert.equal(a.size, 25);
    assert.ok(!s.state.blobs.has(b.id), 'uneven units merge whole');
    const expected = (40 * 10 + 20 * 15) / 25 - MERGE_PENALTY;
    assert.ok(Math.abs(a.training - expected) < 1e-9);
    // Up to the cap, the rest stays behind; a full unit takes no more.
    const big = place(s, 0, 'infantry', 0, 95);
    const c = place(s, 0, 'infantry', 0, 10);
    assert.equal(s.merge(0, [big.id, c.id]), null);
    assert.equal(big.size, UNITS.infantry.maxSize);
    assert.equal(c.size, 5);
    assert.match(s.merge(0, [big.id, c.id]) ?? '', /already full/);
  });

  it('only same-type blobs merge; split halves keep their training', () => {
    const s = duel();
    clearBlobs(s);
    const a = place(s, 0, 'infantry', 0);
    const t = place(s, 0, 'tank', 0);
    assert.match(s.merge(0, [a.id, t.id]) ?? '', /same type/);
    s.state.blobs.delete(t.id);
    a.training = 30;
    assert.equal(s.split(0, a.id), null);
    const parts = [...s.state.blobs.values()];
    assert.equal(parts.length, 2);
    assert.deepEqual(
      parts.map((p) => p.size),
      [5, 5],
    );
    assert.ok(parts.every((p) => p.training === 30));
  });

  it('splits off any amount, kept between 1 and the size less one', () => {
    const s = duel();
    clearBlobs(s);
    const a = place(s, 0, 'infantry', 0);
    assert.equal(s.split(0, a.id, 3), null);
    assert.deepEqual([...s.state.blobs.values()].map((p) => p.size), [7, 3]);
    assert.equal(s.split(0, a.id, 50), null);
    assert.deepEqual([...s.state.blobs.values()].map((p) => p.size), [1, 3, 6]);
  });
});

describe('supply', () => {
  it('a city supplies 3 + its level regions away (the capital starts at level 3)', () => {
    const SUPPLY_RANGE = supplyReach(START_CAPITAL_LEVEL);
    const n = SUPPLY_RANGE + 3;
    const map = makeMap(Array.from({ length: n }, () => ({})), chain(n), [{ id: 'A', capital: 0 }]);
    const s = sim(map, ['A']);
    for (let i = 0; i < n; i++) s.state.regions[i].owner = 0;
    s.tick(0.1);
    assert.ok(s.state.regions[SUPPLY_RANGE].supplied);
    assert.ok(!s.state.regions[SUPPLY_RANGE + 1].supplied);
  });

  it('cut-off empty regions go neutral; cut-off blobs wither', () => {
    const s = duel();
    clearBlobs(s);
    // A owns 0..1 and an island of 3..4 it can't reach (2 is neutral).
    s.state.regions[3].owner = 0;
    s.state.regions[4].owner = 0;
    const b = place(s, 0, 'infantry', 4);
    run(s, CUT_OFF_SECONDS + 1);
    assert.equal(s.state.regions[3].owner, NEUTRAL);
    assert.equal(s.state.regions[4].owner, 0, 'held while a blob is there');
    assert.equal(b.supply, 0);
    assert.ok(b.strength < b.size);
  });

  it('too many blobs for the capacity get partial supply; a bigger city helps', () => {
    const s = duel();
    clearBlobs(s);
    const cap = s.stackCap(0);
    for (let i = 0; i < cap; i++) place(s, 0, 'tank', 0, UNITS.tank.maxSize);
    s.tick(0.1);
    const b = [...s.state.blobs.values()][0];
    const before = b.supply;
    assert.ok(before > 0 && before < 1);
    s.state.regions[0].city += 2;
    s.tick(0.1);
    assert.ok(b.supply > before);
  });
});

describe('economy', () => {
  it('earns from regions and traits, and pays upkeep', () => {
    const map = makeMap([{ traits: ['industry'] }, { traits: ['oil'] }], chain(2), [{ id: 'A', capital: 0 }]);
    const s = sim(map, ['A']);
    clearBlobs(s);
    const p = s.state.players[0];
    const before = { ...p.resources };
    run(s, 10);
    assert.ok(p.resources.steel > before.steel);
    assert.ok(p.resources.oil > before.oil);
    assert.ok(p.resources.money > before.money);
    place(s, 0, 'infantry', 0);
    s.tick(0.1);
    assert.ok(p.upkeep > 0);
  });

  it('broke countries see their blobs wither', () => {
    const s = duel();
    clearBlobs(s);
    const p = s.state.players[0];
    for (let i = 0; i < 20; i++) place(s, 0, 'tank', 0, UNITS.tank.maxSize).supply = 1;
    p.resources.money = 0;
    s.tick(0.1);
    assert.ok(p.broke);
  });

  it('builds over time, and factories only where industry or a city is', () => {
    const s = duel();
    rich(s);
    assert.match(s.build(0, 1, 'factory') ?? '', /needs a city/);
    assert.equal(s.build(0, 1, 'fort'), null);
    run(s, buildCost('fort', 1).seconds - 1);
    assert.equal(s.state.regions[1].fort, 0);
    run(s, 2);
    assert.equal(s.state.regions[1].fort, 1);
  });

  it('queues builds behind the one under way, paid up front, levels counting up', () => {
    const s = duel();
    rich(s);
    const p = s.state.players[0];
    const rs = s.state.regions[0];
    const money = p.resources.money;
    assert.equal(s.build(0, 0, 'fort'), null);
    assert.equal(s.build(0, 0, 'fort'), null);
    assert.equal(s.build(0, 0, 'fort'), null);
    assert.deepEqual([rs.construction?.level, ...rs.buildQueue.map((c) => c.level)], [1, 2, 3]);
    const paid = [1, 2, 3].reduce((sum, l) => sum + buildCost('fort', l).cost.money, 0);
    assert.equal(money - p.resources.money, paid);
    assert.match(s.build(0, 0, 'fort') ?? '', /highest level/);
    assert.equal(s.build(0, 0, 'market'), null);
    assert.match(s.build(0, 0, 'road', 1) ?? '', /queue is full/);
    run(s, buildCost('fort', 1).seconds + 0.5);
    assert.equal(rs.fort, 1);
    assert.equal(rs.construction?.level, 2);
    assert.equal(rs.buildQueue.length, 2);
  });

  it('cancelling a build refunds it and the later levels it led to, then starts the next', () => {
    const s = duel();
    rich(s);
    const p = s.state.players[0];
    const rs = s.state.regions[0];
    s.build(0, 0, 'fort');
    s.build(0, 0, 'market');
    s.build(0, 0, 'fort');
    run(s, 5);
    const money = p.resources.money;
    assert.equal(s.unbuild(0, 0, 0), null);
    assert.equal(p.resources.money - money, buildCost('fort', 1).cost.money + buildCost('fort', 2).cost.money);
    assert.equal(rs.construction?.kind, 'market');
    assert.equal(rs.construction?.progress, 0);
    assert.equal(rs.buildQueue.length, 0);
    assert.match(s.unbuild(0, 0, 1) ?? '', /nothing to cancel/);
    assert.match(s.unbuild(1, 0, 0) ?? '', /not your region/);
  });

  it('a captured region loses its builds', () => {
    const s = duel();
    rich(s);
    s.build(0, 1, 'fort');
    s.build(0, 1, 'market');
    s.declareWar(1, 0);
    clearBlobs(s);
    place(s, 1, 'infantry', 1);
    run(s, 30);
    assert.equal(s.state.regions[1].owner, 1);
    assert.equal(s.state.regions[1].construction, null);
    assert.deepEqual(s.state.regions[1].buildQueue, []);
  });

  it('produces queued blobs, with repeat', () => {
    const s = duel();
    clearBlobs(s);
    rich(s);
    assert.equal(s.produce(0, 0, 'barracks'), null);
    assert.equal(s.setRepeat(0, 0, 'barracks', true), null);
    run(s, UNITS.infantry.buildTime + 0.5);
    assert.equal(s.count(0, 0), 1);
    run(s, UNITS.infantry.buildTime);
    assert.equal(s.count(0, 0), 2);
    assert.match(s.produce(0, 1, 'barracks') ?? '', /no barracks/);
  });

  it('refills strength in supply, paying manpower', () => {
    const s = duel();
    clearBlobs(s);
    const b = place(s, 0, 'infantry', 0);
    b.strength = 5;
    const mp = s.state.players[0].resources.manpower;
    run(s, 5);
    assert.ok(b.strength > 5);
    assert.ok(s.state.players[0].resources.manpower < mp + 5 * 0.3 * 2);
  });
});

describe('development', () => {
  /** A chain of `n` medium plains regions, all A's; the capital (region 0) is a city. */
  function land(n: number, specs: Array<Parameters<typeof makeMap>[0][number]> = []) {
    const map = makeMap(
      Array.from({ length: n }, (_, i) => ({ country: 'A', ...specs[i] })),
      chain(n),
      [{ id: 'A', capital: 0 }],
    );
    const s = sim(map, ['A']);
    clearBlobs(s);
    for (let i = 0; i < n; i++) s.state.regions[i].owner = 0;
    rich(s);
    s.tick(0.1);
    return s;
  }
  /** Runs until builds are done; land cut off meanwhile (and so lost) is given back. */
  const finish = (s: ReturnType<typeof land>) => {
    run(s, 400);
    for (const rs of s.state.regions) rs.owner = 0;
    s.tick(0.1);
  };

  it('slots come from region size, plus the city level', () => {
    const s = land(3, [{}, { size: 'small' }, { size: 'large' }]);
    assert.equal(s.build(0, 1, 'market'), null);
    assert.match(s.build(0, 1, 'market') ?? '', /no free slot/);
    for (let i = 0; i < 2; i++) assert.equal(s.build(0, 2, 'market'), null);
    assert.match(s.build(0, 2, 'farm') ?? '', /no free slot/);
    // Capital: medium (2) + city level 3, minus the barracks.
    assert.equal(s.state.regions[0].city, START_CAPITAL_LEVEL);
    assert.equal(s.slotsUsed(s.state.regions[0]), 1);
  });

  it('economic buildings only near your cities, and only on fitting land', () => {
    const s = land(5, [{}, { terrain: 'hills' }, {}, {}, {}]);
    assert.equal(s.build(0, 2, 'market'), null);
    assert.match(s.build(0, 3, 'market') ?? '', /within 2 regions/);
    assert.match(s.build(0, 1, 'farm') ?? '', /farmland or plains/);
    assert.equal(s.build(0, 1, 'mine'), null);
    assert.match(s.build(0, 2, 'well') ?? '', /oil field/);
    assert.match(s.build(0, 2, 'barracks') ?? '', /needs a city/);
  });

  it('markets raise income', () => {
    const s = land(2);
    const before = s.state.players[0].income.money;
    s.build(0, 1, 'market');
    finish(s);
    assert.equal(s.state.regions[1].econ.market, 1);
    assert.ok(Math.abs(s.state.players[0].income.money - before - 0.4) < 1e-9);
  });

  it('expanding a city raises tax, slots, stack cap and supply reach; forts raise stack cap', () => {
    const s = land(2);
    const p = s.state.players[0];
    const cap0 = s.stackCap(0);
    const money0 = p.income.money;
    assert.equal(s.build(0, 0, 'city'), null);
    finish(s);
    assert.equal(s.state.regions[0].city, START_CAPITAL_LEVEL + 1);
    assert.equal(s.stackCap(0), cap0 + 1);
    assert.ok(Math.abs(p.income.money - money0 - 0.6) < 1e-9);
    assert.equal(supplyReach(s.state.regions[0].city), supplyReach(START_CAPITAL_LEVEL) + 1);
    const cap1 = s.stackCap(1);
    s.build(0, 1, 'fort');
    s.build(0, 1, 'fort');
    finish(s);
    assert.equal(s.stackCap(1), cap1 + 2);
  });

  it('cities of countries nobody plays start small; capitals start at least at 3', () => {
    const map = makeMap(
      [{ country: 'A', city: 1 }, { country: 'A', city: 4 }, { country: 'C', city: 4 }],
      chain(3),
      [{ id: 'A', capital: 0 }],
    );
    const s = sim(map, ['A']);
    assert.deepEqual(s.state.regions.map((r) => r.city), [START_CAPITAL_LEVEL, 4, 1]);
  });

  it('founds a city away from others, which becomes a supply hub', () => {
    const s = land(14);
    assert.match(s.build(0, 1, 'city') ?? '', /too close/);
    // Region 6 is at the edge of the capital's reach; 7 and beyond are cut off.
    assert.ok(s.state.regions[6].supplied);
    assert.ok(!s.state.regions[7].supplied);
    assert.equal(s.build(0, 6, 'city'), null);
    finish(s);
    assert.equal(s.state.regions[6].city, 1);
    assert.ok(s.state.regions[10].supplied, 'a level-1 city reaches 4');
    assert.ok(!s.state.regions[11].supplied);
  });

  it('roads speed up the crossing and carry supply further', () => {
    const s = land(9);
    const slow = s.travelSeconds('infantry', 0, 1, 2);
    assert.ok(!s.state.regions[7].supplied);
    for (let i = 0; i < 6; i++) assert.equal(s.build(0, i, 'road', i + 1), null);
    assert.match(s.build(0, 1, 'road', 0) ?? '', /road already/);
    finish(s);
    assert.ok(Math.abs(s.travelSeconds('infantry', 0, 1, 2) - slow * 0.6) < 1e-9);
    assert.ok(s.state.regions[7].supplied && s.state.regions[8].supplied, 'six road hops cost three');
  });

  it('demolishing frees the slot at once, with no refund', () => {
    const s = land(2, [{}, { size: 'large' }]);
    s.build(0, 1, 'market');
    s.build(0, 1, 'market');
    finish(s);
    const money = s.state.players[0].resources.money;
    assert.equal(s.demolish(0, 1, 'market'), null);
    assert.equal(s.state.regions[1].econ.market, 1);
    assert.ok(s.state.players[0].resources.money <= money);
    assert.equal(s.build(0, 1, 'market'), null);
    assert.match(s.demolish(0, 1, 'city') ?? '', /can't be demolished/);
  });

  it('captured land keeps its buildings', () => {
    const s = duel();
    rich(s);
    s.build(0, 1, 'market');
    run(s, buildCost('market').seconds + 5);
    s.declareWar(1, 0);
    clearBlobs(s);
    place(s, 1, 'infantry', 1);
    run(s, 30);
    assert.equal(s.state.regions[1].owner, 1);
    assert.equal(s.state.regions[1].econ.market, 1);
  });
});

describe('capitals', () => {
  it('taking a capital eliminates its country and ends a two-player game', () => {
    const s = duel();
    clearBlobs(s);
    s.state.regions[6].owner = 0;
    const b = place(s, 0, 'infantry', 6);
    s.move(0, [b.id], 7);
    run(s, 40);
    const p1 = s.state.players[1];
    assert.equal(p1.alive, false);
    assert.equal(s.state.regions[7].owner, 0);
    assert.equal(s.state.winner, 0);
    assert.ok(![...s.state.blobs.values()].some((x) => x.owner === 1));
    const events = s.drainEvents().map((e) => e.kind);
    assert.ok(events.includes('eliminated') && events.includes('won'));
  });
});
