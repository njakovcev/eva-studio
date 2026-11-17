import { describe, expect, it } from 'vitest';
import { clipLines, isInside, linesLength } from '../src/core/clip';
import { createDesign, designPanel, designedPanelToDxf } from '../src/core/design';
import { cutOutline, insetCut, type Panel } from '../src/core/panel';
import { PATTERNS, defaultParams, patternLines, type StoredPattern } from '../src/core/patterns';
import type { StoredArtwork } from '../src/core/artwork';
import { regionArea } from '../src/core/region';
import { bounds, polygonArea } from '../src/core/poly';
import { DEFAULT_GROOVE_TOOL, grooveWidth } from '../src/core/tools';
import type { Vec2 } from '../src/core/vec';

const rect: Vec2[] = [[0, 0], [1000, 0], [1000, 600], [0, 600]];
const panel = (corners: Vec2[], offset: number, radius: number): Panel => ({
  id: 'p', name: 'P', surfaceId: 's', createdAt: '',
  shape: { corners, curves: corners.map(() => null) }, offsets: corners.map(() => offset), radii: corners.map(() => radius),
});

describe('groove width of the form cutter', () => {
  it('follows the tool profile', () => {
    expect(grooveWidth(DEFAULT_GROOVE_TOOL, 1)).toBeCloseTo(4.6, 6);
    expect(grooveWidth(DEFAULT_GROOVE_TOOL, 2)).toBeCloseTo(4.6, 6);
    expect(grooveWidth(DEFAULT_GROOVE_TOOL, 3)).toBeCloseTo(4.94, 2);
    expect(grooveWidth(DEFAULT_GROOVE_TOOL, 4)).toBeCloseTo(6.09, 2);
    expect(grooveWidth(DEFAULT_GROOVE_TOOL, 9)).toBeCloseTo(10.7, 6); // never wider than the cutter
  });
});

describe('cutting lines to a shape', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100], hole = [40, 40, 60, 40, 60, 60, 40, 60];
  it('keeps only the inside, and stops at openings', () => {
    expect(isInside(50, 50, [square])).toBe(true);
    expect(isInside(50, 50, [square, hole])).toBe(false);
    const out = clipLines([[-50, 50, 150, 50], [-50, 10, 150, 10], [200, 0, 300, 0]], [square, hole]);
    expect(out.length).toBe(3); // one line split in two by the hole, one whole, one gone
    expect(linesLength(out)).toBeCloseTo(40 + 40 + 100, 6);
  });
  it('keeps a bent line in one piece while it stays inside', () => {
    const out = clipLines([[10, 10, 50, 20, 90, 10, 150, 10]], [square]);
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(8);
    expect(out[0][out[0].length - 2]).toBeCloseTo(100, 6);
  });
});

describe('patterns', () => {
  const area = { minX: 0, minY: 0, maxX: 1000, maxY: 600 };
  const place = (kind: string, angle = 0, extra = {}) => ({ kind, params: { ...defaultParams(PATTERNS.find((p) => p.id === kind)!), ...extra }, angle, originX: 25, originY: 25 });
  const box = [0, 0, 1000, 0, 1000, 600, 0, 600];

  it('teak lines: one every plank width, in any direction', () => {
    const flat = clipLines(patternLines(place('lines', 0, { size: 50 }), area), [box]);
    expect(flat.length).toBe(12); // y = 25, 75 … 575
    expect(linesLength(flat)).toBeCloseTo(12 * 1000, 0);
    const upright = clipLines(patternLines(place('lines', 90, { size: 50 }), area), [box]);
    expect(linesLength(upright)).toBeCloseTo(20 * 600, 0); // x = 25 … 975
  });

  it('every pattern covers the whole area and never leaves it', () => {
    for (const def of PATTERNS) {
      for (const angle of [0, 30]) {
        const cut = clipLines(patternLines(place(def.id, angle), area), [box]);
        expect(cut.length, def.id).toBeGreaterThan(5);
        const b = bounds(cut.flat());
        expect(b.minX).toBeGreaterThanOrEqual(-1e-6); expect(b.maxX).toBeLessThanOrEqual(1000 + 1e-6);
        expect(b.minY).toBeGreaterThanOrEqual(-1e-6); expect(b.maxY).toBeLessThanOrEqual(600 + 1e-6);
        // reaches all four sides: nothing is left bare
        expect(b.minX).toBeLessThan(80); expect(b.maxX).toBeGreaterThan(920); expect(b.minY).toBeLessThan(80); expect(b.maxY).toBeGreaterThan(520);
      }
    }
  });

  it('hexagons have the size asked for, with no line drawn twice', () => {
    const lines = patternLines(place('hexagon', 0, { size: 60 }), area);
    const total = linesLength(clipLines(lines, [box]));
    // a honeycomb of width s has (2·√3 / s) mm of line per mm²… = 2/(√3·R)… per unit area: edge length per hexagon 3R, area (3√3/2)R²
    const R = 60 / Math.sqrt(3);
    expect(total / 600000).toBeCloseTo((3 * R) / ((3 * Math.sqrt(3)) / 2 * R * R), 2);
  });

  it('continues across two panels: cut separately, the pieces add up to the whole', () => {
    const lines = patternLines(place('diamond', 15), area);
    const whole = linesLength(clipLines(lines, [box]));
    const left = linesLength(clipLines(lines, [[0, 0, 400, 0, 400, 600, 0, 600]]));
    const right = linesLength(clipLines(lines, [[400, 0, 1000, 0, 1000, 600, 400, 600]]));
    expect(left + right).toBeCloseTo(whole, 3);
  });
});

