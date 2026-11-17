/**
 * Keeps a sketch's constraints true.
 *
 * Every point contributes two unknowns (x, y), every circle one (its radius).
 * Every constraint becomes one or two equations that are zero when it holds.
 * The solver (Levenberg–Marquardt) moves the unknowns as little as possible
 * until all equations are zero.
 *
 * It also tells how much freedom is left: a shape is "fully defined" when the
 * only freedom left is moving or turning the whole drawing (which does not
 * matter for a panel).
 */
import { cholesky, rankAndNullSpace } from './linalg';
import { isDimension, type Sketch, type SkConstraint, type SkDimension, type SkEntity } from './model';

/** Unitless equations (angles) are multiplied by this, so they weigh about as much as millimetres. */
const L = 500;
/** An equation counts as satisfied below this, mm. */
export const TOLERANCE = 1e-5;

interface Row { deps: number[]; f: (v: Float64Array) => number }

interface System {
  n: number;
  v: Float64Array;
  pointIndex: Map<string, number>;
  radiusIndex: Map<string, number>;
  rows: Row[];
  /** which rows belong to which constraint (implicit arc rows have key '') */
  owner: string[];
}

const hyp = (x: number, y: number) => Math.sqrt(x * x + y * y);

function buildSystem(s: Sketch, skip?: string): System {
  const pointIndex = new Map<string, number>(), radiusIndex = new Map<string, number>();
  const vals: number[] = [];
  for (const p of s.points) { pointIndex.set(p.id, vals.length); vals.push(p.x, p.y); }
  for (const e of s.entities) if (e.kind === 'circle') { radiusIndex.set(e.id, vals.length); vals.push(e.r); }
  const ents = new Map(s.entities.map((e) => [e.id, e]));
  const rows: Row[] = [], owner: string[] = [];
  const P = (id: string) => { const i = pointIndex.get(id); if (i === undefined) throw new Error(`Missing point ${id}`); return i; };
  const E = (id: string) => { const e = ents.get(id); if (!e) throw new Error(`Missing entity ${id}`); return e; };
  const line = (id: string) => { const e = E(id); if (e.kind !== 'line') throw new Error('Not a line'); return [P(e.a), P(e.b)] as const; };
  /** centre index and a way to read the radius, for arcs and circles */
  const curve = (id: string): { c: number; deps: number[]; r: (v: Float64Array) => number } => {
    const e = E(id);
    if (e.kind === 'circle') { const c = P(e.c), ri = radiusIndex.get(e.id)!; return { c, deps: [c, c + 1, ri], r: (v) => v[ri] }; }
    if (e.kind === 'arc') { const c = P(e.c), a = P(e.a); return { c, deps: [c, c + 1, a, a + 1], r: (v) => hyp(v[a] - v[c], v[a + 1] - v[c + 1]) }; }
    throw new Error('Not an arc or circle');
  };
  const add = (key: string, deps: number[], f: Row['f']) => { rows.push({ deps: [...new Set(deps)], f }); owner.push(key); };
  const xy = (i: number) => [i, i + 1];

  // arcs: both ends at the same distance from the centre
  for (const e of s.entities) {
    if (e.kind !== 'arc') continue;
    const c = P(e.c), a = P(e.a), b = P(e.b);
    add('', [...xy(c), ...xy(a), ...xy(b)], (v) => hyp(v[a] - v[c], v[a + 1] - v[c + 1]) - hyp(v[b] - v[c], v[b + 1] - v[c + 1]));
  }

  for (const k of s.constraints) {
    if (k.id === skip) continue;
    if (isDimension(k) && k.reference) continue;
    addConstraintRows(k, add, { P, line, curve, xy, E });
  }
  return { n: vals.length, v: Float64Array.from(vals), pointIndex, radiusIndex, rows, owner };
}

type Adder = (key: string, deps: number[], f: Row['f']) => void;
interface Ctx {
  P: (id: string) => number;
  line: (id: string) => readonly [number, number];
  curve: (id: string) => { c: number; deps: number[]; r: (v: Float64Array) => number };
  xy: (i: number) => number[];
  E: (id: string) => SkEntity;
}

