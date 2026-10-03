// Builds public/maps/europe.json and public/maps/europe-terrain.png from open data
// (see scripts/map/sources.ts for sources and licences). Run: npm run build:map
//
// 1. Rasterise Natural Earth provinces onto an equal-area pixel grid; keep the mainland.
// 2. Merge provinces within each country, fold in micro-states and split giants until there
//    are ~140 regions.
// 3. Work out each region's terrain (elevation + land cover), traits, size, label point and
//    neighbours (with river borders).
// 4. Paint the terrain picture: land cover colours, hill shading, water depth, rivers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import {
  encodeGrid,
  type Country,
  type GameMap,
  type Neighbor,
  type Region,
  type RegionSize,
  type Terrain,
  type Trait,
  WATER,
} from '../shared/map.ts';
import { INCLUDE, INDUSTRY, MAX_LON, OIL, PLAYABLE, RUSSIA_MAX_LABEL_LON, TURKEY_KEEP, TURKEY_MAX_LON } from './map/europe.ts';
import { drawLine, fillPolygon, Grid, Laea, lines, polygons } from './map/geo.ts';
import { Elevation, LandCover, naturalEarth } from './map/sources.ts';

const KM = 3; // km per pixel
const TARGET_REGIONS = 300;
const AREA_EXPONENT = 0.75; // how strongly a country's area sets its share of regions
const MIN_FRACTION = 0.3; // regions smaller than this × median are merged away
const SPLIT_FRACTION = 1.7; // regions bigger than this × their country's average are split
const RIVER_SCALERANK = 7; // Natural Earth rivers at least this major
const OUT = new URL('../public/maps/', import.meta.url).pathname;

const t0 = performance.now();
const log = (m: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// -- 1. provinces onto pixels ---------------------------------------------------------------

const proj = new Laea(24, 54);
// A generous window, cropped to the mainland later.
const full = new Grid(proj, -3200, 2300, Math.round(6000 / KM), Math.round(4700 / KM), KM);

interface Unit {
  name: string;
  country: string;
  admin: string;
  neRegion: string;
}

const admin1 = await naturalEarth('ne_10m_admin_1_states_provinces');
const units: Unit[] = [];
const unitOf = new Int32Array(full.width * full.height).fill(-1);
for (const f of admin1) {
  const p = f.properties;
  const iso = String(p.iso_a2 === '-1' || p.iso_a2 === '-99' ? (p.adm0_a3 === 'KOS' ? 'XK' : p.iso_a2) : p.iso_a2);
  if (!INCLUDE.has(iso)) continue;
  const name = String(p.name ?? p.name_en ?? '?');
  if (iso === 'TR' && !TURKEY_KEEP.has(name)) continue;
  if (iso === 'RU' && Number(p.longitude) > RUSSIA_MAX_LABEL_LON) continue;
  const id = units.length;
  units.push({ name, country: iso, admin: String(p.admin), neRegion: String(p.region ?? '') });
  for (const rings of polygons(f.geometry)) fillPolygon(full, rings, (i) => {
    if (unitOf[i] === -1) unitOf[i] = id;
  });
}
log(`${units.length} provinces rasterised`);

// Lakes are water; nothing east of the Urals or Bosporus.
const lakes = await naturalEarth('ne_10m_lakes');
for (const f of lakes) for (const rings of polygons(f.geometry)) fillPolygon(full, rings, (i) => (unitOf[i] = -1));
for (let i = 0; i < unitOf.length; i++) {
  if (unitOf[i] === -1) continue;
  const [lon] = full.toLonLat(i % full.width, Math.floor(i / full.width));
  if (lon > MAX_LON || (units[unitOf[i]].country === 'TR' && lon > TURKEY_MAX_LON)) unitOf[i] = -1;
}

// Keep the largest 4-connected landmass: islands wait for naval.
{
  const comp = new Int32Array(unitOf.length).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < unitOf.length; s++) {
    if (unitOf[s] === -1 || comp[s] !== -1) continue;
    const c = sizes.length;
    let n = 0;
    comp[s] = c;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop() as number;
      n++;
      for (const j of neighbors4(i, full.width, full.height)) {
        if (unitOf[j] !== -1 && comp[j] === -1) {
          comp[j] = c;
          stack.push(j);
        }
      }
    }
    sizes.push(n);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  for (let i = 0; i < unitOf.length; i++) if (comp[i] !== main) unitOf[i] = -1;
  log(`mainland: ${sizes[main]} px (dropped ${sizes.length - 1} islands)`);
}

