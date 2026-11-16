/**
 * Works out which way is "up" in a scan.
 *
 * A scanner's own axes are arbitrary (they depend on how it was held when the
 * scan started), so they cannot be trusted. But a scan only contains the side
 * of the boat the scanner could see, and every triangle faces the scanner.
 * So the average facing direction of the whole scan points back towards the
 * person scanning: for a deck, that is up.
 */
import type { MeshData } from './obj';
import type { Region } from './segment';
import { cross, dot, eigenSymmetric3, normalize, type Vec3 } from './vec';

export interface Orientation {
  up: Vec3;
  /** horizontal, along the longest dimension of the scan */
  right: Vec3;
  /** horizontal, across; right × forward = up */
  forward: Vec3;
}

export function computeOrientation(mesh: MeshData, regions: Region[]): Orientation {
  const p = mesh.positions, ix = mesh.indices;
  let sx = 0, sy = 0, sz = 0, area = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    sx += nx; sy += ny; sz += nz; area += Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  let up: Vec3;
  if (Math.hypot(sx, sy, sz) > 0.15 * area) up = normalize([sx, sy, sz]);
  else if (regions.length) up = regions[0].plane.normal; // scanned from all sides: go by the largest flat area
  else up = [0, 0, 1];
  // If a large flat area faces roughly that way, use it exactly, so "Top" looks straight down at the deck
  // (walls scanned on one side tilt the average).
  const level = regions.find((r) => dot(r.plane.normal, up) > 0.75 && r.area > 0.25 * (regions[0]?.area ?? 0));
  if (level) up = level.plane.normal;

  // longest horizontal direction of the scan
  const n = p.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  const cov = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - cx, y = p[i + 1] - cy, z = p[i + 2] - cz;
    cov[0] += x * x; cov[1] += x * y; cov[2] += x * z; cov[3] += y * y; cov[4] += y * z; cov[5] += z * z;
  }
  const { values, vectors } = eigenSymmetric3(cov);
  let right: Vec3 = [1, 0, 0], best = -1;
  vectors.forEach((e, i) => {
    const k = dot(e, up);
    const h: Vec3 = [e[0] - k * up[0], e[1] - k * up[1], e[2] - k * up[2]];
    const score = values[i] * dot(h, h);
    if (score > best) { best = score; right = normalize(h); }
  });
  return { up, right, forward: cross(up, right) };
}
