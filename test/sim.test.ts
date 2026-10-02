import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CROSS_SECONDS,
  CUT_OFF_SECONDS,
  DRILL_CAP,
  ENTRENCH_SECONDS,
  MERGE_PENALTY,
  RETREAT_STRENGTH_LOSS,
  START_INFANTRY,
  SUPPLY_RANGE,
  UNITS,
} from '../shared/rules.ts';
import { NEUTRAL } from '../server/core/state.ts';
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
});

describe('battles', () => {
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
    s.tick(0.1);
    const before = att.strength;
    s.move(0, [att.id], 2);
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
    assert.equal(a.size, UNITS.infantry.maxSize);
    assert.ok(s.state.blobs.has(b.id), 'the rest stays behind');
    assert.equal(b.size, 5);
    const expected = (40 * 10 + 20 * 10) / 20 - MERGE_PENALTY;
    assert.ok(Math.abs(a.training - expected) < 1e-9);
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
});

describe('supply', () => {
  it('reaches SUPPLY_RANGE regions from a hub', () => {
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

  it('too many blobs for the capacity get partial supply; infrastructure helps', () => {
    const s = duel();
    clearBlobs(s);
    const cap = s.stackCap(0);
    for (let i = 0; i < cap; i++) place(s, 0, 'tank', 0, UNITS.tank.maxSize);
    s.tick(0.1);
    const b = [...s.state.blobs.values()][0];
    const before = b.supply;
    assert.ok(before > 0 && before < 1);
    s.state.regions[0].infra = 1;
    s.tick(0.1);
    assert.ok(b.supply > before);
  });
});

describe('economy', () => {
  it('earns from regions and traits, and pays upkeep', () => {
    const map = makeMap([{ traits: ['city', 'industry'] }, { traits: ['oil'] }], chain(2), [{ id: 'A', capital: 0 }]);
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
    assert.match(s.build(0, 1, 'factory') ?? '', /can't build/);
    assert.equal(s.build(0, 1, 'fort'), null);
    assert.match(s.build(0, 1, 'infra') ?? '', /already building/);
    run(s, 19);
    assert.equal(s.state.regions[1].fort, 0);
    run(s, 2);
    assert.equal(s.state.regions[1].fort, 1);
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