// Crop to the land plus a margin.
let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
for (let i = 0; i < unitOf.length; i++) {
  if (unitOf[i] === -1) continue;
  const x = i % full.width;
  const y = Math.floor(i / full.width);
  minX = Math.min(minX, x);
  maxX = Math.max(maxX, x);
  minY = Math.min(minY, y);
  maxY = Math.max(maxY, y);
}
const M = 12;
const grid = full.crop(minX - M, minY - M, maxX - minX + 1 + 2 * M, maxY - minY + 1 + 2 * M);
const W = grid.width;
const H = grid.height;
const N = W * H;
const owner = new Int32Array(N).fill(-1); // group id per pixel
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) owner[y * W + x] = unitOf[(y + minY - M) * full.width + (x + minX - M)];
}
log(`grid ${W}×${H} at ${KM} km/px`);

// -- 2. merge and split ---------------------------------------------------------------------

interface Group {
  country: string;
  neRegion: string;
  name: string;
  area: number;
  border: Map<number, number>;
}

let groups = new Map<number, Group>();
function rebuildGroups(): void {
  const old = groups;
  groups = new Map();
  for (let i = 0; i < N; i++) {
    const g = owner[i];
    if (g === -1) continue;
    let G = groups.get(g);
    if (!G) {
      const prev = old.get(g);
      const u = units[g];
      G = prev
        ? { ...prev, area: 0, border: new Map() }
        : { country: u.country, neRegion: u.neRegion, name: u.name, area: 0, border: new Map() };
      groups.set(g, G);
    }
    G.area++;
    for (const j of neighbors4(i, W, H)) {
      const h = owner[j];
      if (h !== -1 && h !== g) G.border.set(h, (G.border.get(h) ?? 0) + 1);
    }
  }
}

// Merges are recorded here and applied to the pixels by relabel().
const mergedInto = new Map<number, number>();
const find = (g: number): number => {
  let r = g;
  while (mergedInto.has(r)) r = mergedInto.get(r) as number;
  return r;
};
function relabel(): void {
  for (let i = 0; i < N; i++) if (owner[i] !== -1) owner[i] = find(owner[i]);
  mergedInto.clear();
}

/** Folds group b into group a (area and borders; pixels on relabel()). */
function merge(a: number, b: number): void {
  const A = groups.get(a) as Group;
  const B = groups.get(b) as Group;
  mergedInto.set(b, a);
  if (B.area > A.area) {
    A.name = B.name;
    A.neRegion = B.neRegion;
    A.country = B.country;
  }
  A.area += B.area;
  for (const [h, n] of B.border) {
    if (h === a) continue;
    A.border.set(h, (A.border.get(h) ?? 0) + n);
    const H = groups.get(h) as Group;
    H.border.set(a, (H.border.get(a) ?? 0) + n);
    H.border.delete(b);
  }
  A.border.delete(b);
  groups.delete(b);
}

rebuildGroups();
/** Average region area each country is aiming for. */
const aimArea = new Map<string, number>();
{
  // Each country's share of regions grows with its area, but less than linearly.
  const area = new Map<string, number>();
  for (const g of groups.values()) area.set(g.country, (area.get(g.country) ?? 0) + g.area);
  const weight = (c: string) => (area.get(c) as number) ** AREA_EXPONENT;
  const total = [...area.keys()].reduce((s, c) => s + weight(c), 0);
  for (const [country] of area) {
    const target = Math.max(1, Math.round((TARGET_REGIONS * weight(country)) / total));
    aimArea.set(country, (area.get(country) as number) / target);
    const stuck = new Set<number>();
    for (;;) {
      const mine = [...groups].filter(([id, g]) => g.country === country && !stuck.has(id));
      const count = [...groups.values()].filter((g) => g.country === country).length;
      if (count <= target || mine.length === 0) break;
      const [id, g] = mine.reduce((a, b) => (b[1].area < a[1].area ? b : a));
      let best = -1;
      let bestCost = Infinity;
      for (const [h, n] of g.border) {
        const H = groups.get(h) as Group;
        if (H.country !== country) continue;
        const cost = (H.area * (H.neRegion === g.neRegion ? 1 : 1.6)) / Math.sqrt(n);
        if (cost < bestCost) {
          bestCost = cost;
          best = h;
        }
      }
      if (best === -1) stuck.add(id);
      else merge(best, id);
    }
  }
}
log(`${groups.size} regions after merging within countries`);

