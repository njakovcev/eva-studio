/**
 * Grooves in two passes, one each way.
 *
 * Milling a groove the full width of the cutter, one wall is cut with the cutter's edge
 * moving along with the travel (climb milling) and the other against it (conventional).
 * EVA tears on one of the two, which leaves a ragged wall on one side of every groove.
 * Two passes, each moved half the offset to one side and run in opposite directions,
 * finish both walls the same way; the groove stays centred and gets `offset` wider.
 *
 * Assumes the spindle turns clockwise seen from above (M3): climb milling then finishes
 * the wall on the left of the direction of travel.
 */

export interface GroovePasses {
  on: boolean;
  /** distance between the two passes, mm */
  offset: number;
  /** which way of milling finishes the walls */
  finish: 'climb' | 'conventional';
}

export const defaultGroovePasses = (): GroovePasses => ({ on: true, offset: 0.5, finish: 'climb' });
export const NO_PASSES: GroovePasses = { on: false, offset: 0.5, finish: 'climb' };

/** Removes points that repeat the one before (they have no direction). */
function clean(pts: number[], closed: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const n = out.length;
    if (n && Math.hypot(pts[i] - out[n - 2], pts[i + 1] - out[n - 1]) < 1e-6) continue;
    out.push(pts[i], pts[i + 1]);
  }
  if (closed && out.length >= 4 && Math.hypot(out[0] - out[out.length - 2], out[1] - out[out.length - 1]) < 1e-6) out.length -= 2;
  return out;
}

/** The line moved sideways by `d` mm (positive: to the left of its direction), corners mitred. */
export function offsetLine(pts: number[], closed: boolean, d: number): number[] {
  const p = clean(pts, closed), n = p.length / 2;
  if (n < 2 || d === 0) return p.slice();
  const normal = (i: number, j: number) => {
    const dx = p[j * 2] - p[i * 2], dy = p[j * 2 + 1] - p[i * 2 + 1], l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
    const a = hasPrev ? normal((i - 1 + n) % n, i) : null, b = hasNext ? normal(i, (i + 1) % n) : null;
    let mx: number, my: number;
    if (a && b) {
      // the corner point that is `d` away from both neighbouring segments
      const k = 1 + a[0] * b[0] + a[1] * b[1];
      if (k < 0.25) { mx = b[0] * d; my = b[1] * d; } // nearly a U-turn: do not shoot far out
      else { mx = ((a[0] + b[0]) * d) / k; my = ((a[1] + b[1]) * d) / k; }
    } else { const m = (a ?? b)!; mx = m[0] * d; my = m[1] * d; }
    out.push(p[i * 2] + mx, p[i * 2 + 1] + my);
  }
  return out;
}

/** The same line run the other way. */
export function reverseLine(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

/** A closed line with arcs (bulges), run the other way: the arcs keep their shape. */
export function reverseBulged(points: number[], bulges: number[]): { points: number[]; bulges: number[] } {
  const n = points.length / 2;
  const pts: number[] = [], bs: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = n - 1 - k;
    pts.push(points[i * 2], points[i * 2 + 1]);
    bs.push(-(bulges[(i - 1 + n) % n] ?? 0));
  }
  return { points: pts, bulges: bs };
}

/**
 * The two passes for one groove line, in the order and direction to cut them.
 */
export function twoWay(pts: number[], closed: boolean, p: GroovePasses): [number[], number[]] {
  const h = p.offset / 2, side = p.finish === 'climb' ? 1 : -1;
  return [offsetLine(pts, closed, side * h), reverseLine(offsetLine(pts, closed, -side * h))];
}

/** Sideways shift of the first pass for a counter-clockwise closed line (positive: inwards, to the left). */
export const firstPassShift = (p: GroovePasses) => (p.finish === 'climb' ? 1 : -1) * (p.offset / 2);
