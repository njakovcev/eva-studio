/**
 * Arranges panels on EVA sheets using as little sheet length as possible.
 *
 * Rules that are always kept:
 *  - parts stay `margin` mm away from the sheet edge,
 *  - parts stay at least `gap` mm away from each other,
 *  - parts are only turned by the allowed angles (brushed EVA has a direction,
 *    so by default a part may only be turned half-way round), never mirrored.
 *
 * Method: sheets and parts are drawn on a fine grid (2 mm). Parts are taken
 * largest first; each is tried at the spots next to parts already placed, in
 * every allowed turn, slid as far left and down as it will go, and put where it
 * ends up using the least sheet length. Several orderings are tried and the
 * best result is kept. This is a good arrangement, not a mathematically proven
 * optimum (nobody can compute that for free shapes in reasonable time).
 */
import { grow, type Region } from './region';

export interface NestPart {
  id: string;
  outline: number[];
  /** turns allowed for this part, degrees; when missing, those of the options */
  rotations?: number[];
}
export interface NestOptions {
  /** sheet length (along X) and width, mm */
  sheetLength: number;
  sheetWidth: number;
  margin: number;
  gap: number;
  /** allowed turns, degrees */
  rotations: number[];
  /** grid size, mm */
  cell?: number;
  /** how many extra orderings to try on top of the three standard ones (more = better, slower) */
  tries?: number;
}

export interface Placement {
  partId: string;
  sheet: number;
  /** a part point p ends up at R(angle)·p + (tx, ty), in sheet coordinates (origin: lower-left corner of the sheet) */
  angle: number;
  tx: number;
  ty: number;
}

export interface NestResult {
  placements: Placement[];
  sheets: number;
  /** per sheet: how far along the sheet the parts reach, mm (including the edge margin) */
  usedLength: number[];
  unplaced: { partId: string; reason: string }[];
}

interface Shape { angle: number; minX: number; minY: number; w: number; h: number; rows: Uint32Array; words: number }

class Sheet {
  rows: Uint32Array;
  rights: number[] = [0];
  tops: number[] = [0];
  constructor(public w: number, public h: number, public words: number) { this.rows = new Uint32Array(h * words); }

  fits(s: Shape, cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx + s.w > this.w || cy + s.h > this.h) return false;
    const word = cx >>> 5, shift = cx & 31, rows = this.rows, W = this.words;
    for (let r = 0; r < s.h; r++) {
      const base = (cy + r) * W + word, src = r * s.words;
      for (let k = 0; k < s.words; k++) {
        const bits = s.rows[src + k];
        if (!bits) continue;
        if (rows[base + k] & (bits << shift)) return false;
        if (shift && base + k + 1 < (cy + r + 1) * W && rows[base + k + 1] & (bits >>> (32 - shift))) return false;
      }
    }
    return true;
  }

  put(s: Shape, cx: number, cy: number) {
    const word = cx >>> 5, shift = cx & 31, W = this.words;
    for (let r = 0; r < s.h; r++) {
      const base = (cy + r) * W + word, src = r * s.words;
      for (let k = 0; k < s.words; k++) {
        const bits = s.rows[src + k];
        if (!bits) continue;
        this.rows[base + k] |= bits << shift;
        if (shift && base + k + 1 < (cy + r + 1) * W) this.rows[base + k + 1] |= bits >>> (32 - shift);
      }
    }
    if (!this.rights.includes(cx + s.w)) this.rights.push(cx + s.w);
    if (!this.tops.includes(cy + s.h)) this.tops.push(cy + s.h);
  }
}

function rotate(outline: number[], angle: number): number[] {
  const c = Math.cos((angle * Math.PI) / 180), s = Math.sin((angle * Math.PI) / 180), out = new Array<number>(outline.length);
  for (let i = 0; i < outline.length; i += 2) { out[i] = outline[i] * c - outline[i + 1] * s; out[i + 1] = outline[i] * s + outline[i + 1] * c; }
  return out;
}

/** The part, turned and grown by half the gap (plus a safety allowance for the grid), drawn on the grid. */
function rasterize(outline: number[], angle: number, pad: number, cell: number): Shape {
  const turned = rotate(outline, angle);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < turned.length; i += 2) { minX = Math.min(minX, turned[i]); maxX = Math.max(maxX, turned[i]); minY = Math.min(minY, turned[i + 1]); maxY = Math.max(maxY, turned[i + 1]); }
  const grown: Region = grow([turned], pad);
  const ox = minX - pad, oy = minY - pad;
  const w = Math.ceil((maxX - minX + 2 * pad) / cell), h = Math.ceil((maxY - minY + 2 * pad) / cell), words = Math.ceil(w / 32);
  const rows = new Uint32Array(h * words);
  const xs: number[] = [];
  for (let r = 0; r < h; r++) {
    const y = oy + (r + 0.5) * cell;
    xs.length = 0;
    for (const ring of grown) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[i * 2 + 1], yj = ring[j * 2 + 1];
        if ((yi > y) !== (yj > y)) xs.push(ring[i * 2] + ((y - yi) * (ring[j * 2] - ring[i * 2])) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.floor((xs[k] - ox) / cell)), to = Math.min(w - 1, Math.floor((xs[k + 1] - ox) / cell));
      for (let c = from; c <= to; c++) rows[r * words + (c >>> 5)] |= 1 << (c & 31);
    }
  }
  return { angle, minX, minY, w, h, rows, words };
}

