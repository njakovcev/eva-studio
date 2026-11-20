/**
 * An EVA panel: the piece that is cut and glued onto a surface.
 *
 * A panel has its own `shape`, which starts as a copy of the surface outline
 * and can then be reshaped freely (the panel does not have to follow every
 * bump of the surface). The line that is actually cut is derived from it:
 * every side is moved inwards by its own offset, and every corner is rounded
 * with its own radius.
 */
import { LAYER } from './operations';
import { sidePath } from './cleanOutline';
import { writeDxf } from './dxf';
import { bounds, extendToMeet, polygonArea } from './poly';
import { cleanRegion, regionArea } from './region';
import type { ProjectSettings } from './project';
import { outlinePolygonOf, type Surface } from './surface';
import type { Vec2 } from './vec';

export interface PanelShape {
  /** counter-clockwise */
  corners: Vec2[];
  /** per side (corner i → corner i+1): points in between if curved, else null */
  curves: (number[] | null)[];
}

export interface Panel {
  id: string;
  name: string;
  surfaceId: string;
  shape: PanelShape;
  /** per side: how far the cut line sits inside the shape, mm */
  offsets: number[];
  /** per corner: rounding radius, mm (0 = sharp) */
  radii: number[];
  /** openings cut out of the panel: drains, fittings, hatches */
  cutouts?: Cutout[];
  /**
   * Which way the bow is for this panel only, degrees in surface coordinates (see Surface.bow).
   * Missing: the bow of its surface.
   */
  bow?: number;
  createdAt: string;
}

/** An opening. Its size is the size of the hole that is cut (add clearance yourself). */
export type Cutout =
  | { id: string; kind: 'circle'; center: Vec2; diameter: number }
  | { id: string; kind: 'rect'; center: Vec2; width: number; height: number; angle: number; radius: number };

export interface CutOutline {
  /** x0,y0,x1,y1… closed, counter-clockwise */
  points: number[];
  /** per point: arc bulge towards the next point (0 = straight line) */
  bulges: number[];
  /** the same line with arcs broken into short straight pieces (for drawing and measuring) */
  flat: number[];
  /** per corner: the radius actually used (smaller than asked if it did not fit) */
  usedRadii: number[];
  warnings: string[];
}

export function createPanel(args: { id: string; name: string; surface: Surface; settings: ProjectSettings }, now = new Date()): Panel {
  const { corners, curves } = args.surface.outline;
  const n = corners.length;
  return {
    id: args.id, name: args.name, surfaceId: args.surface.id,
    shape: { corners: corners.map((c) => [c[0], c[1]]), curves: corners.map((_, i) => (curves?.[i] ? [...curves[i]!] : null)) },
    offsets: new Array(n).fill(args.settings.defaultEdgeOffset),
    radii: new Array(n).fill(args.settings.defaultCornerRadius),
    createdAt: now.toISOString(),
  };
}

// ---------- small path helpers (paths are lists of points) ----------

const toPoints = (flat: number[]): Vec2[] => { const out: Vec2[] = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const pathLength = (p: Vec2[]) => { let s = 0; for (let i = 0; i + 1 < p.length; i++) s += dist(p[i], p[i + 1]); return s; };

/** Moves a path sideways by `d` (to the left of its direction: inwards for a counter-clockwise outline). */
function offsetPath(p: Vec2[], d: number): Vec2[] {
  const normals: Vec2[] = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1], l = Math.hypot(dx, dy) || 1;
    normals.push([-dy / l, dx / l]);
  }
  return p.map((q, i): Vec2 => {
    const a = normals[Math.max(0, i - 1)], b = normals[Math.min(normals.length - 1, i)];
    let mx = a[0] + b[0], my = a[1] + b[1];
    const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
    const k = d / Math.max(0.3, mx * b[0] + my * b[1]); // keeps the distance to both neighbouring segments
    return [q[0] + mx * k, q[1] + my * k];
  });
}

