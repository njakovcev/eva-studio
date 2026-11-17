/**
 * Drawing operations for the sketch editor: adding lines, arcs, circles and splines,
 * which relations and measurements fit what is selected, where measurements are drawn,
 * and how a photo underneath is scaled and levelled. Pure functions, no DOM.
 */
import { addConstraint } from './solver';
import { mergePoints, pointMap } from './geometry';
import type { SkConstraint, SkDimension, SkEntity, SkPoint, SkRelation, Sketch, SketchPhoto } from './model';

type NewId = () => string;
type Line = Extract<SkEntity, { kind: 'line' }>;
const hyp = Math.hypot;

/** An existing point (by id), or a new point at a position. */
export type PointRef = { id: string } | { x: number; y: number };

/** Lines drawn within this many degrees of level or plumb get a horizontal or vertical relation. */
export const SNAP_DEGREES = 3;

function ensurePoint(s: Sketch, ref: PointRef, newId: NewId): [Sketch, string] {
  if ('id' in ref) return [s, ref.id];
  const p: SkPoint = { id: newId(), x: ref.x, y: ref.y };
  return [{ ...s, points: [...s.points, p] }, p.id];
}

/** Adds a relation if it adds something and can be met; otherwise leaves the sketch as it was. */
function tryRelation(s: Sketch, c: SkConstraint): Sketch {
  const r = addConstraint(s, c);
  return r.status === 'added' ? r.sketch : s;
}

/** Which way a line from a to b nearly points: level, plumb or neither. */
export function nearAxis(a: { x: number; y: number }, b: { x: number; y: number }): 'horizontal' | 'vertical' | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (hyp(dx, dy) < 1e-9) return null;
  const deg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (deg <= SNAP_DEGREES) return 'horizontal';
  if (deg >= 90 - SNAP_DEGREES) return 'vertical';
  return null;
}

/**
 * Draws a line. Either end may be an existing point (it is joined) or a new one.
 * A line drawn nearly level or plumb is made exactly so. A new end dropped on an
 * existing line is held on that line (`onLine`).
 */
export function drawLine(s: Sketch, from: PointRef, to: PointRef, newId: NewId, opts: { onLine?: { end: 'from' | 'to'; line: string }[]; construction?: boolean } = {}): { sketch: Sketch; lineId: string; a: string; b: string } {
  let [next, a] = ensurePoint(s, from, newId);
  let b: string;
  [next, b] = ensurePoint(next, to, newId);
  const line: Line = { id: newId(), kind: 'line', a, b, ...(opts.construction ? { construction: true } : {}) };
  next = { ...next, entities: [...next.entities, line] };
  for (const o of opts.onLine ?? []) next = tryRelation(next, { id: newId(), kind: 'pointOnLine', p: o.end === 'from' ? a : b, line: o.line });
  const pts = pointMap(next), axis = nearAxis(pts.get(a)!, pts.get(b)!);
  if (axis) next = tryRelation(next, { id: newId(), kind: axis, p: a, q: b });
  return { sketch: next, lineId: line.id, a, b };
}

