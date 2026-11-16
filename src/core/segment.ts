/**
 * Finds the flat areas of a scan.
 *
 * Method: every triangle has a direction it faces (its normal). Starting from
 * the smoothest triangles, an area grows across neighbours as long as each new
 * triangle faces the same way as the area so far (within `maxAngleDeg`).
 * A rounded edge or a wall turns away too far and stops the growth, so each
 * flat face of the boat becomes its own area.
 */
import type { MeshData } from './obj';
import { cross, dot, eigenSymmetric3, normalize, type Vec3 } from './vec';

export interface Plane {
  /** a point on the plane (area-weighted centre of the region), mm */
  origin: Vec3;
  /** unit normal, pointing out of the surface (towards the scanner) */
  normal: Vec3;
  /** in-plane axes; u × v = normal. u runs along the longest direction. */
  u: Vec3;
  v: Vec3;
}

export interface Region {
  id: number;
  triangles: number;
  /** mm² */
  area: number;
  plane: Plane;
  /** how far the area strays from a perfect plane, mm */
  flatness: { rms: number; max: number };
}

export interface Segmentation {
  /** region id per triangle, or -1 */
  labels: Int32Array;
  /** neighbouring triangle across each triangle edge (3 per triangle), or -1 */
  adjacency: Int32Array;
  /** largest first */
  regions: Region[];
}

export interface SegmentOptions {
  maxAngleDeg?: number;
  /** areas smaller than this are ignored, mm² */
  minArea?: number;
}

/** For each triangle edge, the triangle on the other side (or -1). */
export function buildAdjacency(mesh: MeshData): Int32Array {
  const ix = mesh.indices;
  const nH = ix.length;
  const nV = mesh.positions.length / 3;
  const adjacency = new Int32Array(nH).fill(-1);
  const head = new Int32Array(nV).fill(-1);
  const next = new Int32Array(nH).fill(-1);
  for (let h = 0; h < nH; h++) {
    const f = (h / 3) | 0, k = h - f * 3;
    const a = ix[h], b = ix[f * 3 + ((k + 1) % 3)];
    const lo = a < b ? a : b, hi = a < b ? b : a;
    let prev = -1, g = head[lo], found = false;
    while (g !== -1) {
      const gf = (g / 3) | 0, gk = g - gf * 3;
      const ga = ix[g], gb = ix[gf * 3 + ((gk + 1) % 3)];
      if ((ga < gb ? gb : ga) === hi) {
        adjacency[h] = gf; adjacency[g] = f;
        if (prev === -1) head[lo] = next[g]; else next[prev] = next[g]; // matched: take it out of the list
        found = true;
        break;
      }
      prev = g; g = next[g];
    }
    if (!found) { next[h] = head[lo]; head[lo] = h; }
  }
  return adjacency;
}

export function segmentFlatRegions(mesh: MeshData, options: SegmentOptions = {}): Segmentation {
  const maxAngleDeg = options.maxAngleDeg ?? 10;
  const minArea = options.minArea ?? 5000;
  const cosMax = Math.cos((maxAngleDeg * Math.PI) / 180);
  const p = mesh.positions, ix = mesh.indices;
  const nF = ix.length / 3;

  // facing direction and size of every triangle
  const normals = new Float32Array(nF * 3);
  const areas = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const a = ix[f * 3] * 3, b = ix[f * 3 + 1] * 3, c = ix[f * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    areas[f] = len / 2;
    if (len > 1e-12) { normals[f * 3] = nx / len; normals[f * 3 + 1] = ny / len; normals[f * 3 + 2] = nz / len; }
  }

  const adjacency = buildAdjacency(mesh);

  // Seed order: smoothest triangles first (those that agree best with their neighbours).
  const BINS = 256;
  const bin = new Uint8Array(nF);
  const counts = new Int32Array(BINS + 1);
  for (let f = 0; f < nF; f++) {
    let worst = 1;
    for (let k = 0; k < 3; k++) {
      const g = adjacency[f * 3 + k];
      if (g < 0) continue;
      const d = normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2];
      if (d < worst) worst = d;
    }
    // bin 0 = perfectly smooth; scale so that the first bins cover small angles finely
    const b = Math.min(BINS - 1, Math.max(0, Math.floor((1 - worst) * 2000)));
    bin[f] = b; counts[b + 1]++;
  }
  for (let b = 0; b < BINS; b++) counts[b + 1] += counts[b];
  const order = new Int32Array(nF);
  const cursor = counts.slice(0, BINS);
  for (let f = 0; f < nF; f++) order[cursor[bin[f]]++] = f;

  const labels = new Int32Array(nF).fill(-1);
  const stack = new Int32Array(nF);
  const grown: { area: number; count: number }[] = [];
  for (let s = 0; s < nF; s++) {
    const seed = order[s];
    if (labels[seed] !== -1 || areas[seed] <= 1e-9) continue;
    const id = grown.length;
    let sx = normals[seed * 3] * areas[seed], sy = normals[seed * 3 + 1] * areas[seed], sz = normals[seed * 3 + 2] * areas[seed];
    let area = areas[seed], count = 1, top = 0;
    labels[seed] = id; stack[top++] = seed;
    while (top > 0) {
      const f = stack[--top];
      const inv = 1 / Math.sqrt(sx * sx + sy * sy + sz * sz);
      for (let k = 0; k < 3; k++) {
        const g = adjacency[f * 3 + k];
        if (g < 0 || labels[g] !== -1) continue;
        const a = areas[g];
        if (a > 1e-9) {
          const d = (normals[g * 3] * sx + normals[g * 3 + 1] * sy + normals[g * 3 + 2] * sz) * inv;
          if (d < cosMax) continue;
          sx += normals[g * 3] * a; sy += normals[g * 3 + 1] * a; sz += normals[g * 3 + 2] * a;
        }
        labels[g] = id; area += a; count++; stack[top++] = g;
      }
    }
    grown.push({ area, count });
  }

  // keep the big ones, largest first, and renumber
  const keep = grown.map((g, id) => ({ id, ...g })).filter((g) => g.area >= minArea).sort((a, b) => b.area - a.area);
  const remap = new Int32Array(grown.length).fill(-1);
  keep.forEach((g, i) => { remap[g.id] = i; });
  for (let f = 0; f < nF; f++) labels[f] = remap[labels[f]];

  const regions = fitPlanes(mesh, labels, normals, areas, keep.length);
  return { labels, adjacency, regions };
}