/** Where path A (arriving) and path B (leaving) meet near a corner; both may be extended in a straight line. */
function join(A: Vec2[], B: Vec2[]): { x: Vec2; ia: number; ib: number } | null {
  const LIMIT = 40;
  const reach = pathLength(A) + pathLength(B) + 1000;
  for (let sum = 0; sum < 2 * LIMIT; sum++) {
    for (let sa = 0; sa <= sum; sa++) {
      const sb = sum - sa;
      const ja = A.length - 2 - sa, kb = sb;
      if (ja < 0 || kb > B.length - 2 || sa >= LIMIT || sb >= LIMIT) continue;
      const p = A[ja], r: Vec2 = [A[ja + 1][0] - p[0], A[ja + 1][1] - p[1]];
      const q = B[kb], s: Vec2 = [B[kb + 1][0] - q[0], B[kb + 1][1] - q[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      const lr = Math.hypot(r[0], r[1]), ls = Math.hypot(s[0], s[1]);
      if (Math.abs(den) < 1e-6 * lr * ls) continue; // parallel
      const tA = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den;
      const tB = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
      const lastA = sa === 0, firstB = sb === 0;
      // a side's line may also be cut back past its own start (A) or end (B): with a large offset a
      // short side (a step) can be overrun by its neighbour, and only the lines' crossing is right
      const wholeA = ja === 0, wholeB = kb === B.length - 2;
      if ((!wholeA && tA < -1e-9) || (!lastA && tA > 1 + 1e-9)) continue;
      if ((!wholeB && tB > 1 + 1e-9) || (!firstB && tB < -1e-9)) continue;
      if ((tA - 1) * lr > reach || -tB * ls > reach) continue; // would meet absurdly far away
      return { x: [p[0] + r[0] * tA, p[1] + r[1] * tA], ia: ja, ib: kb + 1 };
    }
  }
  return null;
}

/** The part of a path between two distances along it. */
function subPath(p: Vec2[], from: number, to: number): Vec2[] {
  const out: Vec2[] = [];
  let walked = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const l = dist(p[i], p[i + 1]);
    const a = walked, b = walked + l;
    const at = (d: number): Vec2 => { const t = l > 0 ? (d - a) / l : 0; return [p[i][0] + (p[i + 1][0] - p[i][0]) * t, p[i][1] + (p[i + 1][1] - p[i][1]) * t]; };
    if (out.length === 0 && from <= b + 1e-9) out.push(at(Math.max(from, a)));
    if (out.length > 0) {
      if (to <= b + 1e-9) { out.push(at(Math.min(to, b))); return out; }
      out.push(p[i + 1]);
    }
    walked = b;
  }
  if (out.length === 0) out.push(p[p.length - 1]);
  return out;
}

// ---------- the cut line ----------

export function cutOutline(panel: Panel): CutOutline {
  const { shape } = panel;
  const n = shape.corners.length;
  const warnings: string[] = [];
  const side = (i: number) => toPoints(sidePath(shape, i));

  // 1. every side moved inwards by its own offset
  const moved = shape.corners.map((_, i) => offsetPath(side(i), panel.offsets[i] ?? 0));

  // 2. neighbouring sides meet in new corners
  const joins = moved.map((B, i) => join(moved[(i - 1 + n) % n], B));
  const sides: Vec2[][] = moved.map((B, i) => {
    const start = joins[i], end = joins[(i + 1) % n];
    const from = start ? start.ib : 0, to = end ? end.ia : B.length - 1;
    const first = start ? start.x : B[0], last = end ? end.x : B[B.length - 1];
    if (from > to + 1) { warnings.push(`Side ${i + 1} disappears with these offsets.`); return [first, last]; }
    return [first, ...B.slice(from, to + 1), last].filter((q, k, arr) => k === 0 || dist(q, arr[k - 1]) > 1e-6);
  });
  sides.forEach((s, i) => { if (s.length < 2) { sides[i] = [s[0], s[0]]; } });

  // 3. rounding: how much of each side every corner takes
  const lengths = sides.map(pathLength);
  const want = shape.corners.map((_, i) => {
    const r = Math.max(0, panel.radii[i] ?? 0);
    const prev = sides[(i - 1 + n) % n], next = sides[i];
    if (r === 0 || !joins[i] || prev.length < 2 || next.length < 2) return { t: 0, half: 0 };
    const x = next[0], a = prev[prev.length - 2], b = next[1];
    const u: Vec2 = [a[0] - x[0], a[1] - x[1]], v: Vec2 = [b[0] - x[0], b[1] - x[1]];
    const lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
    if (lu < 1e-9 || lv < 1e-9) return { t: 0, half: 0 };
    const angle = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv))));
    if (angle > Math.PI - 0.02) return { t: 0, half: 0 }; // practically straight: nothing to round
    return { t: r / Math.tan(angle / 2), half: angle / 2 };
  });
  const scale = new Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, need = want[i].t + want[j].t;
    if (need > lengths[i] * 0.999 && need > 0) {
      const f = (lengths[i] * 0.999) / need;
      scale[i] = Math.min(scale[i], f); scale[j] = Math.min(scale[j], f);
    }
  }
  const take = want.map((w, i) => w.t * scale[i]);
  const usedRadii = want.map((w, i) => (w.t > 0 ? take[i] * Math.tan(w.half) : 0));
  usedRadii.forEach((r, i) => { if (r < (panel.radii[i] ?? 0) - 0.05 && want[i].t > 0) warnings.push(`Corner ${i + 1}: radius reduced to ${r.toFixed(0)} mm to fit.`); });

  // 4. put it together: side, arc, side, arc…
  const points: number[] = [], bulges: number[] = [];
  const push = (q: Vec2, bulge = 0) => {
    const k = points.length;
    if (k >= 2 && Math.hypot(points[k - 2] - q[0], points[k - 1] - q[1]) < 1e-6) { bulges[bulges.length - 1] = bulge; return; }
    points.push(q[0], q[1]); bulges.push(bulge);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const part = subPath(sides[i], take[i], lengths[i] - take[j]);
    part.forEach((q) => push(q));
    if (take[j] > 1e-9) {
      // arc from the end of this side to the start of the next, leaving in this side's direction
      const pa = part[part.length - 1], before = part.length > 1 ? part[part.length - 2] : sides[i][0];
      const pb = subPath(sides[j], take[j], take[j])[0];
      const tx = pa[0] - before[0], ty = pa[1] - before[1], cx = pb[0] - pa[0], cy = pb[1] - pa[1];
      const alpha = Math.atan2(tx * cy - ty * cx, tx * cx + ty * cy);
      bulges[bulges.length - 1] = Math.tan(alpha / 2);
    } else if (!joins[j]) {
      push(sides[j][0]); // parallel neighbours with different offsets: a small step
    }
  }
  // close-up: the last point may repeat the first
  if (points.length >= 4 && Math.hypot(points[0] - points[points.length - 2], points[1] - points[points.length - 1]) < 1e-6) {
    points.length -= 2; bulges.length -= 1;
  }

  const flat = flattenArcs(points, bulges);
  if (polygonArea(flat) <= 0) warnings.push('The offsets are too large for this shape.');
  else {
    // a line that crosses itself cannot be cut: happens where the shape is narrower than the offsets and corners need
    const tidy = cleanRegion([flat], false);
    if (tidy.length !== 1 || Math.abs(regionArea(tidy) - polygonArea(flat)) > 1) warnings.push('The cut line crosses itself: a part of this shape is too narrow for these offsets and corner radii. Reshape the panel or make them smaller.');
  }
  return { points, bulges, flat, usedRadii, warnings };
}

