import { describe, expect, it } from 'vitest';
import { cutOutline, cutSideLength, setCutSideLength, type Panel } from '../src/core/panel';

const panel = (c: [number, number][], offset = 15): Panel => ({
  id: 'p', name: 'P', surfaceId: 's', createdAt: '',
  shape: { corners: c, curves: c.map(() => null) }, offsets: c.map(() => offset), radii: c.map(() => 20),
} as unknown as Panel);

describe('typing the length of a panel side', () => {
  const rect = panel([[0, 0], [400, 0], [400, 300], [0, 300]]);

  it('reads the length of the finished panel, to where the straight sides meet', () => {
    expect(cutSideLength(rect, 0)).toBeCloseTo(370, 6);
    expect(cutSideLength(rect, 1)).toBeCloseTo(270, 6);
  });

  it('moves the side after it parallel, keeping every angle', () => {
    const p = setCutSideLength(rect, 0, 400);
    expect(cutSideLength(p, 0)).toBeCloseTo(400, 6);
    expect(cutSideLength(p, 1)).toBeCloseTo(270, 6); // the moved side keeps its length
    expect(cutSideLength(p, 2)).toBeCloseTo(400, 6); // the opposite side follows
    expect(p.shape.corners[0]).toEqual([0, 0]);
    expect(p.shape.corners[3]).toEqual([0, 300]);
  });

  it('can move the side before it instead', () => {
    const p = setCutSideLength(rect, 0, 350, 'before');
    expect(cutSideLength(p, 0)).toBeCloseTo(350, 6);
    expect(p.shape.corners[1]).toEqual([400, 0]);
    expect(p.shape.corners[0][0]).toBeCloseTo(20, 6);
  });

  it('works on slanted sides too', () => {
    const q = panel([[0, 0], [500, 40], [460, 330], [30, 300]]);
    const p = setCutSideLength(q, 1, 320);
    expect(cutSideLength(p, 1)).toBeCloseTo(320, 6);
    expect(cutOutline(p).warnings.filter((w) => /crosses|too large/.test(w))).toEqual([]);
  });

  it('refuses a length that turns the panel inside out', () => {
    expect(() => setCutSideLength(rect, 0, 1, 'after')).not.toThrow();
    expect(() => setCutSideLength(rect, 0, -5)).toThrow(/above 0/);
  });
});
