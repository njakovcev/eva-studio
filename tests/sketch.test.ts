import { describe, expect, it } from 'vitest';
import { addConstraint, analyse, measure, setDimension, solve, signedNow } from '../src/core/sketch/solver';
import { emptySketch, type Sketch, type SkDimension } from '../src/core/sketch/model';
import { rankAndNullSpace } from '../src/core/sketch/linalg';

/** a rough quadrilateral drawn by hand: corners a b c d, sides ab bc cd da */
function quad(): Sketch {
  return {
    ...emptySketch('s', 'S'),
    points: [{ id: 'a', x: 0, y: 3 }, { id: 'b', x: 1010, y: -8 }, { id: 'c', x: 1003, y: 590 }, { id: 'd', x: 12, y: 612 }],
    entities: [
      { id: 'ab', kind: 'line', a: 'a', b: 'b' }, { id: 'bc', kind: 'line', a: 'b', b: 'c' },
      { id: 'cd', kind: 'line', a: 'c', b: 'd' }, { id: 'da', kind: 'line', a: 'd', b: 'a' },
    ],
  };
}
const P = (s: Sketch, id: string) => s.points.find((p) => p.id === id)!;
const len = (s: Sketch, p: string, q: string) => Math.hypot(P(s, q).x - P(s, p).x, P(s, q).y - P(s, p).y);
const must = (r: ReturnType<typeof addConstraint>) => { if (r.status === 'refused') throw new Error(r.message); return r.sketch; };
const dim = (s: Sketch, d: SkDimension) => signedNow(s, d);

describe('linear algebra', () => {
  it('finds rank and null space', () => {
    const { rank, nullSpace } = rankAndNullSpace(Float64Array.from([1, 2, 3, 2, 4, 6]), 2, 3);
    expect(rank).toBe(1); expect(nullSpace.length).toBe(2);
    for (const z of nullSpace) expect(Math.abs(z[0] + 2 * z[1] + 3 * z[2])).toBeLessThan(1e-12);
  });
});