/**
 * A line running parallel to the cut line, `inset` mm inside it (used for the border groove).
 * Rounded corners stay concentric: outside corners get a smaller radius, inside corners a larger one.
 */
export function insetCut(panel: Panel, inset: number): CutOutline {
  const { corners } = panel.shape, n = corners.length;
  // concentric with the corners the cut line really has (a radius reduced to fit stays reduced)
  const used = cutOutline(panel).usedRadii;
  const radii = used.map((r, i) => {
    const prev = sidePath(panel.shape, (i - 1 + n) % n), next = sidePath(panel.shape, i);
    const ax = prev[prev.length - 2] - prev[prev.length - 4], ay = prev[prev.length - 1] - prev[prev.length - 3];
    const bx = next[2] - next[0], by = next[3] - next[1];
    const outside = ax * by - ay * bx > 0; // a left turn on a counter-clockwise shape
    return outside ? Math.max(0, r - inset) : r > 0 ? r + inset : 0;
  });
  return cutOutline({ ...panel, offsets: panel.offsets.map((o) => o + inset), radii });
}

/** Breaks arcs into short straight pieces (within `tolerance` mm of the true arc). */
export function flattenArcs(points: number[], bulges: number[], tolerance = 0.05): number[] {
  const out: number[] = [];
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = points[i * 2], ay = points[i * 2 + 1], bx = points[j * 2], by = points[j * 2 + 1];
    out.push(ax, ay);
    const bulge = bulges[i];
    if (!bulge) continue;
    const sweep = 4 * Math.atan(bulge), chord = Math.hypot(bx - ax, by - ay);
    if (chord < 1e-9) continue;
    const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
    // centre: from the chord's middle, sideways
    const h = radius * Math.cos(Math.abs(sweep) / 2) * Math.sign(bulge);
    const cx = (ax + bx) / 2 - ((by - ay) / chord) * h, cy = (ay + by) / 2 + ((bx - ax) / chord) * h;
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(0, 1 - tolerance / radius)))));
    const start = Math.atan2(ay - cy, ax - cx);
    for (let k = 1; k < steps; k++) { const a = start + (sweep * k) / steps; out.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a)); }
  }
  return out;
}