describe('design of a panel', () => {
  it('the border runs parallel to the cut line, with concentric corners', () => {
    const p = panel(rect, 15, 20);
    const border = insetCut(p, 15);
    const b = bounds(border.flat);
    expect([b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 10) / 10)).toEqual([30, 30, 970, 570]);
    expect(border.usedRadii.map(Math.round)).toEqual([5, 5, 5, 5]); // 20 − 15
    // inside corner of an L: radius grows instead
    const L: Vec2[] = [[0, 0], [600, 0], [600, 300], [300, 300], [300, 600], [0, 600]];
    expect(insetCut(panel(L, 15, 20), 15).usedRadii.map(Math.round).sort((x, y) => x - y)).toEqual([5, 5, 5, 5, 5, 35]);
  });

  it('pattern stays inside the border and out of openings', () => {
    const p: Panel = { ...panel(rect, 15, 20), cutouts: [{ id: 'o', kind: 'circle', center: [500, 300], diameter: 100 }] };
    const d = designPanel(p, { ...createDesign('d', 's'), pattern: { kind: 'lines', params: { size: 55 }, angle: 0, originX: 0, originY: 0 } });
    expect(d.border).not.toBeNull();
    const b = bounds(d.pattern.flat());
    expect(b.minX).toBeGreaterThanOrEqual(30 - 1e-6); expect(b.maxX).toBeLessThanOrEqual(970 + 1e-6);
    for (const l of d.pattern) for (let k = 0; k < l.length; k += 2) expect(Math.hypot(l[k] - 500, l[k + 1] - 300)).toBeGreaterThan(49.9);
    expect(d.millLength).toBeGreaterThan(polygonArea(cutOutline(p).flat) / 55 * 0.8);
    expect(d.warnings).toEqual([]);
  });

  it('warns when the pattern is too fine for the cutter, and exports milling lines', () => {
    const p = panel(rect, 15, 20);
    const fine = designPanel(p, { ...createDesign('d', 's'), pattern: { kind: 'lines', params: { size: 10 }, angle: 0, originX: 0, originY: 0 } });
    expect(fine.warnings.join(' ')).toMatch(/very fine/);
    const dxf = designedPanelToDxf(p, undefined, createDesign('d', 's'));
    expect(dxf.split('1_T21_GROOVE_3MM').length - 1).toBeGreaterThan(8);
    expect(designedPanelToDxf(p, undefined, undefined)).toContain('5_KNIFE_OUTER');
  });
});

