import { describe, expect, it } from 'vitest';
import { designedPanelToDxf, edgePaths } from '../src/core/design';
import { cutOutline, pointInPolygon, type Panel } from '../src/core/panel';
import { createProject, parseProject, serializeProject } from '../src/core/project';
import { effectiveGap, nestOptionsOf } from '../src/core/sheets';
import { colourWidth, edgeMilling, grooveWidth, machiningOf, T10, T11, type EdgeMilling } from '../src/core/tools';
import type { Vec2 } from '../src/core/vec';

const rect: Vec2[] = [[0, 0], [1000, 0], [1000, 600], [0, 600]];
const panel = (cutouts: Panel['cutouts'] = []): Panel => ({
  id: 'p', name: 'P', surfaceId: 's', createdAt: '',
  shape: { corners: rect, curves: rect.map(() => null) }, offsets: rect.map(() => 15), radii: rect.map(() => 20), cutouts,
});

describe('tool profiles', () => {
  it('works out how wide a ball cuts', () => {
    expect(grooveWidth(T10, 3)).toBeCloseTo(2 * Math.sqrt(2 * 12.5 * 3 - 9), 6); // 16.2
    expect(grooveWidth(T10, 20)).toBeCloseTo(25, 6);
    expect(grooveWidth(T11, 3)).toBeCloseTo(9.12, 2);
    // the line of bottom colour: only where the cut goes through the 3 mm top layer
    expect(colourWidth(T11, 3, 3)).toBeCloseTo(4.6, 6);
    expect(colourWidth(T11, 4, 3)).toBeCloseTo(4.6, 6);
    expect(colourWidth(T11, 5.05, 3)).toBeCloseTo(4.6 + 2 * Math.sqrt(3.05 ** 2 - 3 ** 2), 6); // 0.05 mm into the rounded corner
    expect(colourWidth(T11, 2.5, 3)).toBe(0);
  });
});

describe('rounded outer edge', () => {
  const e = edgeMilling(T10, 5, 2, 6, 3) as EdgeMilling;
  it('puts the ball where 2 mm are left at the knife line', () => {
    expect(typeof e).toBe('object');
    // depth 4 at the knife line, lowest point 5: the ball surface 1 mm above its bottom, sqrt(12.5² − 11.5²)
    expect(e.offset).toBeCloseTo(Math.sqrt(12.5 ** 2 - 11.5 ** 2), 6); // 4.90
    expect(e.band).toBeCloseTo(Math.sqrt(12.5 ** 2 - 10.5 ** 2) - e.offset, 6); // 1.88: bottom colour visible
    expect(e.slope).toBeCloseTo(10 - e.offset, 6); // 5.10: where the rounding ends
  });

  it('explains numbers that cannot work', () => {
    expect(edgeMilling(T10, 3, 2, 6, 3)).toMatch(/at least 4 mm deep/);
    expect(edgeMilling(T10, 6, 2, 6, 3)).toMatch(/less deep than the sheet/);
  });

  it('runs outside the panel and inside openings big enough for the ball', () => {
    const p = panel([
      { id: 'big', kind: 'circle', center: [300, 300], diameter: 100 },
      { id: 'small', kind: 'circle', center: [700, 300], diameter: 8 },
    ]);
    const r = edgePaths(p, e);
    expect(r.paths.length).toBe(2); // the outline and the big opening; the small one is too small
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/Opening O2 is too small/);
    const outer = r.paths.find((q) => pointInPolygon(q[0], q[1], [-100, -100, 1100, -100, 1100, 700, -100, 700]) && !pointInPolygon(q[0], q[1], cutOutline(p).flat))!;
    // every point of the outer path is 4.9 mm outside the knife line
    const cut = cutOutline(p).flat;
    for (let i = 0; i < outer.length; i += 40) {
      let best = Infinity;
      for (let k = 0; k < cut.length; k += 2) {
        const ax = cut[k], ay = cut[k + 1], bx = cut[(k + 2) % cut.length], by = cut[(k + 3) % cut.length];
        const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((outer[i] - ax) * dx + (outer[i + 1] - ay) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(outer[i] - ax - t * dx, outer[i + 1] - ay - t * dy));
      }
      expect(best).toBeCloseTo(e.offset, 1);
    }
  });

  it('writes its own layer, before the knife', () => {
    const p = panel([{ id: 'big', kind: 'circle', center: [300, 300], diameter: 100 }]);
    const settings = createProject({ name: 'x' }).settings;
    const dxf = designedPanelToDxf(p, undefined, undefined, undefined, machiningOf(settings).machining);
    expect(dxf).toContain('3_T10_EDGE_5MM');
    expect(dxf.indexOf('3_T10_EDGE_5MM')).toBeLessThan(dxf.indexOf('5_KNIFE_OUTER'));
  });

  it('keeps panels far enough apart on the sheet', () => {
    const settings = createProject({ name: 'x' }).settings;
    expect(settings.nestGap).toBe(8);
    expect(effectiveGap(settings)).toBeCloseTo(9.8, 6);
    expect(nestOptionsOf(settings).gap).toBeCloseTo(9.8, 6);
    expect(effectiveGap({ ...settings, machining: { ...settings.machining, edge: { ...settings.machining.edge, on: false } } })).toBe(8);
  });
});

describe('choosing tools', () => {
  it('uses the chosen tools for layer names', () => {
    const settings = createProject({ name: 'x' }).settings;
    const m = machiningOf({ ...settings, machining: { ...settings.machining, pocket: 10 } }).machining;
    expect(m.groove.number).toBe(11);
    expect(m.pocket.number).toBe(10);
    const dxf = designedPanelToDxf(panel(), undefined, undefined, undefined, m);
    expect(dxf).toContain('2_T10_POCKET_3MM');
  });

  it('says when a chosen tool is missing', () => {
    const settings = createProject({ name: 'x' }).settings;
    const r = machiningOf({ ...settings, machining: { ...settings.machining, groove: 12 } });
    expect(r.problems[0]).toMatch(/T12 for grooves is not in the tool list/);
  });

  it('opens version 1 projects with the machine tools filled in', () => {
    const old = JSON.parse(serializeProject(createProject({ name: 'old' })));
    old.formatVersion = 1; old.settings.tools = []; delete old.settings.machining;
    const p = parseProject(JSON.stringify(old));
    expect(p.formatVersion).toBe(3);
    expect(p.settings.tools.map((t) => t.number)).toEqual([10, 11]);
    expect(p.settings.machining.edge).toEqual({ on: true, tool: 10, bottomDepth: 5, leftAtEdge: 2 });
  });

  it('renumbers the tools of version 2 projects (T20 → T10, T21 → T11, T22 → T12)', () => {
    const old = JSON.parse(serializeProject(createProject({ name: 'old' })));
    old.formatVersion = 2;
    old.settings.tools = [{ ...T10, number: 20 }, { ...T11, number: 21 }, { ...T11, number: 22, name: 'mine' }];
    old.settings.machining = { groove: 21, pocket: 22, edge: { on: true, tool: 20, bottomDepth: 5, leftAtEdge: 2 } };
    const p = parseProject(JSON.stringify(old));
    expect(p.settings.tools.map((t) => t.number)).toEqual([10, 11, 12]);
    expect(p.settings.machining).toMatchObject({ groove: 11, pocket: 12, edge: { tool: 10 } });
  });
});
