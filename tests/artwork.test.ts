import { describe, expect, it } from 'vitest';
import { cleanRegion, grow, intersect, regionArea, subtract, thicken, union } from '../src/core/region';
import { flattenPathData, parseSvg } from '../src/core/svg';
import { bounds } from '../src/core/poly';

const sq = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s];

describe('shape arithmetic', () => {
  it('cuts, joins and removes', () => {
    expect(regionArea(intersect([sq(0, 0, 100)], [sq(50, 50, 100)]))).toBeCloseTo(2500, 3);
    expect(regionArea(union([sq(0, 0, 100)], [sq(50, 50, 100)]))).toBeCloseTo(17500, 3);
    expect(regionArea(subtract([sq(0, 0, 100)], [sq(25, 25, 50)]))).toBeCloseTo(7500, 3);
    expect(subtract([sq(0, 0, 100)], [sq(25, 25, 50)]).length).toBe(2); // outline + hole
  });
  it('grows and shrinks with round corners', () => {
    expect(regionArea(grow([sq(0, 0, 100)], -10))).toBeCloseTo(6400, 1);
    const big = regionArea(grow([sq(0, 0, 100)], 10));
    expect(Math.abs(big - (10000 + 4 * 1000 + Math.PI * 100))).toBeLessThan(2);
    expect(grow([sq(0, 0, 10)], -6)).toEqual([]); // shrunk away
    expect(Math.abs(regionArea(thicken([[0, 0, 100, 0]], 5)) - (1000 + Math.PI * 25))).toBeLessThan(1);
  });
  it('tidies overlapping and inside-out rings', () => {
    const overlapping = [sq(0, 0, 100), sq(50, 0, 100)];
    expect(regionArea(cleanRegion(overlapping, true))).toBeCloseTo(15000, 3);
    expect(regionArea(cleanRegion(overlapping, false))).toBeCloseTo(10000, 3); // even-odd: the overlap is a hole
  });
});

describe('SVG path data', () => {
  it('reads lines, relative moves, closes', () => {
    const p = flattenPathData('M10 10 h80 v80 h-80 z m20 20 l40 0 0 40 -40 0 z');
    expect(p.length).toBe(2);
    expect(p[0].points).toEqual([10, 10, 90, 10, 90, 90, 10, 90]);
    expect(p[0].closed).toBe(true);
    expect(p[1].points.slice(0, 4)).toEqual([30, 30, 70, 30]); // relative to where the first shape started
  });
  it('flattens curves and arcs accurately', () => {
    const circle = flattenPathData('M0,50 A50,50 0 1 0 100,50 A50,50 0 1 0 0,50 Z')[0].points;
    for (let k = 0; k < circle.length; k += 2) expect(Math.hypot(circle[k] - 50, circle[k + 1] - 50)).toBeCloseTo(50, 6);
    const curve = flattenPathData('M0 0 C0 55.2 44.8 100 100 100')[0].points; // a quarter circle drawn as a Bézier
    for (let k = 0; k < curve.length; k += 2) expect(Math.abs(Math.hypot(curve[k] - 100, curve[k + 1]) - 100)).toBeLessThan(0.1);
    expect(flattenPathData('M0 0 Q50 100 100 0 T200 0')[0].points.at(-2)).toBeCloseTo(200, 6);
  });
});

describe('SVG files', () => {
  const svg = `<?xml version="1.0"?><!-- logo --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
    <defs><rect id="hidden" width="500" height="500"/></defs>
    <g transform="translate(10,10)">
      <path d="M0 0 H100 V80 H0 Z M20 20 V60 H80 V20 Z" fill="#000"/>
      <circle cx="140" cy="40" r="30" style="fill:none;stroke:#f00"/>
    </g>
    <line x1="10" y1="95" x2="190" y2="95" stroke="black"/>
    <text x="0" y="0">hello</text>
  </svg>`;
  const art = parseSvg(svg);

  it('separates filled shapes from stroked lines, and keeps holes', () => {
    expect(art.rings.length).toBe(2); // frame and its hole
    expect(regionArea(art.rings)).toBeCloseTo(100 * 80 - 60 * 40, 1);
    expect(art.lines.length).toBe(2); // the circle outline and the line
    expect(art.skipped).toEqual(['text that is not converted to outlines']);
  });
  it('puts the drawing at 0,0 with y pointing up, ignoring <defs>', () => {
    expect(art.width).toBeCloseTo(180, 6); expect(art.height).toBeCloseTo(85, 6);
    const b = bounds(art.rings.flat());
    expect(b.minX).toBeCloseTo(0, 3); expect(b.maxY).toBeCloseTo(85, 3); // the frame is at the top of the drawing
    const line = art.lines.find((l) => l.length === 4)!;
    expect(line[1]).toBeCloseTo(0, 6); // the bottom line of the SVG ends up at y = 0
  });
  it('explains what is wrong with unusable files', () => {
    expect(() => parseSvg('hello')).toThrow(/not an SVG/);
    expect(() => parseSvg('<svg><text>A</text></svg>')).toThrow(/outlines/);
  });
});

describe('SVG drawing order', () => {
  it('keeps every filled shape as its own layer, lowest first', () => {
    const art = parseSvg('<svg viewBox="0 0 200 200"><rect x="0" y="0" width="120" height="120" fill="blue"/><circle cx="130" cy="130" r="60" fill="red"/><path d="M10 190 H50" stroke="#000"/></svg>');
    expect(art.layers.length).toBe(2);
    expect(regionArea(art.layers[0])).toBeCloseTo(14400, 0);
    expect(Math.abs(regionArea(art.layers[1]) - Math.PI * 3600)).toBeLessThan(20); // the circle is drawn with 72 straight pieces
    expect(regionArea(art.rings)).toBeLessThan(14400 + Math.PI * 3600); // merged: overlap counted once
  });
});