describe('artwork on a panel', () => {
  // a 200 × 100 block with a 100 × 50 window in it, and a line under it
  const art: StoredArtwork = { id: 'a', name: 'Logo', width: 200, height: 120, rings: [[0, 20, 200, 20, 200, 120, 0, 120], [50, 45, 50, 95, 150, 95, 150, 45]], lines: [[0, 0, 200, 0]] };
  const lib = { artworks: [art], patterns: [] };
  const base = { ...createDesign('d', 's'), border: { on: true, inset: 15 }, pattern: { kind: 'lines', params: { size: 55 }, angle: 0, originX: 0, originY: 20 } };
  const p = panel(rect, 0, 0);
  const g = { id: 'g', artworkId: 'a', x: 500, y: 300, width: 400, angle: 0, mode: 'area' as const, clearance: 10 };

  it('filled: the shape is milled out, the pattern keeps its distance', () => {
    const d = designPanel(p, { ...base, graphics: [g] }, lib);
    expect(d.pocketArea).toBeCloseTo(400 * 200 - 200 * 100, 0); // drawn at twice its size
    expect(d.graphicLines.length).toBe(1); // the stroked line is still a groove
    for (const l of d.pattern) for (let k = 0; k < l.length; k += 2) {
      const nearLogo = l[k] > 300 - 9.9 && l[k] < 700 + 9.9 && l[k + 1] > 220 - 9.9 && l[k + 1] < 420 + 9.9;
      // the window in the logo is big enough for the pattern to carry on inside it, 10 mm from its edge
      const inWindow = l[k] >= 410 - 0.1 && l[k] <= 590 + 0.1 && l[k + 1] >= 280 - 0.1 && l[k + 1] <= 360 + 0.1;
      expect(nearLogo && !inWindow).toBe(false);
    }
    expect(d.warnings).toEqual([]);
  });

  it('leaves out pattern stubs that would only be dots', () => {
    // two blocks 12 mm apart with 4 mm clearance each: a 4 mm wide strip of pattern area between them
    const twin: StoredArtwork = { id: 'w', name: 'Twin', width: 212, height: 100, rings: [[0, 0, 100, 0, 100, 100, 0, 100], [112, 0, 212, 0, 212, 100, 112, 100]], lines: [] };
    const d = designPanel(p, { ...base, graphics: [{ ...g, artworkId: 'w', width: 212, clearance: 4 }] }, { artworks: [twin], patterns: [] });
    for (const l of d.pattern) expect(linesLength([l])).toBeGreaterThanOrEqual(7);
  });

  it('lines: the outlines become grooves; with clearance 0 the pattern runs through', () => {
    const d = designPanel(p, { ...base, graphics: [{ ...g, mode: 'line', clearance: 0 }] }, lib);
    expect(d.pocketArea).toBe(0);
    expect(d.graphicLines.length).toBe(3); // outer outline, window, line
    const plain = designPanel(p, base, lib);
    expect(d.pattern.length).toBe(plain.pattern.length);
  });

  it('is cut at the panel edge and shared between two panels', () => {
    const left = panel([[0, 0], [498, 0], [498, 600], [0, 600]], 0, 0), right = panel([[502, 0], [1000, 0], [1000, 600], [502, 600]], 0, 0);
    const design = { ...base, border: { on: false, inset: 15 }, graphics: [g] };
    const a = designPanel(left, design, lib), b = designPanel(right, design, lib);
    expect(a.pocketArea).toBeGreaterThan(0); expect(b.pocketArea).toBeGreaterThan(0);
    // together they are the whole logo minus the 4 mm strip that falls into the gap
    expect(a.pocketArea + b.pocketArea).toBeCloseTo(60000 - 4 * 200 + 4 * 100, 0);
  });

  it('interrupts the border where it would run through the artwork', () => {
    const low = { ...g, y: 80 }; // overlaps the bottom border line
    const d = designPanel(p, { ...base, graphics: [low] }, lib);
    expect(d.border).toBeNull();
    expect(d.borderLines!.length).toBeGreaterThanOrEqual(1);
    const clear = designPanel(p, { ...base, graphics: [g] }, lib);
    expect(clear.border).not.toBeNull(); expect(clear.borderLines).toBeNull();
  });

  it('warns when a filled shape is too thin for the cutter', () => {
    const thin: StoredArtwork = { id: 't', name: 'Hairline', width: 100, height: 2, rings: [[0, 0, 100, 0, 100, 2, 0, 2]], lines: [] };
    const d = designPanel(p, { ...base, graphics: [{ ...g, artworkId: 't', width: 200 }] }, { artworks: [thin], patterns: [] });
    expect(d.warnings.join(' ')).toMatch(/narrower than the cutter/);
  });

  it('writes one DXF layer per operation', () => {
    const dxf = designedPanelToDxf({ ...p, cutouts: [{ id: 'o', kind: 'circle', center: [100, 100], diameter: 50 }] }, undefined, { ...base, graphics: [g] }, lib);
    for (const layer of ['1_T21_GROOVE_3MM', '2_T21_POCKET_3MM', '4_KNIFE_INNER', '5_KNIFE_OUTER']) expect(dxf, layer).toContain(layer);
    expect(regionArea([[0, 0, 1, 0, 1, 1, 0, 1]])).toBe(1);
  });
});