/** Centre of the circle through three points, or null if they are in one line. */
export function circumcentre(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): { x: number; y: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const size = Math.max(hyp(b.x - a.x, b.y - a.y), hyp(c.x - a.x, c.y - a.y), 1);
  if (Math.abs(d) < 1e-6 * size * size) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

const angleOf = (c: { x: number; y: number }, p: { x: number; y: number }) => Math.atan2(p.y - c.y, p.x - c.x);
const ccwSpan = (from: number, to: number) => { let d = to - from; while (d < 0) d += 2 * Math.PI; while (d >= 2 * Math.PI) d -= 2 * Math.PI; return d; };

/** Arc from `from` to `to` passing through `through`. Returns null when the three points are in one line. */
export function drawArc3(s: Sketch, from: PointRef, to: PointRef, through: { x: number; y: number }, newId: NewId): { sketch: Sketch; arcId: string; a: string; b: string } | null {
  let [next, a] = ensurePoint(s, from, newId);
  let b: string;
  [next, b] = ensurePoint(next, to, newId);
  if (a === b) return null;
  const pts = pointMap(next), A = pts.get(a)!, B = pts.get(b)!;
  const c = circumcentre(A, B, through);
  if (!c) return null;
  const centre: SkPoint = { id: newId(), ...c };
  // counter-clockwise from a to b if the middle point is on that way round
  const ccw = ccwSpan(angleOf(c, A), angleOf(c, through)) < ccwSpan(angleOf(c, A), angleOf(c, B));
  const arc: SkEntity = ccw ? { id: newId(), kind: 'arc', c: centre.id, a, b } : { id: newId(), kind: 'arc', c: centre.id, a: b, b: a };
  return { sketch: { ...next, points: [...next.points, centre], entities: [...next.entities, arc] }, arcId: arc.id, a, b };
}

/** Direction of travel when arriving at point `at` along an entity that ends there. */
export function arrivingDirection(s: Sketch, e: SkEntity, at: string): { x: number; y: number } | null {
  const pts = pointMap(s);
  const unit = (x: number, y: number) => { const l = hyp(x, y); return l > 1e-9 ? { x: x / l, y: y / l } : null; };
  if (e.kind === 'line') {
    const a = pts.get(e.a)!, b = pts.get(e.b)!;
    if (at === e.b) return unit(b.x - a.x, b.y - a.y);
    if (at === e.a) return unit(a.x - b.x, a.y - b.y);
  }
  if (e.kind === 'arc') {
    const c = pts.get(e.c)!, p = pts.get(at)!;
    if (at === e.b) return unit(-(p.y - c.y), p.x - c.x); // counter-clockwise travel
    if (at === e.a) return unit(p.y - c.y, -(p.x - c.x));
  }
  return null;
}

/** An entity (line or arc) that ends at this point, to continue tangent from. */
export function entityEndingAt(s: Sketch, point: string): SkEntity | undefined {
  const found = s.entities.filter((e) => !e.construction && ((e.kind === 'line' && (e.a === point || e.b === point)) || (e.kind === 'arc' && (e.a === point || e.b === point))));
  return found.length === 1 ? found[0] : found.find((e) => e.kind === 'line') ?? found[0];
}

/**
 * Arc that continues smoothly (tangent) from the line or arc ending at `from`, to `to`.
 * Returns null when there is nothing to continue from or `to` is straight ahead.
 */
export function drawTangentArc(s: Sketch, from: string, to: PointRef, newId: NewId): { sketch: Sketch; arcId: string; b: string } | null {
  const prev = entityEndingAt(s, from);
  if (!prev) return null;
  const t = arrivingDirection(s, prev, from);
  if (!t) return null;
  let [next, b] = ensurePoint(s, to, newId);
  if (b === from) return null;
  const pts = pointMap(next), P = pts.get(from)!, Q = pts.get(b)!;
  const n = { x: -t.y, y: t.x }; // left of the direction of travel
  const qx = Q.x - P.x, qy = Q.y - P.y, side = n.x * qx + n.y * qy;
  const size = hyp(qx, qy);
  if (Math.abs(side) < 1e-3 * size) return null;
  const r = (qx * qx + qy * qy) / (2 * side); // signed: positive turns left
  const centre: SkPoint = { id: newId(), x: P.x + n.x * r, y: P.y + n.y * r };
  const arc: SkEntity = r > 0 ? { id: newId(), kind: 'arc', c: centre.id, a: from, b } : { id: newId(), kind: 'arc', c: centre.id, a: b, b: from };
  next = { ...next, points: [...next.points, centre], entities: [...next.entities, arc] };
  next = tryRelation(next, { id: newId(), kind: 'tangent', e1: prev.id, e2: arc.id });
  return { sketch: next, arcId: arc.id, b };
}

export function drawCircle(s: Sketch, centre: PointRef, radius: number, newId: NewId): { sketch: Sketch; circleId: string } {
  const [next, c] = ensurePoint(s, centre, newId);
  const circle: SkEntity = { id: newId(), kind: 'circle', c, r: Math.max(radius, 1) };
  return { sketch: { ...next, entities: [...next.entities, circle] }, circleId: circle.id };
}

export function drawSpline(s: Sketch, through: PointRef[], newId: NewId): { sketch: Sketch; splineId: string } | null {
  let next = s;
  const ids: string[] = [];
  for (const ref of through) { let id: string; [next, id] = ensurePoint(next, ref, newId); if (ids[ids.length - 1] !== id) ids.push(id); }
  if (ids.length < 2) return null;
  const spline: SkEntity = { id: newId(), kind: 'spline', pts: ids };
  return { sketch: { ...next, entities: [...next.entities, spline] }, splineId: spline.id };
}

// ---------- what fits the selection ----------

export interface Selected { points: string[]; lines: string[]; curves: string[] /* arcs and circles */; splines: string[] }

export function classify(s: Sketch, ids: string[]): Selected {
  const ent = new Map(s.entities.map((e) => [e.id, e])), pts = new Set(s.points.map((p) => p.id));
  const out: Selected = { points: [], lines: [], curves: [], splines: [] };
  for (const id of ids) {
    if (pts.has(id)) out.points.push(id);
    const e = ent.get(id);
    if (e?.kind === 'line') out.lines.push(id);
    else if (e?.kind === 'arc' || e?.kind === 'circle') out.curves.push(id);
    else if (e?.kind === 'spline') out.splines.push(id);
  }
  return out;
}

export interface RelationChoice { label: string; make: (newId: NewId) => SkRelation }

/** The relations that can be added between exactly what is selected. */
export function relationChoices(s: Sketch, ids: string[]): RelationChoice[] {
  const { points: P, lines: L, curves: C, splines: S } = classify(s, ids);
  const n = ids.length, out: RelationChoice[] = [];
  const ent = new Map(s.entities.map((e) => [e.id, e]));
  if (S.length) return out;
  if (n === 1 && L.length === 1) {
    const l = ent.get(L[0]) as Line;
    out.push({ label: 'Horizontal', make: (id) => ({ id: id(), kind: 'horizontal', p: l.a, q: l.b }) });
    out.push({ label: 'Vertical', make: (id) => ({ id: id(), kind: 'vertical', p: l.a, q: l.b }) });
  }
  if (n === 2 && P.length === 2) {
    out.push({ label: 'Horizontal', make: (id) => ({ id: id(), kind: 'horizontal', p: P[0], q: P[1] }) });
    out.push({ label: 'Vertical', make: (id) => ({ id: id(), kind: 'vertical', p: P[0], q: P[1] }) });
  }
  if (n === 2 && L.length === 2) {
    out.push({ label: 'Parallel', make: (id) => ({ id: id(), kind: 'parallel', l1: L[0], l2: L[1] }) });
    out.push({ label: 'Perpendicular', make: (id) => ({ id: id(), kind: 'perpendicular', l1: L[0], l2: L[1] }) });
    out.push({ label: 'Equal length', make: (id) => ({ id: id(), kind: 'equalLength', l1: L[0], l2: L[1] }) });
  }
  if (n === 2 && L.length === 1 && C.length === 1) out.push({ label: 'Tangent', make: (id) => ({ id: id(), kind: 'tangent', e1: L[0], e2: C[0] }) });
  if (n === 2 && C.length === 2) {
    out.push({ label: 'Equal radius', make: (id) => ({ id: id(), kind: 'equalRadius', e1: C[0], e2: C[1] }) });
    out.push({ label: 'Tangent', make: (id) => ({ id: id(), kind: 'tangent', e1: C[0], e2: C[1] }) });
  }
  if (n === 2 && P.length === 1 && L.length === 1) {
    out.push({ label: 'On line', make: (id) => ({ id: id(), kind: 'pointOnLine', p: P[0], line: L[0] }) });
    out.push({ label: 'Midpoint', make: (id) => ({ id: id(), kind: 'midpoint', p: P[0], line: L[0] }) });
  }
  if (n === 2 && P.length === 1 && C.length === 1) out.push({ label: 'On curve', make: (id) => ({ id: id(), kind: 'pointOnCurve', p: P[0], curve: C[0] }) });
  if (n === 3 && P.length === 2 && L.length === 1) out.push({ label: 'Symmetric', make: (id) => ({ id: id(), kind: 'symmetric', p: P[0], q: P[1], line: L[0] }) });
  if (n === 1 && P.length === 1) {
    const p = s.points.find((x) => x.id === P[0])!;
    out.push({ label: 'Fix in place', make: (id) => ({ id: id(), kind: 'fix', p: p.id, x: p.x, y: p.y }) });
  }
  return out;
}

/** A measurement that can be taken of the picked items; `options` are the alternatives for the same pick. */
export type DimensionKind = 'aligned' | 'horizontal' | 'vertical';
export interface DimensionChoice { kinds: DimensionKind[]; make: (kind: DimensionKind, newId: NewId) => SkDimension }

export function dimensionChoice(s: Sketch, ids: string[]): DimensionChoice | null {
  const { points: P, lines: L, curves: C } = classify(s, ids);
  const ent = new Map(s.entities.map((e) => [e.id, e]));
  const between = (p: string, q: string): DimensionChoice => ({
    kinds: ['aligned', 'horizontal', 'vertical'],
    make: (kind, id) => kind === 'aligned' ? { id: id(), kind: 'distance', p, q, value: 0 } : { id: id(), kind: kind === 'horizontal' ? 'hDistance' : 'vDistance', p, q, value: 0, sign: 1 },
  });
  if (ids.length === 1 && L.length === 1) { const l = ent.get(L[0]) as Line; return between(l.a, l.b); }
  if (ids.length === 1 && C.length === 1) return { kinds: ['aligned'], make: (_k, id) => ({ id: id(), kind: 'radius', e: C[0], value: 0, ...(ent.get(C[0])!.kind === 'circle' ? { diameter: true } : {}) }) };
  if (ids.length === 2 && P.length === 2) return between(P[0], P[1]);
  if (ids.length === 2 && P.length === 1 && L.length === 1) return { kinds: ['aligned'], make: (_k, id) => ({ id: id(), kind: 'pointLine', p: P[0], line: L[0], value: 0, sign: 1 }) };
  if (ids.length === 2 && L.length === 2) {
    const pts = pointMap(s), l1 = ent.get(L[0]) as Line, l2 = ent.get(L[1]) as Line;
    const a1 = pts.get(l1.a)!, b1 = pts.get(l1.b)!, a2 = pts.get(l2.a)!, b2 = pts.get(l2.b)!;
    const ux = b1.x - a1.x, uy = b1.y - a1.y, wx = b2.x - a2.x, wy = b2.y - a2.y;
    const sin = Math.abs(ux * wy - uy * wx) / (hyp(ux, uy) * hyp(wx, wy) || 1);
    // (nearly) parallel lines: the gap between them; otherwise the angle
    if (sin < Math.sin((1 * Math.PI) / 180)) return { kinds: ['aligned'], make: (_k, id) => ({ id: id(), kind: 'pointLine', p: l2.a, line: l1.id, value: 0, sign: 1 }) };
    return { kinds: ['aligned'], make: (_k, id) => ({ id: id(), kind: 'angle', l1: L[0], l2: L[1], value: 0 }) };
  }
  if (ids.length === 2 && P.length === 1 && C.length === 1) {
    const e = ent.get(C[0])!;
    if (e.kind === 'arc' || e.kind === 'circle') return between(P[0], e.c);
  }
  if (ids.length === 2 && C.length === 2) {
    const e1 = ent.get(C[0])!, e2 = ent.get(C[1])!;
    if ((e1.kind === 'arc' || e1.kind === 'circle') && (e2.kind === 'arc' || e2.kind === 'circle')) return between(e1.c, e2.c);
  }
  if (ids.length === 2 && L.length === 1 && C.length === 1) {
    const e = ent.get(C[0])!;
    if (e.kind === 'arc' || e.kind === 'circle') return { kinds: ['aligned'], make: (_k, id) => ({ id: id(), kind: 'pointLine', p: e.c, line: L[0], value: 0, sign: 1 }) };
  }
  return null;
}

/** Joins two points into one (coincident). */
export function joinPoints(s: Sketch, keep: string, drop: string): Sketch {
  return keep === drop ? s : mergePoints(s, keep, drop);
}

// ---------- where measurements are drawn ----------

export interface DimensionDrawing {
  /** lines to draw: [x1, y1, x2, y2] in drawing coordinates */
  lines: [number, number, number, number][];
  /** an arc for angles: centre, radius, start and end angle (radians, counter-clockwise) */
  arc?: { x: number; y: number; r: number; from: number; to: number };
  label: { x: number; y: number; text: string };
}

const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));