const median = () => {
  const a = [...groups.values()].map((g) => g.area).sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

// Micro-states and slivers join the neighbour they share the longest border with.
function absorbSmall(): void {
  const min = median() * MIN_FRACTION;
  for (;;) {
    const small = [...groups].filter(([, g]) => g.area < min).sort((a, b) => a[1].area - b[1].area)[0];
    if (!small) break;
    const [id, g] = small;
    const [into] = [...g.border].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (into === undefined) break;
    merge(into, id);
  }
}
absorbSmall();
relabel();

// Giants are split into compact parts: k-means seeds, then grown outward together.
{
  let next = Math.max(...groups.keys()) + 1;
  for (const [id, g] of [...groups]) {
    const aim = aimArea.get(g.country) as number;
    if (g.area <= aim * SPLIT_FRACTION) continue;
    const k = Math.round(g.area / aim);
    const px: number[] = [];
    for (let i = 0; i < N; i++) if (owner[i] === id) px.push(i);
    const seeds = kmeans(px, k, W);
    const part = new Map<number, number>();
    const queue: number[] = [];
    seeds.forEach((s, n) => {
      part.set(s, n);
      queue.push(s);
    });
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      for (const j of neighbors4(i, W, H)) {
        if (owner[j] === id && !part.has(j)) {
          part.set(j, part.get(i) as number);
          queue.push(j);
        }
      }
    }
    const ids = seeds.map((_, n) => (n === 0 ? id : next++));
    for (const i of px) owner[i] = ids[part.get(i) ?? 0];
    for (const nid of ids.slice(1)) units[nid] = { ...units[id], name: g.name };
    log(`split ${g.name} (${g.country}) into ${k}`);
  }
  rebuildGroups();
}

// Each region must be one piece: stray pieces join the neighbour they touch most.
{
  const comp = new Int32Array(N).fill(-1);
  const pieces: Array<{ group: number; px: number[] }> = [];
  for (let s = 0; s < N; s++) {
    if (owner[s] === -1 || comp[s] !== -1) continue;
    const g = owner[s];
    const px = [s];
    comp[s] = pieces.length;
    for (let q = 0; q < px.length; q++) {
      for (const j of neighbors4(px[q], W, H)) {
        if (owner[j] === g && comp[j] === -1) {
          comp[j] = pieces.length;
          px.push(j);
        }
      }
    }
    pieces.push({ group: g, px });
  }
  const largest = new Map<number, number>();
  for (const p of pieces) largest.set(p.group, Math.max(largest.get(p.group) ?? 0, p.px.length));
  let moved = 0;
  for (const p of pieces) {
    if (p.px.length === largest.get(p.group)) continue;
    const touch = new Map<number, number>();
    for (const i of p.px) {
      for (const j of neighbors4(i, W, H)) {
        if (owner[j] !== -1 && owner[j] !== p.group) touch.set(owner[j], (touch.get(owner[j]) ?? 0) + 1);
      }
    }
    const [into] = [...touch].sort((a, b) => b[1] - a[1])[0] ?? [-1];
    for (const i of p.px) owner[i] = into;
    moved += p.px.length;
  }
  rebuildGroups();
  absorbSmall();
  relabel();
  log(`made regions contiguous (${moved} px moved); ${groups.size} regions`);
}

if (groups.size >= WATER) throw new Error(`too many regions (${groups.size})`);

// Number the regions 0..n-1.
const groupIds = [...groups.keys()];
const indexOf = new Map(groupIds.map((g, r) => [g, r]));
const regionOf = new Uint16Array(N).fill(WATER);
for (let i = 0; i < N; i++) if (owner[i] !== -1) regionOf[i] = indexOf.get(owner[i]) as number;
const R = groupIds.length;

// -- 3. what each region is like --------------------------------------------------------------