function addConstraintRows(k: SkConstraint, add: Adder, { P, line, curve, xy, E }: Ctx) {
  const key = k.id;
  const vec = (v: Float64Array, a: number, b: number) => [v[b] - v[a], v[b + 1] - v[a + 1]] as const;
  switch (k.kind) {
    case 'horizontal': { const p = P(k.p), q = P(k.q); add(key, [p + 1, q + 1], (v) => v[p + 1] - v[q + 1]); break; }
    case 'vertical': { const p = P(k.p), q = P(k.q); add(key, [p, q], (v) => v[p] - v[q]); break; }
    case 'parallel': case 'perpendicular': {
      const [a1, b1] = line(k.l1), [a2, b2] = line(k.l2), par = k.kind === 'parallel';
      add(key, [...xy(a1), ...xy(b1), ...xy(a2), ...xy(b2)], (v) => {
        const [ux, uy] = vec(v, a1, b1), [wx, wy] = vec(v, a2, b2);
        return (L * (par ? ux * wy - uy * wx : ux * wx + uy * wy)) / (hyp(ux, uy) * hyp(wx, wy) || 1);
      });
      break;
    }
    case 'equalLength': {
      const [a1, b1] = line(k.l1), [a2, b2] = line(k.l2);
      add(key, [...xy(a1), ...xy(b1), ...xy(a2), ...xy(b2)], (v) => hyp(...vec(v, a1, b1)) - hyp(...vec(v, a2, b2)));
      break;
    }
    case 'equalRadius': { const c1 = curve(k.e1), c2 = curve(k.e2); add(key, [...c1.deps, ...c2.deps], (v) => c1.r(v) - c2.r(v)); break; }
    case 'tangent': {
      const e1 = E(k.e1), e2 = E(k.e2);
      // Where the two touch at a shared end point, say it directly at that point: it is far better
      // behaved for the solver than "distance equals radius", which is flat at the touching point.
      const ends = (e: SkEntity) => (e.kind === 'line' || e.kind === 'arc' ? [e.a, e.b] : []);
      const shared = ends(e1).find((p) => ends(e2).includes(p));
      if (e1.kind === 'line' || e2.kind === 'line') {
        const ln = e1.kind === 'line' ? k.e1 : k.e2, cv = curve(e1.kind === 'line' ? k.e2 : k.e1), [a, b] = line(ln);
        if (shared) {
          const t = P(shared);
          // the radius to the joint is at right angles to the line
          add(key, [...xy(a), ...xy(b), ...xy(cv.c), ...xy(t)], (v) => { const [ux, uy] = vec(v, a, b), rx = v[cv.c] - v[t], ry = v[cv.c + 1] - v[t + 1]; return (ux * rx + uy * ry) / (hyp(ux, uy) || 1); });
        } else {
          add(key, [...xy(a), ...xy(b), ...cv.deps], (v) => {
            const [ux, uy] = vec(v, a, b), cx = v[cv.c] - v[a], cy = v[cv.c + 1] - v[a + 1];
            return Math.abs(ux * cy - uy * cx) / (hyp(ux, uy) || 1) - cv.r(v);
          });
        }
      } else {
        const c1 = curve(k.e1), c2 = curve(k.e2);
        if (shared) {
          const t = P(shared);
          // both centres lie on one line through the joint
          add(key, [...xy(c1.c), ...xy(c2.c), ...xy(t)], (v) => { const ax = v[c1.c] - v[t], ay = v[c1.c + 1] - v[t + 1], bx = v[c2.c] - v[t], by = v[c2.c + 1] - v[t + 1]; return (ax * by - ay * bx) / (hyp(ax, ay) || 1); });
        } else {
          add(key, [...c1.deps, ...c2.deps], (v) => {
            const d = hyp(v[c2.c] - v[c1.c], v[c2.c + 1] - v[c1.c + 1]);
            return k.inside ? d - Math.abs(c1.r(v) - c2.r(v)) : d - (c1.r(v) + c2.r(v));
          });
        }
      }
      break;
    }
    case 'pointOnLine': {
      const p = P(k.p), [a, b] = line(k.line);
      add(key, [...xy(p), ...xy(a), ...xy(b)], (v) => { const [ux, uy] = vec(v, a, b), [wx, wy] = vec(v, a, p); return (ux * wy - uy * wx) / (hyp(ux, uy) || 1); });
      break;
    }
    case 'pointOnCurve': { const p = P(k.p), cv = curve(k.curve); add(key, [...xy(p), ...cv.deps], (v) => hyp(v[p] - v[cv.c], v[p + 1] - v[cv.c + 1]) - cv.r(v)); break; }
    case 'midpoint': {
      const p = P(k.p), [a, b] = line(k.line);
      add(key, [p, a, b], (v) => v[p] - (v[a] + v[b]) / 2);
      add(key, [p + 1, a + 1, b + 1], (v) => v[p + 1] - (v[a + 1] + v[b + 1]) / 2);
      break;
    }
    case 'symmetric': {
      const p = P(k.p), q = P(k.q), [a, b] = line(k.line), deps = [...xy(p), ...xy(q), ...xy(a), ...xy(b)];
      add(key, deps, (v) => { const [ux, uy] = vec(v, a, b), mx = (v[p] + v[q]) / 2 - v[a], my = (v[p + 1] + v[q + 1]) / 2 - v[a + 1]; return (ux * my - uy * mx) / (hyp(ux, uy) || 1); });
      add(key, deps, (v) => { const [ux, uy] = vec(v, a, b), [wx, wy] = vec(v, p, q); return (ux * wx + uy * wy) / (hyp(ux, uy) || 1); });
      break;
    }
    case 'fix': { const p = P(k.p); add(key, [p], (v) => v[p] - k.x); add(key, [p + 1], (v) => v[p + 1] - k.y); break; }
    case 'distance': { const p = P(k.p), q = P(k.q); add(key, [...xy(p), ...xy(q)], (v) => hyp(...vec(v, p, q)) - k.value); break; }
    case 'hDistance': { const p = P(k.p), q = P(k.q); add(key, [p, q], (v) => k.sign * (v[q] - v[p]) - k.value); break; }
    case 'vDistance': { const p = P(k.p), q = P(k.q); add(key, [p + 1, q + 1], (v) => k.sign * (v[q + 1] - v[p + 1]) - k.value); break; }
    case 'pointLine': {
      const p = P(k.p), [a, b] = line(k.line);
      add(key, [...xy(p), ...xy(a), ...xy(b)], (v) => { const [ux, uy] = vec(v, a, b), [wx, wy] = vec(v, a, p); return (k.sign * (ux * wy - uy * wx)) / (hyp(ux, uy) || 1) - k.value; });
      break;
    }
    case 'angle': {
      const [a1, b1] = line(k.l1), [a2, b2] = line(k.l2), t = (k.value * Math.PI) / 180, ct = Math.cos(t), st = Math.sin(t);
      add(key, [...xy(a1), ...xy(b1), ...xy(a2), ...xy(b2)], (v) => {
        const [ux, uy] = vec(v, a1, b1), [wx, wy] = vec(v, a2, b2);
        // zero when turning u by the angle gives the direction of w
        return (L * ((ux * wy - uy * wx) * ct - (ux * wx + uy * wy) * st)) / (hyp(ux, uy) * hyp(wx, wy) || 1);
      });
      break;
    }
    case 'radius': { const cv = curve(k.e); add(key, cv.deps, (v) => cv.r(v) - k.value); break; }
  }
}