describe('sketch solver', () => {
  it('a free quadrilateral has 5 degrees of freedom in its shape (8 unknowns minus moving and turning)', () => {
    expect(analyse(quad()).dof).toBe(5);
    expect(analyse(quad()).freePoints.size).toBe(3); // the first point acts as the origin
  });

  it('becomes a true rectangle of measured size, step by step, and ends fully defined', () => {
    let s = quad();
    for (const [p, q] of [['a', 'b'], ['d', 'c']]) s = must(addConstraint(s, { id: `h${p}`, kind: 'horizontal', p, q }));
    for (const [p, q] of [['b', 'c'], ['a', 'd']]) s = must(addConstraint(s, { id: `v${p}`, kind: 'vertical', p, q }));
    expect(analyse(s).dof).toBe(2); // width and height still free
    s = must(addConstraint(s, dim(s, { id: 'w', kind: 'distance', p: 'a', q: 'b', value: 0 })));
    s = must(addConstraint(s, dim(s, { id: 'h', kind: 'distance', p: 'b', q: 'c', value: 0 })));
    expect(analyse(s).dof).toBe(0);
    expect(analyse(s).freePoints.size).toBe(0);
    // the tape says 1200 × 800
    const w = setDimension(s, 'w', 1200); if (!w.ok) throw new Error(w.message); s = w.sketch;
    const h = setDimension(s, 'h', 800); if (!h.ok) throw new Error(h.message); s = h.sketch;
    expect(len(s, 'a', 'b')).toBeCloseTo(1200, 4); expect(len(s, 'b', 'c')).toBeCloseTo(800, 4);
    expect(len(s, 'a', 'c')).toBeCloseTo(Math.hypot(1200, 800), 3);
    expect(P(s, 'a').y).toBeCloseTo(P(s, 'b').y, 6);
  });

  it('a fifth measurement on a fixed shape becomes a reference, not a conflict', () => {
    let s = quad();
    // four sides and one diagonal fix a quadrilateral's shape
    for (const [id, p, q] of [['1', 'a', 'b'], ['2', 'b', 'c'], ['3', 'c', 'd'], ['4', 'd', 'a'], ['5', 'a', 'c']]) s = must(addConstraint(s, dim(s, { id, kind: 'distance', p, q, value: 0 })));
    expect(analyse(s).dof).toBe(0);
    const r = addConstraint(s, dim(s, { id: '6', kind: 'distance', p: 'b', q: 'd', value: 0 }));
    expect(r.status).toBe('reference');
    if (r.status === 'reference') {
      const d = r.sketch.constraints.find((c) => c.id === '6') as SkDimension;
      expect(d.reference).toBe(true);
      expect(d.value).toBeCloseTo(len(s, 'b', 'd'), 3);
    }
  });

  it('triangulation: a corner placed from two tape measurements', () => {
    // known base a–b = 2000; the corner c is 1500 from a and 1300 from b
    let s: Sketch = { ...emptySketch('t', 'T'), points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1900, y: 0 }, { id: 'c', x: 800, y: 1000 }], entities: [{ id: 'ab', kind: 'line', a: 'a', b: 'b' }, { id: 'bc', kind: 'line', a: 'b', b: 'c' }, { id: 'ca', kind: 'line', a: 'c', b: 'a' }] };
    for (const [id, p, q, v] of [['1', 'a', 'b', 2000], ['2', 'a', 'c', 1500], ['3', 'b', 'c', 1300]] as const) {
      s = must(addConstraint(s, dim(s, { id, kind: 'distance', p, q, value: 0 })));
      const r = setDimension(s, id, v); if (!r.ok) throw new Error(r.message); s = r.sketch;
    }
    expect(analyse(s).dof).toBe(0);
    // the corner stays on the side it was drawn on
    expect(P(s, 'c').y - P(s, 'a').y).toBeGreaterThan(0);
    // law of cosines: x along the base
    const x = (1500 ** 2 - 1300 ** 2 + 2000 ** 2) / (2 * 2000);
    const ab = [P(s, 'b').x - P(s, 'a').x, P(s, 'b').y - P(s, 'a').y].map((v) => v / 2000);
    const ac = [P(s, 'c').x - P(s, 'a').x, P(s, 'c').y - P(s, 'a').y];
    expect(ac[0] * ab[0] + ac[1] * ab[1]).toBeCloseTo(x, 3);
  });

  it('refuses measurements that cannot all be true', () => {
    let s: Sketch = { ...emptySketch('t', 'T'), points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1000, y: 0 }, { id: 'c', x: 500, y: 600 }], entities: [{ id: 'ab', kind: 'line', a: 'a', b: 'b' }, { id: 'bc', kind: 'line', a: 'b', b: 'c' }, { id: 'ca', kind: 'line', a: 'c', b: 'a' }] };
    for (const [id, p, q] of [['1', 'a', 'b'], ['2', 'a', 'c'], ['3', 'b', 'c']] as const) s = must(addConstraint(s, dim(s, { id, kind: 'distance', p, q, value: 0 })));
    const bad = setDimension(s, '1', 3000); // longer than the other two sides together
    expect(bad.ok).toBe(false);
    expect(addConstraint(s, { id: 'r', kind: 'horizontal', p: 'a', q: 'b' }).status).toBe('added');
  });

  it('keeps arcs round, tangent and of the measured radius', () => {
    // a line a–b followed by an arc from b to e around centre k
    let s: Sketch = {
      ...emptySketch('t', 'T'),
      points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1000, y: 5 }, { id: 'k', x: 990, y: 210 }, { id: 'e', x: 1190, y: 220 }],
      entities: [{ id: 'l', kind: 'line', a: 'a', b: 'b' }, { id: 'arc', kind: 'arc', c: 'k', a: 'b', b: 'e' }],
    };
    s = solve(s).sketch;
    expect(len(s, 'k', 'b')).toBeCloseTo(len(s, 'k', 'e'), 4); // the arc's two ends are on one circle
    s = must(addConstraint(s, { id: 't', kind: 'tangent', e1: 'l', e2: 'arc' }));
    s = must(addConstraint(s, dim(s, { id: 'r', kind: 'radius', e: 'arc', value: 0 })));
    const r = setDimension(s, 'r', 300); if (!r.ok) throw new Error(r.message); s = r.sketch;
    expect(measure(s, s.constraints.find((c) => c.id === 'r') as SkDimension)).toBeCloseTo(300, 4);
    // tangent: the radius to the joint is at right angles to the line
    const k = P(s, 'k'), b = P(s, 'b'), a = P(s, 'a');
    expect(((b.x - a.x) * (k.x - b.x) + (b.y - a.y) * (k.y - b.y)) / (len(s, 'a', 'b') * 300)).toBeCloseTo(0, 3);
  });

  it('angles, parallel, perpendicular, symmetry and point-to-line distance', () => {
    let s = quad();
    s = must(addConstraint(s, { id: 'par', kind: 'parallel', l1: 'ab', l2: 'cd' }));
    s = must(addConstraint(s, { id: 'perp', kind: 'perpendicular', l1: 'ab', l2: 'bc' }));
    // ab ∥ cd and ab ⟂ bc already make the angle at c a right angle: a measurement there is only a reference
    expect(addConstraint(s, dim(s, { id: 'x', kind: 'angle', l1: 'bc', l2: 'cd', value: 0 })).status).toBe('reference');
    s = must(addConstraint(s, dim(s, { id: 'ang', kind: 'angle', l1: 'cd', l2: 'da', value: 0 })));
    const r = setDimension(s, 'ang', 100); if (!r.ok) throw new Error(r.message); s = r.sketch;
    const dir = (p: string, q: string) => Math.atan2(P(s, q).y - P(s, p).y, P(s, q).x - P(s, p).x);
    // the corner at d, as drawn, is 100°
    const corner = Math.abs(((dir('d', 'c') - dir('d', 'a')) * 180) / Math.PI) % 360;
    expect(Math.min(corner, 360 - corner)).toBeCloseTo(100, 3);
    expect(measure(s, s.constraints.find((c) => c.id === 'ang') as SkDimension)).toBeCloseTo(100, 3);
    // a centre line and two points mirrored about it
    let m: Sketch = { ...emptySketch('m', 'M'), points: [{ id: 'o1', x: 0, y: -100 }, { id: 'o2', x: 3, y: 900 }, { id: 'p', x: -300, y: 200 }, { id: 'q', x: 280, y: 230 }], entities: [{ id: 'axis', kind: 'line', a: 'o1', b: 'o2', construction: true }] };
    m = must(addConstraint(m, { id: 'sym', kind: 'symmetric', p: 'p', q: 'q', line: 'axis' }));
    m = must(addConstraint(m, dim(m, { id: 'd', kind: 'pointLine', p: 'p', line: 'axis', sign: 1, value: 0 })));
    const r2 = setDimension(m, 'd', 450); if (!r2.ok) throw new Error(r2.message); m = r2.sketch;
    const o1 = P(m, 'o1'), o2 = P(m, 'o2'), ux = o2.x - o1.x, uy = o2.y - o1.y, ul = Math.hypot(ux, uy);
    const side = (id: string) => (ux * (P(m, id).y - o1.y) - uy * (P(m, id).x - o1.x)) / ul;
    expect(Math.abs(side('p'))).toBeCloseTo(450, 4); expect(side('p')).toBeCloseTo(-side('q'), 4);
  });

  it('dragging moves what is free and leaves what is fixed', () => {
    let s = quad();
    s = must(addConstraint(s, { id: 'f', kind: 'fix', p: 'a', x: 0, y: 3 }));
    s = must(addConstraint(s, dim(s, { id: 'w', kind: 'distance', p: 'a', q: 'b', value: 0 })));
    const r = solve(s, [{ point: 'b', x: 500, y: 900 }]);
    expect(r.ok).toBe(true);
    expect(P(r.sketch, 'a').x).toBeCloseTo(0, 5); expect(P(r.sketch, 'a').y).toBeCloseTo(3, 5);
    expect(len(r.sketch, 'a', 'b')).toBeCloseTo(len(s, 'a', 'b'), 4); // b swings round a at the measured distance
    expect(Math.atan2(P(r.sketch, 'b').y - 3, P(r.sketch, 'b').x)).toBeCloseTo(Math.atan2(897, 500), 2);
  });
});

