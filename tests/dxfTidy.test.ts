import { describe, expect, it } from 'vitest';
import { MIN_ARC, MIN_SEGMENT, tidyPolyline } from '../src/core/dxf';
import { createDesign, designedPanelToDxf } from '../src/core/design';
import { createProject } from '../src/core/project';
import { machiningOf } from '../src/core/tools';
import type { Panel } from '../src/core/panel';
import type { Vec2 } from '../src/core/vec';

describe('tidying lines for the machine', () => {
  it('drops a point 0.001 mm from the one before, keeping the next arc', () => {
    // straight to (100, 0), a 0.001 mm step, then a quarter arc to (110, 10)
    const t = tidyPolyline([0, 0, 100, 0, 100.001, 0, 110, 10], [0, 0, 0.4142, 0], false);
    expect(t.points).toEqual([0, 0, 100, 0, 110, 10]);
    expect(t.bulges[1]).toBeCloseTo(0.4142, 6);
  });
  it('removes a 0.02 mm zig-zag', () => {
    const t = tidyPolyline([0, 0, 50, 0, 50, 0.02, 50.01, 0.02, 100, 0], undefined, false);
    expect(t.points).toEqual([0, 0, 50, 0, 100, 0]);
  });
  it('closes a loop without a zero-length last segment', () => {
    const t = tidyPolyline([0, 0, 10, 0, 10, 10, 0, 10, 0.001, 0.001], undefined, true);
    expect(t.points).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
  });
  it('writes arcs shorter than 1 mm as straight lines', () => {
    // 3° of a 15 mm radius: 0.79 mm long
    const a = (3 * Math.PI) / 180, b = Math.tan(a / 4);
    const t = tidyPolyline([0, 0, 15 * Math.sin(a), 15 - 15 * Math.cos(a), 30, 30], [b, 0, 0], false);
    expect(t.bulges).toEqual([0, 0, 0]);
    const long = tidyPolyline([0, 0, 10, 0], [0.4142, 0], false);
    expect(long.bulges[0]).toBeCloseTo(0.4142, 6);
  });
  it('keeps a circle written as two half circles', () => {
    expect(tidyPolyline([0, 0, 100, 0], [1, 1], true).points).toEqual([0, 0, 100, 0]);
  });
});

/** Every segment of every polyline in a DXF: [layer, length, isArc] */
function segments(dxf: string): { layer: string; length: number; arc: boolean }[] {
  const l = dxf.split(/\r?\n/).map((s) => s.trim()), out: { layer: string; length: number; arc: boolean }[] = [];
  for (let i = 0; i < l.length; i++) {
    if (l[i] !== 'POLYLINE') continue;
    const layer = l[i + 2], closed = l[l.indexOf('70', i) + 1] === '1';
    const v: { x: number; y: number; b: number }[] = [];
    let k = i + 1;
    for (; l[k] !== 'SEQEND'; k++) {
      if (l[k] === 'VERTEX') {
        const v0: { x: number; y: number; b: number } = { x: 0, y: 0, b: 0 };
        for (let j = k + 1; l[j] !== '0' || !['VERTEX', 'SEQEND'].includes(l[j + 1]); j += 2) {
          if (l[j] === '10') v0.x = +l[j + 1]; if (l[j] === '20') v0.y = +l[j + 1]; if (l[j] === '42') v0.b = +l[j + 1];
        }
        v.push(v0);
      }
    }
    const n = v.length;
    for (let s = 0; s < (closed ? n : n - 1); s++) {
      const a = v[s], c = v[(s + 1) % n], chord = Math.hypot(c.x - a.x, c.y - a.y), b = Math.abs(a.b);
      out.push({ layer, arc: b > 0, length: b ? ((chord * (1 + b * b)) / (4 * b)) * 4 * Math.atan(b) : chord });
    }
    i = k;
  }
  return out;
}

describe('a whole panel file', () => {
  it('has no segment shorter than 0.05 mm and no arc shorter than 1 mm, on any layer', () => {
    const shape: Vec2[] = [[0, 0], [380, 0], [400, 115], [380, 230], [0, 230]];
    const panel: Panel = { id: 'p', name: 'P', surfaceId: 's', createdAt: '', shape: { corners: shape, curves: shape.map(() => null) }, offsets: [0, 0, 0, 0, 0], radii: [20, 20, 20, 20, 20], cutouts: [{ id: 'o', kind: 'circle', center: [100, 115], diameter: 60 }] };
    const design = { ...createDesign('d', 's'), pattern: { kind: 'hexagon', params: { size: 60 }, angle: 90, originX: 0, originY: 0 } };
    const dxf = designedPanelToDxf(panel, undefined, design, undefined, machiningOf(createProject({ name: 'x' }).settings).machining);
    const segs = segments(dxf);
    expect(segs.length).toBeGreaterThan(100);
    expect(segs.some((s) => s.arc)).toBe(true);
    expect(new Set(segs.map((s) => s.layer))).toEqual(new Set(['1_T11_GROOVE_3_5MM', '3_T10_EDGE_5MM', '4_KNIFE_INNER', '5_KNIFE_OUTER']));
    const short = segs.filter((s) => s.length < MIN_SEGMENT - 1e-6);
    const shortArcs = segs.filter((s) => s.arc && s.length < MIN_ARC - 1e-6);
    expect(short, JSON.stringify(short.slice(0, 3))).toEqual([]);
    expect(shortArcs, JSON.stringify(shortArcs.slice(0, 3))).toEqual([]);
  });
});