/** Sum of squares and its gradient/curvature (Jᵀr, JᵀJ), from finite differences over each row's own unknowns. */
function linearize(rows: Row[], v: Float64Array, n: number, weights?: number[]) {
  const A = new Float64Array(n * n), g = new Float64Array(n);
  let cost = 0, worst = 0;
  const grad: number[] = [];
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k], w = weights?.[k] ?? 1;
    const r = row.f(v) * w;
    cost += r * r;
    if (!weights || w === 1) worst = Math.max(worst, Math.abs(r));
    grad.length = 0;
    for (const i of row.deps) {
      const keep = v[i], h = 1e-5 * Math.max(1, Math.abs(keep));
      v[i] = keep + h; const fp = row.f(v);
      v[i] = keep - h; const fm = row.f(v);
      v[i] = keep;
      grad.push(((fp - fm) / (2 * h)) * w);
    }
    for (let a = 0; a < row.deps.length; a++) {
      const i = row.deps[a];
      g[i] += grad[a] * r;
      for (let b = 0; b < row.deps.length; b++) A[i * n + row.deps[b]] += grad[a] * grad[b];
    }
  }
  return { A, g, cost, worst };
}

function residuals(rows: Row[], v: Float64Array, weights?: number[]) {
  let cost = 0, worst = 0;
  rows.forEach((row, k) => { const w = weights?.[k] ?? 1, r = row.f(v) * w; cost += r * r; if (w === 1) worst = Math.max(worst, Math.abs(r)); });
  return { cost, worst };
}

