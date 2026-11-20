import { describe, expect, it } from 'vitest';
import { fitToTape } from '../src/core/tapeFit';
import { checkLength, type Surface } from '../src/core/surface';

/** A surface with straight sides between the given corners (no scan noise). */
function surface(corners: [number, number][], checks: { a: number; b: number; measured: number | null }[]): Surface {
  const edge: number[] = [], anchors = [];
  for (let k = 0; k < corners.length; k++) {
    const [x0, y0] = corners[k], [x1, y1] = corners[(k + 1) % corners.length];
    anchors.push({ at: edge.length / 2 });
    for (let t = 0; t < 20; t++) edge.push(x0 + ((x1 - x0) * t) / 20, y0 + ((y1 - y0) * t) / 20);
  }
  return {
    id: 's', name: 'S', scanId: 'x', createdAt: '',
    plane: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    raw: { outer: edge, holes: [] },
    outline: { options: { tolerance: 3 }, edge, anchors, corners, sides: [] },
    checks: checks.map((c, i) => ({ id: `m${i}`, a: corners[c.a], b: corners[c.b], measured: c.measured })),
  } as unknown as Surface;
}

describe('fitting the drawing to the tape', () => {
  const rect: [number, number][] = [[0, 0], [1000, 0], [1000, 500], [0, 500]];

  it('makes every measurement come out as the tape showed', () => {
    const s = surface(rect, [{ a: 0, b: 1, measured: 1010 }, { a: 0, b: 2, measured: 1125 }]);
    const r = fitToTape(s);
    for (const c of r.surface.checks!) expect(checkLength(r.surface, c)).toBeCloseTo(c.measured!, 0);
    expect(r.used).toBe(2);
    expect(r.worst).toBeLessThan(0.5);
    // what was not measured stays close to the scan
    const [, , c2, c3] = r.surface.outline.corners;
    expect(Math.hypot(c2[0] - c3[0], c2[1] - c3[1])).toBeCloseTo(1000, -1);
  });

  it('leaves the drawing alone when the tape agrees', () => {
    const r = fitToTape(surface(rect, [{ a: 0, b: 1, measured: 1000 }]));
    expect(r.moved).toBeLessThan(0.01);
  });

  it('says so when the measurements cannot all be true', () => {
    // two diagonals of a rectangle that differ by 100 mm
    const r = fitToTape(surface(rect, [{ a: 0, b: 2, measured: 1100 }, { a: 1, b: 3, measured: 1200 }, { a: 0, b: 1, measured: 1000 }, { a: 1, b: 2, measured: 500 }, { a: 2, b: 3, measured: 1000 }, { a: 3, b: 0, measured: 500 }]));
    expect(r.worst).toBeGreaterThan(5);
  });

  it('needs a tape value between two corners', () => {
    expect(() => fitToTape(surface(rect, [{ a: 0, b: 1, measured: null }]))).toThrow(/at least one/);
  });
});