export function nest(parts: NestPart[], options: NestOptions): NestResult {
  const cell = options.cell ?? 2;
  // Growing every part by half the gap keeps two parts a full gap apart. The extra
  // 0.71 cell makes that true even though positions snap to the grid.
  const pad = options.gap / 2 + 0.71 * cell;
  const W = Math.floor((options.sheetLength - 2 * options.margin + 2 * pad) / cell);
  const H = Math.floor((options.sheetWidth - 2 * options.margin + 2 * pad) / cell);
  const words = Math.ceil(W / 32) + 1;

  const unplaced: NestResult['unplaced'] = [];
  const shapes = new Map<string, Shape[]>();
  const sizeOf = new Map<string, { area: number; long: number; high: number }>();
  for (const p of parts) {
    const all = (p.rotations ?? options.rotations).map((a) => rasterize(p.outline, a, pad, cell));
    const usable = all.filter((s) => s.w <= W && s.h <= H);
    if (!usable.length) { unplaced.push({ partId: p.id, reason: 'It is larger than a sheet. Split the panel into smaller ones.' }); continue; }
    shapes.set(p.id, usable);
    let area = 0; const o = p.outline, n = o.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += o[i * 2] * o[j * 2 + 1] - o[j * 2] * o[i * 2 + 1]; }
    sizeOf.set(p.id, { area: Math.abs(area / 2), long: Math.max(...usable.map((s) => Math.max(s.w, s.h))), high: Math.min(...usable.map((s) => s.h)) });
  }
  const placeable = parts.filter((p) => shapes.has(p.id));

  const run = (order: NestPart[]) => {
    const sheets: Sheet[] = [];
    const placements: Placement[] = [];
    const reach: number[] = [];
    for (const part of order) {
      let done = false;
      for (let si = 0; si <= sheets.length && !done; si++) {
        if (si === sheets.length) sheets.push(new Sheet(W, H, words)), reach.push(0);
        const sheet = sheets[si];
        let best: { s: Shape; cx: number; cy: number } | null = null;
        for (const s of shapes.get(part.id)!) {
          // spots next to what is already there, most promising (furthest left) first
          const spots: { cx: number; cy: number }[] = [];
          const xs = new Set(sheet.rights), ys = new Set(sheet.tops);
          // also a coarse grid of starting spots and the far edges, so a part can settle into
          // a pocket between others even when it would not fit right next to the last one
          for (let cx = 0; cx + s.w <= W; cx += 64) xs.add(cx);
          for (let cy = 0; cy + s.h <= H; cy += 64) ys.add(cy);
          xs.add(W - s.w); ys.add(H - s.h);
          for (const cx of xs) for (const cy of ys) if (sheet.fits(s, cx, cy)) spots.push({ cx, cy });
          spots.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
          for (const spot of spots.slice(0, 8)) {
            let { cx, cy } = spot;
            // let it settle: as far left and down as it will go
            for (let moved = true; moved;) {
              moved = false;
              for (const step of [32, 8, 1]) { while (sheet.fits(s, cx - step, cy)) { cx -= step; moved = true; } }
              for (const step of [32, 8, 1]) { while (sheet.fits(s, cx, cy - step)) { cy -= step; moved = true; } }
            }
            const better = !best || cx + s.w < best.cx + best.s.w || (cx + s.w === best.cx + best.s.w && cy < best.cy);
            if (better) best = { s, cx, cy };
          }
        }
        if (best) {
          sheet.put(best.s, best.cx, best.cy);
          reach[si] = Math.max(reach[si], best.cx + best.s.w);
          placements.push({
            partId: part.id, sheet: si, angle: best.s.angle,
            tx: options.margin + best.cx * cell - best.s.minX, ty: options.margin + best.cy * cell - best.s.minY,
          });
          done = true;
        }
      }
    }
    // length used on each sheet, measured to the edge of the outermost part plus the edge margin
    const usedLength = reach.map((r) => Math.min(options.sheetLength, Math.max(0, r * cell - 2 * pad) + 2 * options.margin));
    return { placements, sheets: sheets.length, usedLength };
  };

  const by = (key: (p: NestPart) => number) => [...placeable].sort((a, b) => key(b) - key(a));
  const orders = [by((p) => sizeOf.get(p.id)!.area), by((p) => sizeOf.get(p.id)!.long), by((p) => sizeOf.get(p.id)!.high)];
  let best: ReturnType<typeof run> | null = null;
  const score = (r: ReturnType<typeof run>) => (r.sheets - 1) * options.sheetLength + (r.usedLength[r.usedLength.length - 1] ?? 0);
  // further tries: the largest-first order with neighbours swapped here and there (always the same sequence,
  // so the same panels give the same arrangement every time)
  let seed = 12345;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let t = 0; t < (options.tries ?? 30); t++) {
    const o = [...orders[t % 2]];
    for (let k = 0; k + 1 < o.length; k++) if (random() < 0.35) { const j = Math.min(o.length - 1, k + 1 + Math.floor(random() * 3)); [o[k], o[j]] = [o[j], o[k]]; }
    orders.push(o);
  }
  for (const order of orders) {
    const r = run(order);
    if (!best || score(r) < score(best)) best = r;
  }
  return { ...(best ?? { placements: [], sheets: 0, usedLength: [] }), unplaced };
}

/** Moves points of a part to where the part was placed on its sheet. */
export function applyPlacement(p: Placement, points: ArrayLike<number>): number[] {
  const c = Math.cos((p.angle * Math.PI) / 180), s = Math.sin((p.angle * Math.PI) / 180), out = new Array<number>(points.length);
  for (let i = 0; i < points.length; i += 2) { out[i] = points[i] * c - points[i + 1] * s + p.tx; out[i + 1] = points[i] * s + points[i + 1] * c + p.ty; }
  return out;
}