/** Levenberg–Marquardt: small steps first, so the drawing changes as little as possible. */
function levenbergMarquardt(rows: Row[], v: Float64Array, n: number, weights?: number[], maxIter = 200) {
  let lambda = 1e-3;
  for (let iter = 0; iter < maxIter; iter++) {
    const { A, g, cost, worst } = linearize(rows, v, n, weights);
    if (!weights && worst < TOLERANCE * 0.1) break;
    let stepped = false;
    while (lambda < 1e14) {
      const M = Float64Array.from(A);
      for (let i = 0; i < n; i++) M[i * n + i] += lambda * A[i * n + i] + lambda * 1e-6 + 1e-12;
      const neg = g.map((x) => -x);
      const d = cholesky(M, neg, n);
      if (!d) { lambda *= 4; continue; }
      const trial = Float64Array.from(v);
      for (let i = 0; i < n; i++) trial[i] += d[i];
      const next = residuals(rows, trial, weights);
      if (next.cost < cost) {
        v.set(trial);
        lambda = Math.max(lambda / 3, 1e-12);
        stepped = true;
        let size = 0; for (let i = 0; i < n; i++) size = Math.max(size, Math.abs(d[i]));
        if (size < 1e-9) return;
        break;
      }
      lambda *= 4;
    }
    if (!stepped) return;
  }
}

function writeBack(s: Sketch, sys: System, v: Float64Array): Sketch {
  return {
    ...s,
    points: s.points.map((p) => { const i = sys.pointIndex.get(p.id)!; return v[i] === p.x && v[i + 1] === p.y ? p : { ...p, x: v[i], y: v[i + 1] }; }),
    entities: s.entities.map((e) => (e.kind === 'circle' ? { ...e, r: Math.abs(v[sys.radiusIndex.get(e.id)!]) } : e)),
  };
}

export interface SolveResult { sketch: Sketch; ok: boolean; worst: number }

/**
 * Makes every constraint true, changing the drawing as little as possible.
 * With `drag`, those points are pulled towards where the pointer is, as far as the constraints allow.
 */
export function solve(s: Sketch, drag: { point: string; x: number; y: number }[] = []): SolveResult {
  const sys = buildSystem(s);
  const v = Float64Array.from(sys.v);
  if (drag.length) {
    const soft: Row[] = [], weights: number[] = sys.rows.map(() => 1);
    for (const d of drag) {
      const i = sys.pointIndex.get(d.point);
      if (i === undefined) continue;
      soft.push({ deps: [i], f: (w) => w[i] - d.x }, { deps: [i + 1], f: (w) => w[i + 1] - d.y });
      weights.push(0.02, 0.02);
    }
    levenbergMarquardt([...sys.rows, ...soft], v, sys.n, weights, 60);
  }
  levenbergMarquardt(sys.rows, v, sys.n);
  const { worst } = residuals(sys.rows, v);
  return { sketch: writeBack(s, sys, v), ok: worst < TOLERANCE * 10, worst };
}

/** The Jacobian (one row per equation) at the current geometry, dense. */
function jacobian(sys: System) {
  const m = sys.rows.length, n = sys.n, J = new Float64Array(m * n), v = Float64Array.from(sys.v);
  sys.rows.forEach((row, k) => {
    for (const i of row.deps) {
      const keep = v[i], h = 1e-5 * Math.max(1, Math.abs(keep));
      v[i] = keep + h; const fp = row.f(v);
      v[i] = keep - h; const fm = row.f(v);
      v[i] = keep;
      J[k * n + i] = (fp - fm) / (2 * h);
    }
  });
  return J;
}