// ---------- reshaping ----------

/** Slides the ends of a curved side to new corner positions, fading the shift along the curve. */
function repin(curve: number[] | null, oldA: Vec2, oldB: Vec2, newA: Vec2, newB: Vec2): number[] | null {
  if (!curve) return null;
  const m = curve.length / 2, out: number[] = [];
  for (let i = 0; i < m; i++) {
    const t = (i + 1) / (m + 1);
    out.push(curve[i * 2] + (newA[0] - oldA[0]) * (1 - t) + (newB[0] - oldB[0]) * t, curve[i * 2 + 1] + (newA[1] - oldA[1]) * (1 - t) + (newB[1] - oldB[1]) * t);
  }
  return out;
}

export function moveCorner(panel: Panel, i: number, to: Vec2): Panel {
  const { corners, curves } = panel.shape, n = corners.length;
  const prev = (i - 1 + n) % n, next = (i + 1) % n, old = corners[i];
  const newCurves = curves.slice();
  newCurves[prev] = repin(curves[prev], corners[prev], old, corners[prev], to);
  newCurves[i] = repin(curves[i], old, corners[next], to, corners[next]);
  return { ...panel, shape: { corners: corners.map((c, k) => (k === i ? to : c)), curves: newCurves } };
}

// ---------- side lengths ----------

type Line = { p: Vec2; d: Vec2 };

/** Where two lines cross (null when parallel). */
function crossing(a: Line, b: Line): Vec2 | null {
  const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(den) < 1e-9 * Math.hypot(...a.d) * Math.hypot(...b.d)) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
  return [a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t];
}

/** The line of straight side k of the shape, or of the cut line (moved inside by its offset). */
function sideLine(panel: Panel, k: number, onCut: boolean): Line {
  const { corners } = panel.shape, n = corners.length;
  const a = corners[k], b = corners[(k + 1) % n];
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(d[0], d[1]) || 1;
  const off = onCut ? panel.offsets[k] ?? 0 : 0;
  // counter-clockwise shape: inside is to the left
  return { p: [a[0] - (d[1] / l) * off, a[1] + (d[0] / l) * off], d };
}

/**
 * Length of side i of the finished panel: along the cut line, between the points where it meets
 * its neighbouring sides (as if the corners were not rounded). Null when this side or a
 * neighbour is curved, or when neighbours are parallel to it.
 */
export function cutSideLength(panel: Panel, i: number): number | null {
  const { curves } = panel.shape, n = curves.length;
  const before = (i - 1 + n) % n, after = (i + 1) % n;
  if (curves[i] || curves[before] || curves[after]) return null;
  const line = sideLine(panel, i, true);
  const a = crossing(sideLine(panel, before, true), line), b = crossing(line, sideLine(panel, after, true));
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null;
}

/**
 * Makes side i of the finished panel `length` mm long (see cutSideLength). The side after it
 * (or before it) moves parallel to itself; every side keeps its direction, so angles stay as they are.
 */
export function setCutSideLength(panel: Panel, i: number, length: number, move: 'after' | 'before' = 'after'): Panel {
  const { corners, curves } = panel.shape, n = corners.length;
  const now = cutSideLength(panel, i);
  if (now === null) throw new Error('The length can only be typed for a straight side between two straight sides.');
  if (!(length > 0)) throw new Error('Type a length above 0 mm.');
  const delta = length - now;
  const d = sideLine(panel, i, false).d, l = Math.hypot(d[0], d[1]), u: Vec2 = [d[0] / l, d[1] / l];
  const next = corners.slice();
  if (move === 'after') {
    // corner i+1 slides along side i; corner i+2 slides along side i+2, so side i+1 moves parallel
    const j = (i + 1) % n, k = (i + 2) % n;
    if (curves[j] || curves[k]) throw new Error('The side after this one and the one after it must be straight to move.');
    next[j] = [corners[j][0] + u[0] * delta, corners[j][1] + u[1] * delta];
    const meet = crossing({ p: next[j], d: sideLine(panel, j, false).d }, sideLine(panel, k, false));
    if (!meet) throw new Error('The next two sides are parallel, so the side cannot move this way. Move the side before it instead.');
    next[k] = meet;
  } else {
    const j = i, k = (i - 1 + n) % n, h = (i - 2 + n) % n;
    if (curves[k] || curves[h]) throw new Error('The side before this one and the one before it must be straight to move.');
    next[j] = [corners[j][0] - u[0] * delta, corners[j][1] - u[1] * delta];
    const meet = crossing({ p: next[j], d: sideLine(panel, k, false).d }, sideLine(panel, h, false));
    if (!meet) throw new Error('The two sides before it are parallel, so the side cannot move this way. Move the side after it instead.');
    next[k] = meet;
  }
  if (polygonArea(next.flat()) <= 0) throw new Error('That length turns the panel inside out. Type a smaller change.');
  return { ...panel, shape: { corners: next, curves } };
}