import { filletCorner, mergePoints, mirrorEntities, removeItems, sketchOutline } from '../src/core/sketch/geometry';

describe('sketch editing and outline', () => {
  let n = 0; const id = () => `n${++n}`;
  it('finds the closed outline, counter-clockwise, whichever way it was drawn', () => {
    const s = quad();
    const cw: Sketch = { ...s, points: s.points.map((p) => ({ ...p, y: -p.y })) }; // mirror: now clockwise
    for (const x of [s, cw]) {
      const r = sketchOutline(x); if (!r.ok) throw new Error(r.message);
      const p = r.outline.polygon; let a = 0; for (let i = 0; i < p.length / 2; i++) { const j = (i + 1) % (p.length / 2); a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
      expect(a).toBeGreaterThan(0); expect(r.outline.corners.length).toBe(4);
    }
    const open = sketchOutline(removeItems(s, new Set(['cd'])));
    expect(open.ok).toBe(false); if (!open.ok) expect(open.openPoints.sort()).toEqual(['c', 'd']);
  });

  it('rounds a corner: tangent arc of the radius, sharp corner kept on both lines', () => {
    let s = quad();
    for (const [p, q] of [['a', 'b'], ['d', 'c']]) s = must(addConstraint(s, { id: `h${p}`, kind: 'horizontal', p, q }));
    for (const [p, q] of [['b', 'c'], ['a', 'd']]) s = must(addConstraint(s, { id: `v${p}`, kind: 'vertical', p, q }));
    const f = filletCorner(s, 'b', 100, id); if (!f.ok) throw new Error(f.message);
    const r = solve(f.sketch); expect(r.ok).toBe(true);
    const o = sketchOutline(r.sketch); if (!o.ok) throw new Error(o.message);
    expect(o.outline.corners.length).toBe(5); // four corners became five (two tangent points)
    expect(o.outline.curves.filter(Boolean).length).toBe(1);
    // the corner point is still where the two lines meet
    const b = P(r.sketch, 'b'), c = P(r.sketch, 'c'), a = P(r.sketch, 'a');
    expect(b.x).toBeCloseTo(c.x, 4); expect(b.y).toBeCloseTo(a.y, 4);
    expect(analyse(r.sketch).dof).toBe(2); // still just width and height
  });

  it('mirrors half a deck about the centre line and keeps it symmetric', () => {
    let s: Sketch = {
      ...emptySketch('m', 'M'),
      points: [{ id: 'o1', x: 0, y: 0 }, { id: 'o2', x: 0, y: 2000 }, { id: 'p', x: 600, y: 300 }, { id: 'q', x: 500, y: 1500 }],
      entities: [{ id: 'axis', kind: 'line', a: 'o1', b: 'o2', construction: true }, { id: 'l1', kind: 'line', a: 'o1', b: 'p' }, { id: 'l2', kind: 'line', a: 'p', b: 'q' }, { id: 'l3', kind: 'line', a: 'q', b: 'o2' }],
    };
    s = mirrorEntities(s, ['l1', 'l2', 'l3'], 'axis', id);
    expect(s.points.length).toBe(6); // o1, o2 shared; p, q copied
    const r = sketchOutline(s); if (!r.ok) throw new Error(r.message);
    expect(r.outline.corners.length).toBe(6);
    s = must(addConstraint(s, dim(s, { id: 'w', kind: 'distance', p: 'p', q: 'o1', value: 0 })));
    const w = setDimension(s, 'w', 800); if (!w.ok) throw new Error(w.message);
    // the copy of p follows: it is p reflected in the (possibly moved) centre line
    const sym = w.sketch.constraints.find((c) => c.kind === 'symmetric' && c.p === 'p') as { q: string };
    const o1 = P(w.sketch, 'o1'), o2 = P(w.sketch, 'o2'), p = P(w.sketch, 'p'), t = P(w.sketch, sym.q);
    const dx = o2.x - o1.x, dy = o2.y - o1.y, k = ((p.x - o1.x) * dx + (p.y - o1.y) * dy) / (dx * dx + dy * dy);
    expect(2 * (o1.x + k * dx) - p.x).toBeCloseTo(t.x, 3); expect(2 * (o1.y + k * dy) - p.y).toBeCloseTo(t.y, 3);
    expect(Math.hypot(p.x - o1.x, p.y - o1.y)).toBeCloseTo(800, 4);
  });

  it('joins points and cleans up after deleting', () => {
    let s = quad();
    s = { ...s, points: [...s.points, { id: 'e', x: 5, y: 600 }], entities: s.entities.map((e) => (e.id === 'da' && e.kind === 'line' ? { ...e, a: 'e' } : e)) };
    expect(sketchOutline(s).ok).toBe(false);
    s = mergePoints(s, 'd', 'e');
    expect(sketchOutline(s).ok).toBe(true);
    s = must(addConstraint(s, dim(s, { id: 'w', kind: 'distance', p: 'a', q: 'b', value: 0 })));
    const gone = removeItems(s, new Set(['ab']));
    expect(gone.constraints.length).toBe(1); // the distance a–b stays: both points still exist
    expect(removeItems(s, new Set(['b'])).constraints.length).toBe(0);
  });
});