export interface Analysis {
  /** freedom left in the shape (moving or turning the whole drawing does not count) */
  dof: number;
  /** points that can still move relative to the rest */
  freePoints: Set<string>;
  /** circles whose radius is still free */
  freeRadius: Set<string>;
}

export function analyse(s: Sketch): Analysis {
  if (!s.points.length) return { dof: 0, freePoints: new Set(), freeRadius: new Set() };
  const sys = buildSystem(s);
  const J = jacobian(sys);
  const n = sys.n, m0 = sys.rows.length;
  // The drawing as a whole may still move and turn; that does not matter for a panel.
  // Pin it the way a CAD origin would: at a fixed point if there is one (else the first point),
  // and, only if turning is still free, by the direction to the farthest point.
  const fixed = s.constraints.find((c) => c.kind === 'fix');
  const p0 = s.points.find((p) => p.id === fixed?.p) ?? s.points[0], i0 = sys.pointIndex.get(p0.id)!;
  const moves = (motion: Float64Array) => {
    let worst = 0, size = 0;
    for (let k = 0; k < m0; k++) {
      let dot = 0, nrm = 0;
      for (let i = 0; i < n; i++) { dot += J[k * n + i] * motion[i]; nrm += J[k * n + i] ** 2; }
      worst = Math.max(worst, Math.abs(dot) / (Math.sqrt(nrm) || 1));
    }
    for (let i = 0; i < n; i++) size = Math.max(size, Math.abs(motion[i]));
    return worst > 1e-7 * Math.max(size, 1);
  };
  const shift = (axis: 0 | 1) => { const t = new Float64Array(n); for (const i of sys.pointIndex.values()) t[i + axis] = 1; return t; };
  const turn = new Float64Array(n);
  for (const p of s.points) { const i = sys.pointIndex.get(p.id)!; turn[i] = -(p.y - p0.y); turn[i + 1] = p.x - p0.x; }
  const gauge: Float64Array[] = [];
  const pin = () => { const r = new Float64Array(n); gauge.push(r); return r; };
  if (!moves(shift(0))) pin()[i0] = 1;
  if (!moves(shift(1))) pin()[i0 + 1] = 1;
  let far = p0, farD = 0;
  for (const p of s.points) { const d = hyp(p.x - p0.x, p.y - p0.y); if (d > farD) { farD = d; far = p; } }
  if (farD > 1e-6 && !moves(turn)) { const r = pin(), j = sys.pointIndex.get(far.id)!; r[j] = -(far.y - p0.y) / farD; r[j + 1] = (far.x - p0.x) / farD; }
  const m = m0 + gauge.length;
  const M = new Float64Array(m * n);
  M.set(J);
  gauge.forEach((r, k) => M.set(r, (m0 + k) * n));
  normalizeRows(M, m, n);
  const { rank, nullSpace } = rankAndNullSpace(M, m, n, RANK_TOL);
  const freeVar = new Uint8Array(n);
  for (const z of nullSpace) {
    let big = 0; for (const x of z) big = Math.max(big, Math.abs(x));
    for (let i = 0; i < n; i++) if (Math.abs(z[i]) > 1e-6 * big) freeVar[i] = 1;
  }
  const freePoints = new Set<string>(), freeRadius = new Set<string>();
  for (const [id, i] of sys.pointIndex) if (freeVar[i] || freeVar[i + 1]) freePoints.add(id);
  for (const [id, i] of sys.radiusIndex) if (freeVar[i]) freeRadius.add(id);
  return { dof: n - rank, freePoints, freeRadius };
}

const RANK_TOL = 1e-7;
function normalizeRows(M: Float64Array, m: number, n: number) {
  for (let k = 0; k < m; k++) { let s2 = 0; for (let i = 0; i < n; i++) s2 += M[k * n + i] ** 2; const f = s2 > 0 ? 1 / Math.sqrt(s2) : 1; for (let i = 0; i < n; i++) M[k * n + i] *= f; }
}

