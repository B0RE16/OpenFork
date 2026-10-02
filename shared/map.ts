// The map format: what scripts/build-map.ts writes to public/maps/<id>.json, and what the
// server (rules) and the client (drawing, picking) read.
//
// The map is a pixel grid. Every land pixel belongs to one region; water is WATER. The
// terrain picture is a separate PNG of the same size (public/maps/<id>-terrain.png).

export const WATER = 0xffff;

export type Terrain = 'plains' | 'forest' | 'hills' | 'mountains';
export const TERRAINS: readonly Terrain[] = ['plains', 'forest', 'hills', 'mountains'];

export type Trait = 'industry' | 'oil' | 'farmland';
export const TRAITS: readonly Trait[] = ['industry', 'oil', 'farmland'];

export type RegionSize = 'small' | 'medium' | 'large';

export interface Neighbor {
  id: number;
  /** Border pixels shared with this neighbour. */
  border: number;
  /** A river runs along most of this border: defenders get the river bonus. */
  river: boolean;
  /** Distance between the two regions' label points, in pixels. */
  dist: number;
}

export interface Region {
  id: number;
  name: string;
  /** ISO 3166-1 alpha-2 of the country it belongs to at the start. */
  country: string;
  terrain: Terrain;
  traits: Trait[];
  /** A city here at the start: its level (1-4, from the real population), or absent. */
  city?: number;
  /** Where the city really is (pixel), for drawing the town. */
  cityAt?: [number, number];
  size: RegionSize;
  /** Land pixels. */
  area: number;
  /** Label point: the pixel deepest inside the region. */
  x: number;
  y: number;
  neighbors: Neighbor[];
}

export interface Country {
  /** ISO 3166-1 alpha-2. */
  id: string;
  name: string;
  /** Region holding the capital, or -1 if the capital isn't on the map. */
  capital: number;
  /** Can be picked as a start country. */
  playable: boolean;
}

export interface GameMap {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Kilometres per pixel (for display). */
  kmPerPx: number;
  regions: Region[];
  countries: Country[];
  /** Region id per pixel, row-major, run-length encoded (see encodeGrid). */
  grid: string;
  /** Where the map data came from. */
  attribution: string;
}

/** Run-length encodes the grid as base64 of (value, run length) pairs, both LEB128. */
export function encodeGrid(cells: Uint16Array): string {
  const out: number[] = [];
  const leb = (n: number) => {
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
  };
  let i = 0;
  while (i < cells.length) {
    const v = cells[i];
    let run = 1;
    while (i + run < cells.length && cells[i + run] === v) run++;
    leb(v);
    leb(run);
    i += run;
  }
  return bytesToBase64(Uint8Array.from(out));
}

export function decodeGrid(data: string, size: number): Uint16Array {
  const bytes = base64ToBytes(data);
  const cells = new Uint16Array(size);
  let at = 0;
  let i = 0;
  const leb = () => {
    let n = 0;
    let shift = 0;
    let b: number;
    do {
      b = bytes[i++];
      n |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return n;
  };
  while (i < bytes.length) {
    const v = leb();
    const run = leb();
    if (at + run > size) throw new Error('map grid overruns its size');
    cells.fill(v, at, at + run);
    at += run;
  }
  if (at !== size) throw new Error(`map grid has ${at} cells, expected ${size}`);
  return cells;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToBytes(data: string): Uint8Array {
  const s = atob(data);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
