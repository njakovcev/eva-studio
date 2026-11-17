/** Drawing, editing and reading sketches: everything that is not the solver. */
import { constraintRefs, entityPoints, isDimension, type Sketch, type SkEntity, type SkPoint, type SkConstraint } from './model';

type Pt = { x: number; y: number };
const hyp = (x: number, y: number) => Math.sqrt(x * x + y * y);

export function pointMap(s: Sketch) { return new Map(s.points.map((p) => [p.id, p])); }

/** Arc from a to b, counter-clockwise around c, as points (both ends included). */
export function arcPoints(c: Pt, a: Pt, b: Pt, tolerance = 0.05): number[] {
  const r = hyp(a.x - c.x, a.y - c.y);
  const t0 = Math.atan2(a.y - c.y, a.x - c.x);
  let sweep = Math.atan2(b.y - c.y, b.x - c.x) - t0;
  while (sweep <= 1e-9) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(sweep / (2 * Math.acos(Math.max(0, 1 - tolerance / Math.max(r, 1e-9))))));
  const out: number[] = [];
  for (let k = 0; k <= steps; k++) { const t = t0 + (sweep * k) / steps; out.push(c.x + r * Math.cos(t), c.y + r * Math.sin(t)); }
  out[out.length - 2] = b.x; out[out.length - 1] = b.y;
  return out;
}

/** Smooth curve through the points (centripetal Catmull–Rom), as points. */
export function splinePoints(pts: Pt[], perSegment = 16): number[] {
  if (pts.length < 2) return pts.flatMap((p) => [p.x, p.y]);
  if (pts.length === 2) return [pts[0].x, pts[0].y, pts[1].x, pts[1].y];
  const ext = [
    { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y }, ...pts,
    { x: 2 * pts[pts.length - 1].x - pts[pts.length - 2].x, y: 2 * pts[pts.length - 1].y - pts[pts.length - 2].y },
  ];
  const out: number[] = [pts[0].x, pts[0].y];
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const knot = (a: Pt, b: Pt) => Math.max(Math.sqrt(hyp(b.x - a.x, b.y - a.y)), 1e-6);
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let k = 1; k <= perSegment; k++) {
      const t = t1 + ((t2 - t1) * k) / perSegment;
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => ({ x: ((tb - t) * a.x + (t - ta) * b.x) / (tb - ta), y: ((tb - t) * a.y + (t - ta) * b.y) / (tb - ta) });
      const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
      const c = lerp(b1, b2, t1, t2);
      out.push(c.x, c.y);
    }
  }
  return out;
}

/** An entity as a line of points (a circle closes on itself). */
export function entityPath(s: Sketch, e: SkEntity, pts = pointMap(s)): number[] {
  switch (e.kind) {
    case 'line': { const a = pts.get(e.a)!, b = pts.get(e.b)!; return [a.x, a.y, b.x, b.y]; }
    case 'arc': return arcPoints(pts.get(e.c)!, pts.get(e.a)!, pts.get(e.b)!);
    case 'circle': { const c = pts.get(e.c)!; const p = { x: c.x + e.r, y: c.y }; return arcPoints(c, p, p); }
    case 'spline': return splinePoints(e.pts.map((id) => pts.get(id)!));
  }
}

/** The two ends of an open entity (none for a circle). */
export function entityEnds(e: SkEntity): [string, string] | null {
  if (e.kind === 'line' || e.kind === 'arc') return [e.a, e.b];
  if (e.kind === 'spline') return [e.pts[0], e.pts[e.pts.length - 1]];
  return null;
}

// ---------- closed outline → surface ----------

export interface SketchOutline {
  /** corners counter-clockwise; side i runs from corner i to corner i+1 */
  corners: [number, number][];
  /** for each side, the points between its corners if it is curved */
  curves: (number[] | null)[];
  /** the outline as one closed polygon */
  polygon: number[];
  /** other closed outlines inside it (later: openings) */
  inner: number[][];
}

export type OutlineResult = { ok: true; outline: SketchOutline } | { ok: false; message: string; openPoints: string[] };

const signedArea = (p: number[]) => { let s = 0; const n = p.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; } return s / 2; };