const elevation = new Elevation(6);
{
  const corners = [
    grid.toLonLat(0, 0),
    grid.toLonLat(W - 1, 0),
    grid.toLonLat(0, H - 1),
    grid.toLonLat(W - 1, H - 1),
    grid.toLonLat(W / 2, 0),
    grid.toLonLat(W / 2, H - 1),
  ];
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  await elevation.prefetch(Math.min(...lons) - 1, Math.min(...lats) - 1, Math.max(...lons) + 1, Math.min(84, Math.max(...lats) + 1));
}
const cover = await LandCover.open();
const elev = new Float32Array(N);
const lc = new Uint8Array(N * 3);
for (let i = 0; i < N; i++) {
  const [lon, lat] = grid.toLonLat(i % W, Math.floor(i / W));
  elev[i] = elevation.at(lon, lat);
  const c = cover.at(lon, lat);
  lc.set(c, i * 3);
}
log('sampled elevation and land cover');

// Land cover is masked coarsely at coasts (white); borrow the nearest real colour.
const isBlank = (i: number) => lc[i * 3] > 236 && lc[i * 3 + 1] > 236 && lc[i * 3 + 2] > 236;
{
  const queue: number[] = [];
  const fixed = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!isBlank(i) || elev[i] > 1600) {
      fixed[i] = 1;
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (const j of neighbors4(i, W, H)) {
      if (fixed[j]) continue;
      fixed[j] = 1;
      lc.copyWithin(j * 3, i * 3, i * 3 + 3);
      queue.push(j);
    }
  }
}

// Pixel terrain: mountains/hills from height and local relief, forest from land cover.
const relief = new Float32Array(N);
{
  const r = 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(H - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const e = elev[yy * W + Math.min(W - 1, Math.max(0, x + dx))];
          if (e < lo) lo = e;
          if (e > hi) hi = e;
        }
      }
      relief[y * W + x] = hi - lo;
    }
  }
}
const T_PLAINS = 0;
const T_FOREST = 1;
const T_HILLS = 2;
const T_MOUNTAINS = 3;
const terrainPx = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const e = elev[i];
  // Relief more than altitude: high but level plateaus (the Meseta) are plains.
  if (e > 1600 || relief[i] > 1000) terrainPx[i] = T_MOUNTAINS;
  else if (relief[i] > 300 || (e > 900 && relief[i] > 150)) terrainPx[i] = T_HILLS;
  else if (lc[i * 3] <= 172 && lc[i * 3 + 1] > lc[i * 3]) terrainPx[i] = T_FOREST;
  else terrainPx[i] = T_PLAINS;
}

// Rivers.
const riverPx = new Uint8Array(N);
const rivers = await naturalEarth('ne_10m_rivers_lake_centerlines');
for (const f of rivers) {
  if (Number(f.properties.scalerank) > RIVER_SCALERANK || f.properties.featurecla === 'Lake Centerline') continue;
  for (const line of lines(f.geometry)) drawLine(grid, line, (i) => (riverPx[i] = 1));
}

// Per-region stats, neighbours, label points.
const area = new Array<number>(R).fill(0);
const counts = Array.from({ length: R }, () => [0, 0, 0, 0]);
const sumLat = new Array<number>(R).fill(0);
const borders = Array.from({ length: R }, () => new Map<number, { n: number; river: number }>());
for (let i = 0; i < N; i++) {
  const r = regionOf[i];
  if (r === WATER) continue;
  area[r]++;
  counts[r][terrainPx[i]]++;
  sumLat[r] += grid.toLonLat(i % W, Math.floor(i / W))[1];
  for (const j of neighbors4(i, W, H)) {
    const s = regionOf[j];
    if (s === WATER || s === r) continue;
    const b = borders[r].get(s) ?? { n: 0, river: 0 };
    b.n++;
    if (nearRiver(i) || nearRiver(j)) b.river++;
    borders[r].set(s, b);
  }
}
function nearRiver(i: number): boolean {
  if (riverPx[i]) return true;
  for (const j of neighbors4(i, W, H)) if (riverPx[j]) return true;
  return false;
}

const label = labelPoints();

