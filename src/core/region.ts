/**
 * Shape arithmetic: combining, cutting and growing/shrinking closed shapes.
 * A "region" is a list of closed rings (x0,y0,x1,y1…, mm) that do not cross each
 * other; a point is inside the region when it is inside an odd number of rings
 * (so an outline with a hole in it is two rings).
 *
 * The heavy lifting is done by the Clipper library, which works on whole numbers;
 * coordinates are scaled to thousandths of a millimetre on the way in and out.
 */
import ClipperLib from 'clipper-lib';

export type Ring = number[];
export type Region = Ring[];

const SCALE = 1000;
type IntPath = { X: number; Y: number }[];

const toInt = (r: ArrayLike<number>): IntPath => {
  const out: IntPath = [];
  for (let i = 0; i < r.length; i += 2) out.push({ X: Math.round(r[i] * SCALE), Y: Math.round(r[i + 1] * SCALE) });
  return out;
};
const fromInt = (p: IntPath): Ring => { const out: number[] = []; for (const q of p) out.push(q.X / SCALE, q.Y / SCALE); return out; };
const fromPaths = (paths: IntPath[]): Region => paths.filter((p) => p.length >= 3).map(fromInt);

const EVEN_ODD = ClipperLib.PolyFillType.pftEvenOdd, NON_ZERO = ClipperLib.PolyFillType.pftNonZero;

function boolean(kind: number, a: ArrayLike<number>[], b: ArrayLike<number>[], fillA = EVEN_ODD, fillB = EVEN_ODD): Region {
  const c = new ClipperLib.Clipper();
  if (a.length) c.AddPaths(a.map(toInt), ClipperLib.PolyType.ptSubject, true);
  if (b.length) c.AddPaths(b.map(toInt), ClipperLib.PolyType.ptClip, true);
  const out: IntPath[] = [];
  c.Execute(kind, out, fillA, fillB);
  return fromPaths(out);
}

/** What both regions cover. */
export const intersect = (a: Region, b: Region) => boolean(ClipperLib.ClipType.ctIntersection, a, b);
/** `a` with everything in `b` removed. */
export const subtract = (a: Region, b: Region) => boolean(ClipperLib.ClipType.ctDifference, a, b);
/** Everything covered by either. */
export const union = (a: Region, b: Region = []) => boolean(ClipperLib.ClipType.ctUnion, a, b);

/**
 * Tidies arbitrary rings (possibly overlapping, any direction) into a clean region.
 * `nonZero` follows the usual drawing-program rule (SVG default); otherwise even-odd.
 */
export function cleanRegion(rings: ArrayLike<number>[], nonZero = true): Region {
  const fill = nonZero ? NON_ZERO : EVEN_ODD;
  return boolean(ClipperLib.ClipType.ctUnion, rings, [], fill, fill);
}

/** Grows (positive) or shrinks (negative) a region by `delta` mm, with rounded corners. */
export function grow(region: Region, delta: number): Region {
  if (!region.length) return [];
  const o = new ClipperLib.ClipperOffset(2, 0.02 * SCALE);
  o.AddPaths(region.map(toInt), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: IntPath[] = [];
  o.Execute(out, delta * SCALE);
  return fromPaths(out);
}

/** The band within `width` mm of open lines (for keeping a pattern clear of line artwork). */
export function thicken(lines: ArrayLike<number>[], width: number): Region {
  const usable = lines.filter((l) => l.length >= 4);
  if (!usable.length || width <= 0) return [];
  const o = new ClipperLib.ClipperOffset(2, 0.02 * SCALE);
  o.AddPaths(usable.map(toInt), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
  const out: IntPath[] = [];
  o.Execute(out, width * SCALE);
  return fromPaths(out);
}

/** Area of a region in mm² (holes count negative, as they should). */
export function regionArea(region: Region): number {
  let s = 0;
  for (const r of region) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1]; }
  }
  return Math.abs(s / 2);
}
