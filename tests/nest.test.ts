import { describe, expect, it } from 'vitest';
import { applyPlacement, nest, type NestOptions, type NestPart } from '../src/core/nest';
import { bounds } from '../src/core/poly';
import { grow, intersect, regionArea } from '../src/core/region';

const options: NestOptions = { sheetLength: 2400, sheetWidth: 1200, margin: 10, gap: 8, rotations: [0, 180] };
const rect = (id: string, w: number, h: number, x = 0, y = 0): NestPart => ({ id, outline: [x, y, x + w, y, x + w, y + h, x, y + h] });

/** Checks every rule on a result: on the sheet, inside the margin, a full gap apart, turned only as allowed. */
function check(parts: NestPart[], r: ReturnType<typeof nest>, o: NestOptions) {
  const placed = r.placements.map((p) => ({ p, at: applyPlacement(p, parts.find((q) => q.id === p.partId)!.outline) }));
  for (const { p, at } of placed) {
    const b = bounds(at);
    expect(b.minX, p.partId).toBeGreaterThanOrEqual(o.margin - 1e-6); expect(b.minY).toBeGreaterThanOrEqual(o.margin - 1e-6);
    expect(b.maxX).toBeLessThanOrEqual(o.sheetLength - o.margin + 1e-6); expect(b.maxY).toBeLessThanOrEqual(o.sheetWidth - o.margin + 1e-6);
    expect(o.rotations).toContain(p.angle);
  }
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    if (placed[i].p.sheet !== placed[j].p.sheet) continue;
    // grown by half the gap each, two parts must not touch
    const overlap = regionArea(intersect(grow([placed[i].at], o.gap / 2 - 0.01), grow([placed[j].at], o.gap / 2 - 0.01)));
    expect(overlap, `${placed[i].p.partId} / ${placed[j].p.partId}`).toBeLessThan(1e-3);
  }
}

describe('arranging panels on sheets', () => {
  it('packs rectangles tightly and keeps every rule', () => {
    // four 1100 × 550 pieces: two columns of two fit in 2 × 1100 + gap + margins = 2228 mm of sheet
    const parts = ['a', 'b', 'c', 'd'].map((id, k) => rect(id, 1100, 550, k * 3000, 500));
    const r = nest(parts, options);
    expect(r.sheets).toBe(1); expect(r.unplaced).toEqual([]); expect(r.placements.length).toBe(4);
    check(parts, r, options);
    expect(r.usedLength[0]).toBeLessThan(2250);
  });

  it('starts a second sheet only when the first is full', () => {
    const parts = Array.from({ length: 5 }, (_, k) => rect(`p${k}`, 1100, 550));
    const r = nest(parts, options);
    expect(r.sheets).toBe(2);
    expect(r.placements.filter((p) => p.sheet === 0).length).toBe(4);
    check(parts, r, options);
  });

  it('turns parts only as allowed', () => {
    const tall = [rect('t', 500, 1500)]; // only fits lying down
    expect(nest(tall, options).unplaced.length).toBe(1);
    const turned = nest(tall, { ...options, rotations: [0, 90, 180, 270] });
    expect(turned.unplaced).toEqual([]);
    expect([90, 270]).toContain(turned.placements[0].angle);
    check(tall, turned, { ...options, rotations: [0, 90, 180, 270] });
  });

  it('fits triangles together better than their boxes would allow', () => {
    // right triangles 1000 × 1000: two of them make a square when one is turned half-way round
    const tri = (id: string): NestPart => ({ id, outline: [0, 0, 1000, 0, 0, 1000] });
    const parts = [tri('a'), tri('b'), tri('c'), tri('d')];
    const r = nest(parts, options);
    expect(r.sheets).toBe(1);
    check(parts, r, options);
    expect(r.usedLength[0]).toBeLessThan(2 * 1000 + 250); // boxes side by side would need more than 4 m
  });

  it('reports a part that is larger than a sheet', () => {
    const r = nest([rect('big', 2500, 300), rect('ok', 300, 300)], options);
    expect(r.unplaced.map((u) => u.partId)).toEqual(['big']);
    expect(r.placements.map((p) => p.partId)).toEqual(['ok']);
  });
});

import { createProject } from '../src/core/project';
import { createDesign, EMPTY_LIBRARY } from '../src/core/design';
import { nestOptionsOf, nestParts, sheetToDxf, summarize } from '../src/core/sheets';
import type { Panel } from '../src/core/panel';

