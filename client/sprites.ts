// Pixel art: every graphic on the map and in the HUD is a tiny bitmap, built once into a
// canvas and drawn at a whole-number scale with smoothing off, so it stays crisp.
//
// Bitmaps are string art; each character picks a colour from the palette passed in
// ('.' is transparent). 'F' is the owner colour for recoloured sprites.

export const INK = '#0b0f13';

const BASE: Record<string, string> = {
  O: INK,
  W: '#f2f5f7',
  G: '#9aa7b1', // stone grey
  g: '#5d6973',
  Y: '#f1c232', // gold
  y: '#a8801a',
  R: '#d9534f',
  B: '#6fa8dc',
  b: '#3d6e99',
  T: '#8a9a5b', // canvas olive
  t: '#5c6a35',
  K: '#2b2f33', // oil black
  C: '#4fd1ff',
};

export type Sprite = HTMLCanvasElement;

const cache = new Map<string, Sprite>();

/** A sprite from string art. */
export function art(rows: string[], colors: Record<string, string> = {}): Sprite {
  const pal = { ...BASE, ...colors };
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const k = row[x];
      if (k === '.' || k === ' ') continue;
      ctx.fillStyle = pal[k] ?? '#ff00ff';
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return c;
}

function cached(key: string, make: () => Sprite): Sprite {
  let s = cache.get(key);
  if (!s) {
    s = make();
    cache.set(key, s);
  }
  return s;
}

/** Draws a sprite with its top-left at whole pixels, `scale` screen pixels per art pixel. */
export function blit(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, scale: number): void {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(s, Math.round(x), Math.round(y), s.width * scale, s.height * scale);
}

/** Draws a sprite centred on (x, y). */
export function blitCentred(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, scale: number): void {
  blit(ctx, s, x - (s.width * scale) / 2, y - (s.height * scale) / 2, scale);
}

// -- colours ----------------------------------------------------------------------------------

export function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(k >= 1 ? v + (255 - v) * (k - 1) : v * k)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// -- NATO unit frames -------------------------------------------------------------------------

export const FRAME_W = 17;
export const FRAME_H = 15; // 3 rows of echelon marks, then a 17×12 frame

/** Echelon marks over the frame, by size: • •• | || (squad .. battalion, loosely). */
function echelon(size: number, max: number): string[] {
  const r = size / max;
  if (r <= 0.25) return ['........O........', '.......OWO.......', '........O........'];
  if (r <= 0.5) return ['......O...O......', '.....OWO.OWO.....', '......O...O......'];
  if (r <= 0.75) return ['.......OWO.......', '.......OWO.......', '.......OWO.......'];
  return ['.....OWO.OWO.....', '.....OWO.OWO.....', '.....OWO.OWO.....'];
}

/**
 * A NATO unit symbol: a rectangle in the owner's colour with a dark outline, a lighter top
 * edge, and the branch mark inside: infantry ✕, armour an oval.
 */
export function unitFrame(type: 'infantry' | 'tank', size: number, max: number, color: string): Sprite {
  const marks = echelon(size, max);
  const key = `unit:${type}:${marks[1]}:${color}`;
  return cached(key, () => {
    const W = FRAME_W;
    const H = 12;
    const grid: string[][] = Array.from({ length: H }, () => new Array<string>(W).fill('F'));
    for (let x = 0; x < W; x++) {
      grid[0][x] = 'O';
      grid[H - 1][x] = 'O';
      grid[1][x] = x > 0 && x < W - 1 ? 'L' : 'O';
      grid[H - 2][x] = x > 0 && x < W - 1 ? 'D' : 'O';
    }
    for (let y = 0; y < H; y++) {
      grid[y][0] = 'O';
      grid[y][W - 1] = 'O';
    }
    const ix0 = 2;
    const iy0 = 2;
    const iw = W - 4;
    const ih = H - 4;
    if (type === 'infantry') {
      // ✕ from corner to corner of the inner box.
      for (let i = 0; i < iw; i++) {
        const y = iy0 + Math.round((i * (ih - 1)) / (iw - 1));
        grid[y][ix0 + i] = 'S';
        grid[iy0 + ih - 1 - (y - iy0)][ix0 + i] = 'S';
      }
    } else {
      // An oval (track outline), 9×5, centred.
      const oval = ['..SSSSS..', '.S.....S.', 'S.......S', '.S.....S.', '..SSSSS..'];
      const ox = Math.floor((W - 9) / 2);
      const oy = Math.floor((H - 5) / 2);
      oval.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) if (row[x] === 'S') grid[oy + y][ox + x] = 'S';
      });
    }
    const rows = [...marks, ...grid.map((r) => r.join(''))];
    return art(rows, { F: color, L: shade(color, 1.35), D: shade(color, 0.7), S: INK });
  });
}

// -- map icons --------------------------------------------------------------------------------

