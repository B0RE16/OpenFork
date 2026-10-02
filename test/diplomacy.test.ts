import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PEACE_OFFER_SECONDS, TRUCE_SECONDS } from '../shared/rules.ts';
import { NEUTRAL } from '../server/core/state.ts';
import { clearBlobs, makeMap, place, run, sim } from './helpers.ts';

/**
 *   0(A) - 1(B land) - 2 - 5(B capital)
 *     \               /
 *      3 ---------- 4
 */
function setup() {
  const map = makeMap(
    Array.from({ length: 6 }, () => ({})),
    [
      [0, 1],
      [1, 2],
      [2, 5],
      [0, 3],
      [3, 4],
      [4, 2],
    ],
    [
      { id: 'A', capital: 0 },
      { id: 'B', capital: 5 },
    ],
  );
  const s = sim(map, ['A', 'B']);
  clearBlobs(s);
  for (let r = 0; r < 6; r++) s.state.regions[r].owner = NEUTRAL;
  s.state.regions[0].owner = 0;
  s.state.regions[1].owner = 1;
  s.state.regions[5].owner = 1;
  return s;
}

describe('diplomacy', () => {
  it('everyone starts at peace; peaceful units share neutral land without fighting', () => {
    const s = setup();
    assert.equal(s.atWar(0, 1), false);
    s.state.regions[3].owner = 0; // so A's unit in 2 is supplied (via 4)
    s.state.regions[4].owner = 0;
    const a = place(s, 0, 'infantry', 2);
    const b = place(s, 1, 'infantry', 2);
    for (const x of [a, b]) x.supply = 1;
    run(s, 2);
    assert.equal(a.strength, a.size);
    assert.equal(b.strength, b.size);
    assert.equal(s.contested(2), false);
    run(s, 20);
    assert.ok(s.state.regions[2].owner !== NEUTRAL, 'one of them took it');
  });

  it('routes go around land of countries at peace', () => {
    const s = setup();
    const route = s.route('infantry', 0, 0, 0, 2);
    assert.deepEqual(route, [3, 4, 2]);
  });

  it('sending units into a peaceful country starts a war', () => {
    const s = setup();
    const a = place(s, 0, 'infantry', 0);
    assert.equal(s.move(0, [a.id], 1), null);
    assert.equal(s.atWar(0, 1), true);
    assert.ok(s.drainEvents().some((e) => e.kind === 'war' && e.by === 0));
    assert.deepEqual(a.path, [1]);
  });

  it('peace: offered, accepted, units go home, and a truce holds', () => {
    const s = setup();
    s.state.regions[2].owner = 1; // B's region 1 stays connected to its capital
    const a = place(s, 0, 'infantry', 0);
    s.move(0, [a.id], 1);
    run(s, 9); // arrived, still capturing
    assert.equal(a.region, 1);
    assert.equal(s.state.regions[1].owner, 1);
    assert.equal(s.offerPeace(1, 0), null);
    assert.ok(s.drainEvents().some((e) => e.kind === 'peaceOffer'));
    assert.equal(s.offerPeace(0, 1), null); // accepting
    assert.equal(s.atWar(0, 1), false);
    assert.ok(a.path.length > 0, 'heading home');
    run(s, 30);
    assert.equal(s.state.regions[a.region].owner, 0, 'back on its own land');
    assert.match(s.declareWar(0, 1) ?? '', /truce/);
    run(s, TRUCE_SECONDS);
    assert.equal(s.declareWar(0, 1), null);
  });

  it('offers can be refused, and lapse', () => {
    const s = setup();
    s.declareWar(0, 1);
    s.offerPeace(1, 0);
    assert.equal(s.refusePeace(0, 1), null);
    assert.equal(s.atWar(0, 1), true);
    s.offerPeace(1, 0);
    run(s, PEACE_OFFER_SECONDS + 1);
    assert.equal(s.state.peaceOffers.size, 0);
    assert.equal(s.atWar(0, 1), true);
  });
});
