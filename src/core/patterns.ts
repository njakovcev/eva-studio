/**
 * The pattern library. A pattern is a set of lines that covers an area; the
 * app cuts it to each panel. Patterns are laid out in the surface's own
 * coordinates, so they continue from one panel to the next.
 *
 * To add a pattern: write a generator that fills a rectangle (in the pattern's
 * own, unrotated coordinates) with lines, and add it to PATTERNS.
 */
export interface PatternParam { key: string; label: string; unit: string; min: number; max: number; step: number; default: number }

export interface PatternDef {
  id: string;
  name: string;
  params: PatternParam[];
  /** lines covering the rectangle x0…x1, y0…y1; each line is x0,y0,x1,y1… */
  generate(box: { x0: number; y0: number; x1: number; y1: number }, p: Record<string, number>): number[][];
}

const SIZE = (label: string, def: number, max = 400): PatternParam => ({ key: 'size', label, unit: 'mm', min: 15, max, step: 1, default: def });

const lines: PatternDef = {
  id: 'lines', name: 'Teak lines',
  params: [SIZE('Plank width', 55)],
  generate(b, p) {
    const out: number[][] = [];
    for (let k = Math.ceil(b.y0 / p.size); k * p.size <= b.y1; k++) out.push([b.x0, k * p.size, b.x1, k * p.size]);
    return out;
  },
};

const diamond: PatternDef = {
  id: 'diamond', name: 'Diamond',
  params: [SIZE('Diamond width', 50), { key: 'stretch', label: 'Length ÷ width', unit: '×', min: 1, max: 5, step: 0.1, default: 2.5 }],
  generate(b, p) {
    // two families of slanted lines; every diamond is `size` wide and `size × stretch` long
    const w = p.size, h = p.size * p.stretch, out: number[][] = [];
    for (const sign of [1, -1]) {
      // line: y = sign·(h/w)·x + c, with c stepping by h
      const slope = (sign * h) / w;
      const cs = [b.y0 - slope * b.x0, b.y0 - slope * b.x1, b.y1 - slope * b.x0, b.y1 - slope * b.x1];
      for (let k = Math.ceil(Math.min(...cs) / h); k * h <= Math.max(...cs); k++) out.push([b.x0, slope * b.x0 + k * h, b.x1, slope * b.x1 + k * h]);
    }
    return out;
  },
};

const hexagon: PatternDef = {
  id: 'hexagon', name: 'Hexagon',
  params: [SIZE('Hexagon width', 60)],
  generate(b, p) {
    const s = p.size, R = s / Math.sqrt(3), out: number[][] = [];
    for (let j = Math.floor(b.y0 / (1.5 * R)) - 1; j * 1.5 * R <= b.y1 + 2 * R; j++) {
      const shift = (((j % 2) + 2) % 2) * 0.5;
      for (let i = Math.floor(b.x0 / s) - 1; (i + shift) * s <= b.x1 + s; i++) {
        const cx = (i + shift) * s, cy = j * 1.5 * R;
        // three of the six edges per hexagon; the neighbours supply the rest
        out.push([cx + s / 2, cy + R / 2, cx, cy + R, cx - s / 2, cy + R / 2, cx - s / 2, cy - R / 2]);
      }
    }
    return out;
  },
};

const fishScale: PatternDef = {
  id: 'fishscale', name: 'Fish scale',
  params: [SIZE('Scale width', 70)],
  generate(b, p) {
    const r = p.size / 2, out: number[][] = [], STEPS = 24;
    for (let j = Math.floor(b.y0 / r) - 1; j * r <= b.y1; j++) {
      const shift = (((j % 2) + 2) % 2) * r;
      for (let i = Math.floor(b.x0 / (2 * r)) - 1; i * 2 * r + shift <= b.x1 + r; i++) {
        const cx = i * 2 * r + shift, cy = j * r, arc: number[] = [];
        for (let k = 0; k <= STEPS; k++) { const a = (Math.PI * k) / STEPS; arc.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
        out.push(arc);
      }
    }
    return out;
  },
};

export const PATTERNS: PatternDef[] = [lines, diamond, hexagon, fishScale];
export const patternById = (id: string) => PATTERNS.find((p) => p.id === id);

export interface PatternPlacement {
  /** which pattern; 'none' for a plain panel */
  kind: string;
  params: Record<string, number>;
  /** direction of the pattern, degrees */
  angle: number;
  /** a point the pattern is anchored to (move it to shift the pattern), mm */
  originX: number;
  originY: number;
}

export function defaultParams(def: PatternDef): Record<string, number> {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

/** The pattern's lines covering a rectangle of the surface (before cutting to a panel). */
export function patternLines(place: PatternPlacement, area: { minX: number; minY: number; maxX: number; maxY: number }): number[][] {
  const def = patternById(place.kind);
  if (!def) return [];
  const params = { ...defaultParams(def), ...place.params };
  const cos = Math.cos((place.angle * Math.PI) / 180), sin = Math.sin((place.angle * Math.PI) / 180);
  // the area's corners in the pattern's own (unrotated) coordinates
  const local = [[area.minX, area.minY], [area.maxX, area.minY], [area.maxX, area.maxY], [area.minX, area.maxY]].map(([x, y]) => {
    const dx = x - place.originX, dy = y - place.originY;
    return [dx * cos + dy * sin, -dx * sin + dy * cos];
  });
  const xs = local.map((q) => q[0]), ys = local.map((q) => q[1]);
  const box = { x0: Math.min(...xs) - 1, y0: Math.min(...ys) - 1, x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 };
  return def.generate(box, params).map((l) => {
    const out = new Array<number>(l.length);
    for (let k = 0; k < l.length; k += 2) {
      out[k] = place.originX + l[k] * cos - l[k + 1] * sin;
      out[k + 1] = place.originY + l[k] * sin + l[k + 1] * cos;
    }
    return out;
  });
}
