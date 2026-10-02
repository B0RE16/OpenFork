// Projection and rasterising for the map builder.

const R = 6371; // km
const RAD = Math.PI / 180;

/** Lambert azimuthal equal-area around (lon0, lat0), in km. Areas stay true, so pixel
 * counts are fair region sizes. */
export class Laea {
  private readonly lon0: number;
  private readonly sin0: number;
  private readonly cos0: number;

  constructor(lon0: number, lat0: number) {
    this.lon0 = lon0;
    this.sin0 = Math.sin(lat0 * RAD);
    this.cos0 = Math.cos(lat0 * RAD);
  }

  forward(lon: number, lat: number): [number, number] {
    const p = lat * RAD;
    const l = (lon - this.lon0) * RAD;
    const k = Math.sqrt(2 / (1 + this.sin0 * Math.sin(p) + this.cos0 * Math.cos(p) * Math.cos(l)));
    return [R * k * Math.cos(p) * Math.sin(l), R * k * (this.cos0 * Math.sin(p) - this.sin0 * Math.cos(p) * Math.cos(l))];
  }

  inverse(x: number, y: number): [number, number] {
    const rho = Math.hypot(x, y);
    if (rho === 0) return [this.lon0, Math.asin(this.sin0) / RAD];
    const c = 2 * Math.asin(rho / (2 * R));
    const lat = Math.asin(Math.cos(c) * this.sin0 + (y * Math.sin(c) * this.cos0) / rho);
    const lon = this.lon0 * RAD + Math.atan2(x * Math.sin(c), rho * this.cos0 * Math.cos(c) - y * this.sin0 * Math.sin(c));
    return [lon / RAD, lat / RAD];
  }
}

/** A pixel window over the projection: column x, row y (row 0 at the top/north). */
export class Grid {
  readonly width: number;
  readonly height: number;
  readonly km: number;
  private readonly x0: number;
  private readonly y0: number;
  readonly proj: Laea;

  constructor(proj: Laea, west: number, north: number, width: number, height: number, km: number) {
    this.proj = proj;
    this.x0 = west;
    this.y0 = north;
    this.width = width;
    this.height = height;
    this.km = km;
  }

  /** Fractional pixel coordinates of a lon/lat. */
  toPx(lon: number, lat: number): [number, number] {
    const [x, y] = this.proj.forward(lon, lat);
    return [(x - this.x0) / this.km, (this.y0 - y) / this.km];
  }

  /** Lon/lat of a pixel's centre. */
  toLonLat(px: number, py: number): [number, number] {
    return this.proj.inverse(this.x0 + (px + 0.5) * this.km, this.y0 - (py + 0.5) * this.km);
  }

  /** The same window, cropped. */
  crop(x: number, y: number, width: number, height: number): Grid {
    return new Grid(this.proj, this.x0 + x * this.km, this.y0 - y * this.km, width, height, this.km);
  }
}

type Ring = number[][];

/** Polygon rings (outer + holes) of a Polygon/MultiPolygon geometry. */
export function polygons(geometry: { type: string; coordinates: unknown } | null): Ring[][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates as Ring[]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as Ring[][];
  return [];
}

export function lines(geometry: { type: string; coordinates: unknown } | null): Ring[] {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates as Ring];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Ring[];
  return [];
}

/** Fills a polygon (even-odd over all its rings) by pixel centres; calls set(i) per pixel. */
export function fillPolygon(grid: Grid, rings: Ring[], set: (i: number) => void): void {
  const edges: Array<[number, number, number, number]> = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    const pts = ring.map(([lon, lat]) => grid.toPx(lon, lat));
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if (ay === by) continue;
      edges.push([ax, ay, bx, by]);
      minY = Math.min(minY, ay, by);
      maxY = Math.max(maxY, ay, by);
    }
  }
  const y0 = Math.max(0, Math.ceil(minY - 0.5));
  const y1 = Math.min(grid.height - 1, Math.floor(maxY - 0.5));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (const [ax, ay, bx, by] of edges) {
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(grid.width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = from; x <= to; x++) set(y * grid.width + x);
    }
  }
}

/** Draws a polyline; calls set(i) for each pixel it passes. */
export function drawLine(grid: Grid, line: Ring, set: (i: number) => void): void {
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = grid.toPx(line[i][0], line[i][1]);
    const [bx, by] = grid.toPx(line[i + 1][0], line[i + 1][1]);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2));
    for (let s = 0; s <= steps; s++) {
      const x = Math.floor(ax + ((bx - ax) * s) / steps);
      const y = Math.floor(ay + ((by - ay) * s) / steps);
      if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) set(y * grid.width + x);
    }
  }
}