describe('own repeating pattern', () => {
  it('repeats a tile across the area at the size asked for', () => {
    const cross: StoredPattern = { id: 'x', name: 'Cross', tileWidth: 10, tileHeight: 10, lines: [[0, 5, 10, 5], [5, 0, 5, 10]] };
    const lines = patternLines({ kind: 'custom:x', params: { size: 100, brick: 0 }, angle: 0, originX: 0, originY: 0 }, { minX: 0, minY: 0, maxX: 1000, maxY: 600 }, [cross]);
    const cut = clipLines(lines, [[0, 0, 1000, 0, 1000, 600, 0, 600]]);
    expect(linesLength(cut)).toBeCloseTo(6 * 1000 + 10 * 600, 0); // six rows and ten columns of 100 mm tiles
    expect(patternLines({ kind: 'custom:gone', params: {}, angle: 0, originX: 0, originY: 0 }, { minX: 0, minY: 0, maxX: 1, maxY: 1 }, [cross])).toEqual([]);
  });
});

describe('logos with overlapping shapes', () => {
  // a big square with a smaller square drawn on top of it, overlapping its corner
  const lower = [0, 0, 100, 0, 100, 100, 0, 100], upper = [60, 60, 160, 60, 160, 160, 60, 160];
  const art: StoredArtwork = { id: 'o', name: 'Overlap', width: 160, height: 160, rings: [[0, 0, 100, 0, 100, 60, 160, 60, 160, 160, 60, 160, 60, 100, 0, 100]], lines: [], layers: [[lower], [upper]] };
  const lib = { artworks: [art], patterns: [] };
  const p = panel(rect, 0, 0);
  const base = { ...createDesign('d', 's'), border: { on: false, inset: 15 }, pattern: { kind: 'none', params: {}, angle: 0, originX: 0, originY: 0 } };
  const g = { id: 'g', artworkId: 'o', x: 500, y: 300, width: 160, angle: 0, mode: 'area' as const, clearance: 0 };

  it('merged (gap 0): one silhouette', () => {
    const d = designPanel(p, { ...base, graphics: [g] }, lib);
    expect(d.pocketArea).toBeCloseTo(10000 + 10000 - 1600, 0);
  });

  it('with a gap: the shape on top stays whole, the one below gives way by the gap', () => {
    const d = designPanel(p, { ...base, graphics: [{ ...g, separation: 5 }] }, lib);
    // lower square loses the 45 × 45 corner under the grown upper square (rounded corner adds back a little)
    const expected = 10000 + (10000 - 45 * 45 + (1 - Math.PI / 4) * 25);
    expect(Math.abs(d.pocketArea - expected)).toBeLessThan(3);
    expect(d.pockets.length).toBe(2); // two separate shapes now
  });

  it('as lines: each shape has its own outline, hidden where the shape above covers it', () => {
    const d = designPanel(p, { ...base, graphics: [{ ...g, mode: 'line', separation: 5 }] }, lib);
    // upper outline 400 + lower outline 400 minus the 2 × 40 hidden under the upper square
    expect(linesLength(d.graphicLines)).toBeCloseTo(400 + 400 - 80, 0);
    const merged = designPanel(p, { ...base, graphics: [{ ...g, mode: 'line', separation: 0 }] }, lib);
    expect(linesLength(merged.graphicLines)).toBeCloseTo(640, 0); // outline of the silhouette only (each square loses 80 mm inside the other)
  });
});