/** Finds the closed outline drawn with the solid (non-construction) entities. */
export function sketchOutline(s: Sketch): OutlineResult {
  const solid = s.entities.filter((e) => !e.construction);
  if (!solid.length) return { ok: false, message: 'Draw the outline of the surface first.', openPoints: [] };
  const pts = pointMap(s);
  const ends = new Map<string, SkEntity[]>();
  for (const e of solid) { const en = entityEnds(e); if (!en) continue; for (const p of en) ends.set(p, [...(ends.get(p) ?? []), e]); }
  const open = [...ends].filter(([, es]) => es.length !== 2).map(([p]) => p);
  if (open.length) return { ok: false, message: `The outline is not closed: ${open.length} end${open.length === 1 ? ' is' : 's are'} not joined to another line (shown in red). Draw to the end point to join it.`, openPoints: open };

  const loops: { corners: string[]; sides: SkEntity[]; forward: boolean[] }[] = [];
  const used = new Set<string>();
  for (const start of solid) {
    if (used.has(start.id) || !entityEnds(start)) continue;
    const corners: string[] = [], sides: SkEntity[] = [], forward: boolean[] = [];
    let e = start, at = entityEnds(start)![0];
    for (let guard = 0; guard <= solid.length; guard++) {
      used.add(e.id);
      const [a, b] = entityEnds(e)!;
      const fwd = a === at;
      corners.push(at); sides.push(e); forward.push(fwd);
      at = fwd ? b : a;
      const next = (ends.get(at) ?? []).find((x) => x.id !== e.id && !used.has(x.id));
      if (!next) break;
      e = next;
    }
    loops.push({ corners, sides, forward });
  }
  // circles are closed outlines on their own
  const shapes = loops.map((l) => {
    const curves: (number[] | null)[] = [];
    const polygon: number[] = [];
    l.sides.forEach((e, i) => {
      const c = pts.get(l.corners[i])!;
      polygon.push(c.x, c.y);
      if (e.kind === 'line') { curves.push(null); return; }
      let path = entityPath(s, e, pts);
      if (!l.forward[i]) { const r: number[] = []; for (let k = path.length - 2; k >= 0; k -= 2) r.push(path[k], path[k + 1]); path = r; }
      const mid = path.slice(2, -2);
      curves.push(mid.length ? mid : null);
      polygon.push(...mid);
    });
    return { corners: l.corners.map((id) => [pts.get(id)!.x, pts.get(id)!.y] as [number, number]), curves, polygon };
  });
  for (const e of solid) if (e.kind === 'circle') { const p = entityPath(s, e, pts).slice(0, -2); shapes.push({ corners: [[p[0], p[1]]], curves: [p.slice(2)], polygon: p }); }
  shapes.sort((a, b) => Math.abs(signedArea(b.polygon)) - Math.abs(signedArea(a.polygon)));
  const outer = shapes[0];
  if (outer.corners.length < 3 && outer.curves.every((c) => !c)) return { ok: false, message: 'An outline needs at least three sides.', openPoints: [] };
  // counter-clockwise
  if (signedArea(outer.polygon) < 0) {
    const n = outer.corners.length;
    const corners = [outer.corners[0], ...outer.corners.slice(1).reverse()];
    // side i of the reversed outline is side (n − 1 − i) of the original, run backwards
    const curves = corners.map((_, i) => { const c = outer.curves[(n - 1 - i + n) % n]; if (!c) return null; const r: number[] = []; for (let k = c.length - 2; k >= 0; k -= 2) r.push(c[k], c[k + 1]); return r; });
    const polygon: number[] = [];
    corners.forEach((c, i) => polygon.push(c[0], c[1], ...(curves[i] ?? [])));
    return { ok: true, outline: { corners, curves, polygon, inner: shapes.slice(1).map((x) => x.polygon) } };
  }
  return { ok: true, outline: { ...outer, inner: shapes.slice(1).map((x) => x.polygon) } };
}

// ---------- editing ----------

