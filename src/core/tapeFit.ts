/**
 * Fitting a scanned outline to tape measurements taken on the boat.
 *
 * Every measurement between two corners must come out as the tape showed. The rest of the
 * shape changes as little as possible: all other distances between corners are kept close to
 * the scan, so a correction spreads over the whole outline instead of bending one side.
 */
import { cholesky } from './sketch/linalg';
import { snapToCorner, withAnchors, type Surface } from './surface';
import type { Vec2 } from './vec';

/** how firmly the tape is held, mm (small = firm) */
const TAPE = 0.2;
/** how firmly the other distances between corners keep their scanned length, mm */
const SCAN = 5;
/** keeps the outline where it is (no drifting or turning), mm */
const PLACE = 2000;

export interface TapeFit {
  surface: Surface;
  /** measurements used (between two corners, with a tape value) */
  used: number;
  /** measurements left out: not between two corners, or no tape value */
  skipped: number;
  /** the corner that moved most, mm */
  moved: number;
  /** after fitting, the largest difference left between drawing and tape, mm: above ~1 mm the measurements disagree with each other */
  worst: number;
}

interface Pair { i: number; j: number; length: number; sigma: number }

function cornerIndex(corners: Vec2[], p: Vec2): number {
  return corners.findIndex((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) < 0.5);
}

/** Least squares on distances between points, by damped Gauss-Newton. */
function solveDistances(start: Vec2[], pairs: Pair[]): Vec2[] {
  const n = start.length, N = n * 2;
  let x = start.flatMap((p) => [p[0], p[1]]);
  const cost = (v: number[]) => {
    let c = 0;
    for (const p of pairs) { const r = (Math.hypot(v[p.j * 2] - v[p.i * 2], v[p.j * 2 + 1] - v[p.i * 2 + 1]) - p.length) / p.sigma; c += r * r; }
    for (let k = 0; k < N; k++) { const r = (v[k] - x0[k]) / PLACE; c += r * r; }
    return c;
  };
  const x0 = [...x];
  let mu = 1e-3, now = cost(x);
  for (let it = 0; it < 100; it++) {
    const A = new Float64Array(N * N), g = new Float64Array(N);
    for (const p of pairs) {
      const dx = x[p.j * 2] - x[p.i * 2], dy = x[p.j * 2 + 1] - x[p.i * 2 + 1], d = Math.hypot(dx, dy) || 1e-9;
      const r = (d - p.length) / p.sigma, w = 1 / p.sigma;
      const J: [number, number][] = [[p.i * 2, -dx / d * w], [p.i * 2 + 1, -dy / d * w], [p.j * 2, dx / d * w], [p.j * 2 + 1, dy / d * w]];
      for (const [a, ja] of J) { g[a] += ja * r; for (const [b, jb] of J) A[a * N + b] += ja * jb; }
    }
    for (let k = 0; k < N; k++) { const w = 1 / PLACE; A[k * N + k] += w * w; g[k] += w * ((x[k] - x0[k]) / PLACE); }
    let accepted = false;
    for (let tries = 0; tries < 12 && !accepted; tries++) {
      const M = A.slice();
      for (let k = 0; k < N; k++) M[k * N + k] += mu * (A[k * N + k] || 1);
      const step = cholesky(M, g.map((v) => -v), N);
      if (!step) { mu *= 10; continue; }
      const next = x.map((v, k) => v + step[k]);
      const c = cost(next);
      if (c <= now) {
        const gain = now - c;
        x = next; now = c; mu = Math.max(mu / 3, 1e-9); accepted = true;
        if (gain < 1e-10 * (1 + now)) return toPoints(x);
      } else mu *= 10;
    }
    if (!accepted) break;
  }
  return toPoints(x);
}

const toPoints = (x: number[]): Vec2[] => Array.from({ length: x.length / 2 }, (_, k) => [x[k * 2], x[k * 2 + 1]] as Vec2);

/**
 * Moves the corners of a scanned surface so every tape measurement between two corners is met.
 * The corners become hand-placed (as if dragged). Throws with a plain message when there is nothing to fit.
 */
export function fitToTape(s: Surface): TapeFit {
  const corners = s.outline.corners, n = corners.length;
  const checks = s.checks ?? [];
  const tape: Pair[] = [];
  const ends = new Map<string, [number, number]>();
  for (const c of checks) {
    const i = cornerIndex(corners, snapToCorner(s, c.a)), j = cornerIndex(corners, snapToCorner(s, c.b));
    if (c.measured === null || !(c.measured > 0) || i < 0 || j < 0 || i === j) continue;
    tape.push({ i, j, length: c.measured, sigma: TAPE });
    ends.set(c.id, [i, j]);
  }
  if (!tape.length) throw new Error('Enter at least one tape measurement between two corners first.');
  if (s.sketchId) throw new Error('This surface is drawn by hand: set the measurements as dimensions in the drawing instead.');
  const measured = new Set(tape.map((p) => `${Math.min(p.i, p.j)}-${Math.max(p.i, p.j)}`));
  const keep: Pair[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!measured.has(`${i}-${j}`)) keep.push({ i, j, length: Math.hypot(corners[j][0] - corners[i][0], corners[j][1] - corners[i][1]), sigma: SCAN });
  }
  const fitted = solveDistances(corners, [...tape, ...keep]);
  const moved = Math.max(...fitted.map((p, k) => Math.hypot(p[0] - corners[k][0], p[1] - corners[k][1])));
  const worst = Math.max(...tape.map((p) => Math.abs(Math.hypot(fitted[p.j][0] - fitted[p.i][0], fitted[p.j][1] - fitted[p.i][1]) - p.length)));
  const anchors = s.outline.anchors.map((a, k) => ({ ...a, manual: fitted[k] }));
  const next = withAnchors(s, anchors);
  // the measurements stay on their corners
  const out = next.outline.corners;
  const checksAfter = checks.map((c) => { const e = ends.get(c.id); return e ? { ...c, a: out[e[0]], b: out[e[1]] } : c; });
  return { surface: { ...next, checks: checksAfter }, used: tape.length, skipped: checks.length - tape.length, moved, worst };
}
