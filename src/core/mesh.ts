import type { MeshData } from './obj';

export interface MeshStats {
  vertices: number;
  triangles: number;
  /** [minX, minY, minZ] */
  min: [number, number, number];
  /** [maxX, maxY, maxZ] */
  max: [number, number, number];
  /** total surface area, mm² */
  area: number;
}

export function computeStats(mesh: MeshData): MeshStats {
  const p = mesh.positions, ix = mesh.indices;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  let area = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  return { vertices: p.length / 3, triangles: ix.length / 3, min, max, area };
}