/** True when the constraint would add nothing new (it is already decided by the others). */
export function isRedundant(s: Sketch, c: SkConstraint): boolean {
  const without = buildSystem(s), withIt = buildSystem({ ...s, constraints: [...s.constraints, isDimension(c) ? { ...c, reference: false } : c] });
  const added = withIt.rows.length - without.rows.length;
  if (added === 0) return true;
  const rank = (sys: System) => {
    const J = jacobian(sys), m = sys.rows.length, n = sys.n;
    normalizeRows(J, m, n);
    return rankAndNullSpace(J, m, n, RANK_TOL).rank;
  };
  return rank(withIt) - rank(without) < added;
}

/** The value a dimension shows for the drawing as it is now (always positive). */
export function measure(s: Sketch, d: SkDimension): number {
  const pt = new Map(s.points.map((p) => [p.id, p])), ent = new Map(s.entities.map((e) => [e.id, e]));
  const P = (id: string) => pt.get(id)!;
  const lineOf = (id: string) => { const e = ent.get(id) as Extract<SkEntity, { kind: 'line' }>; return [P(e.a), P(e.b)] as const; };
  switch (d.kind) {
    case 'distance': { const p = P(d.p), q = P(d.q); return hyp(q.x - p.x, q.y - p.y); }
    case 'hDistance': return Math.abs(P(d.q).x - P(d.p).x);
    case 'vDistance': return Math.abs(P(d.q).y - P(d.p).y);
    case 'pointLine': { const p = P(d.p), [a, b] = lineOf(d.line); return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / (hyp(b.x - a.x, b.y - a.y) || 1); }
    case 'angle': {
      const [a1, b1] = lineOf(d.l1), [a2, b2] = lineOf(d.l2);
      const ux = b1.x - a1.x, uy = b1.y - a1.y, wx = b2.x - a2.x, wy = b2.y - a2.y;
      const between = Math.abs((Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy) * 180) / Math.PI);
      return d.flip ? 180 - between : between;
    }
    case 'radius': {
      const e = ent.get(d.e)!;
      if (e.kind === 'circle') return e.r;
      if (e.kind === 'arc') { const c = P(e.c), a = P(e.a); return hyp(a.x - c.x, a.y - c.y); }
      return 0;
    }
  }
}

/** The signed value to store for a new dimension, so it matches the drawing as it is now. */
export function signedNow(s: Sketch, d: SkDimension): SkDimension {
  const pt = new Map(s.points.map((p) => [p.id, p])), ent = new Map(s.entities.map((e) => [e.id, e]));
  if (d.kind === 'hDistance' || d.kind === 'vDistance') {
    const p = pt.get(d.p)!, q = pt.get(d.q)!, delta = d.kind === 'hDistance' ? q.x - p.x : q.y - p.y;
    return { ...d, sign: delta < 0 ? -1 : 1, value: Math.abs(delta) };
  }
  if (d.kind === 'pointLine') {
    const e = ent.get(d.line) as Extract<SkEntity, { kind: 'line' }>, p = pt.get(d.p)!, a = pt.get(e.a)!, b = pt.get(e.b)!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    return { ...d, sign: cross < 0 ? -1 : 1, value: Math.abs(cross) / (hyp(b.x - a.x, b.y - a.y) || 1) };
  }
  if (d.kind === 'angle') {
    const l1 = ent.get(d.l1) as Extract<SkEntity, { kind: 'line' }>, l2 = ent.get(d.l2) as Extract<SkEntity, { kind: 'line' }>;
    const a1 = pt.get(l1.a)!, b1 = pt.get(l1.b)!, a2 = pt.get(l2.a)!, b2 = pt.get(l2.b)!;
    const ux = b1.x - a1.x, uy = b1.y - a1.y, wx = b2.x - a2.x, wy = b2.y - a2.y;
    // show the corner as drawn: directions pointing away from where the two lines meet
    const den = ux * wy - uy * wx;
    let flip = d.flip ?? false;
    if (d.flip === undefined && Math.abs(den) > 1e-9 * Math.hypot(ux, uy) * Math.hypot(wx, wy)) {
      const t = ((a2.x - a1.x) * wy - (a2.y - a1.y) * wx) / den, X = { x: a1.x + ux * t, y: a1.y + uy * t };
      const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 }, m2 = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
      const out1 = ux * (m1.x - X.x) + uy * (m1.y - X.y) >= 0, out2 = wx * (m2.x - X.x) + wy * (m2.y - X.y) >= 0;
      flip = out1 !== out2;
    }
    return { ...d, flip, value: (Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy) * 180) / Math.PI };
  }
  return { ...d, value: measure(s, d) };
}

