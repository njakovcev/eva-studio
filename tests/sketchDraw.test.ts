import { describe, expect, it } from 'vitest';
import { emptySketch, type Sketch, type SkDimension } from '../src/core/sketch/model';
import { addConstraint, analyse, setDimension, signedNow } from '../src/core/sketch/solver';
import { sketchOutline } from '../src/core/sketch/geometry';
import { dimensionChoice, dimensionDrawing, drawArc3, drawLine, drawTangentArc, levelPhoto, photoToDrawing, relationChoices, scalePhoto } from '../src/core/sketch/draw';
import { surfaceFromSketch } from '../src/core/surface';
import { outlinePolygon } from '../src/core/cleanOutline';

let n = 0;
const id = () => `n${++n}`;
const P = (s: Sketch, pid: string) => s.points.find((p) => p.id === pid)!;
const apply = (s: Sketch, ids: string[], kind: 'aligned' | 'horizontal' | 'vertical', value: number) => {
  const choice = dimensionChoice(s, ids)!;
  const d = signedNow(s, choice.make(kind, id)) as SkDimension;
  const r = addConstraint(s, d);
  if (r.status !== 'added') throw new Error(r.status === 'refused' ? r.message : 'reference');
  const set = setDimension(r.sketch, d.id, value);
  if (!set.ok) throw new Error(set.message);
  return set.sketch;
};

/** a deck drawn roughly by hand, like over a photo: square stern, pointed bow made of a tangent arc */
function drawDeck(): Sketch {
  let s = emptySketch('k', 'Deck');
  let r = drawLine(s, { x: 0, y: 1 }, { x: 2980, y: 40 }, id); s = r.sketch; const first = r.a; let last = r.b;
  const bottom = r.lineId;
  r = drawLine(s, { id: last }, { x: 2990, y: 1210 }, id); s = r.sketch; last = r.b; const stern = r.lineId;
  r = drawLine(s, { id: last }, { x: 30, y: 1190 }, id); s = r.sketch; last = r.b; const top = r.lineId;
  const arc = drawTangentArc(s, last, { id: first }, id)!; s = arc.sketch;
  return { ...s, name: `${bottom} ${stern} ${top} ${arc.arcId}` };
}

