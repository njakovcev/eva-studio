import { describe, expect, it } from 'vitest';
import type { MeshData } from '../src/core/obj';
import { segmentFlatRegions } from '../src/core/segment';
import { extractOutline } from '../src/core/outline';
import { autoClean, bridgeGaps, nearestEdgeIndex, outlinePolygon, resolveCorners } from '../src/core/cleanOutline';
import { polygonArea } from '../src/core/poly';
import { bowOf, checkLength, createSurface, guessBow, removeSideExtend, surfaceToDxf, withAnchors } from '../src/core/surface';
import type { Orientation } from '../src/core/orientation';
import type { Plane } from '../src/core/segment';
import { extendToMeet, slideAlongSides } from '../src/core/poly';
import { eigenSymmetric3 } from '../src/core/vec';
import { computeOrientation } from '../src/core/orientation';

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

describe('scan orientation', () => {
  it('finds up from the side the scanner saw, whatever the scan axes are', () => {
    const mesh = floorAndWall();
    const seg = segmentFlatRegions(mesh);
    const o = computeOrientation(mesh, seg.regions);
    expect(o.up[2]).toBeGreaterThan(0.99); // floor faces +Z
    expect(Math.abs(o.right[0])).toBeGreaterThan(0.99); // long side runs along X

    // the same scan turned upside down: up must follow
    const flipped = { positions: mesh.positions.map((v, i) => (i % 3 === 0 ? v : -v)), indices: mesh.indices };
    const o2 = computeOrientation(flipped, segmentFlatRegions(flipped).regions);
    expect(o2.up[2]).toBeLessThan(-0.99);
  });
});

describe('curved sides', () => {
  // 600 × 300 with the top side bulging out as a circular arc (80 mm high), a slightly noisy point every 4 mm
  const R = (300 * 300 + 80 * 80) / (2 * 80), cy = 300 + 80 - R;
  let seed = 7; const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.8; };
  const pts: number[] = [];
  for (let x = 0; x < 600; x += 4) pts.push(x, noise());
  for (let y = 0; y < 300; y += 4) pts.push(600 + noise(), y);
  const half = Math.asin(300 / R);
  for (let k = 0; k < 150; k++) { const a = Math.PI / 2 - half + (2 * half * k) / 150; pts.push(300 + (R + noise()) * Math.cos(a), cy + (R + noise()) * Math.sin(a)); }
  for (let y = 300; y > 0; y -= 4) pts.push(noise(), y);
  const theta = 2 * half, expected = 600 * 300 + (R * R / 2) * (theta - Math.sin(theta));

  const anchors = [[0, 0], [600, 0], [600, 300], [0, 300]].map(([x, y]) => ({ at: nearestEdgeIndex(pts, x, y) })).sort((a, b) => a.at - b.at);
  const top = anchors.findIndex((a) => Math.abs(pts[a.at * 2] - 600) < 5 && Math.abs(pts[a.at * 2 + 1] - 300) < 5);

  it('a straight side across an arc is far from the scan; a curved side follows it', () => {
    const straight = resolveCorners(pts, anchors, 20);
    expect(straight.sides[top].maxDeviation).toBeGreaterThan(40);
    const curved = resolveCorners(pts, anchors.map((a, i) => (i === top ? { ...a, curve: true } : a)), 20);
    expect(curved.sides[top].maxDeviation).toBeLessThan(1.5);
    expect(curved.curves[top]!.length).toBeGreaterThan(10);
    const area = Math.abs(polygonAreaOf(outlinePolygon(curved)));
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.005);
    expect(curved.sides[top].length).toBeCloseTo(R * theta, -1);
  });
});

function polygonAreaOf(p: number[]) { return polygonArea(p); }

describe('tape checks', () => {
  it('measures between corners and follows them when they move', () => {
    const mesh = floorAndWall();
    const seg = segmentFlatRegions(mesh);
    const s = createSurface({ id: 's', name: 'F', scanId: 'x', region: seg.regions[0], raw: extractOutline(mesh, seg, 0) });
    const [a, , c] = s.outline.corners;
    const check = { id: 'c', a, b: c, measured: 1166 };
    expect(checkLength(s, check)).toBeCloseTo(Math.hypot(1000, 600), 0);
  });
});

describe('alignment tools', () => {
  it('extends two sides until they meet', () => {
    expect(extendToMeet([0, 0], [800, 0], [1000, 100], [1000, 600])).toEqual([1000, 0]);
    expect(() => extendToMeet([0, 0], [800, 0], [0, 100], [800, 100])).toThrow(/parallel/);
  });

  it('slides a corner along one of its sides', () => {
    expect(slideAlongSides([1000, 0], [0, 0], [1000, 600], [1100, 37])).toEqual([1100, 0]); // nearer the bottom line
    expect(slideAlongSides([1000, 0], [0, 0], [1000, 600], [1012, 200])).toEqual([1000, 200]); // nearer the right line
  });

  it('removes the tip of a protrusion from a scanned outline and leaves the other sides where they were', () => {
    // 1000 × 600 scan outline, a point every 5 mm, with the bottom-right corner cut off (chamfer 200 × 100)
    const pts: number[] = [];
    for (let x = 0; x < 800; x += 5) pts.push(x, 0);
    for (let k = 0; k < 40; k++) pts.push(800 + k * 5, k * 2.5);
    for (let y = 100; y < 600; y += 5) pts.push(1000, y);
    for (let x = 1000; x > 0; x -= 5) pts.push(x, 600);
    for (let y = 600; y > 0; y -= 5) pts.push(0, y);
    const region = { id: 0, triangles: 0, area: 0, plane: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, flatness: { rms: 0, max: 0 } } as never;
    const s = createSurface({ id: 's', name: 'S', scanId: 'x', region, raw: { outer: pts, holes: [] } });
    expect(s.outline.corners.length).toBe(5);
    const chamfer = s.outline.sides.findIndex((x) => Math.abs(x.length - Math.hypot(200, 100)) < 2);
    const fixed = removeSideExtend(s, chamfer);
    expect(fixed.outline.corners.length).toBe(4);
    const key = (c: number[]) => c.map((v) => Math.round(v)).join(',');
    expect(fixed.outline.corners.map(key).sort()).toEqual(['0,0', '0,600', '1000,0', '1000,600'].sort());
  });
});

describe('where the bow is', () => {
  const orientation = { up: [0, 0, 1], right: [1, 0, 0], forward: [0, 1, 0] } as Orientation;
  it('on a deck follows the longest direction of the scan', () => {
    // deck whose own x axis runs across the boat (along forward): the bow is along its −y or +y
    const plane = { origin: [0, 0, 0], normal: [0, 0, 1], u: [0, 1, 0], v: [-1, 0, 0] } as Plane;
    expect([90, 270]).toContain(guessBow(plane, orientation));
  });
  it('on a wall runs horizontally along the wall', () => {
    // wall facing across the boat; its x axis points up the wall
    const plane = { origin: [0, 0, 0], normal: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] } as Plane;
    expect([90, 270]).toContain(guessBow(plane, orientation));
  });
  it('is 0 when not set', () => {
    expect(bowOf({})).toBe(0);
    expect(bowOf({ bow: 45 })).toBe(45);
  });
});
