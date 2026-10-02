import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { decodeGrid, encodeGrid, type GameMap, WATER } from '../shared/map.ts';

describe('map grid encoding', () => {
  it('round-trips region ids above 255 and long runs', () => {
    const cells = new Uint16Array(70_000);
    cells.fill(WATER, 0, 1000);
    cells.fill(300, 1000, 1001);
    cells.fill(12, 1001, 66_000);
    cells.fill(65_000, 66_000);
    assert.deepEqual(decodeGrid(encodeGrid(cells), cells.length), cells);
  });

  it('the Europe map decodes, and every region has pixels', () => {
    const map: GameMap = JSON.parse(readFileSync(new URL('../public/maps/europe.json', import.meta.url), 'utf8'));
    const grid = decodeGrid(map.grid, map.width * map.height);
    const seen = new Set<number>();
    for (const r of grid) if (r !== WATER) seen.add(r);
    assert.equal(seen.size, map.regions.length);
    assert.ok(map.regions.length > 255, 'needs 16-bit ids');
  });
});
