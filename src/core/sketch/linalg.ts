/** Small dense linear algebra for the solver (matrices as row-major Float64Array). */

/** Solves A·x = b for a symmetric positive definite A (n×n). Returns null if A is not positive definite. */
export function cholesky(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 0) return null; L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

/**
 * Rank of an m×n matrix and a basis of its null space, by Householder QR with column pivoting.
 * `tol` is relative to the largest column norm.
 */
export function rankAndNullSpace(M: Float64Array, m: number, n: number, tol = 1e-9): { rank: number; nullSpace: Float64Array[] } {
  const A = Float64Array.from(M);
  const perm = Array.from({ length: n }, (_, i) => i);
  const norms = new Float64Array(n);
  for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < m; i++) s += A[i * n + j] ** 2; norms[j] = s; }
  const first = Math.sqrt(Math.max(0, ...norms));
  const limit = tol * Math.max(first, 1e-300);
  let rank = 0;
  const steps = Math.min(m, n);
  for (let k = 0; k < steps; k++) {
    // pivot: the remaining column with the largest norm (below row k)
    let best = k, bestNorm = -1;
    for (let j = k; j < n; j++) { let s = 0; for (let i = k; i < m; i++) s += A[i * n + j] ** 2; if (s > bestNorm) { bestNorm = s; best = j; } }
    if (Math.sqrt(bestNorm) <= limit) break;
    if (best !== k) {
      for (let i = 0; i < m; i++) { const t = A[i * n + k]; A[i * n + k] = A[i * n + best]; A[i * n + best] = t; }
      [perm[k], perm[best]] = [perm[best], perm[k]];
    }
    // Householder reflection zeroing column k below the diagonal
    let alpha = 0; for (let i = k; i < m; i++) alpha += A[i * n + k] ** 2;
    alpha = Math.sqrt(alpha) * (A[k * n + k] > 0 ? -1 : 1);
    const v = new Float64Array(m);
    for (let i = k; i < m; i++) v[i] = A[i * n + k];
    v[k] -= alpha;
    let vv = 0; for (let i = k; i < m; i++) vv += v[i] * v[i];
    if (vv > 0) {
      for (let j = k; j < n; j++) {
        let s = 0; for (let i = k; i < m; i++) s += v[i] * A[i * n + j];
        const f = (2 * s) / vv;
        for (let i = k; i < m; i++) A[i * n + j] -= f * v[i];
      }
    }
    rank++;
  }
  // null space from R = [R11 R12]: x = P·[−R11⁻¹·R12·z ; z]
  const nullSpace: Float64Array[] = [];
  for (let f = rank; f < n; f++) {
    const z = new Float64Array(n);
    z[f] = 1;
    for (let i = rank - 1; i >= 0; i--) {
      let s = A[i * n + f];
      for (let k = i + 1; k < rank; k++) s += A[i * n + k] * z[k];
      z[i] = -s / A[i * n + i];
    }
    const x = new Float64Array(n);
    for (let j = 0; j < n; j++) x[perm[j]] = z[j];
    nullSpace.push(x);
  }
  return { rank, nullSpace };
}
