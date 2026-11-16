/**
 * Turns the rough scanned edge of a surface into a clean outline with
 * straight sides and sharp corners.
 *
 *  1. Narrow gaps cut into the edge (places the scanner did not read) are bridged.
 *  2. Corners are found where the edge changes direction.
 *  3. Each side is replaced by the straight line that best follows the scan,
 *     ignoring stray points; corners are where neighbouring lines meet.
 *
 * The user can then delete, move or add corners. A corner the user placed
 * ("manual") stays exactly where it was put.
 */
import { distToSegment, simplifyOpenIndices } from './poly';
import type { Vec2 } from './vec';

export interface Anchor {
  /** position along the prepared scan edge (point index) */
  at: number;
  /** set when the user placed this corner by hand */
  manual?: Vec2;
}

export interface CleanOptions {
  /** how far the edge may wander before it counts as a new corner, mm */
  tolerance: number;
  /** gaps narrower than this are bridged, mm (0 = off) */
  bridgeWidth: number;
}

export interface SideInfo { length: number; maxDeviation: number }
export interface CleanResult { corners: Vec2[]; sides: SideInfo[] }

export const DEFAULT_CLEAN: CleanOptions = { tolerance: 20, bridgeWidth: 40 };

/**
 * Step 1: bridge narrow inlets. Input and output are counter-clockwise loops.
 *
 * An inlet is a place where two edge points are close together (under `width`)
 * although the edge between them takes a long detour into the surface.
 */
export function bridgeGaps(loop: number[], width: number): number[] {
  if (width <= 0) return loop.slice();
  let pts = loop.slice();
  for (let pass = 0; pass < 8; pass++) {
    const n = pts.length / 2;
    if (n < 8) break;
    // running totals along the edge: distance travelled, and area swept (for a quick inlet/protrusion test)
    const along = new Float64Array(n + 1), swept = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      along[i + 1] = along[i] + Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
      swept[i + 1] = swept[i] + pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
    }
    const total = along[n];
    const maxDetour = Math.min(total / 3, width * 30);
    const removed = new Uint8Array(n);
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (removed[i]) continue;
      let bestStep = 0, bestSaved = 0;
      for (let step = 2; step < n - 2; step++) {
        const j = (i + step) % n;
        if (removed[j]) break;
        const path = j > i ? along[j] - along[i] : total - along[i] + along[j];
        if (path > maxDetour) break;
        const gap = Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
        if (gap > width || path < gap * 3 || path < width) continue;
        // Only bridge inlets (the skipped part dips into the surface); never cut off a real protrusion.
        const chain = (j > i ? swept[j] - swept[i] : swept[n] - swept[i] + swept[j]) + pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
        if (chain >= 0) continue;
        if (path - gap > bestSaved) { bestSaved = path - gap; bestStep = step; }
      }
      if (bestStep) {
        for (let k = 1; k < bestStep; k++) removed[(i + k) % n] = 1;
        changed = true;
      }
    }
    if (!changed) break;
    const next: number[] = [];
    for (let i = 0; i < n; i++) if (!removed[i]) next.push(pts[i * 2], pts[i * 2 + 1]);
    pts = next;
  }
  return pts;
}

/** Step 2: automatic corners. */
export function findCorners(edge: number[], tolerance: number): Anchor[] {
  const n = edge.length / 2;
  // start from the two points farthest apart, so the result does not depend on where the loop begins
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const d = (edge[i * 2] - edge[0]) ** 2 + (edge[i * 2 + 1] - edge[1]) ** 2;
    if (d > best) { best = d; b = i; }
  }
  best = -1;
  for (let i = 0; i < n; i++) {
    const d = (edge[i * 2] - edge[b * 2]) ** 2 + (edge[i * 2 + 1] - edge[b * 2 + 1]) ** 2;
    if (d > best) { best = d; a = i; }
  }
  const rotated: number[] = [];
  for (let k = 0; k < n; k++) { const q = (a + k) % n; rotated.push(edge[q * 2], edge[q * 2 + 1]); }
  const split = (b - a + n) % n;
  const first = simplifyOpenIndices(rotated.slice(0, split * 2 + 2), tolerance);
  const second = simplifyOpenIndices([...rotated.slice(split * 2), rotated[0], rotated[1]], tolerance).map((i) => i + split);
  const idx = [...first.slice(0, -1), ...second.slice(0, -1)].map((i) => (i + a) % n).sort((x, y) => x - y);
  return idx.map((at) => ({ at }));
}

interface Line { px: number; py: number; dx: number; dy: number; maxDeviation: number; ok: boolean }

/** Points every `step` mm along the edge, starting at point `from` and covering `count` points. */
function sampleEvery(edge: number[], from: number, count: number, step: number): number[] {
  const n = edge.length / 2;
  const out: number[] = [];
  let carry = 0;
  for (let k = 0; k + 1 < count; k++) {
    const a = (from + k) % n, b = (from + k + 1) % n;
    const ax = edge[a * 2], ay = edge[a * 2 + 1], dx = edge[b * 2] - ax, dy = edge[b * 2 + 1] - ay;
    const len = Math.hypot(dx, dy);
    let t = carry;
    for (; t <= len; t += step) out.push(ax + (dx * t) / (len || 1), ay + (dy * t) / (len || 1));
    carry = t - len;
  }
  return out;
}

