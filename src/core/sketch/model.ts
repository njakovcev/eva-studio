/**
 * A parametric sketch: points, entities drawn between them, and constraints
 * (relations and dimensions) that the solver keeps true. Lengths in mm,
 * angles in degrees, y pointing up.
 */
export interface SkPoint { id: string; x: number; y: number }

export type SkEntity =
  | { id: string; kind: 'line'; a: string; b: string; construction?: boolean }
  /** counter-clockwise from a to b around centre c */
  | { id: string; kind: 'arc'; c: string; a: string; b: string; construction?: boolean }
  | { id: string; kind: 'circle'; c: string; r: number; construction?: boolean }
  /** smooth curve through its points, first to last */
  | { id: string; kind: 'spline'; pts: string[]; construction?: boolean };

/** Relations: hold geometry in shape without a number. */
export type SkRelation =
  | { id: string; kind: 'horizontal' | 'vertical'; p: string; q: string }
  | { id: string; kind: 'parallel' | 'perpendicular' | 'equalLength'; l1: string; l2: string }
  | { id: string; kind: 'equalRadius'; e1: string; e2: string }
  /** line–arc/circle or arc–arc; `inside` is for two curves, one inside the other */
  | { id: string; kind: 'tangent'; e1: string; e2: string; inside?: boolean }
  | { id: string; kind: 'pointOnLine'; p: string; line: string }
  | { id: string; kind: 'pointOnCurve'; p: string; curve: string }
  | { id: string; kind: 'midpoint'; p: string; line: string }
  | { id: string; kind: 'symmetric'; p: string; q: string; line: string }
  | { id: string; kind: 'fix'; p: string; x: number; y: number };

/**
 * Dimensions: measurements that set the geometry (driving), or that only show
 * a value the other constraints already decide (reference).
 * `side` / `sign` remember which way round the measurement was taken, so the
 * solver never flips the drawing to satisfy it.
 */
export type SkDimension =
  | { id: string; kind: 'distance'; p: string; q: string; value: number; reference?: boolean; offset?: number }
  | { id: string; kind: 'hDistance' | 'vDistance'; p: string; q: string; value: number; sign: 1 | -1; reference?: boolean; offset?: number }
  | { id: string; kind: 'pointLine'; p: string; line: string; value: number; sign: 1 | -1; reference?: boolean; offset?: number }
  /** `flip`: the angle shown is 180° minus the angle between the two line directions (so it is the corner as drawn) */
  | { id: string; kind: 'angle'; l1: string; l2: string; value: number; flip?: boolean; reference?: boolean; offset?: number }
  | { id: string; kind: 'radius'; e: string; value: number; reference?: boolean; diameter?: boolean; offset?: number };

export type SkConstraint = SkRelation | SkDimension;

export const isDimension = (c: SkConstraint): c is SkDimension =>
  c.kind === 'distance' || c.kind === 'hDistance' || c.kind === 'vDistance' || c.kind === 'pointLine' || c.kind === 'angle' || c.kind === 'radius';

export interface SketchPhoto {
  /** path inside the project folder */
  file: string;
  /** image size in pixels */
  widthPx: number;
  heightPx: number;
  /** millimetres per pixel */
  scale: number;
  /** where the image's top-left corner sits, and its rotation (degrees, counter-clockwise) */
  x: number;
  y: number;
  angle: number;
  opacity: number;
  hidden?: boolean;
}

export interface Sketch {
  id: string;
  name: string;
  points: SkPoint[];
  entities: SkEntity[];
  constraints: SkConstraint[];
  photo?: SketchPhoto;
  /** the surface made from this sketch, kept up to date while the outline is closed */
  surfaceId?: string;
  createdAt: string;
}

export function emptySketch(id: string, name: string, now = new Date()): Sketch {
  return { id, name, points: [], entities: [], constraints: [], createdAt: now.toISOString() };
}

/** Points an entity uses (for an arc: centre, start, end). */
export function entityPoints(e: SkEntity): string[] {
  switch (e.kind) {
    case 'line': return [e.a, e.b];
    case 'arc': return [e.c, e.a, e.b];
    case 'circle': return [e.c];
    case 'spline': return e.pts;
  }
}

/** Everything a constraint refers to (points and entities). */
export function constraintRefs(c: SkConstraint): string[] {
  switch (c.kind) {
    case 'horizontal': case 'vertical': case 'distance': case 'hDistance': case 'vDistance': return [c.p, c.q];
    case 'parallel': case 'perpendicular': case 'equalLength': case 'angle': return [c.l1, c.l2];
    case 'equalRadius': case 'tangent': return [c.e1, c.e2];
    case 'pointOnLine': case 'midpoint': case 'pointLine': return [c.p, c.line];
    case 'pointOnCurve': return [c.p, c.curve];
    case 'symmetric': return [c.p, c.q, c.line];
    case 'fix': return [c.p];
    case 'radius': return [c.e];
  }
}
