import { describe, expect, it } from 'vitest';
import { addCorner, cutLength, cutOutline, moveCorner, panelToDxf, removeCorner, smallestBox, type Panel } from '../src/core/panel';
import { bounds, polygonArea } from '../src/core/poly';
import type { Vec2 } from '../src/core/vec';

const panel = (corners: Vec2[], offset: number | number[], radius: number | number[], curves?: (number[] | null)[]): Panel => ({
  id: 'p', name: 'P', surfaceId: 's', createdAt: '',
  shape: { corners, curves: curves ?? corners.map(() => null) },
  offsets: Array.isArray(offset) ? offset : corners.map(() => offset),
  radii: Array.isArray(radius) ? radius : corners.map(() => radius),
});
/** areas are compared loosely: arcs are measured as many short straight pieces, which is a hair smaller */
const near = (a: number, b: number, within = 15) => expect(Math.abs(a - b)).toBeLessThan(within);
const rect: Vec2[] = [[0, 0], [1000, 0], [1000, 600], [0, 600]];

describe('cut outline', () => {
  it('no offset, no radius: the shape itself', () => {
    const cut = cutOutline(panel(rect, 0, 0));
    expect(cut.points).toEqual([0, 0, 1000, 0, 1000, 600, 0, 600]);
    expect(cut.warnings).toEqual([]);
  });

  it('15 mm offset and 20 mm corners on a rectangle', () => {
    const cut = cutOutline(panel(rect, 15, 20));
    near(polygonArea(cut.flat), 970 * 570 - (4 - Math.PI) * 400);
    expect(cutLength(cut)).toBeCloseTo(2 * (970 + 570) - 8 * 20 + 2 * Math.PI * 20, 0);
    const b = bounds(cut.flat);
    expect([b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 10) / 10)).toEqual([15, 15, 985, 585]);
    expect(cut.bulges.filter((v) => v !== 0).length).toBe(4);
    for (const v of cut.bulges.filter((x) => x !== 0)) expect(v).toBeCloseTo(Math.tan(Math.PI / 8), 6); // quarter circles, counter-clockwise
  });

  it('a different offset on every side', () => {
    const b = bounds(cutOutline(panel(rect, [10, 20, 30, 40], 0)).flat); // bottom, right, top, left
    expect([b.minX, b.minY, b.maxX, b.maxY].map(Math.round)).toEqual([40, 10, 980, 570]);
  });

  it('a different radius on every corner, and sharp where it is 0', () => {
    const cut = cutOutline(panel(rect, 0, [0, 50, 0, 100]));
    expect(cut.bulges.filter((v) => v !== 0).length).toBe(2);
    near(polygonArea(cut.flat), 600000 - (1 - Math.PI / 4) * (2500 + 10000));
  });

  it('reduces a radius that does not fit and says so', () => {
    const cut = cutOutline(panel([[0, 0], [100, 0], [100, 60], [0, 60]], 0, 50));
    expect(Math.max(...cut.usedRadii)).toBeLessThanOrEqual(30.001);
    expect(cut.warnings.length).toBeGreaterThan(0);
    expect(polygonArea(cut.flat)).toBeGreaterThan(0);
  });

  it('rounds inside (concave) corners too, and keeps the 15 mm gap', () => {
    const L: Vec2[] = [[0, 0], [600, 0], [600, 300], [300, 300], [300, 600], [0, 600]];
    const cut = cutOutline(panel(L, 15, 20));
    expect(cut.bulges.filter((v) => v > 0).length).toBe(5);
    expect(cut.bulges.filter((v) => v < 0).length).toBe(1); // the inside corner turns the other way
    expect(polygonArea(cut.flat)).toBeGreaterThan(0);
  });

  it('matches the hand-made test panel from the first scan', () => {
    // corners of the straightened test surface (mm), counter-clockwise; reference: 0.4383 m², 2646 mm of cut
    const hex: Vec2[] = [[822.2, 135.1], [864.0, 746.2], [66.7, 746.2], [0, 510.6], [503.1, 0], [880.3, 84.9]];
    expect(polygonArea(hex.flat())).toBeGreaterThan(0);
    const cut = cutOutline(panel(hex, 15, 20));
    expect(polygonArea(cut.flat) / 1e6).toBeCloseTo(0.4383, 3);
    expect(Math.abs(cutLength(cut) - 2646)).toBeLessThan(3);
    expect(cut.warnings).toEqual([]);
  });

  it('follows a curved side', () => {
    // top side bulging 50 mm outwards
    const top: number[] = [];
    for (let k = 1; k < 20; k++) { const t = k / 20; top.push(1000 - 1000 * t, 600 + 200 * t * (1 - t)); }
    const cut = cutOutline(panel(rect, 15, 20, [null, null, top, null]));
    const b = bounds(cut.flat);
    expect(b.maxY).toBeGreaterThan(630); // 650 peak minus 15 offset
    expect(b.maxY).toBeLessThan(636);
    expect(cut.warnings).toEqual([]);
  });
});

describe('reshaping', () => {
  it('removing the corners of a bump makes the panel ignore it', () => {
    // rectangle with a 100 × 80 tab sticking out of the right side
    const withTab: Vec2[] = [[0, 0], [1000, 0], [1000, 200], [1100, 200], [1100, 280], [1000, 280], [1000, 600], [0, 600]];
    let p = panel(withTab, 15, 20);
    for (let k = 0; k < 4; k++) p = removeCorner(p, 2);
    expect(p.shape.corners).toEqual(rect);
    expect(p.offsets.length).toBe(4);
    near(polygonArea(cutOutline(p).flat), 970 * 570 - (4 - Math.PI) * 400);
  });

  it('moves and adds corners', () => {
    let p = panel(rect, 0, 0);
    p = addCorner(p, 0, [500, 0], 0);
    expect(p.shape.corners.length).toBe(5);
    expect(polygonArea(cutOutline(p).flat)).toBeCloseTo(600000, 0); // a corner on a straight side changes nothing
    p = moveCorner(p, 1, [500, -100]);
    expect(polygonArea(cutOutline(p).flat)).toBeCloseTo(600000 + 50000, 0);
    expect(removeCorner(panel(rect.slice(0, 3), 0, 0), 0).shape.corners.length).toBe(3); // never fewer than three
  });
});

describe('panel facts and DXF', () => {
  it('finds the smallest box even when the panel is drawn at an angle', () => {
    const a = (30 * Math.PI) / 180;
    const turned = rect.flatMap(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
    const [long, short] = smallestBox(turned);
    expect(long).toBeCloseTo(1000, 0); expect(short).toBeCloseTo(600, 0);
  });

  it('writes the cut line with true arcs', () => {
    const dxf = panelToDxf(panel(rect, 15, 20), undefined);
    expect(dxf).toContain('OUTER_CUT');
    expect(dxf.split('\r\n 42\r\n').length + dxf.split('\r\n42\r\n').length - 2).toBe(4);
  });
});
