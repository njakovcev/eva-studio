import { describe, expect, it } from 'vitest';
import type { MeshData } from '../src/core/obj';
import { segmentFlatRegions } from '../src/core/segment';
import { extractOutline } from '../src/core/outline';
import { autoClean, bridgeGaps, nearestEdgeIndex, resolveCorners } from '../src/core/cleanOutline';
import { polygonArea } from '../src/core/poly';
import { createSurface, surfaceToDxf, withAnchors } from '../src/core/surface';
import { eigenSymmetric3 } from '../src/core/vec';

/** A 1000 × 600 floor with a 300 high wall along one long side, in 20 mm squares, with small noise. */
function floorAndWall(noise = 0.2): MeshData {
  const pos: number[] = [], idx: number[] = [];
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2 * noise; };
  const grid = (nx: number, ny: number, at: (i: number, j: number) => [number, number, number]) => {
    const base = pos.length / 3;
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) pos.push(...at(i, j));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = base + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  };
  grid(50, 30, (i, j) => [i * 20, j * 20, rnd()]);
  grid(50, 15, (i, j) => [i * 20, 600 + rnd(), j * 20]); // separate sheet standing on the far edge
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

describe('flat area detection', () => {
  const mesh = floorAndWall();
  const seg = segmentFlatRegions(mesh);

  it('finds the floor and the wall as two areas, largest first', () => {
    expect(seg.regions.length).toBe(2);
    expect(seg.regions[0].area / 1e6).toBeCloseTo(0.6, 2);
    expect(seg.regions[1].area / 1e6).toBeCloseTo(0.3, 2);
    expect(Math.abs(seg.regions[0].plane.normal[2])).toBeGreaterThan(0.999);
    expect(seg.regions[0].flatness.max).toBeLessThan(0.5);
  });

  it('draws the floor outline at true size', () => {
    const raw = extractOutline(mesh, seg, 0);
    expect(polygonArea(raw.outer) / 1e6).toBeCloseTo(0.6, 3);
    const clean = autoClean(raw.outer);
    expect(clean.corners.length).toBe(4);
    const lengths = clean.sides.map((s) => Math.round(s.length)).sort((a, b) => a - b);
    expect(lengths).toEqual([600, 600, 1000, 1000]);
  });
});

describe('edge cleaning', () => {
  // 800 × 500 rectangle, counter-clockwise, a point every 5 mm, with a 20 mm wide, 120 mm deep scan gap in the bottom side
  const rect: number[] = [];
  for (let x = 0; x < 800; x += 5) {
    if (x > 400 && x < 420) continue;
    rect.push(x, 0);
    if (x === 400) rect.push(400, 120, 420, 120, 420, 0);
  }
  for (let y = 0; y < 500; y += 5) rect.push(800, y);
  for (let x = 800; x > 0; x -= 5) rect.push(x, 500);
  for (let y = 500; y > 0; y -= 5) rect.push(0, y);

  it('bridges a narrow scan gap but keeps the shape', () => {
    expect(polygonArea(rect)).toBeCloseTo(800 * 500 - 20 * 120, 0);
    const bridged = bridgeGaps(rect, 40);
    expect(polygonArea(bridged)).toBeCloseTo(800 * 500, 0);
    expect(polygonArea(bridgeGaps(rect, 0))).toBeCloseTo(800 * 500 - 20 * 120, 0);
  });

  it('never cuts off a real protrusion', () => {
    const tab = [0, 0, 300, 0, 300, 100, 320, 100, 320, 0, 600, 0, 600, 300, 0, 300]; // inlet…
    const flipped = [0, 0, 300, 0, 300, -100, 320, -100, 320, 0, 600, 0, 600, 300, 0, 300]; // …and a tab sticking out
    expect(polygonArea(bridgeGaps(tab, 40))).toBeGreaterThan(polygonArea(tab));
    expect(polygonArea(bridgeGaps(flipped, 40))).toBeCloseTo(polygonArea(flipped), 6);
  });

  it('finds four square corners and lets the user edit them', () => {
    const clean = autoClean(rect);
    expect(clean.corners.length).toBe(4);
    for (const c of clean.corners) {
      expect(Math.min(Math.abs(c[0]), Math.abs(c[0] - 800))).toBeLessThan(0.5);
      expect(Math.min(Math.abs(c[1]), Math.abs(c[1] - 500))).toBeLessThan(0.5);
    }
    // add a manual corner in the middle of the top side, pulled outwards
    const at = nearestEdgeIndex(clean.edge, 400, 500);
    const anchors = [...clean.anchors, { at, manual: [400, 560] as [number, number] }].sort((a, b) => a.at - b.at);
    const edited = resolveCorners(clean.edge, anchors, 20);
    expect(edited.corners.length).toBe(5);
    expect(edited.corners.some((c) => c[0] === 400 && c[1] === 560)).toBe(true);
    expect(polygonArea(edited.corners.flat())).toBeCloseTo(800 * 500 + (800 * 60) / 2, -2);
  });
});

describe('surface and DXF', () => {
  const mesh = floorAndWall();
  const seg = segmentFlatRegions(mesh);
  const surface = createSurface({ id: 's1', name: 'Floor', scanId: 'x', region: seg.regions[0], raw: extractOutline(mesh, seg, 0) });

  it('survives saving to JSON', () => {
    const back = JSON.parse(JSON.stringify(surface));
    expect(back.outline.corners).toEqual(surface.outline.corners);
  });

  it('deleting a corner leaves a triangle', () => {
    const three = withAnchors(surface, surface.outline.anchors.slice(1));
    expect(three.outline.corners.length).toBe(3);
  });

  it('writes a DXF that starts at 0,0 in millimetres', () => {
    const dxf = surfaceToDxf(surface);
    expect(dxf).toContain('$INSUNITS');
    expect(dxf).toContain('SURFACE');
    expect(dxf.trim().endsWith('EOF')).toBe(true);
    const xs = [...dxf.matchAll(/\r\n 10\r\n|\r\n10\r\n([-\d.]+)/g)].map((m) => Number(m[1])).filter((v) => !Number.isNaN(v));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-5);
  });
});

describe('eigenSymmetric3', () => {
  it('orders axes by spread', () => {
    const { values, vectors } = eigenSymmetric3([4, 0, 0, 9, 0, 1]);
    expect(values).toEqual([9, 4, 1]);
    expect(Math.abs(vectors[0][1])).toBeCloseTo(1);
    expect(Math.abs(vectors[2][2])).toBeCloseTo(1);
  });
});
