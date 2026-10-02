// Debug picture of a built map: terrain, region borders, river borders (blue), label points
// (red = city). Usage: node scripts/preview-map.ts [borders|terrain] out.png
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { decodeGrid, WATER } from '../shared/map.ts';
const dir = new URL('../public/maps/', import.meta.url).pathname;
const map = JSON.parse(readFileSync(dir + 'europe.json', 'utf8'));
const img = PNG.sync.read(readFileSync(dir + 'europe-terrain.png'));
const g = decodeGrid(map.grid, map.width * map.height);
const W = map.width;
const mode = process.argv[2] ?? 'borders';
const tcol: Record<string, number[]> = { plains: [200, 220, 120], forest: [40, 120, 50], hills: [170, 130, 70], mountains: [120, 100, 100] };
for (let i = 0; i < g.length; i++) {
  const r = g[i];
  if (r === WATER) continue;
  const x = i % W;
  if (mode === 'terrain') { const c = tcol[map.regions[r].terrain]; img.data.set(c, i * 4); }
  const edge = (x < W - 1 && g[i + 1] !== r) || (i + W < g.length && g[i + W] !== r);
  if (edge) img.data.set([20, 20, 20], i * 4);
}
for (const r of map.regions) for (const n of r.neighbors) if (n.river) {
  const o = map.regions[n.id];
  for (let t = 0; t <= 1; t += 0.02) { const x = Math.round(r.x + (o.x - r.x) * t), y = Math.round(r.y + (o.y - r.y) * t); img.data.set([0, 80, 255], (y * W + x) * 4); }
}
for (const r of map.regions) for (let d = -2; d <= 2; d++) for (let e = -2; e <= 2; e++) img.data.set(r.traits.includes('city') ? [255, 0, 0] : [255, 255, 255], ((r.y + d) * W + r.x + e) * 4);
writeFileSync(process.argv[3], PNG.sync.write(img));