export type AddResult =
  | { status: 'added'; sketch: Sketch }
  | { status: 'reference'; sketch: Sketch; message: string }
  | { status: 'refused'; message: string };

const shortestLine = (s: Sketch) => {
  const pt = new Map(s.points.map((p) => [p.id, p]));
  let min = Infinity;
  for (const e of s.entities) if (e.kind === 'line') { const a = pt.get(e.a)!, b = pt.get(e.b)!; min = Math.min(min, hyp(b.x - a.x, b.y - a.y)); }
  return min;
};

/**
 * Adds a relation or dimension. A dimension the others already decide is added as a
 * reference (it shows the value but does not set it). A relation that is already
 * true through the others, or that cannot be met, is refused with a reason.
 */
export function addConstraint(s: Sketch, c: SkConstraint): AddResult {
  if (isRedundant(s, c)) {
    if (isDimension(c)) {
      const ref = { ...signedNow(s, c), reference: true } as SkDimension;
      return { status: 'reference', sketch: { ...s, constraints: [...s.constraints, ref] }, message: 'This measurement is already decided by the other measurements and relations, so it is shown as a reference (in brackets) and does not change the drawing.' };
    }
    return { status: 'refused', message: 'This relation is already decided by the other measurements and relations, so it would add nothing.' };
  }
  const next = { ...s, constraints: [...s.constraints, c] };
  const before = shortestLine(s);
  const r = solve(next);
  if (!r.ok) return { status: 'refused', message: 'This cannot be true together with the measurements and relations already in the sketch.' };
  if (shortestLine(r.sketch) < Math.min(0.5, before)) return { status: 'refused', message: 'This would shrink a line to nothing.' };
  return { status: 'added', sketch: r.sketch };
}

/**
 * Changes a dimension to a new value. Large changes are made in small steps, so the
 * drawing moves smoothly instead of jumping or folding over.
 */
export function setDimension(s: Sketch, id: string, value: number): { ok: true; sketch: Sketch } | { ok: false; message: string } {
  const d = s.constraints.find((c) => c.id === id) as SkDimension | undefined;
  if (!d) return { ok: false, message: 'That measurement no longer exists.' };
  if (!(value > 0) && d.kind !== 'angle') return { ok: false, message: 'A measurement must be larger than zero.' };
  if (d.reference) return { ok: false, message: 'This is a reference measurement: it only shows the value the others give. Delete another measurement first to make it set the drawing.' };
  if (d.kind === 'angle' && !(value > 0 && value < 180)) return { ok: false, message: 'An angle must be between 0° and 180°.' };
  const signed = d.kind === 'angle' ? Math.sign(d.value || 1) * (d.flip ? 180 - value : value) : value;
  const from = d.value;
  // size of the drawing, to decide how big a step is safe
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of s.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const size = Math.max(maxX - minX, maxY - minY, 1);
  const unit = d.kind === 'angle' ? 5 : 0.1 * size;
  const steps = Math.min(40, Math.max(1, Math.ceil(Math.abs(signed - from) / unit)));
  let cur = s;
  for (let k = 1; k <= steps; k++) {
    const v = from + ((signed - from) * k) / steps;
    const r = solve({ ...cur, constraints: cur.constraints.map((c) => (c.id === id ? ({ ...c, value: v } as SkDimension) : c)) });
    if (!r.ok) return { ok: false, message: 'This value cannot be true together with the other measurements. Check the measurement, or remove the one it fights with.' };
    cur = r.sketch;
  }
  if (shortestLine(cur) < 0.5) return { ok: false, message: 'This value would shrink a line to nothing.' };
  return { ok: true, sketch: cur };
}

/** Recomputes the shown value of reference dimensions after the drawing changed. */
export function refreshReferences(s: Sketch): Sketch {
  if (!s.constraints.some((c) => isDimension(c) && c.reference)) return s;
  return { ...s, constraints: s.constraints.map((c) => (isDimension(c) && c.reference ? ({ ...signedNow(s, c), reference: true } as SkDimension) : c)) };
}