describe('sketch drawing', () => {
  it('makes nearly level or plumb lines exact', () => {
    const r = drawLine(emptySketch('k', 'K'), { x: 0, y: 0 }, { x: 1000, y: 30 }, id);
    expect(r.sketch.constraints.some((c) => c.kind === 'horizontal')).toBe(true);
    expect(P(r.sketch, r.b).y).toBeCloseTo(P(r.sketch, r.a).y, 6);
    const slanted = drawLine(emptySketch('k', 'K'), { x: 0, y: 0 }, { x: 1000, y: 300 }, id);
    expect(slanted.sketch.constraints.length).toBe(0);
  });

  it('draws an arc through three points, either way round', () => {
    for (const mid of [{ x: 500, y: 300 }, { x: 500, y: -300 }]) {
      const r = drawArc3(emptySketch('k', 'K'), { x: 0, y: 0 }, { x: 1000, y: 0 }, mid, id)!;
      const o = sketchOutline({ ...r.sketch, entities: [...r.sketch.entities, { id: 'l', kind: 'line', a: r.a, b: r.b }] });
      expect(o.ok).toBe(true);
      // the arc bulges towards the middle point
      if (o.ok) { const ys = o.outline.polygon.filter((_, i) => i % 2 === 1); expect(Math.sign(mid.y) > 0 ? Math.max(...ys) : -Math.min(...ys)).toBeGreaterThan(250); }
    }
  });

  it('draws a whole deck, measured with a tape, and turns it into a surface', () => {
    let s = drawDeck();
    const [bottom, stern, top, arc] = s.name.split(' ');
    expect(s.constraints.filter((c) => c.kind === 'tangent').length).toBe(1);
    expect(sketchOutline(s).ok).toBe(true);
    s = apply(s, [bottom], 'aligned', 3000);
    s = apply(s, [stern], 'aligned', 1200);
    expect(analyse(s).dof).toBe(1);
    // the straight part of the top side; the bow arc then follows from the tangency
    s = apply(s, [top], 'aligned', 2200);
    expect(analyse(s).dof).toBe(0);
    const lengths = (['bottom', 'stern', 'top'] as const).map((_, i) => { const e = s.entities.find((x) => x.id === [bottom, stern, top][i]) as { a: string; b: string }; return Math.hypot(P(s, e.b).x - P(s, e.a).x, P(s, e.b).y - P(s, e.a).y); });
    expect(lengths[0]).toBeCloseTo(3000, 2); expect(lengths[1]).toBeCloseTo(1200, 2); expect(lengths[2]).toBeCloseTo(2200, 2);
    expect(s.entities.some((e) => e.id === arc)).toBe(true);
    const o = sketchOutline(s);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const surface = surfaceFromSketch({ id: 'f', name: 'Deck', sketchId: s.id, outline: o.outline });
    expect(surface.outline.corners.length).toBe(4);
    expect((surface.outline.curves ?? []).filter(Boolean).length).toBe(1);
    // the outline the panels use follows the drawing
    const poly = outlinePolygon(surface.outline);
    const xs = poly.filter((_, i) => i % 2 === 0);
    // bow arc: tangent to the top side 800 from the tip, through the tip: r = (800² + 1200²) / 2400
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3000 + (2080000 / 2400 - 800), 0);
  });

  it('offers the relations and measurements that fit the selection', () => {
    const s = drawDeck();
    const [bottom, stern, , arc] = s.name.split(' ');
    expect(relationChoices(s, [bottom, stern]).map((c) => c.label)).toEqual(['Parallel', 'Perpendicular', 'Equal length']);
    expect(relationChoices(s, [bottom, arc]).map((c) => c.label)).toEqual(['Tangent']);
    expect(dimensionChoice(s, [bottom])!.kinds).toEqual(['aligned', 'horizontal', 'vertical']);
    expect(dimensionChoice(s, [bottom, stern])!.make('aligned', id).kind).toBe('angle');
    expect(dimensionChoice(s, [arc])!.make('aligned', id).kind).toBe('radius');
  });

  it('draws measurements next to what they measure', () => {
    const s = drawDeck();
    const [bottom] = s.name.split(' ');
    const d = signedNow(s, dimensionChoice(s, [bottom])!.make('aligned', id)) as SkDimension;
    const g = dimensionDrawing(s, d, d.value, 50)!;
    expect(g.lines.length).toBe(3);
    // the bottom side's measurement sits below it, outside the deck
    expect(g.label.y).toBeLessThan(0);
  });

  it('scales and levels a photo from two clicked points', () => {
    const ph = { file: 'p.jpg', widthPx: 4000, heightPx: 3000, scale: 1, x: 0, y: 3000, angle: 0, opacity: 0.5 };
    // two marks on the photo 1000 px apart are really 2500 mm apart
    const a = photoToDrawing(ph, 1000, 1000), b = photoToDrawing(ph, 2000, 1000);
    const scaled = scalePhoto(ph, a, b, 2500);
    const a2 = photoToDrawing(scaled, 1000, 1000), b2 = photoToDrawing(scaled, 2000, 1000);
    expect(a2.x).toBeCloseTo(a.x, 6); expect(a2.y).toBeCloseTo(a.y, 6);
    expect(Math.hypot(b2.x - a2.x, b2.y - a2.y)).toBeCloseTo(2500, 6);
    // a slightly tilted edge becomes level, turning about its first point
    const c = photoToDrawing(scaled, 1000, 2000), d = photoToDrawing(scaled, 2000, 2040);
    const level = levelPhoto(scaled, c, d);
    const c2 = photoToDrawing(level, 1000, 2000), d2 = photoToDrawing(level, 2000, 2040);
    expect(c2.x).toBeCloseTo(c.x, 6); expect(d2.y).toBeCloseTo(c2.y, 6);
  });
});
