import type { MeshStats } from '../core/mesh';

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const mm = (v: number) => `${nf0.format(v)} mm`;
export const count = (v: number) => nf0.format(v);
export const squareMetres = (mm2: number) => `${nf2.format(mm2 / 1e6)} m²`;
export const size = (s: MeshStats) => s.max.map((v, i) => nf0.format(v - s.min[i])).join(' × ') + ' mm';
