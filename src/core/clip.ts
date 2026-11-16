/**
 * Cuts lines to the inside of a shape.
 *
 * `rings` are closed polygons (x0,y0,x1,y1…). A point counts as inside when it is
 * inside an odd number of them, so an outline plus the openings inside it gives
 * "inside the outline but not in an opening".
 */
export function isInside(x: number, y: number, rings: ArrayLike<number>[]): boolean {
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[i * 2], yi = r[i * 2 + 1], xj = r[j * 2], yj = r[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

interface Edge { ax: number; ay: number; bx: number; by: number; minX: number; maxX: number; minY: number; maxY: number }

/** Keeps the parts of each line that lie inside. Lines are open polylines (x0,y0,x1,y1…). */
export function clipLines(lines: number[][], rings: ArrayLike<number>[]): number[][] {
  const edges: Edge[] = [];
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = r[i * 2], ay = r[i * 2 + 1], bx = r[j * 2], by = r[j * 2 + 1];
      edges.push({ ax, ay, bx, by, minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minY: Math.min(ay, by), maxY: Math.max(ay, by) });
    }
  }
  const out: number[][] = [];
  for (const line of lines) {
    let current: number[] | null = null;
    const end = () => { if (current && current.length >= 4) out.push(current); current = null; };
    for (let k = 0; k + 3 < line.length; k += 2) {
      const px = line[k], py = line[k + 1], qx = line[k + 2], qy = line[k + 3];
      const dx = qx - px, dy = qy - py;
      const minX = Math.min(px, qx), maxX = Math.max(px, qx), minY = Math.min(py, qy), maxY = Math.max(py, qy);
      // where this piece crosses the shape's edges
      const cuts: number[] = [0, 1];
      for (const e of edges) {
        if (e.maxX < minX || e.minX > maxX || e.maxY < minY || e.minY > maxY) continue;
        const ex = e.bx - e.ax, ey = e.by - e.ay, den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((e.ax - px) * ey - (e.ay - py) * ex) / den, u = ((e.ax - px) * dy - (e.ay - py) * dx) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) cuts.push(t);
      }
      cuts.sort((a, b) => a - b);
      for (let c = 0; c + 1 < cuts.length; c++) {
        const t0 = cuts[c], t1 = cuts[c + 1];
        if (t1 - t0 < 1e-9) continue;
        const tm = (t0 + t1) / 2;
        if (!isInside(px + dx * tm, py + dy * tm, rings)) { end(); continue; }
        const x0 = px + dx * t0, y0 = py + dy * t0, x1 = px + dx * t1, y1 = py + dy * t1;
        if (current && Math.hypot(current[current.length - 2] - x0, current[current.length - 1] - y0) < 1e-6) current.push(x1, y1);
        else { end(); current = [x0, y0, x1, y1]; }
        if (t1 < 1 - 1e-9) end(); // the line leaves the shape here
      }
    }
    end();
  }
  return out;
}

export function linesLength(lines: number[][]): number {
  let s = 0;
  for (const l of lines) for (let k = 0; k + 3 < l.length; k += 2) s += Math.hypot(l[k + 2] - l[k], l[k + 3] - l[k + 1]);
  return s;
}
