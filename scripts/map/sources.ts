// Downloads and reads the map's source data. Everything is cached in .cache/map-src/.
//
// - Natural Earth 1:10m vectors (provinces, lakes, rivers, places): public domain.
// - Natural Earth II land cover raster (NE2_HR_LC): public domain.
// - Elevation: AWS Terrain Tiles (terrarium PNGs, Mapzen/Tilezen); for Europe built from
//   SRTM, GMTED2010, ETOPO1 (public domain) and EU-DEM (Copernicus, attribution required).
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { PNG } from 'pngjs';

export const CACHE = new URL('../../.cache/map-src/', import.meta.url).pathname;

const NE_GEOJSON = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const NE_RASTER = 'https://naciscdn.org/naturalearth/10m/raster/NE2_HR_LC.zip';
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';

export interface Feature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

export async function naturalEarth(name: string): Promise<Feature[]> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${name}.geojson`);
  if (!existsSync(file)) {
    console.log(`downloading ${name}`);
    await download(`${NE_GEOJSON}${name}.geojson`, file);
  }
  return JSON.parse(readFileSync(file, 'utf8')).features;
}

/** Natural Earth II land cover, read straight from its uncompressed TIFF. */
export class LandCover {
  private readonly fd: number;
  private readonly strips: number[] = [];
  readonly width: number;
  readonly height: number;
  private readonly rows = new Map<number, Buffer>();

  private constructor(file: string) {
    this.fd = openSync(file, 'r');
    const head = this.read(0, 8);
    if (head.toString('ascii', 0, 2) !== 'II') throw new Error('NE2_HR_LC.tif: expected a little-endian TIFF');
    const ifd = head.readUInt32LE(4);
    const count = this.read(ifd, 2).readUInt16LE(0);
    const entries = this.read(ifd + 2, count * 12);
    const tags = new Map<number, { count: number; value: number }>();
    for (let i = 0; i < count; i++) {
      tags.set(entries.readUInt16LE(i * 12), {
        count: entries.readUInt32LE(i * 12 + 4),
        value: entries.readUInt32LE(i * 12 + 8),
      });
    }
    const tag = (t: number) => {
      const v = tags.get(t);
      if (!v) throw new Error(`NE2_HR_LC.tif: missing TIFF tag ${t}`);
      return v;
    };
    this.width = tag(256).value;
    this.height = tag(257).value;
    if (tag(259).value !== 1 || tag(277).value !== 3 || tag(278).value !== 1) {
      throw new Error('NE2_HR_LC.tif: expected uncompressed RGB, one row per strip');
    }
    const offsets = this.read(tag(273).value, this.height * 4);
    for (let y = 0; y < this.height; y++) this.strips.push(offsets.readUInt32LE(y * 4));
  }

  static async open(): Promise<LandCover> {
    const tif = join(CACHE, 'NE2_HR_LC.tif');
    if (!existsSync(tif)) {
      const zip = join(CACHE, 'NE2_HR_LC.zip');
      if (!existsSync(zip)) {
        console.log('downloading NE2_HR_LC.zip (125 MB)');
        await download(NE_RASTER, zip);
      }
      console.log('unzipping NE2_HR_LC.tif (700 MB)');
      await unzipOne(zip, 'NE2_HR_LC.tif', tif);
    }
    return new LandCover(tif);
  }

  private read(offset: number, length: number): Buffer {
    const b = Buffer.alloc(length);
    readSync(this.fd, b, 0, length, offset);
    return b;
  }

  /** RGB at a lon/lat (nearest pixel). */
  at(lon: number, lat: number): [number, number, number] {
    const x = Math.min(this.width - 1, Math.max(0, Math.floor(((lon + 180) / 360) * this.width)));
    const y = Math.min(this.height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * this.height)));
    let row = this.rows.get(y);
    if (!row) {
      row = this.read(this.strips[y], this.width * 3);
      this.rows.set(y, row);
    }
    return [row[x * 3], row[x * 3 + 1], row[x * 3 + 2]];
  }
}

function unzipOne(zip: string, name: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let found = false;
    const unzip = new Unzip((file) => {
      if (file.name !== name) return;
      found = true;
      const ws = createWriteStream(out);
      file.ondata = (err, chunk, final) => {
        if (err) return reject(err);
        ws.write(chunk);
        if (final) ws.end(resolve);
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    const data = readFileSync(zip);
    for (let i = 0; i < data.length; i += 1 << 20) unzip.push(data.subarray(i, i + (1 << 20)), i + (1 << 20) >= data.length);
    if (!found) reject(new Error(`${name} not in ${zip}`));
  });
}

/** Elevation in metres from terrarium tiles at one zoom level (bilinear). */
export class Elevation {
  private readonly tiles = new Map<string, Float32Array>();
  readonly zoom: number;

  constructor(zoom: number) {
    this.zoom = zoom;
  }

  private key(x: number, y: number) {
    return `${this.zoom}/${x}/${y}`;
  }

  /** Downloads every tile in a lon/lat box (call before at()). */
  async prefetch(west: number, south: number, east: number, north: number): Promise<void> {
    const [x0, y0] = this.tileOf(west, north);
    const [x1, y1] = this.tileOf(east, south);
    const dir = join(CACHE, 'terrarium', String(this.zoom));
    mkdirSync(dir, { recursive: true });
    const jobs: Array<() => Promise<void>> = [];
    for (let y = Math.floor(y0); y <= Math.floor(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
        const file = join(dir, `${x}-${y}.png`);
        if (!existsSync(file)) jobs.push(() => download(`${TERRARIUM}${this.key(x, y)}.png`, file));
      }
    }
    if (jobs.length) console.log(`downloading ${jobs.length} elevation tiles`);
    for (let i = 0; i < jobs.length; i += 16) await Promise.all(jobs.slice(i, i + 16).map((j) => j()));
  }

  private tileOf(lon: number, lat: number): [number, number] {
    const n = 2 ** this.zoom;
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }

  private tile(x: number, y: number): Float32Array {
    const k = this.key(x, y);
    let t = this.tiles.get(k);
    if (!t) {
      const png = PNG.sync.read(readFileSync(join(CACHE, 'terrarium', String(this.zoom), `${x}-${y}.png`)));
      t = new Float32Array(256 * 256);
      for (let i = 0; i < t.length; i++) {
        t[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
      }
      this.tiles.set(k, t);
    }
    return t;
  }

  private px(gx: number, gy: number): number {
    const tx = Math.floor(gx / 256);
    const ty = Math.floor(gy / 256);
    return this.tile(tx, ty)[(gy - ty * 256) * 256 + (gx - tx * 256)];
  }

  at(lon: number, lat: number): number {
    const [tx, ty] = this.tileOf(lon, lat);
    const gx = tx * 256 - 0.5;
    const gy = ty * 256 - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const a = this.px(x0, y0);
    const b = this.px(x0 + 1, y0);
    const c = this.px(x0, y0 + 1);
    const d = this.px(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
}
