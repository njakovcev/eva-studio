import { describe, expect, it } from 'vitest';
import { createDesign, designPanel } from '../src/core/design';
import { cutOutline, type Panel } from '../src/core/panel';
import { createProject } from '../src/core/project';
import { machiningOf } from '../src/core/tools';
import { straightenAngle, turnSurface, turnSurfaceInProject } from '../src/core/turn';
import type { Surface } from '../src/core/surface';

const corners: [number, number][] = [[0, 0], [600, 100], [550, 400], [-20, 350]];
const surface = {
  id: 's', name: 'S', scanId: 'x', createdAt: '', bow: 80,
  plane: { origin: [10, 20, 30], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  raw: { outer: corners.flat(), holes: [{ points: [100, 100, 110, 100, 110, 110], area: 50 }] },
  outline: { options: { tolerance: 20, bridgeWidth: 40 }, edge: corners.flat(), anchors: corners.map((_, i) => ({ at: i })), corners, sides: [] },
  checks: [{ id: 'm', a: corners[0], b: corners[2], measured: 700 }],
} as unknown as Surface;
const panel = { id: 'p', name: 'P', surfaceId: 's', createdAt: '', shape: { corners, curves: corners.map(() => null) }, offsets: [15, 15, 15, 15], radii: [20, 20, 20, 20], cutouts: [{ id: 'h', kind: 'circle', center: [300, 200], diameter: 50 }] } as unknown as Panel;
const design = { ...createDesign('d', 's'), pattern: { kind: 'lines', params: { spacing: 50 }, angle: 10, originX: 5, originY: 7 } };
const project = { ...createProject({ name: 'T' }), surfaces: [surface], panels: [panel], designs: [design] };
const { machining } = machiningOf(project.settings);
const lengthOf = (lines: number[][]) => lines.reduce((t, l) => { for (let k = 0; k + 3 < l.length; k += 2) t += Math.hypot(l[k + 2] - l[k], l[k + 3] - l[k + 1]); return t; }, 0);

describe('turning the drawing of a surface', () => {
  it('keeps every point where it is on the boat', () => {
    const t = turnSurface(surface, 33);
    const at = (s: Surface, p: number[]) => s.plane.u.map((u, k) => s.plane.origin[k] + p[0] * u + p[1] * s.plane.v[k]);
    const before = at(surface, corners[1]), after = at(t, t.outline.corners[1]);
    after.forEach((x, k) => expect(x).toBeCloseTo(before[k], 6));
    expect(t.bow).toBeCloseTo(113, 6);
  });

  it('turns panels and design with it, so the design comes out the same', () => {
    const turned = turnSurfaceInProject(project, 's', -12.5);
    const p2 = turned.panels[0];
    const a = designPanel(panel, design, { artworks: [], patterns: [] }, machining);
    const b = designPanel(p2, turned.designs[0], { artworks: [], patterns: [] }, machining);
    expect(lengthOf(b.pattern)).toBeCloseTo(lengthOf(a.pattern), 0);
    expect(cutOutline(p2).flat.length).toBe(cutOutline(panel).flat.length);
  });

  it('finds the smallest turn that lays a side level', () => {
    expect(straightenAngle(surface, 0)).toBeCloseTo(-9.46, 2); // side 0 rises 100 over 600
    const t = turnSurface(surface, straightenAngle(surface, 0));
    expect(t.outline.corners[1][1] - t.outline.corners[0][1]).toBeCloseTo(0, 6);
  });
});