/** Removes entities, points and constraints, and anything that no longer has something to hold on to. */
export function removeItems(s: Sketch, ids: Set<string>): Sketch {
  let entities = s.entities.filter((e) => !ids.has(e.id) && !entityPoints(e).some((p) => ids.has(p)));
  const usedPoints = new Set(entities.flatMap(entityPoints));
  // keep points that are only held by constraints (e.g. a corner kept after rounding it), unless removed
  for (const c of s.constraints) if (!ids.has(c.id)) for (const r of constraintRefs(c)) if (s.points.some((p) => p.id === r) && !ids.has(r)) usedPoints.add(r);
  const points = s.points.filter((p) => usedPoints.has(p.id) && !ids.has(p.id));
  const alive = new Set([...points.map((p) => p.id), ...entities.map((e) => e.id)]);
  entities = entities.filter((e) => entityPoints(e).every((p) => alive.has(p)));
  const constraints = s.constraints.filter((c) => !ids.has(c.id) && constraintRefs(c).every((r) => alive.has(r)));
  // points that only constraints referred to, and whose constraints are now gone
  const stillUsed = new Set([...entities.flatMap(entityPoints), ...constraints.flatMap(constraintRefs)]);
  return { ...s, points: points.filter((p) => stillUsed.has(p.id)), entities, constraints };
}

/** Joins point `drop` onto point `keep` (coincident): everything that used `drop` now uses `keep`. */
export function mergePoints(s: Sketch, keep: string, drop: string): Sketch {
  if (keep === drop) return s;
  const swap = (id: string) => (id === drop ? keep : id);
  const entities = s.entities.map((e): SkEntity => {
    switch (e.kind) {
      case 'line': return { ...e, a: swap(e.a), b: swap(e.b) };
      case 'arc': return { ...e, c: swap(e.c), a: swap(e.a), b: swap(e.b) };
      case 'circle': return { ...e, c: swap(e.c) };
      case 'spline': return { ...e, pts: e.pts.map(swap) };
    }
  }).filter((e) => !(e.kind === 'line' && e.a === e.b));
  const constraints = s.constraints.map((c) => {
    const o = { ...c } as Record<string, unknown>;
    for (const k of ['p', 'q']) if (typeof o[k] === 'string') o[k] = swap(o[k] as string);
    return o as unknown as SkConstraint;
  }).filter((c) => !((c.kind === 'distance' || c.kind === 'horizontal' || c.kind === 'vertical' || c.kind === 'hDistance' || c.kind === 'vDistance') && c.p === c.q));
  return { ...s, points: s.points.filter((p) => p.id !== drop), entities, constraints };
}

/**
 * Rounds the corner where two lines meet with an arc of the given radius.
 * The sharp corner stays as a construction point on both lines, so measurements taken to it still hold.
 */
export function filletCorner(s: Sketch, corner: string, radius: number, newId: () => string): { ok: true; sketch: Sketch; arcId: string } | { ok: false; message: string } {
  const lines = s.entities.filter((e): e is Extract<SkEntity, { kind: 'line' }> => e.kind === 'line' && !e.construction && (e.a === corner || e.b === corner));
  const others = s.entities.filter((e) => !e.construction && e.kind !== 'line' && entityPoints(e).includes(corner));
  if (lines.length !== 2 || others.length) return { ok: false, message: 'Rounding works on a corner where exactly two straight lines meet.' };
  const pts = pointMap(s), c = pts.get(corner)!;
  const far = lines.map((l) => pts.get(l.a === corner ? l.b : l.a)!);
  const u = far.map((f) => { const d = hyp(f.x - c.x, f.y - c.y); return { x: (f.x - c.x) / d, y: (f.y - c.y) / d, d }; });
  const angle = Math.acos(Math.max(-1, Math.min(1, u[0].x * u[1].x + u[0].y * u[1].y)));
  if (angle < 0.01 || angle > Math.PI - 0.01) return { ok: false, message: 'These two lines are (almost) in one line: there is no corner to round.' };
  const t = radius / Math.tan(angle / 2);
  if (t >= Math.min(u[0].d, u[1].d)) return { ok: false, message: 'This radius is too large for these lines.' };
  const t1 = { id: newId(), x: c.x + u[0].x * t, y: c.y + u[0].y * t }, t2 = { id: newId(), x: c.x + u[1].x * t, y: c.y + u[1].y * t };
  const bis = { x: u[0].x + u[1].x, y: u[0].y + u[1].y }, bl = hyp(bis.x, bis.y);
  const k = { id: newId(), x: c.x + (bis.x / bl) * (radius / Math.sin(angle / 2)), y: c.y + (bis.y / bl) * (radius / Math.sin(angle / 2)) };
  // the arc runs counter-clockwise from one tangent point to the other
  const cross = (t1.x - k.x) * (t2.y - k.y) - (t1.y - k.y) * (t2.x - k.x);
  const arc: SkEntity = cross > 0 ? { id: newId(), kind: 'arc', c: k.id, a: t1.id, b: t2.id } : { id: newId(), kind: 'arc', c: k.id, a: t2.id, b: t1.id };
  const entities = s.entities.map((e): SkEntity => {
    if (e.id === lines[0].id) return e.kind === 'line' ? (e.a === corner ? { ...e, a: t1.id } : { ...e, b: t1.id }) : e;
    if (e.id === lines[1].id) return e.kind === 'line' ? (e.a === corner ? { ...e, a: t2.id } : { ...e, b: t2.id }) : e;
    return e;
  });
  const constraints: SkConstraint[] = [
    ...s.constraints,
    { id: newId(), kind: 'tangent', e1: lines[0].id, e2: arc.id },
    { id: newId(), kind: 'tangent', e1: lines[1].id, e2: arc.id },
    { id: newId(), kind: 'radius', e: arc.id, value: radius },
    // the old sharp corner, kept where the two lines would meet
    { id: newId(), kind: 'pointOnLine', p: corner, line: lines[0].id },
    { id: newId(), kind: 'pointOnLine', p: corner, line: lines[1].id },
  ];
  return { ok: true, sketch: { ...s, points: [...s.points, t1, t2, k], entities: [...entities, arc], constraints }, arcId: arc.id };
}