/** Where a measurement is drawn. `gap` is the default distance from the measured items (in mm, about 30 screen pixels). */
export function dimensionDrawing(s: Sketch, d: SkDimension, shown: number, gap: number): DimensionDrawing | null {
  const pts = pointMap(s), ent = new Map(s.entities.map((e) => [e.id, e]));
  const text = d.kind === 'angle' ? `${fmt(shown)}°` : d.kind === 'radius' ? `${d.diameter ? 'Ø' : 'R'}${fmt(d.diameter ? shown * 2 : shown)}` : fmt(shown);
  const label = (x: number, y: number) => ({ x, y, text: d.reference ? `(${text})` : text });
  // until moved by hand, a measurement sits on the outside of the drawing
  let cx = 0, cy = 0;
  for (const p of s.points) { cx += p.x; cy += p.y; }
  cx /= s.points.length || 1; cy /= s.points.length || 1;
  const off = d.offset ?? gap;
  switch (d.kind) {
    case 'distance': {
      const p = pts.get(d.p), q = pts.get(d.q);
      if (!p || !q) return null;
      const l = hyp(q.x - p.x, q.y - p.y) || 1;
      let nx = -(q.y - p.y) / l, ny = (q.x - p.x) / l;
      if (d.offset === undefined && nx * ((p.x + q.x) / 2 - cx) + ny * ((p.y + q.y) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
      const P = [p.x + nx * off, p.y + ny * off], Q = [q.x + nx * off, q.y + ny * off];
      return { lines: [[p.x, p.y, P[0], P[1]], [q.x, q.y, Q[0], Q[1]], [P[0], P[1], Q[0], Q[1]]], label: label((P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2) };
    }
    case 'hDistance': {
      const p = pts.get(d.p), q = pts.get(d.q);
      if (!p || !q) return null;
      const y = d.offset === undefined && (p.y + q.y) / 2 < cy ? Math.min(p.y, q.y) - gap : Math.max(p.y, q.y) + off;
      return { lines: [[p.x, p.y, p.x, y], [q.x, q.y, q.x, y], [p.x, y, q.x, y]], label: label((p.x + q.x) / 2, y) };
    }
    case 'vDistance': {
      const p = pts.get(d.p), q = pts.get(d.q);
      if (!p || !q) return null;
      const x = d.offset === undefined && (p.x + q.x) / 2 < cx ? Math.min(p.x, q.x) - gap : Math.max(p.x, q.x) + off;
      return { lines: [[p.x, p.y, x, p.y], [q.x, q.y, x, q.y], [x, p.y, x, q.y]], label: label(x, (p.y + q.y) / 2) };
    }
    case 'pointLine': {
      const p = pts.get(d.p), l = ent.get(d.line);
      if (!p || l?.kind !== 'line') return null;
      const a = pts.get(l.a)!, b = pts.get(l.b)!, dx = b.x - a.x, dy = b.y - a.y, ll = dx * dx + dy * dy || 1;
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / ll, f = { x: a.x + dx * t, y: a.y + dy * t };
      const lines: DimensionDrawing['lines'] = [[p.x, p.y, f.x, f.y]];
      // extend the measured line to the foot if it lies beyond its ends
      if (t < 0) lines.push([a.x, a.y, f.x, f.y]); else if (t > 1) lines.push([b.x, b.y, f.x, f.y]);
      return { lines, label: label((p.x + f.x) / 2, (p.y + f.y) / 2) };
    }
    case 'angle': {
      const l1 = ent.get(d.l1), l2 = ent.get(d.l2);
      if (l1?.kind !== 'line' || l2?.kind !== 'line') return null;
      const a1 = pts.get(l1.a)!, b1 = pts.get(l1.b)!, a2 = pts.get(l2.a)!, b2 = pts.get(l2.b)!;
      const ux = b1.x - a1.x, uy = b1.y - a1.y, wx = b2.x - a2.x, wy = b2.y - a2.y, den = ux * wy - uy * wx;
      const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 }, m2 = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
      if (Math.abs(den) < 1e-9 * hyp(ux, uy) * hyp(wx, wy)) return { lines: [], label: label((m1.x + m2.x) / 2, (m1.y + m2.y) / 2) };
      const t = ((a2.x - a1.x) * wy - (a2.y - a1.y) * wx) / den, X = { x: a1.x + ux * t, y: a1.y + uy * t };
      const r = Math.max(Math.abs(off) * 1.5, 1);
      let s1 = angleOf(X, m1), s2 = angleOf(X, m2);
      if (hyp(m1.x - X.x, m1.y - X.y) < 1e-9) s1 = Math.atan2(uy, ux);
      if (hyp(m2.x - X.x, m2.y - X.y) < 1e-9) s2 = Math.atan2(wy, wx);
      // the arc spans the drawn corner, the shorter way round
      let from = s1, to = s2;
      if (ccwSpan(s1, s2) > Math.PI) { from = s2; to = s1; }
      const mid = from + ccwSpan(from, to) / 2;
      const lines: DimensionDrawing['lines'] = [];
      // when the lines do not reach the corner, show where they would meet
      for (const [a, b] of [[a1, b1], [a2, b2]] as const) {
        const near = hyp(a.x - X.x, a.y - X.y) < hyp(b.x - X.x, b.y - X.y) ? a : b;
        if (hyp(near.x - X.x, near.y - X.y) > 1e-6) lines.push([near.x, near.y, X.x, X.y]);
      }
      return { lines, arc: { x: X.x, y: X.y, r, from, to }, label: label(X.x + Math.cos(mid) * r * 1.25, X.y + Math.sin(mid) * r * 1.25) };
    }
    case 'radius': {
      const e = ent.get(d.e);
      if (e?.kind !== 'arc' && e?.kind !== 'circle') return null;
      const c = pts.get(e.c)!;
      let ang = Math.PI / 4, r = shown;
      if (e.kind === 'arc') { const a = pts.get(e.a)!, b = pts.get(e.b)!; const s0 = angleOf(c, a); ang = s0 + ccwSpan(s0, angleOf(c, b)) / 2; r = hyp(a.x - c.x, a.y - c.y); }
      const tip = { x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r };
      const out = { x: c.x + Math.cos(ang) * (r + Math.abs(off)), y: c.y + Math.sin(ang) * (r + Math.abs(off)) };
      return { lines: [[c.x, c.y, tip.x, tip.y], [tip.x, tip.y, out.x, out.y]], label: label(out.x, out.y) };
    }
  }
}

/** The offset that puts a distance-type measurement's line through a point (for dragging it). */
export function offsetThrough(s: Sketch, d: SkDimension, x: number, y: number): number | undefined {
  const pts = pointMap(s);
  if (d.kind === 'distance') {
    const p = pts.get(d.p)!, q = pts.get(d.q)!, l = hyp(q.x - p.x, q.y - p.y) || 1;
    return (-(q.y - p.y) / l) * (x - p.x) + ((q.x - p.x) / l) * (y - p.y);
  }
  if (d.kind === 'hDistance') return y - Math.max(pts.get(d.p)!.y, pts.get(d.q)!.y);
  if (d.kind === 'vDistance') return x - Math.max(pts.get(d.p)!.x, pts.get(d.q)!.x);
  return undefined;
}

// ---------- photo underneath ----------

/** Where a photo pixel lands in the drawing. */
export function photoToDrawing(ph: SketchPhoto, u: number, v: number): { x: number; y: number } {
  const t = (ph.angle * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const lx = u * ph.scale, ly = -v * ph.scale;
  return { x: ph.x + lx * cos - ly * sin, y: ph.y + lx * sin + ly * cos };
}

/**
 * Sets the photo's scale from two points clicked on it whose real distance is known.
 * The first point stays where it is.
 */
export function scalePhoto(ph: SketchPhoto, a: { x: number; y: number }, b: { x: number; y: number }, realDistance: number): SketchPhoto {
  const now = hyp(b.x - a.x, b.y - a.y);
  if (!(now > 0) || !(realDistance > 0)) return ph;
  const k = realDistance / now;
  return { ...ph, scale: ph.scale * k, x: a.x + (ph.x - a.x) * k, y: a.y + (ph.y - a.y) * k };
}

/** Turns the photo so the line from a to b becomes exactly level or plumb (whichever it is closer to). */
export function levelPhoto(ph: SketchPhoto, a: { x: number; y: number }, b: { x: number; y: number }): SketchPhoto {
  const now = Math.atan2(b.y - a.y, b.x - a.x);
  if (hyp(b.x - a.x, b.y - a.y) < 1e-9) return ph;
  const target = Math.round(now / (Math.PI / 2)) * (Math.PI / 2), turn = target - now;
  const cos = Math.cos(turn), sin = Math.sin(turn), dx = ph.x - a.x, dy = ph.y - a.y;
  let angle = ph.angle + (turn * 180) / Math.PI;
  angle = ((angle % 360) + 540) % 360 - 180;
  return { ...ph, angle, x: a.x + dx * cos - dy * sin, y: a.y + dx * sin + dy * cos };
}

/** Moves the photo by an offset. */
export const movePhoto = (ph: SketchPhoto, dx: number, dy: number): SketchPhoto => ({ ...ph, x: ph.x + dx, y: ph.y + dy });

export type { Line as SkLine };
