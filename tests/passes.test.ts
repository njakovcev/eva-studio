import { describe, expect, it } from 'vitest';
import { offsetLine, reverseBulged, reverseLine, twoWay, defaultGroovePasses } from '../src/core/passes';
import { flattenArcs, insetCut, type Panel } from '../src/core/panel';
import { createDesign, designedPanelToDxf } from '../src/core/design';
import { createProject } from '../src/core/project';
import { grooveFootprint, machiningOf, T11 } from '../src/core/tools';
import type { Vec2 } from '../src/core/vec';

const signedArea = (f: number[]) => { let a = 0; const n = f.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += f[i * 2] * f[j * 2 + 1] - f[j * 2] * f[i * 2 + 1]; } return a / 2; };

describe('moving a line sideways', () => {
  it('moves a straight line to its left', () => {
    expect(offsetLine([0, 0, 100, 0], false, 1)).toEqual([0, 1, 100, 1]);
    expect(offsetLine([0, 0, 100, 0], false, -1)).toEqual([0, -1, 100, -1]);
  });
  it('keeps corners sharp, 1 mm from both sides', () => {
    // counter-clockwise square: left is inside
    const sq = offsetLine([0, 0, 10, 0, 10, 10, 0, 10], true, 1);
    expect(sq.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 1, 9, 1, 9, 9, 1, 9]);
    const bend = offsetLine([0, 0, 10, 0, 10, 10], false, 1);
    expect(bend.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 9, 1, 9, 10]);
  });
  it('runs a line the other way', () => expect(reverseLine([0, 0, 1, 2, 3, 4])).toEqual([3, 4, 1, 2, 0, 0]));
});

describe('grooves in two passes', () => {
  const p = defaultGroovePasses();
  it('finishes both walls by climb milling: first pass left and forwards, second right and backwards', () => {
    const [a, b] = twoWay([0, 0, 100, 0], false, p);
    expect(a).toEqual([0, 0.25, 100, 0.25]);
    expect(b).toEqual([100, -0.25, 0, -0.25]);
  });
  it('swaps sides for conventional milling', () => {
    const [a, b] = twoWay([0, 0, 100, 0], false, { ...p, finish: 'conventional' });
    expect(a).toEqual([0, -0.25, 100, -0.25]);
    expect(b).toEqual([100, 0.25, 0, 0.25]);
  });
  it('turns an arc line round without changing its shape', () => {
    const rect: Vec2[] = [[0, 0], [400, 0], [400, 300], [0, 300]];
    const panel: Panel = { id: 'p', name: 'P', surfaceId: 's', createdAt: '', shape: { corners: rect, curves: rect.map(() => null) }, offsets: [0, 0, 0, 0], radii: [40, 40, 40, 40], cutouts: [] };
    const c = insetCut(panel, 20);
    const back = reverseBulged(c.points, c.bulges);
    const fwd = flattenArcs(c.points, c.bulges), rev = flattenArcs(back.points, back.bulges);
    expect(signedArea(fwd)).toBeGreaterThan(0);
    expect(signedArea(rev)).toBeCloseTo(-signedArea(fwd), 3);
  });
});

describe('two passes in the files', () => {
  const rect: Vec2[] = [[0, 0], [1000, 0], [1000, 600], [0, 600]];
  const panel: Panel = { id: 'p', name: 'P', surfaceId: 's', createdAt: '', shape: { corners: rect, curves: rect.map(() => null) }, offsets: [15, 15, 15, 15], radii: [20, 20, 20, 20], cutouts: [] };
  const design = { ...createDesign('d', 's'), border: { on: true, inset: 15 }, pattern: { kind: 'lines', params: { size: 110 }, angle: 0, originX: 0, originY: 20 } };
  const settings = createProject({ name: 'x' }).settings;

  it('writes every groove twice, the border as two loops one each way', () => {
    const one = designedPanelToDxf(panel, undefined, design, undefined, machiningOf({ ...settings, machining: { ...settings.machining, passes: { ...settings.machining.passes, on: false } } }).machining);
    const two = designedPanelToDxf(panel, undefined, design, undefined, machiningOf(settings).machining);
    const count = (dxf: string) => dxf.split('POLYLINE\r\n  8\r\n1_T11_GROOVE_3_5MM').length - 1 || dxf.split(/POLYLINE\r?\n8\r?\n1_T11_GROOVE_3_5MM/).length - 1;
    expect(count(two)).toBe(2 * count(one));
    expect(count(one)).toBeGreaterThan(1);
  });

  it('makes the groove wider by the offset', () => {
    const m = machiningOf(settings).machining;
    expect(grooveFootprint(m, T11, 3).width).toBeCloseTo(9.12 + 0.5, 2);
    expect(grooveFootprint(m, T11, 3).colour).toBeCloseTo(5.1, 6);
  });

  it('refuses passes so far apart that a ridge stays between them', () => {
    const r = machiningOf({ ...settings, machining: { ...settings.machining, passes: { on: true, offset: 5, finish: 'climb' } } });
    expect(r.problems.join(' ')).toMatch(/ridge/);
    expect(r.machining.passes.on).toBe(false);
  });
});