// Places, for names and city traits.
const places = (await naturalEarth('ne_10m_populated_places'))
  .map((f) => ({
    // Some names carry stray spaces or direction marks.
    name: String(f.properties.NAME)
      .replace(/[\u200e\u200f]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    pop: Number(f.properties.POP_MAX),
    lon: Number(f.properties.LONGITUDE),
    lat: Number(f.properties.LATITUDE),
  }))
  .sort((a, b) => b.pop - a.pop);
function regionAt(lon: number, lat: number): number {
  const [fx, fy] = grid.toPx(lon, lat);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  for (let rad = 0; rad <= 4; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const r = regionOf[y * W + x];
        if (r !== WATER) return r;
      }
    }
  }
  return -1;
}

const names = new Array<string>(R).fill('');
const traits = Array.from({ length: R }, () => new Set<Trait>());
/** City level per region (0: none), from its largest place of a million people or more. */
const cityLevel = new Array<number>(R).fill(0);
const cityAt = new Array<[number, number] | null>(R).fill(null);
/** Big cities (a million or more) aren't farmland. */
const bigCity = new Array<boolean>(R).fill(false);
const levelOfPop = (pop: number) => (pop >= 8e6 ? 4 : pop >= 4e6 ? 3 : pop >= 2e6 ? 2 : 1);
for (const p of places) {
  const r = regionAt(p.lon, p.lat);
  if (r === -1) continue;
  if (!names[r] && p.pop >= 20_000) names[r] = p.name;
  if (p.pop >= 1_000_000) bigCity[r] = true;
  if (p.pop >= 1_000_000 && !cityLevel[r]) {
    cityLevel[r] = levelOfPop(p.pop);
    const [fx, fy] = grid.toPx(p.lon, p.lat);
    cityAt[r] = [Math.round(fx), Math.round(fy)];
  }
}
for (const [, lon, lat] of INDUSTRY) {
  const r = regionAt(lon, lat);
  if (r !== -1) traits[r].add('industry');
}
for (const [, lon, lat] of OIL) {
  const r = regionAt(lon, lat);
  if (r !== -1) traits[r].add('oil');
}

const terrainOf = (r: number): Terrain => {
  const [, f, h, m] = counts[r].map((c) => c / area[r]);
  if (m >= 0.35) return 'mountains';
  if (m + h >= 0.45) return 'hills';
  if (f >= 0.45) return 'forest';
  return 'plains';
};

const countries: Country[] = [];
const countryNames = new Map<string, string>();
for (const u of units) countryNames.set(u.country, u.admin);
for (const id of new Set(groupIds.map((g) => (groups.get(g) as Group).country))) {
  const play = PLAYABLE.find((p) => p.id === id);
  let capital = -1;
  if (play) {
    capital = regionAt(play.capital[0], play.capital[1]);
    if (capital === -1) throw new Error(`capital of ${id} is off the map`);
    bigCity[capital] = true;
    if (!cityLevel[capital]) {
      cityLevel[capital] = 1;
      const [fx, fy] = grid.toPx(play.capital[0], play.capital[1]);
      cityAt[capital] = [Math.round(fx), Math.round(fy)];
    }
  }
  countries.push({ id, name: play?.name ?? countryNames.get(id) ?? id, capital, playable: !!play });
}
countries.sort((a, b) => a.name.localeCompare(b.name));

const sorted = [...area].sort((a, b) => a - b);
const sizeOf = (a: number): RegionSize => (a < sorted[Math.floor(R / 3)] ? 'small' : a < sorted[Math.floor((2 * R) / 3)] ? 'medium' : 'large');

const regions: Region[] = groupIds.map((g, r) => {
  const G = groups.get(g) as Group;
  const terrain = terrainOf(r);
  const t = traits[r];
  if (terrain === 'plains' && !bigCity[r] && !t.has('industry') && sumLat[r] / area[r] < 57 && counts[r][T_FOREST] / area[r] < 0.3) {
    t.add('farmland');
  }
  const neighbors: Neighbor[] = [...borders[r]]
    .map(([id, b]) => ({
      id,
      border: b.n,
      river: b.river / b.n >= 0.4,
      dist: Math.round(Math.hypot(label[id][0] - label[r][0], label[id][1] - label[r][1]) * 10) / 10,
    }))
    .sort((a, b) => a.id - b.id);
  return {
    id: r,
    name: names[r] || G.name,
    country: G.country,
    terrain,
    traits: [...t].sort(),
    ...(cityLevel[r] ? { city: cityLevel[r], cityAt: cityAt[r] as [number, number] } : {}),
    size: sizeOf(area[r]),
    area: area[r],
    x: label[r][0],
    y: label[r][1],
    neighbors,
  };
});
dedupeNames(regions, new Set(regions.filter((r) => names[r.id]).map((r) => r.id)));

