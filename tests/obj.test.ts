import { describe, expect, it } from 'vitest';
import { parseObj } from '../src/core/obj';
import { computeStats } from '../src/core/mesh';

const enc = (s: string) => new TextEncoder().encode(s);

describe('parseObj', () => {
  it('reads vertices and triangles', () => {
    const m = parseObj(enc('# comment\nv 0 0 0\nv 1000 0 0\nv 0 500.5 0\nf 1 2 3\n'));
    expect(Array.from(m.positions)).toEqual([0, 0, 0, 1000, 0, 0, 0, 500.5, 0]);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
  });

  it('handles v/vt/vn faces, negative indices, quads, CRLF and exponents', () => {
    const text = 'v -1.5e2 0 0\r\nv 1.5E+2 0 0\r\nv 150 100 0\r\nv -150 100 0\r\nvn 0 0 1\r\nvt 0 0\r\nf 1/1/1 2/1/1 3/1/1 4/1/1\r\nf -4//1 -3//1 -2//1\r\n';
    const m = parseObj(enc(text));
    expect(m.positions[0]).toBeCloseTo(-150);
    expect(m.positions[3]).toBeCloseTo(150);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3, 0, 1, 2]);
  });

  it('works without a newline at the end', () => {
    const m = parseObj(enc('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'));
    expect(m.indices.length).toBe(3);
  });

  it('rejects files with no geometry and with bad references', () => {
    expect(() => parseObj(enc('hello\n'))).toThrow(/No geometry/);
    expect(() => parseObj(enc('v 0 0 0\nf 1 2 3\n'))).toThrow(/does not exist/);
  });

  it('computes size and area', () => {
    const m = parseObj(enc('v 0 0 0\nv 1000 0 0\nv 1000 500 0\nv 0 500 0\nf 1 2 3 4\n'));
    const s = computeStats(m);
    expect(s.triangles).toBe(2);
    expect(s.max).toEqual([1000, 500, 0]);
    expect(s.area).toBeCloseTo(500000);
  });
});