export const ICONS = {
  capital: art(
    [
      '....O....',
      '...OYO...',
      '...OYO...',
      'OOOOYOOOO',
      'OYYYYYYYO',
      '.OYYYYYO.',
      '..OYYYO..',
      '.OYYOYYO.',
      '.OYO.OYO.',
      '.OO...OO.',
    ],
  ),
  city: art(['OOOOO', 'OWWWO', 'OWgWO', 'OWWWO', 'OOOOO']),
  fort: art([
    'OOO.OOO.OOO',
    'OGO.OGO.OGO',
    'OGOOOGOOOGO',
    'OGGGGGGGGGO',
    'OGgGGGGGgGO',
    'OGGGOOOGGGO',
    'OGGGO.OGGGO',
    'OOOOO.OOOOO',
  ]),
  barracks: art([
    '....O....',
    '...OTO...',
    '..OTTTO..',
    '.OTTtTTO.',
    'OTTtOtTTO',
    'OTtO.OtTO',
    'OOOO.OOOO',
  ]),
  factory: art([
    'OOO......',
    'OgO......',
    'OgO.O..O.',
    'OgOOGOOGO',
    'OgGGGGGGO',
    'OGYGGYGGO',
    'OGGGGGGGO',
    'OOOOOOOOO',
  ]),
  infra: art(['.O..O..O.', 'OGOOGOOGO', '.O..O..O.', '.O..O..O.', 'OGOOGOOGO', '.O..O..O.']),
  crate: art(
    [
      'OOOOOOOOO',
      'OyYYYYYyO',
      'OYyYYYyYO',
      'OYYyYyYYO',
      'OYYYyYYYO',
      'OYYyYyYYO',
      'OYyYYYyYO',
      'OyYYYYYyO',
      'OOOOOOOOO',
    ],
    { Y: '#c19a5b', y: '#6e5230' },
  ),
  swords: [
    art([
      'W.......W',
      'WW.....WW',
      '.WW...WW.',
      '..WW.WW..',
      '...WWW...',
      '..YYWYY..',
      '.YO...OY.',
      'YO.....OY',
      'O.......O',
    ]),
    art(
      [
        'W.......W',
        'WW.....WW',
        '.WW...WW.',
        '..WW.WW..',
        '...WWW...',
        '..YYWYY..',
        '.YO...OY.',
        'YO.....OY',
        'O.......O',
      ],
      { W: '#ff5a5a' },
    ),
  ],
};

// -- HUD icons ----------------------------------------------------------------------------------

const HUD = {
  money: art([
    '..OOOOO..',
    '.OYYYYYO.',
    'OYYyyyYYO',
    'OYyYYYYYO',
    'OYYyyyYYO',
    'OYYYYYyYO',
    'OYYyyyYYO',
    '.OYYYYYO.',
    '..OOOOO..',
  ]),
  manpower: art([
    '..OOOOO..',
    '.OTTTTTO.',
    'OTTTTTTTO',
    'OOOOOOOOO',
    '..OWWWO..',
    '..OWWWO..',
    '.OTTTTTO.',
    'OTTTTTTTO',
    'OOOOOOOOO',
  ]),
  steel: art([
    'OOOOOOOOO',
    'OGGGGGGGO',
    'OOOOGOOOO',
    '...OGO...',
    '...OGO...',
    '...OGO...',
    'OOOOGOOOO',
    'OGGGGGGGO',
    'OOOOOOOOO',
  ]),
  oil: art(
    [
      '....O....',
      '...OKO...',
      '..OKKKO..',
      '.OKKKKKO.',
      'OKKKKKKKO',
      'OKWKKKKKO',
      'OKKWKKKKO',
      '.OKKKKKO.',
      '..OOOOO..',
    ],
    { K: '#3a3f45' },
  ),
};

/** A sprite as an image URL, for the DOM. */
export function spriteUrl(s: Sprite, scale = 2): string {
  const c = document.createElement('canvas');
  c.width = s.width * scale;
  c.height = s.height * scale;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(s, 0, 0, c.width, c.height);
  return c.toDataURL();
}

const urls = new Map<string, string>();

/** HUD icons as image URLs. */
export function hudIcon(name: keyof typeof HUD, scale = 2): string {
  const key = `${name}:${scale}`;
  let url = urls.get(key);
  if (!url) {
    url = spriteUrl(HUD[name], scale);
    urls.set(key, url);
  }
  return url;
}

// -- digits -------------------------------------------------------------------------------------

/** Classic 3×5 pixel digits: unambiguous at any scale (a font's 2 can look like an 8). */
const DIGITS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
};

/** Width in screen pixels of a number drawn with pixelDigits. */
export function digitsWidth(text: string, scale: number): number {
  return text.length * 4 * scale - scale;
}

/** Draws a number in 3×5 pixel digits, centred on (x, y). */
export function pixelDigits(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number, color: string): void {
  const x0 = Math.round(x - digitsWidth(text, scale) / 2);
  const y0 = Math.round(y - (5 * scale) / 2);
  ctx.fillStyle = color;
  [...text].forEach((ch, i) => {
    const rows = DIGITS[ch];
    if (!rows) return;
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) {
        if (row[rx] === '#') ctx.fillRect(x0 + (i * 4 + rx) * scale, y0 + ry * scale, scale, scale);
      }
    });
  });
}
