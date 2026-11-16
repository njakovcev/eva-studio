/**
 * An EVA panel: the piece that is cut and glued onto a surface.
 *
 * A panel has its own `shape`, which starts as a copy of the surface outline
 * and can then be reshaped freely (the panel does not have to follow every
 * bump of the surface). The line that is actually cut is derived from it:
 * every side is moved inwards by its own offset, and every corner is rounded
 * with its own radius.
 */
import { sidePath } from './cleanOutline';
import { writeDxf } from './dxf';
import { bounds, polygonArea } from './poly';
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
  createdAt: string;
}

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
      if (tA < -1e-9 || (!lastA && tA > 1 + 1e-9)) continue;
      if (tB > 1 + 1e-9 || (!firstB && tB < -1e-9)) continue;
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
  return { points, bulges, flat, usedRadii, warnings };
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

/** Removes a corner: its two sides become one straight side (keeping the offset of the first). */
export function removeCorner(panel: Panel, i: number): Panel {
  const n = panel.shape.corners.length;
  if (n <= 3) return panel;
  const curves = panel.shape.curves.slice();
  curves[(i - 1 + n) % n] = null;
  const drop = <T,>(a: T[]) => a.filter((_, k) => k !== i);
  return { ...panel, shape: { corners: drop(panel.shape.corners), curves: drop(curves) }, offsets: drop(panel.offsets), radii: drop(panel.radii) };
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

export function panelToDxf(panel: Panel, surface: Surface | undefined): string {
  const cut = cutOutline(panel);
  const reference = surface ? outlinePolygonOf(surface) : [];
  // Origin from the surface, not the panel, so several panels of one surface keep their positions relative to each other.
  const b = bounds(reference.length ? reference : cut.flat);
  const shift = (pts: ArrayLike<number>) => Array.from(pts, (v, i) => v - (i % 2 === 0 ? b.minX : b.minY));
  return writeDxf(
    [{ name: 'OUTER_CUT', color: 1 }, { name: 'REFERENCE', color: 8 }],
    [
      { layer: 'OUTER_CUT', points: shift(cut.points), bulges: cut.bulges },
      ...(reference.length ? [{ layer: 'REFERENCE', points: shift(reference) }] : []),
      ...(surface ? surface.raw.holes.map((h) => ({ layer: 'REFERENCE', points: shift(h.points) })) : []),
    ],
  );
}