describe('sheet files', () => {
  const panel = (id: string, w: number, h: number): Panel => ({
    id, name: `Panel ${id}`, surfaceId: 's', createdAt: '',
    shape: { corners: [[0, 0], [w, 0], [w, h], [0, h]], curves: [null, null, null, null] }, offsets: [0, 0, 0, 0], radii: [20, 20, 20, 20],
    cutouts: id === 'a' ? [{ id: 'o', kind: 'circle', center: [w / 2, h / 2], diameter: 60 }] : undefined,
  });
  const project = { ...createProject({ name: 'T' }), panels: [panel('a', 900, 500), panel('b', 700, 400), panel('c', 600, 300)], designs: [createDesign('d', 's')] };
  const result = nest(nestParts(project), nestOptionsOf(project.settings));

  it('uses the project rules', () => {
    expect(nestOptionsOf(project.settings)).toMatchObject({ sheetLength: 2400, sheetWidth: 1200, margin: 25, gap: 9.8, rotations: [0, 180] }); // gap 8 raised for the rounded edge
    expect(result.sheets).toBe(1);
    const s = summarize(project, result)[0];
    expect(s.panels).toBe(3);
    expect(s.fill).toBeGreaterThan(0.5); expect(s.fill).toBeLessThanOrEqual(1);
    expect(s.usedLength + s.offcut).toBeCloseTo(2400, 6);
    expect(s.usedWidth + s.sideOffcut).toBeCloseTo(1200, 6);
  });

  it('measures how far across the sheet the panels reach', () => {
    // one panel 700 × 400 on its own: it reaches its own height plus the edge margin across the sheet
    const one = { ...project, panels: [panel('b', 700, 400)] };
    const r = nest(nestParts(one), nestOptionsOf(one.settings));
    const s = summarize(one, r)[0];
    const pl = r.placements[0];
    const turned = pl.angle === 90 || pl.angle === 270;
    const across = (turned ? 700 : 400) + 2 * one.settings.sheetMargin;
    expect(s.usedWidth).toBeGreaterThanOrEqual(across - 0.01);
    expect(s.usedWidth).toBeLessThan(across + 3); // positions snap to a 2 mm grid
    expect(s.usedLength).toBeGreaterThanOrEqual((turned ? 400 : 700) + 2 * one.settings.sheetMargin - 0.01);
  });

  it('writes every panel with its operations at its place on the sheet', () => {
    const dxf = sheetToDxf(project, EMPTY_LIBRARY, result.placements, 0);
    const count = (layer: string) => dxf.split(`\r\nPOLYLINE\r\n8\r\n${layer}\r\n`).length - 1;
    expect(count('5_KNIFE_OUTER')).toBe(3);
    expect(count('4_KNIFE_INNER')).toBe(1);
    expect(count('1_T11_GROOVE_3_5MM')).toBeGreaterThan(10); // borders and teak lines
    expect(count('0_REFERENCE')).toBe(1); // the sheet edge
    expect(dxf.split('\r\nTEXT\r\n').length - 1).toBe(3); // a name on each panel
    // nothing is drawn outside the sheet
    const xs = [...dxf.matchAll(/\r\n10\r\n([-\d.]+)\r\n20\r\n([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(Math.min(...xs.map((p) => p[0]))).toBeGreaterThanOrEqual(0); expect(Math.max(...xs.map((p) => p[0]))).toBeLessThanOrEqual(2400);
    expect(Math.min(...xs.map((p) => p[1]))).toBeGreaterThanOrEqual(0); expect(Math.max(...xs.map((p) => p[1]))).toBeLessThanOrEqual(1200);
  });
});

describe('brushing direction', () => {
  const panel = (id: string, surfaceId: string, w: number, h: number): Panel => ({
    id, name: id, surfaceId, createdAt: '',
    shape: { corners: [[0, 0], [w, 0], [w, h], [0, h]], curves: [null, null, null, null] }, offsets: [0, 0, 0, 0], radii: [20, 20, 20, 20],
  });
  const surface = (id: string, bow?: number) => ({ id, ...(bow === undefined ? {} : { bow }) }) as never;
  const base = createProject({ name: 'T' });

  it('lays the bow of every panel along the sheet length, either end first', () => {
    const project = { ...base, surfaces: [surface('deck', 90)], panels: [panel('a', 'deck', 800, 500)] };
    const parts = nestParts(project);
    expect(parts[0].rotations).toEqual([270, 90]);
    const r = nest(parts, nestOptionsOf(project.settings));
    // the panel's y axis (the bow) now runs along the sheet: 500 along, 800 across
    expect(summarize(project, r)[0].usedWidth).toBeGreaterThanOrEqual(800);
  });

  it('keeps panels as drawn when the bow is not set', () => {
    const project = { ...base, surfaces: [surface('deck')], panels: [panel('a', 'deck', 800, 500)] };
    expect(nestParts(project)[0].rotations).toEqual([0, 180]);
  });

  it('turns each panel by the bow of its own surface', () => {
    const project = { ...base, settings: { ...base.settings, turning: 'none' as const }, surfaces: [surface('deck', 90), surface('wall', 0)], panels: [panel('a', 'deck', 800, 500), panel('b', 'wall', 800, 500)] };
    expect(nestParts(project).map((p) => p.rotations)).toEqual([[270], [0]]);
  });
});