function fitPlanes(mesh: MeshData, labels: Int32Array, normals: Float32Array, areas: Float32Array, count: number): Region[] {
  const p = mesh.positions, ix = mesh.indices;
  const nF = ix.length / 3;
  const acc = Array.from({ length: count }, () => ({
    area: 0, tris: 0, c: [0, 0, 0] as Vec3, n: [0, 0, 0] as Vec3, cov: [0, 0, 0, 0, 0, 0],
  }));
  const centroid = (f: number, out: Vec3) => {
    const a = ix[f * 3] * 3, b = ix[f * 3 + 1] * 3, c = ix[f * 3 + 2] * 3;
    out[0] = (p[a] + p[b] + p[c]) / 3; out[1] = (p[a + 1] + p[b + 1] + p[c + 1]) / 3; out[2] = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
  };
  const t: Vec3 = [0, 0, 0];
  for (let f = 0; f < nF; f++) {
    const r = labels[f]; if (r < 0) continue;
    const a = areas[f], A = acc[r];
    centroid(f, t);
    A.area += a; A.tris++;
    A.c[0] += t[0] * a; A.c[1] += t[1] * a; A.c[2] += t[2] * a;
    A.n[0] += normals[f * 3] * a; A.n[1] += normals[f * 3 + 1] * a; A.n[2] += normals[f * 3 + 2] * a;
  }
  for (const A of acc) { A.c[0] /= A.area; A.c[1] /= A.area; A.c[2] /= A.area; }
  for (let f = 0; f < nF; f++) {
    const r = labels[f]; if (r < 0) continue;
    const a = areas[f], A = acc[r];
    centroid(f, t);
    const x = t[0] - A.c[0], y = t[1] - A.c[1], z = t[2] - A.c[2];
    A.cov[0] += a * x * x; A.cov[1] += a * x * y; A.cov[2] += a * x * z;
    A.cov[3] += a * y * y; A.cov[4] += a * y * z; A.cov[5] += a * z * z;
  }
  const planes: Plane[] = acc.map((A) => {
    const { vectors } = eigenSymmetric3(A.cov); // sorted: largest spread first
    let normal = normalize(vectors[2]);
    if (dot(normal, A.n) < 0) normal = [-normal[0], -normal[1], -normal[2]];
    // u along the longest direction, made exactly perpendicular to the normal
    let u = vectors[0];
    const k = dot(u, normal);
    u = normalize([u[0] - k * normal[0], u[1] - k * normal[1], u[2] - k * normal[2]]);
    const v = cross(normal, u);
    return { origin: [A.c[0], A.c[1], A.c[2]], normal, u, v };
  });

  // flatness: distance of triangle centres from the plane
  const lists = acc.map((A) => new Float32Array(A.tris));
  const fill = new Int32Array(count);
  const sumSq = new Float64Array(count);
  for (let f = 0; f < nF; f++) {
    const r = labels[f]; if (r < 0) continue;
    centroid(f, t);
    const pl = planes[r];
    const d = (t[0] - pl.origin[0]) * pl.normal[0] + (t[1] - pl.origin[1]) * pl.normal[1] + (t[2] - pl.origin[2]) * pl.normal[2];
    lists[r][fill[r]++] = Math.abs(d);
    sumSq[r] += d * d * areas[f];
  }
  return acc.map((A, id) => {
    const sorted = lists[id].sort();
    // 99th percentile: a few stray triangles should not decide the verdict
    const max = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0;
    return { id, triangles: A.tris, area: A.area, plane: planes[id], flatness: { rms: Math.sqrt(sumSq[id] / A.area), max } };
  });
}
