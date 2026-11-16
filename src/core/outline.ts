/**
 * Turns a flat area of the scan into a 2D drawing: the area seen straight on,
 * as if looking down at it. Coordinates are millimetres in the plane's own
 * axes (u to the right, v up).
 */
import type { MeshData } from './obj';
import type { Plane, Segmentation } from './segment';
import { polygonArea, simplifyOpen } from './poly';

export interface RawOutline {
  /** outer edge, counter-clockwise, x0,y0,x1,y1… (not repeated at the end) */
  outer: number[];
  /** gaps inside the area: scanner markers, unread spots, real openings */
  holes: { points: number[]; area: number }[];
}

export function projectToPlane(plane: Plane, x: number, y: number, z: number): [number, number] {
  const dx = x - plane.origin[0], dy = y - plane.origin[1], dz = z - plane.origin[2];
  return [dx * plane.u[0] + dy * plane.u[1] + dz * plane.u[2], dx * plane.v[0] + dy * plane.v[1] + dz * plane.v[2]];
}

export function extractOutline(mesh: MeshData, seg: Segmentation, regionId: number): RawOutline {
  const p = mesh.positions, ix = mesh.indices;
  const { labels, adjacency } = seg;
  const plane = seg.regions[regionId].plane;
  const nF = ix.length / 3;

  // Edge of the area: triangle edges whose other side is not part of it.
  // Each is kept as "from → to" in the triangle's own direction, which puts the area on the left.
  const from: number[] = [], to: number[] = [];
  for (let f = 0; f < nF; f++) {
    if (labels[f] !== regionId) continue;
    for (let k = 0; k < 3; k++) {
      const g = adjacency[f * 3 + k];
      if (g >= 0 && labels[g] === regionId) continue;
      from.push(ix[f * 3 + k]); to.push(ix[f * 3 + ((k + 1) % 3)]);
    }
  }

  const xy = new Map<number, [number, number]>();
  const point = (v: number) => {
    let q = xy.get(v);
    if (!q) { q = projectToPlane(plane, p[v * 3], p[v * 3 + 1], p[v * 3 + 2]); xy.set(v, q); }
    return q;
  };

  const outgoing = new Map<number, number[]>();
  for (let e = 0; e < from.length; e++) {
    const list = outgoing.get(from[e]);
    if (list) list.push(e); else outgoing.set(from[e], [e]);
  }
  const used = new Uint8Array(from.length);
  const loops: number[][] = [];
  for (let start = 0; start < from.length; start++) {
    if (used[start]) continue;
    const loop: number[] = [];
    let e = start;
    for (let guard = 0; guard <= from.length; guard++) {
      used[e] = 1;
      const a = point(from[e]);
      loop.push(a[0], a[1]);
      const candidates = (outgoing.get(to[e]) ?? []).filter((c) => !used[c]);
      if (candidates.length === 0) break;
      if (candidates.length === 1) { e = candidates[0]; continue; }
      // Several ways on (two parts of the area touch at one point): take the first
      // edge clockwise from the way we came, which stays with the same part.
      const b = point(to[e]);
      const back = Math.atan2(a[1] - b[1], a[0] - b[0]);
      let best = candidates[0], bestTurn = Infinity;
      for (const c of candidates) {
        const d = point(to[c]);
        let turn = back - Math.atan2(d[1] - b[1], d[0] - b[0]);
        while (turn <= 0) turn += 2 * Math.PI;
        if (turn < bestTurn) { bestTurn = turn; best = c; }
      }
      e = best;
    }
    if (loop.length >= 6) loops.push(loop);
  }
  if (loops.length === 0) throw new Error('This area has no usable edge.');

  let outer = loops[0], outerArea = polygonArea(loops[0]);
  for (const l of loops) { const a = polygonArea(l); if (a > outerArea) { outer = l; outerArea = a; } }
  const tidy = (l: number[]) => simplifyClosed(l, 0.2).map((v) => Math.round(v * 100) / 100);
  const holes = loops
    .filter((l) => l !== outer && polygonArea(l) < 0)
    .map((l) => ({ points: tidy(l), area: -polygonArea(l) }))
    .filter((h) => h.area >= 20 && h.points.length >= 6)
    .sort((a, b) => b.area - a.area);
  return { outer: tidy(outer), holes };
}

/** Drops points that do not change the shape by more than `tolerance` mm. */
export function simplifyClosed(loop: number[], tolerance: number): number[] {
  const n = loop.length / 2;
  if (n < 5) return loop.slice();
  // split at the two points farthest apart so each half can be simplified as an open line
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (loop[i * 2] - loop[0]) ** 2 + (loop[i * 2 + 1] - loop[1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const first = simplifyOpen(loop.slice(0, far * 2 + 2), tolerance);
  const second = simplifyOpen([...loop.slice(far * 2), loop[0], loop[1]], tolerance);
  return [...first.slice(0, -2), ...second.slice(0, -2)];
}
