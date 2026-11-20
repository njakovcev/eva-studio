import { describe, expect, it } from 'vitest';
import { cutOutline, insetCut, type Panel } from '../src/core/panel';

describe('border line on a panel with a narrow step', () => {
  // a "bottle": a 25 mm shoulder on each side, offsets 15 mm, radii 20 mm (the cut reduces the step corners to 12)
  const c: [number, number][] = [[25, 380], [25, 320], [0, 320], [0, 0], [200, 0], [200, 320], [175, 320], [175, 380]];
  const bottle = { id: 'p', name: 'P', surfaceId: 's', createdAt: '', shape: { corners: c, curves: c.map(() => null) }, offsets: c.map(() => 15), radii: c.map(() => 20) } as unknown as Panel;

  it('does not cross itself or stick out of the panel', () => {
    const b = insetCut(bottle, 15);
    expect(b.warnings.filter((w) => /crosses|too large|disappears/.test(w))).toEqual([]);
    const cut = cutOutline(bottle).flat;
    // every point of the border is at least 15 mm inside the cut line
    const seg = (x: number, y: number, a: number, b: number, c: number, d: number) => {
      const l = (c - a) ** 2 + (d - b) ** 2, t = Math.max(0, Math.min(1, ((x - a) * (c - a) + (y - b) * (d - b)) / l));
      return Math.hypot(x - a - t * (c - a), y - b - t * (d - b));
    };
    for (let i = 0; i < b.flat.length; i += 2) {
      const x = b.flat[i], y = b.flat[i + 1];
      let d = Infinity;
      for (let k = 0; k < cut.length; k += 2) { const m = (k + 2) % cut.length; d = Math.min(d, seg(x, y, cut[k], cut[k + 1], cut[m], cut[m + 1])); }
      expect(d).toBeGreaterThan(14.9);
      expect(x > 15 && x < 185 && y > 15 && y < 365).toBe(true);
    }
    expect(cut.length).toBeGreaterThan(0);
  });
});
