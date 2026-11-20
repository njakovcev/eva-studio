/** A flat surface of the boat, picked from a scan and stored in the project. */
import { autoClean, DEFAULT_CLEAN, outlinePolygon, resolveCorners, sidePath, type Anchor, type CleanOptions, type SideInfo } from './cleanOutline';
import type { SketchOutline } from './sketch/geometry';
import { writeDxf } from './dxf';
import type { RawOutline } from './outline';
import { bounds, extendToMeet, polygonArea } from './poly';
import type { Orientation } from './orientation';
import type { Plane, Region } from './segment';
import { cross, dot, normalize, type Vec2, type Vec3 } from './vec';

export interface Surface {
  id: string;
  name: string;
  scanId: string;
  /** where the surface sits in the scan (kept so later versions can show it in 3D) */
  plane: Plane;
  /** mm² of scanned area, and how far it strays from a perfect plane (mm) */
  scannedArea: number;
  flatness: { rms: number; max: number };
  /** rough edge and holes exactly as scanned, in plane coordinates (mm) */
  raw: RawOutline;
  outline: {
    options: CleanOptions;
    /** scan edge after bridging gaps; corners refer to points on it */
    edge: number[];
    anchors: Anchor[];
    /** final clean corners, counter-clockwise */
    corners: Vec2[];
    sides: SideInfo[];
    /** points of curved sides (see cleanOutline); missing in projects saved before curves existed */
    curves?: (number[] | null)[];
  };
  /** tape measurements taken on the boat, to check the drawing against reality */
  checks?: Check[];
  /** set when the surface was drawn by hand: its outline comes from this sketch */
  sketchId?: string;
  /**
   * Which way the bow is, in the surface's own coordinates: degrees counter-clockwise from its x axis.
   * Panels are laid on the sheet with this direction along the sheet length, the way the sheet is
   * brushed. Missing (projects before 20. 11. 2026) means 0.
   */
  bow?: number;
  createdAt: string;
}

export interface Check {
  id: string;
  /** the two measured points, in plane coordinates (mm) */
  a: Vec2;
  b: Vec2;
  /** what the tape showed on the boat, mm (null until entered) */
  measured: number | null;
}

/** A measured point follows the nearest corner (within 30 mm), so it stays attached when corners are adjusted. */
export function snapToCorner(s: Surface, p: Vec2): Vec2 {
  let best = p, bestD = 30;
  for (const c of s.outline.corners) { const d = Math.hypot(c[0] - p[0], c[1] - p[1]); if (d < bestD) { bestD = d; best = c; } }
  return best;
}

