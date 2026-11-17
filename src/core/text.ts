/**
 * Turns a line of text into artwork (outlines of the letters), using font files.
 * A font may come in several files that each hold part of the alphabet (for
 * example basic Latin, and accented letters such as Č Š Ž); each letter is
 * taken from the first file that has it.
 */
import type { Font } from 'opentype.js';
import { cleanRegion, type Region } from './region';
import { flattenPathData } from './svg';

export function textOutlines(content: string, fonts: Font[]): { width: number; height: number; rings: Region; missing: string[] } {
  const SIZE = 1000;
  const raw: number[][] = [];
  const missing = new Set<string>();
  let x = 0, prev: { font: Font; index: number } | null = null;
  for (const ch of content) {
    const font = fonts.find((f) => f.charToGlyphIndex(ch) > 0);
    if (!font) { if (ch.trim()) missing.add(ch); x += SIZE * 0.3; prev = null; continue; }
    const glyph = font.charToGlyph(ch), scale = SIZE / font.unitsPerEm;
    if (prev && prev.font === font) x += font.getKerningValue(prev.index, glyph.index) * scale;
    const d = glyph.getPath(x, 0, SIZE).toPathData(3);
    for (const sub of flattenPathData(d)) if (sub.points.length >= 6) raw.push(sub.points.map((v, k) => (k % 2 ? -v : v))); // font paths are drawn y-down
    x += (glyph.advanceWidth ?? 0) * scale;
    prev = { font, index: glyph.index };
  }
  const rings = cleanRegion(raw, true);
  if (!rings.length) return { width: 0, height: 0, rings: [], missing: [...missing] };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (let k = 0; k < r.length; k += 2) { minX = Math.min(minX, r[k]); maxX = Math.max(maxX, r[k]); minY = Math.min(minY, r[k + 1]); maxY = Math.max(maxY, r[k + 1]); }
  return {
    width: maxX - minX, height: maxY - minY,
    rings: rings.map((r) => r.map((v, k) => (k % 2 ? v - minY : v - minX))),
    missing: [...missing],
  };
}
