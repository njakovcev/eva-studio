/**
 * Artwork (a logo, a drawing, a piece of text) kept in the project, and its
 * placement on a surface. The same artwork can be placed more than once.
 */
import { simplifyOpen } from './poly';
import type { Region } from './region';

export interface StoredArtwork {
  id: string;
  name: string;
  /** size in the artwork's own units; it is scaled to millimetres when placed */
  width: number;
  height: number;
  /** filled shapes (closed, tidy; lower-left corner at 0,0, y up) */
  rings: Region;
  /** stroked lines (open) */
  lines: number[][];
  /** set when the artwork was made from text, so it can be edited again */
  text?: { content: string; font: string };
}

export interface Graphic {
  id: string;
  artworkId: string;
  /** where its centre sits on the surface, mm */
  x: number;
  y: number;
  /** its width on the surface, mm (height follows) */
  width: number;
  /** turned by this many degrees */
  angle: number;
  /** 'line': mill along the outlines. 'area': mill the filled shapes out completely. */
  mode: 'line' | 'area';
  /** the pattern is kept this far away from the artwork, mm (0 with 'line': pattern runs straight through) */
  clearance: number;
}

export interface PlacedArtwork { rings: Region; lines: number[][]; corners: number[] }

/** The artwork in surface coordinates (mm), at its placed size, position and angle. */
export function placeArtwork(art: StoredArtwork, g: Graphic): PlacedArtwork {
  const k = g.width / art.width;
  const cos = Math.cos((g.angle * Math.PI) / 180), sin = Math.sin((g.angle * Math.PI) / 180);
  const move = (p: ArrayLike<number>) => {
    const out: number[] = new Array(p.length);
    for (let i = 0; i < p.length; i += 2) {
      const x = (p[i] - art.width / 2) * k, y = (p[i + 1] - art.height / 2) * k;
      out[i] = g.x + x * cos - y * sin; out[i + 1] = g.y + x * sin + y * cos;
    }
    return out;
  };
  // drop points that no longer matter at this size (keeps files and previews light)
  const tidyClosed = (p: number[]) => { const s = simplifyOpen([...p, p[0], p[1]], 0.03); return s.slice(0, -2); };
  return {
    rings: art.rings.map((r) => tidyClosed(move(r))).filter((r) => r.length >= 6),
    lines: art.lines.map((l) => simplifyOpen(move(l), 0.03)),
    corners: move([0, 0, art.width, 0, art.width, art.height, 0, art.height]),
  };
}

export const graphicHeight = (art: StoredArtwork, g: Graphic) => (g.width * art.height) / art.width;
