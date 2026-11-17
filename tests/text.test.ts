import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { textOutlines } from '../src/core/text';
import { regionArea } from '../src/core/region';

const font = (name: string) => { const b = readFileSync(`node_modules/@fontsource/montserrat/files/${name}`); return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const fonts = [font('montserrat-latin-700-normal.woff'), font('montserrat-latin-ext-700-normal.woff')];

describe('text to outlines', () => {
  it('draws letters with their holes, lower-left at 0,0', () => {
    const o = textOutlines('O', fonts);
    expect(o.rings.length).toBe(2); // the O and its inside
    expect(o.width).toBeGreaterThan(600); expect(o.height).toBeGreaterThan(600);
    const xs = o.rings.flat().filter((_, k) => k % 2 === 0), ys = o.rings.flat().filter((_, k) => k % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(0, 6); expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(regionArea(o.rings)).toBeLessThan(o.width * o.height * 0.7); // a ring, not a blob
  });
  it('handles Croatian letters from the extended file, and spaces', () => {
    const o = textOutlines('ŠČ Ž', fonts);
    expect(o.missing).toEqual([]);
    expect(o.width).toBeGreaterThan(textOutlines('SC', fonts).width);
    expect(o.height).toBeGreaterThan(textOutlines('S', fonts).height); // the carons add height
  });
  it('reports letters the font does not have', () => {
    expect(textOutlines('A日', fonts).missing).toEqual(['日']);
    expect(textOutlines('', fonts).rings).toEqual([]);
  });
});