// -- 4. the terrain picture ------------------------------------------------------------------

// Land that isn't playable (islands, Asia, Africa) is drawn too, greyed out.
const scenery = new Uint8Array(N);
{
  const admin0 = await naturalEarth('ne_10m_admin_0_countries');
  for (const f of admin0) for (const rings of polygons(f.geometry)) fillPolygon(grid, rings, (i) => (scenery[i] = 1));
  for (const f of lakes) for (const rings of polygons(f.geometry)) fillPolygon(grid, rings, (i) => (scenery[i] = 0));
}

const png = new PNG({ width: W, height: H });
const SHALLOW = [88, 131, 166];
const DEEP = [34, 62, 96];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const o = i * 4;
    const inPlay = regionOf[i] !== WATER;
    let c: number[];
    if (inPlay || scenery[i]) {
      c = [lc[i * 3], lc[i * 3 + 1], lc[i * 3 + 2]];
      c = saturate(c, 1.35);
      const s = shade(x, y);
      c = c.map((v) => v * s);
      if (riverPx[i] && inPlay) c = [70, 120, 170];
      if (!inPlay) c = c.map((v) => v * 0.55 + 40);
    } else {
      const depth = Math.min(1, Math.max(0, -elev[i] / 2500));
      c = SHALLOW.map((v, k) => v + (DEEP[k] - v) * Math.sqrt(depth));
    }
    png.data[o] = clamp(c[0]);
    png.data[o + 1] = clamp(c[1]);
    png.data[o + 2] = clamp(c[2]);
    png.data[o + 3] = 255;
  }
}