/** Removes a corner: its two sides become one straight side (keeping the offset of the first). */
export function removeCorner(panel: Panel, i: number): Panel {
  const n = panel.shape.corners.length;
  if (n <= 3) return panel;
  const curves = panel.shape.curves.slice();
  curves[(i - 1 + n) % n] = null;
  const drop = <T,>(a: T[]) => a.filter((_, k) => k !== i);
  return { ...panel, shape: { corners: drop(panel.shape.corners), curves: drop(curves) }, offsets: drop(panel.offsets), radii: drop(panel.radii) };
}

/**
 * Removes one side by extending its two neighbours until they meet (for example to ignore
 * the tip of a protrusion). The neighbours stay on their lines and keep their offsets.
 */
export function removeSide(panel: Panel, i: number): Panel {
  const { corners, curves } = panel.shape, n = corners.length;
  if (n < 4) throw new Error('A panel needs at least three sides.');
  const before = (i - 1 + n) % n, after = (i + 1) % n, afterEnd = (i + 2) % n;
  if (curves[before] || curves[after]) throw new Error('This works when both neighbouring sides are straight.');
  const meet = extendToMeet(corners[before], corners[i], corners[after], corners[afterEnd]);
  // corner i moves to the meeting point; corner i+1 and side i go away
  const keep = <T,>(a: T[], dropIndex: number) => a.filter((_, k) => k !== dropIndex);
  const newCorners = corners.map((c, k) => (k === i ? meet : c));
  const newCurves = curves.slice(); newCurves[i] = curves[after]; // side i is now what side i+1 was
  const newOffsets = panel.offsets.slice(); newOffsets[i] = panel.offsets[after];
  return {
    ...panel,
    shape: { corners: keep(newCorners, after), curves: keep(newCurves, after) },
    offsets: keep(newOffsets, after),
    radii: keep(panel.radii, after),
  };
}

/** Adds a corner on a side, at the point of that side nearest to `at`. */
export function addCorner(panel: Panel, sideIndex: number, at: Vec2, radius: number): Panel {
  const { corners, curves } = panel.shape;
  const curve = curves[sideIndex];
  let point = at, before: number[] | null = null, after: number[] | null = null;
  if (curve && curve.length >= 2) {
    let best = Infinity, k = 0;
    for (let q = 0; q < curve.length; q += 2) { const d = Math.hypot(curve[q] - at[0], curve[q + 1] - at[1]); if (d < best) { best = d; k = q; } }
    point = [curve[k], curve[k + 1]];
    before = curve.slice(0, k); after = curve.slice(k + 2);
    if (before.length === 0) before = null;
    if (after.length === 0) after = null;
  }
  const insert = <T,>(a: T[], value: T) => [...a.slice(0, sideIndex + 1), value, ...a.slice(sideIndex + 1)];
  const newCurves = curves.slice(); newCurves[sideIndex] = before;
  return {
    ...panel,
    shape: { corners: insert(corners, point), curves: insert(newCurves, after) },
    offsets: insert(panel.offsets, panel.offsets[sideIndex]),
    radii: insert(panel.radii, radius),
  };
}

// ---------- openings ----------