export function checkLength(s: Surface, c: Check): number {
  const a = snapToCorner(s, c.a), b = snapToCorner(s, c.b);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Which way the bow is on a surface, degrees from its x axis (0 when not set). */
export const bowOf = (s: Pick<Surface, 'bow'> | undefined) => s?.bow ?? 0;

/** An angle in degrees as 0 … < 360, rounded to 0.1°. */
export const normalAngle = (a: number) => { const r = Math.round((((a % 360) + 360) % 360) * 10) / 10; return r >= 360 ? 0 : r; };

/**
 * A first guess at where the bow is on a scanned surface. On a deck (facing up) it is the scan's
 * longest horizontal direction, which on a boat runs fore-aft; on a wall it is horizontal along
 * the wall. Which end is the bow cannot be told from the scan, so it may point to the stern:
 * that does not matter on the sheet as long as panels may be turned half-way round.
 */
export function guessBow(plane: Plane, orientation: Orientation): number {
  const level = Math.abs(dot(plane.normal, orientation.up)) > 0.7;
  let dir: Vec3;
  if (level) {
    const r = orientation.right, k = dot(r, plane.normal);
    dir = [r[0] - k * plane.normal[0], r[1] - k * plane.normal[1], r[2] - k * plane.normal[2]];
  } else dir = cross(orientation.up, plane.normal);
  if (Math.hypot(dir[0], dir[1], dir[2]) < 1e-9) return 0;
  dir = normalize(dir);
  return normalAngle((Math.atan2(dot(dir, plane.v), dot(dir, plane.u)) * 180) / Math.PI);
}

export function createSurface(args: { id: string; name: string; scanId: string; region: Region; raw: RawOutline; orientation?: Orientation }, now = new Date()): Surface {
  const options = { ...DEFAULT_CLEAN };
  return {
    id: args.id, name: args.name, scanId: args.scanId,
    ...(args.orientation ? { bow: guessBow(args.region.plane, args.orientation) } : {}),
    plane: args.region.plane,
    scannedArea: args.region.area,
    flatness: args.region.flatness,
    raw: args.raw,
    outline: { options, ...autoClean(args.raw.outer, options) },
    createdAt: now.toISOString(),
  };
}

/** Throws away manual corner edits and finds corners again with new settings. */
export function recleanSurface(s: Surface, options: CleanOptions): Surface {
  return { ...s, outline: { options, ...autoClean(s.raw.outer, options) } };
}

/** Applies a changed list of corners (after delete / move / add). */
export function withAnchors(s: Surface, anchors: Anchor[]): Surface {
  const sorted = [...anchors].sort((a, b) => a.at - b.at);
  return { ...s, outline: { ...s.outline, anchors: sorted, ...resolveCorners(s.outline.edge, sorted, s.outline.options.tolerance) } };
}

/**
 * Removes one side (for example the tip of a protrusion) by extending the two neighbouring
 * sides until they meet. The neighbours stay exactly on their lines; only their length changes.
 */
export function removeSideExtend(s: Surface, i: number): Surface {
  const { corners, anchors } = s.outline, n = corners.length;
  if (n < 4) throw new Error('An outline needs at least three sides.');
  const before = (i - 1 + n) % n, after = (i + 1) % n, afterEnd = (i + 2) % n;
  if (anchors[before].curve || anchors[after].curve) throw new Error('This works when both neighbouring sides are straight. Untick "Curved" on them first.');
  const meet = extendToMeet(corners[before], corners[i], corners[after], corners[afterEnd]);
  const next = anchors
    // the far end of the second neighbour is pinned where it is, so that side cannot shift
    .map((a, k) => (k === afterEnd && k !== before ? { ...a, manual: corners[k] } : a))
    .map((a, k) => (k === i ? { at: a.at, manual: meet } : a))
    .filter((_, k) => k !== after);
  return withAnchors(s, next);
}

/** The clean outline of a surface as one closed polygon. */
export const outlinePolygonOf = (s: Surface) => outlinePolygon(s.outline);

export const surfaceArea = (s: Surface) => Math.abs(polygonArea(outlinePolygon(s.outline)));

/**
 * How much a tape measure laid over a bulging surface would differ from the
 * flat drawing, over the surface's longest dimension (mm). Zero for a true plane.
 */
export function lengthErrorFromBulge(s: Surface): number {
  const b = bounds(s.raw.outer);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const sag = s.flatness.max;
  return span > 0 ? (8 * sag * sag) / (3 * span) : 0;
}

/** Holes this small are scanner markers or unread spots, not real openings (mm²). */
export const MARKER_MAX_AREA = 10000;

export function surfaceToDxf(s: Surface): string {
  const corners = outlinePolygon(s.outline);
  const b = bounds(corners);
  // move everything so the drawing starts at 0,0
  const shift = (pts: ArrayLike<number>) => Array.from(pts, (v, i) => v - (i % 2 === 0 ? b.minX : b.minY));
  return writeDxf(
    [{ name: 'SURFACE', color: 1 }, { name: 'SCAN_EDGE', color: 8 }, { name: 'SCAN_HOLES', color: 3 }],
    [
      { layer: 'SURFACE', points: shift(corners) },
      { layer: 'SCAN_EDGE', points: shift(s.raw.outer) },
      ...s.raw.holes.map((h) => ({ layer: 'SCAN_HOLES', points: shift(h.points) })),
    ],
  );
}

/** A flat plane for drawings made by hand (they have no position in a scan). */
const FLAT_PLANE: Plane = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };

/** The surface outline for a closed sketch outline: corners and curved sides exactly as drawn. */
function outlineFromSketch(o: SketchOutline): Surface['outline'] {
  const anchors: Anchor[] = [];
  let at = 0;
  o.corners.forEach((c, i) => {
    anchors.push({ at, manual: [c[0], c[1]], ...(o.curves[i] ? { curve: true } : {}) });
    at += 1 + (o.curves[i]?.length ?? 0) / 2;
  });
  const sides = o.corners.map((_, i) => {
    const pts = sidePath({ corners: o.corners, curves: o.curves }, i);
    let length = 0;
    for (let k = 0; k + 3 < pts.length; k += 2) length += Math.hypot(pts[k + 2] - pts[k], pts[k + 3] - pts[k + 1]);
    return { length, maxDeviation: 0 };
  });
  return { options: { ...DEFAULT_CLEAN }, edge: o.polygon, anchors, corners: o.corners.map((c) => [c[0], c[1]]), sides, curves: o.curves.map((c) => (c ? [...c] : null)) };
}

export function surfaceFromSketch(args: { id: string; name: string; sketchId: string; outline: SketchOutline }, now = new Date()): Surface {
  return {
    id: args.id, name: args.name, scanId: '', sketchId: args.sketchId,
    plane: FLAT_PLANE,
    scannedArea: Math.abs(polygonArea(args.outline.polygon)),
    flatness: { rms: 0, max: 0 },
    raw: { outer: args.outline.polygon, holes: args.outline.inner.map((h) => ({ points: h, area: Math.abs(polygonArea(h)) })) },
    outline: outlineFromSketch(args.outline),
    createdAt: now.toISOString(),
  };
}

/** Keeps a hand-drawn surface in step with its sketch. */
export function updateFromSketch(surface: Surface, outline: SketchOutline): Surface {
  return {
    ...surface,
    scannedArea: Math.abs(polygonArea(outline.polygon)),
    raw: { outer: outline.polygon, holes: outline.inner.map((h) => ({ points: h, area: Math.abs(polygonArea(h)) })) },
    outline: outlineFromSketch(outline),
  };
}