function shade(x: number, y: number): number {
  const e = (xx: number, yy: number) => {
    const i = Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx));
    return Math.max(0, elev[i]);
  };
  const z = 5; // exaggeration, so hills read at 3 km/px
  const dzdx = ((e(x + 1, y) - e(x - 1, y)) * z) / (2 * KM * 1000);
  const dzdy = ((e(x, y + 1) - e(x, y - 1)) * z) / (2 * KM * 1000);
  const slope = Math.atan(Math.hypot(dzdx, dzdy));
  const aspect = Math.atan2(dzdy, -dzdx);
  const zen = (45 * Math.PI) / 180;
  const az = (315 * Math.PI) / 180;
  const hs = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - Math.PI / 2 - aspect);
  return 0.62 + 0.55 * hs;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}europe-terrain.png`, PNG.sync.write(png));

const map: GameMap = {
  id: 'europe',
  name: 'Europe',
  width: W,
  height: H,
  kmPerPx: KM,
  regions,
  countries,
  grid: encodeGrid(regionOf),
  attribution:
    'Borders, rivers, lakes and places: Natural Earth (public domain). Land cover: Natural Earth II (public domain). ' +
    'Elevation: AWS Terrain Tiles (Mapzen/Tilezen) from SRTM, GMTED2010, ETOPO1 and EU-DEM (produced using Copernicus data and information funded by the European Union).',
};
writeFileSync(`${OUT}europe.json`, JSON.stringify(map));

const tally = (k: (r: Region) => string) => {
  const m = new Map<string, number>();
  for (const r of regions) m.set(k(r), (m.get(k(r)) ?? 0) + 1);
  return [...m].map(([a, b]) => `${a} ${b}`).join(', ');
};
log(`wrote ${R} regions, ${countries.length} countries`);
console.log(`  terrain: ${tally((r) => r.terrain)}`);
console.log(`  traits: ${tally((r) => r.traits.join('+') || '-')}`);
console.log(`  river borders: ${regions.reduce((s, r) => s + r.neighbors.filter((n) => n.river).length, 0) / 2}`);

// -- helpers ---------------------------------------------------------------------------------

function neighbors4(i: number, w: number, h: number): number[] {
  const x = i % w;
  const out: number[] = [];
  if (x > 0) out.push(i - 1);
  if (x < w - 1) out.push(i + 1);
  if (i >= w) out.push(i - w);
  if (i < w * (h - 1)) out.push(i + w);
  return out;
}

/** k seed pixels for a group: farthest-point start, then Lloyd iterations. */
function kmeans(px: number[], k: number, w: number): number[] {
  const pts = px.map((i) => [i % w, Math.floor(i / w)]);
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const centres: number[][] = [];
  let far = pts.reduce((a, p) => (Math.hypot(p[0] - cx, p[1] - cy) > Math.hypot(a[0] - cx, a[1] - cy) ? p : a));
  centres.push([...far]);
  while (centres.length < k) {
    let best = 0;
    for (const p of pts) {
      const d = Math.min(...centres.map((c) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      if (d > best) {
        best = d;
        far = p;
      }
    }
    centres.push([...far]);
  }
  for (let it = 0; it < 15; it++) {
    const sum = centres.map(() => [0, 0, 0]);
    for (const p of pts) {
      let bi = 0;
      let bd = Infinity;
      centres.forEach((c, n) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
        if (d < bd) {
          bd = d;
          bi = n;
        }
      });
      sum[bi][0] += p[0];
      sum[bi][1] += p[1];
      sum[bi][2]++;
    }
    centres.forEach((c, n) => {
      if (sum[n][2]) {
        c[0] = sum[n][0] / sum[n][2];
        c[1] = sum[n][1] / sum[n][2];
      }
    });
  }
  // The group pixel nearest each centre.
  return centres.map((c) => {
    let bi = 0;
    let bd = Infinity;
    pts.forEach((p, n) => {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
      if (d < bd) {
        bd = d;
        bi = n;
      }
    });
    return px[bi];
  });
}

/** For each region, the pixel farthest from its edge (ties: nearest the centroid). */
function labelPoints(): Array<[number, number]> {
  const dist = new Int32Array(N).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = regionOf[i];
    if (r === WATER) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || neighbors4(i, W, H).some((j) => regionOf[j] !== r);
    if (edge) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (const j of neighbors4(i, W, H)) {
      if (dist[j] === -1 && regionOf[j] === regionOf[i]) {
        dist[j] = dist[i] + 1;
        queue.push(j);
      }
    }
  }
  const cxy = Array.from({ length: R }, () => [0, 0, 0]);
  for (let i = 0; i < N; i++) {
    const r = regionOf[i];
    if (r === WATER) continue;
    cxy[r][0] += i % W;
    cxy[r][1] += Math.floor(i / W);
    cxy[r][2]++;
  }
  const best: Array<[number, number, number, number]> = Array.from({ length: R }, () => [-1, Infinity, 0, 0]);
  for (let i = 0; i < N; i++) {
    const r = regionOf[i];
    if (r === WATER) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    const c = Math.hypot(x - cxy[r][0] / cxy[r][2], y - cxy[r][1] / cxy[r][2]);
    // Prefer depth, but don't wander far from the middle for one extra pixel of it.
    const score = Math.min(dist[i], 12);
    const b = best[r];
    if (score > b[0] || (score === b[0] && c < b[1])) best[r] = [score, c, x, y];
  }
  return best.map((b) => [b[2], b[3]]);
}

/**
 * Gives regions that share a name a compass prefix. A region named after a city it really
 * contains keeps the plain name (the others are parts of the province around it).
 */
function dedupeNames(list: Region[], fromPlace: Set<number>): void {
  const by = new Map<string, Region[]>();
  for (const r of list) by.set(r.name, [...(by.get(r.name) ?? []), r]);
  for (const [name, all] of by) {
    if (all.length < 2) continue;
    const real = all.filter((r) => fromPlace.has(r.id));
    const same = real.length === 1 ? all.filter((r) => r !== real[0]) : all;
    const ref = real.length === 1 ? [real[0]] : same;
    const cx = ref.reduce((s, r) => s + r.x, 0) / ref.length;
    const cy = ref.reduce((s, r) => s + r.y, 0) / ref.length;
    for (const r of same) {
      const dx = r.x - cx;
      const dy = r.y - cy;
      const dirs = ['East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest', 'North', 'Northeast'];
      const dir = dirs[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
      r.name = `${dir} ${name}`;
    }
    const again = new Map<string, number>();
    for (const r of same) {
      const n = (again.get(r.name) ?? 0) + 1;
      again.set(r.name, n);
      if (n > 1) r.name = `${r.name} ${n}`;
    }
  }
}

function saturate(c: number[], k: number): number[] {
  const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  return c.map((v) => l + (v - l) * k);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