/** The cut line of an opening, with true arcs. */
export function cutoutOutline(c: Cutout): { points: number[]; bulges: number[]; flat: number[] } {
  let points: number[], bulges: number[];
  if (c.kind === 'circle') {
    const r = c.diameter / 2;
    points = [c.center[0] - r, c.center[1], c.center[0] + r, c.center[1]];
    bulges = [1, 1]; // two half circles
  } else {
    const w = c.width / 2, h = c.height / 2, r = Math.max(0, Math.min(c.radius, w, h));
    const local: number[] = r > 0
      ? [-w + r, -h, w - r, -h, w, -h + r, w, h - r, w - r, h, -w + r, h, -w, h - r, -w, -h + r]
      : [-w, -h, w, -h, w, h, -w, h];
    const quarter = Math.tan(Math.PI / 8);
    bulges = r > 0 ? [0, quarter, 0, quarter, 0, quarter, 0, quarter] : [0, 0, 0, 0];
    const cos = Math.cos((c.angle * Math.PI) / 180), sin = Math.sin((c.angle * Math.PI) / 180);
    points = [];
    for (let i = 0; i < local.length; i += 2) points.push(c.center[0] + local[i] * cos - local[i + 1] * sin, c.center[1] + local[i] * sin + local[i + 1] * cos);
  }
  return { points, bulges, flat: flattenArcs(points, bulges) };
}

export function pointInPolygon(x: number, y: number, poly: ArrayLike<number>): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Plain-language problems with the openings of a panel (outside the panel, or too close to its edge). */
export function cutoutWarnings(panel: Panel, cut: CutOutline): string[] {
  const out: string[] = [];
  (panel.cutouts ?? []).forEach((c, i) => {
    const flat = cutoutOutline(c).flat;
    let outside = false;
    for (let k = 0; k < flat.length; k += 2) if (!pointInPolygon(flat[k], flat[k + 1], cut.flat)) { outside = true; break; }
    if (outside) out.push(`Opening ${i + 1} reaches outside the panel.`);
  });
  return out;
}

/** How far an opening's edge is from one side of the panel (measured to the cut line of that side). */
export interface EdgeDistance {
  side: number;
  /** mm, edge of the opening to the cut line; negative if the opening crosses it */
  distance: number;
  /** the two ends of the measurement: on the panel edge, and on the opening */
  from: Vec2;
  to: Vec2;
}

/**
 * Distances from an opening to the nearest sides of the panel, nearest first.
 * Only sides the opening actually faces are listed (not ones it merely lies beyond the end of).
 */
export function cutoutDistances(panel: Panel, index: number, max = 3): EdgeDistance[] {
  const c = panel.cutouts?.[index];
  if (!c) return [];
  const outline = toPoints(cutoutOutline(c).flat);
  const n = panel.shape.corners.length;
  const out: EdgeDistance[] = [];
  for (let i = 0; i < n; i++) {
    const path = offsetPath(toPoints(sidePath(panel.shape, i)), panel.offsets[i] ?? 0);
    let best: EdgeDistance | null = null, atEnd = false;
    const total = pathLength(path);
    for (const q of outline) {
      let walked = 0;
      for (let k = 0; k + 1 < path.length; k++) {
        const a = path[k], b = path[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        const t = Math.max(0, Math.min(1, len > 0 ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (len * len) : 0));
        const f: Vec2 = [a[0] + dx * t, a[1] + dy * t], d = dist(f, q);
        if (!best || d < best.distance) {
          best = { side: i, distance: d, from: f, to: q };
          const along = walked + len * t;
          atEnd = along < 1e-6 || along > total - 1e-6;
        }
        walked += len;
      }
    }
    if (!best || atEnd) continue;
    // inside the panel the opening lies to the left of the side's direction; beyond the cut line the distance is negative
    const centre = c.center, a = path[0], b = path[path.length - 1];
    const leftOf = (b[0] - a[0]) * (centre[1] - a[1]) - (b[1] - a[1]) * (centre[0] - a[0]) > 0;
    const crosses = outline.some((q) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) < 0) && path.length === 2;
    if (!leftOf || crosses) best.distance = -best.distance;
    out.push(best);
  }
  return out.sort((x, y) => x.distance - y.distance).slice(0, max);
}

/** Moves an opening straight towards or away from a side until it is `distance` mm from that side's cut line. */
export function setCutoutDistance(panel: Panel, index: number, side: number, distance: number): Panel {
  const now = cutoutDistances(panel, index, panel.shape.corners.length).find((d) => d.side === side);
  const c = panel.cutouts?.[index];
  if (!now || !c) return panel;
  let dx = now.to[0] - now.from[0], dy = now.to[1] - now.from[1];
  let len = Math.hypot(dx, dy);
  if (len < 1e-6 || now.distance < 0) {
    // touching or crossing the edge: move along the side's inward direction instead
    const sp = toPoints(sidePath(panel.shape, side)), a = sp[0], b = sp[sp.length - 1];
    dx = -(b[1] - a[1]); dy = b[0] - a[0]; len = Math.hypot(dx, dy) || 1;
  }
  const move = distance - now.distance;
  const center: Vec2 = [c.center[0] + (dx / len) * move, c.center[1] + (dy / len) * move];
  return { ...panel, cutouts: panel.cutouts!.map((x, k) => (k === index ? { ...x, center } : x)) };
}