/** Best straight line through the scan points of one side, ignoring strays. */
function fitSide(edge: number[], from: number, to: number): Line {
  const n = edge.length / 2;
  const count = ((to - from + n) % n) + 1;
  // Sample the scanned edge every 2 mm, so long clean stretches (stored with few
  // points) count as much as ragged ones (stored with many).
  const all = sampleEvery(edge, from, count, 2);
  const trim = Math.floor((all.length / 2) * 0.1); // corners are often rounded or ragged: leave the ends out
  const xs: number[] = [], ys: number[] = [];
  for (let k = trim; k < all.length / 2 - trim; k++) { xs.push(all[k * 2]); ys.push(all[k * 2 + 1]); }
  const ax = edge[from * 2], ay = edge[from * 2 + 1], bx = edge[to * 2], by = edge[to * 2 + 1];
  const chord: Line = { px: ax, py: ay, dx: bx - ax, dy: by - ay, maxDeviation: 0, ok: false };
  if (xs.length < 5) return chord;

  let keep = xs.map((_, i) => i);
  let line = chord;
  for (let pass = 0; pass < 6; pass++) {
    let cx = 0, cy = 0;
    for (const i of keep) { cx += xs[i]; cy += ys[i]; }
    cx /= keep.length; cy /= keep.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const i of keep) { const x = xs[i] - cx, y = ys[i] - cy; sxx += x * x; sxy += x * y; syy += y * y; }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const dist = (i: number) => Math.abs((xs[i] - cx) * -dy + (ys[i] - cy) * dx);
    const d = keep.map(dist).sort((p, q) => p - q);
    const median = d[Math.floor(d.length / 2)];
    const limit = Math.max(2.5, 3 * median);
    const next = xs.map((_, i) => i).filter((i) => dist(i) <= limit);
    line = { px: cx, py: cy, dx, dy, maxDeviation: Math.max(...next.map(dist), 0), ok: true };
    if (next.length < 5 || next.length === keep.length) break;
    keep = next;
  }
  return line;
}

function intersect(a: Line, b: Line): Vec2 | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  const la = Math.hypot(a.dx, a.dy), lb = Math.hypot(b.dx, b.dy);
  if (Math.abs(den) < 0.05 * la * lb) return null; // nearly parallel
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return [a.px + t * a.dx, a.py + t * a.dy];
}

/** Step 3: final corner positions for a set of anchors. */
export function resolveCorners(edge: number[], anchors: Anchor[], tolerance: number): CleanResult {
  const m = anchors.length;
  if (m < 3) throw new Error('An outline needs at least three corners.');
  const raw = (a: Anchor): Vec2 => a.manual ?? [edge[a.at * 2], edge[a.at * 2 + 1]];
  const lines = anchors.map((a, i) => fitSide(edge, a.at, anchors[(i + 1) % m].at));
  const corners = anchors.map((a, i): Vec2 => {
    if (a.manual) return a.manual;
    const before = lines[(i - 1 + m) % m], after = lines[i];
    const here = raw(a);
    if (!before.ok || !after.ok) return here;
    const x = intersect(before, after);
    // if the lines meet far from where the scan turns, trust the scan point
    if (!x || Math.hypot(x[0] - here[0], x[1] - here[1]) > Math.max(3 * tolerance, 40)) return here;
    return x;
  });
  const n = edge.length / 2;
  const sides = corners.map((c, i): SideInfo => {
    const d = corners[(i + 1) % m];
    // how far the scanned edge strays from this side (middle part only)
    const from = anchors[i].at, count = ((anchors[(i + 1) % m].at - from + n) % n) + 1;
    const pts = sampleEvery(edge, from, count, 2);
    const trim = Math.floor((pts.length / 2) * 0.1);
    const dists: number[] = [];
    for (let k = trim; k < pts.length / 2 - trim; k++) dists.push(distToSegment(pts[k * 2], pts[k * 2 + 1], c[0], c[1], d[0], d[1]));
    dists.sort((p, q) => p - q);
    const typical = dists.length ? dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.9))] : 0;
    return { length: Math.hypot(d[0] - c[0], d[1] - c[1]), maxDeviation: typical };
  });
  return { corners, sides };
}

/** Index of the scan-edge point nearest to (x, y). */
export function nearestEdgeIndex(edge: number[], x: number, y: number): number {
  let best = Infinity, at = 0;
  for (let i = 0; i < edge.length; i += 2) {
    const d = (edge[i] - x) ** 2 + (edge[i + 1] - y) ** 2;
    if (d < best) { best = d; at = i / 2; }
  }
  return at;
}

/** Everything in one go: prepared edge, automatic corners and their positions. */
export function autoClean(outer: number[], options: CleanOptions = DEFAULT_CLEAN) {
  const edge = bridgeGaps(outer, options.bridgeWidth);
  const anchors = findCorners(edge, options.tolerance);
  return { edge, anchors, ...resolveCorners(edge, anchors, options.tolerance) };
}
