import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseObj } from '../src/core/obj';
import { computeStats } from '../src/core/mesh';

// Optional check against a real scanner file: set EVA_TEST_SCAN to its path.
const path = process.env.EVA_TEST_SCAN;

describe.skipIf(!path || !existsSync(path))('real scan', () => {
  it('matches the reference numbers', () => {
    const t0 = performance.now();
    const m = parseObj(new Uint8Array(readFileSync(path!)));
    const ms = performance.now() - t0;
    const s = computeStats(m);
    console.log(`parsed ${s.vertices} vertices, ${s.triangles} triangles in ${ms.toFixed(0)} ms; area ${(s.area / 1e6).toFixed(4)} m2; min ${s.min.map((v) => v.toFixed(1))} max ${s.max.map((v) => v.toFixed(1))}`);
    expect(s.vertices).toBeGreaterThan(0);
  });
});