// ---------- splitting ----------

/** A point on the edge of the panel shape: which side, and where. */
export interface EdgePoint { side: number; point: Vec2 }

/** The point of the panel shape's edge nearest to (x, y). */
export function nearestEdgePoint(shape: PanelShape, x: number, y: number): EdgePoint & { distance: number } {
  let best: EdgePoint & { distance: number } = { side: 0, point: shape.corners[0], distance: Infinity };
  shape.corners.forEach((_, i) => {
    const sp = sidePath(shape, i);
    for (let k = 0; k + 3 < sp.length; k += 2) {
      const ax = sp[k], ay = sp[k + 1], dx = sp[k + 2] - ax, dy = sp[k + 3] - ay;
      const len2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0));
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(x - px, y - py);
      if (d < best.distance) best = { side: i, point: [px, py], distance: d };
    }
  });
  return best;
}

/** How far an edge point is from the two ends of its side, measured along the side (mm). */
export function distancesAlongSide(shape: PanelShape, at: EdgePoint): { before: number; after: number } {
  const path = toPoints(sidePath(shape, at.side));
  let walked = 0, best = Infinity, before = 0;
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    const t = Math.max(0, Math.min(1, len > 0 ? ((at.point[0] - a[0]) * dx + (at.point[1] - a[1]) * dy) / (len * len) : 0));
    const d = Math.hypot(at.point[0] - (a[0] + dx * t), at.point[1] - (a[1] + dy * t));
    if (d < best) { best = d; before = walked + len * t; }
    walked += len;
  }
  return { before, after: walked - before };
}

/** The point at a given distance along a side, from its first corner. */
export function pointAlongSide(shape: PanelShape, side: number, distance: number): Vec2 {
  const path = toPoints(sidePath(shape, side));
  const d = Math.max(0, Math.min(pathLength(path), distance));
  return subPath(path, d, d)[0];
}

/**
 * From a point on the edge, straight across the panel at a right angle to that edge:
 * where does it reach the edge again? Used to offer a square split.
 */
export function straightAcross(shape: PanelShape, from: EdgePoint): EdgePoint | null {
  const sp = sidePath(shape, from.side);
  // direction of the edge at that point
  let dx = sp[sp.length - 2] - sp[0], dy = sp[sp.length - 1] - sp[1], bestD = Infinity;
  for (let k = 0; k + 3 < sp.length; k += 2) {
    const mx = (sp[k] + sp[k + 2]) / 2 - from.point[0], my = (sp[k + 1] + sp[k + 3]) / 2 - from.point[1];
    if (mx * mx + my * my < bestD) { bestD = mx * mx + my * my; dx = sp[k + 2] - sp[k]; dy = sp[k + 3] - sp[k + 1]; }
  }
  const l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l; // inwards for a counter-clockwise shape
  let best: EdgePoint | null = null, bestT = Infinity;
  shape.corners.forEach((_, i) => {
    const q = sidePath(shape, i);
    for (let k = 0; k + 3 < q.length; k += 2) {
      const ax = q[k], ay = q[k + 1], ex = q[k + 2] - ax, ey = q[k + 3] - ay;
      const den = nx * ey - ny * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - from.point[0]) * ey - (ay - from.point[1]) * ex) / den;
      const u = ((ax - from.point[0]) * ny - (ay - from.point[1]) * nx) / den;
      if (t > 1 && u >= 0 && u <= 1 && t < bestT) { bestT = t; best = { side: i, point: [from.point[0] + nx * t, from.point[1] + ny * t] }; }
    }
  });
  return best;
}

/** Makes sure there is a corner at an edge point; returns the panel and that corner's index. */
function cornerAt(panel: Panel, at: EdgePoint): { panel: Panel; index: number } {
  const { corners } = panel.shape, n = corners.length;
  const a = at.side, b = (at.side + 1) % n;
  if (dist(corners[a], at.point) < 1) return { panel, index: a };
  if (dist(corners[b], at.point) < 1) return { panel, index: b };
  return { panel: addCorner(panel, at.side, at.point, 0), index: at.side + 1 };
}

/**
 * Cuts a panel in two along a straight line between two points on its edge.
 * The two halves keep everything they had; along the cut each is set back by
 * half the gap, so the finished panels sit `gap` mm apart.
 */