/**
 * Mirrors entities about a line. The copies stay mirrored (symmetric relations);
 * points lying on the mirror line are shared, not copied.
 */
export function mirrorEntities(s: Sketch, ids: string[], axis: string, newId: () => string): Sketch {
  const ax = s.entities.find((e) => e.id === axis);
  if (!ax || ax.kind !== 'line') return s;
  const pts = pointMap(s), a = pts.get(ax.a)!, b = pts.get(ax.b)!;
  const dx = b.x - a.x, dy = b.y - a.y, dl = hyp(dx, dy);
  const reflect = (p: SkPoint) => { const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dl * dl), fx = a.x + dx * t, fy = a.y + dy * t; return { x: 2 * fx - p.x, y: 2 * fy - p.y }; };
  const onAxis = (p: SkPoint) => Math.abs(((p.x - a.x) * dy - (p.y - a.y) * dx) / dl) < 0.5;
  const copyOf = new Map<string, string>(), newPoints: SkPoint[] = [], constraints: SkConstraint[] = [];
  const twin = (id: string) => {
    if (id === ax.a || id === ax.b) return id;
    let t = copyOf.get(id);
    if (!t) {
      const p = pts.get(id)!;
      if (onAxis(p)) { copyOf.set(id, id); constraints.push({ id: newId(), kind: 'pointOnLine', p: id, line: axis }); return id; }
      t = newId(); copyOf.set(id, t);
      newPoints.push({ id: t, ...reflect(p) });
      constraints.push({ id: newId(), kind: 'symmetric', p: id, q: t, line: axis });
    }
    return t;
  };
  const newEntities: SkEntity[] = [];
  for (const e of s.entities) {
    if (!ids.includes(e.id) || e.id === axis) continue;
    const id = newId();
    switch (e.kind) {
      case 'line': newEntities.push({ ...e, id, a: twin(e.a), b: twin(e.b) }); break;
      case 'arc': newEntities.push({ ...e, id, c: twin(e.c), a: twin(e.b), b: twin(e.a) }); break; // a mirror turns direction around
      case 'circle': newEntities.push({ ...e, id, c: twin(e.c) }); constraints.push({ id: newId(), kind: 'equalRadius', e1: e.id, e2: id }); break;
      case 'spline': newEntities.push({ ...e, id, pts: e.pts.map(twin) }); break;
    }
  }
  return { ...s, points: [...s.points, ...newPoints], entities: [...s.entities, ...newEntities], constraints: [...s.constraints, ...constraints] };
}

/** Distance from a point to an entity's drawn line. */
export function distanceToEntity(s: Sketch, e: SkEntity, x: number, y: number, pts = pointMap(s)): number {
  const p = entityPath(s, e, pts);
  let best = Infinity;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const ax = p[k], ay = p[k + 1], dx = p[k + 2] - ax, dy = p[k + 3] - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, hyp(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** Constraints that mention any of the given ids. */
export const constraintsOn = (s: Sketch, ids: Set<string>) => s.constraints.filter((c) => constraintRefs(c).some((r) => ids.has(r)));
export const dimensionsOf = (s: Sketch) => s.constraints.filter(isDimension);
