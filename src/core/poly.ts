/** Small 2D polygon helpers. Polygons are flat arrays: x0,y0,x1,y1… */

/** Signed area: positive when counter-clockwise. */
export function polygonArea(pts: ArrayLike<number>): number {
  const n = pts.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return s / 2;
}

export function polygonPerimeter(pts: ArrayLike<number>): number {
  const n = pts.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
  }
  return s;
}

export function bounds(pts: ArrayLike<number>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i]; if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1]; if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  return { minX, minY, maxX, maxY };
}

/** Distance from point (px,py) to the segment a–b. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Indices of the points kept by Douglas–Peucker on an open line (ends always kept). */
export function simplifyOpenIndices(pts: ArrayLike<number>, tolerance: number): number[] {
  const n = pts.length / 2;
  if (n <= 2) return n === 2 ? [0, 1] : [0];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i * 2], pts[i * 2 + 1], pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export function simplifyOpen(pts: ArrayLike<number>, tolerance: number): number[] {
  const out: number[] = [];
  for (const i of simplifyOpenIndices(pts, tolerance)) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/**
 * Where two sides meet when the first is extended past its end (a0 → a1 → …) and the
 * second backwards past its start (… → b0 → b1). Used to remove what lies between them.
 * Throws a plain-language error when they cannot meet that way.
 */
export function extendToMeet(a0: [number, number], a1: [number, number], b0: [number, number], b1: [number, number]): [number, number] {
  const rx = a1[0] - a0[0], ry = a1[1] - a0[1], sx = b1[0] - b0[0], sy = b1[1] - b0[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-6 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) throw new Error('The two neighbouring sides are parallel, so they never meet. Remove a corner instead.');
  const t = ((b0[0] - a0[0]) * sy - (b0[1] - a0[1]) * sx) / den; // along the first side: 0 at a0, 1 at a1
  const u = ((b0[0] - a0[0]) * ry - (b0[1] - a0[1]) * rx) / den; // along the second: 0 at b0, 1 at b1
  if (t <= 0 || u >= 1) throw new Error('The two neighbouring sides point away from each other, so extending them does not close the shape. Remove a corner instead.');
  return [a0[0] + rx * t, a0[1] + ry * t];
}

/** For a constrained drag: the point nearest to `target` on either line through `corner` and one of its neighbours. */
export function slideAlongSides(corner: [number, number], prev: [number, number], next: [number, number], target: [number, number]): [number, number] {
  const onLine = (o: [number, number]): [number, number] => {
    const dx = o[0] - corner[0], dy = o[1] - corner[1], l2 = dx * dx + dy * dy;
    if (l2 === 0) return corner;
    const t = ((target[0] - corner[0]) * dx + (target[1] - corner[1]) * dy) / l2;
    return [corner[0] + dx * t, corner[1] + dy * t];
  };
  const a = onLine(prev), b = onLine(next);
  return Math.hypot(a[0] - target[0], a[1] - target[1]) <= Math.hypot(b[0] - target[0], b[1] - target[1]) ? a : b;
}