export function splitPanel(
  panel: Panel, from: EdgePoint, to: EdgePoint,
  opts: { gap: number; radius: number; ids: [string, string]; names: [string, string] },
): [Panel, Panel] {
  if (from.side === to.side && !panel.shape.curves[from.side]) throw new Error('Pick the two points on different sides of the panel.');
  // insert the later point first, so the earlier side number stays valid
  const [first, second] = from.side < to.side || (from.side === to.side && false) ? [from, to] : [to, from];
  const two = cornerAt(panel, second);
  const one = cornerAt(two.panel, first);
  const p = one.panel;
  const i = one.index;
  const j = two.index + (p.shape.corners.length - two.panel.shape.corners.length); // shifted if a corner was inserted before it
  const n = p.shape.corners.length;
  if (i === j || (j - i + n) % n === 1 && !p.shape.curves[i] || (i - j + n) % n === 1 && !p.shape.curves[j]) {
    throw new Error('These two points are on the same straight edge: there is nothing to split.');
  }
  const loop = (a: number, b: number, id: string, name: string): Panel => {
    const idx: number[] = [];
    for (let k = a; ; k = (k + 1) % n) { idx.push(k); if (k === b) break; }
    const last = idx.length - 1;
    return {
      ...p, id, name,
      shape: { corners: idx.map((k) => p.shape.corners[k]), curves: idx.map((k, q) => (q === last ? null : p.shape.curves[k])) },
      offsets: idx.map((k, q) => (q === last ? opts.gap / 2 : p.offsets[k])),
      radii: idx.map((k, q) => (q === 0 || q === last ? opts.radius : p.radii[k])),
      cutouts: undefined,
    };
  };
  const A = loop(i, j, opts.ids[0], opts.names[0]), B = loop(j, i, opts.ids[1], opts.names[1]);
  // each opening goes to the half it lies in
  for (const c of panel.cutouts ?? []) {
    const target = pointInPolygon(c.center[0], c.center[1], A.shape.corners.flat()) ? A : B;
    target.cutouts = [...(target.cutouts ?? []), c];
  }
  return [A, B];
}

// ---------- facts and export ----------

export function cutLength(cut: CutOutline): number {
  let s = 0; const f = cut.flat, n = f.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += Math.hypot(f[j * 2] - f[i * 2], f[j * 2 + 1] - f[i * 2 + 1]); }
  return s;
}

/** Smallest rectangle the panel fits in, trying every rotation in 1° steps. Returns [long side, short side]. */
export function smallestBox(flat: number[]): [number, number] {
  let best: [number, number] = [Infinity, Infinity], bestArea = Infinity;
  for (let deg = 0; deg < 180; deg++) {
    const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i] * c - flat[i + 1] * s, y = flat[i] * s + flat[i + 1] * c;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const w = maxX - minX, h = maxY - minY;
    if (w * h < bestArea) { bestArea = w * h; best = [Math.max(w, h), Math.min(w, h)]; }
  }
  return best;
}

/** Area of EVA in the panel: the outline minus its openings, mm². */
export function panelArea(panel: Panel, cut: CutOutline): number {
  let a = polygonArea(cut.flat);
  for (const c of panel.cutouts ?? []) a -= Math.abs(polygonArea(cutoutOutline(c).flat));
  return a;
}

export function panelToDxf(panel: Panel, surface: Surface | undefined): string {
  const cut = cutOutline(panel);
  const reference = surface ? outlinePolygonOf(surface) : [];
  // Origin from the surface, not the panel, so several panels of one surface keep their positions relative to each other.
  const b = bounds(reference.length ? reference : cut.flat);
  const shift = (pts: ArrayLike<number>) => Array.from(pts, (v, i) => v - (i % 2 === 0 ? b.minX : b.minY));
  return writeDxf(
    [{ name: LAYER.reference, color: 8 }, { name: LAYER.innerCut, color: 5 }, { name: LAYER.outerCut, color: 1 }],
    [
      { layer: LAYER.outerCut, points: shift(cut.points), bulges: cut.bulges },
      ...(panel.cutouts ?? []).map((c) => { const o = cutoutOutline(c); return { layer: LAYER.innerCut, points: shift(o.points), bulges: o.bulges }; }),
      ...(reference.length ? [{ layer: LAYER.reference, points: shift(reference) }] : []),
      ...(surface ? surface.raw.holes.map((h) => ({ layer: LAYER.reference, points: shift(h.points) })) : []),
    ],
  );
}
