/** A flat surface of the boat, picked from a scan and stored in the project. */
import { autoClean, DEFAULT_CLEAN, outlinePolygon, resolveCorners, type Anchor, type CleanOptions, type SideInfo } from './cleanOutline';
import { writeDxf } from './dxf';
import type { RawOutline } from './outline';
import { bounds, polygonArea } from './poly';
import type { Plane, Region } from './segment';
import type { Vec2 } from './vec';

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

export function createSurface(args: { id: string; name: string; scanId: string; region: Region; raw: RawOutline }, now = new Date()): Surface {
  const options = { ...DEFAULT_CLEAN };
  return {
    id: args.id, name: args.name, scanId: args.scanId,
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
