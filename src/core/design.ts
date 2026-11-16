/**
 * The design milled into the panels of one surface: a border line along the
 * edge and a pattern inside it. Everything is milled into the top layer, so a
 * design is two-coloured: top colour, with the bottom colour showing in the grooves.
 */
import { clipLines, linesLength } from './clip';
import { writeDxf, type DxfPolyline } from './dxf';
import { cutOutline, cutoutOutline, insetCut, type CutOutline, type Panel } from './panel';
import { defaultParams, patternById, patternLines, type PatternPlacement } from './patterns';
import { bounds } from './poly';
import { outlinePolygonOf, type Surface } from './surface';
import { DEFAULT_GROOVE_TOOL, grooveWidth, type GrooveTool } from './tools';

export interface Design {
  id: string;
  surfaceId: string;
  /** a line following the panel edge, `inset` mm inside it */
  border: { on: boolean; inset: number };
  pattern: PatternPlacement;
  /** how deep the grooves are milled, mm (3 = through the whole top layer) */
  depth: number;
}

export function createDesign(id: string, surfaceId: string): Design {
  const def = patternById('lines')!;
  return {
    id, surfaceId,
    border: { on: true, inset: 15 },
    pattern: { kind: 'lines', params: defaultParams(def), angle: 0, originX: 0, originY: 0 },
    depth: 3,
  };
}

export interface PanelDesign {
  cut: CutOutline;
  /** the border line (closed, with arcs), or null */
  border: CutOutline | null;
  /** pattern lines cut to the panel (open polylines) */
  pattern: number[][];
  /** total length of milling, mm */
  millLength: number;
  warnings: string[];
}

const closedLength = (flat: number[]) => { let s = 0; const n = flat.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += Math.hypot(flat[j * 2] - flat[i * 2], flat[j * 2 + 1] - flat[i * 2 + 1]); } return s; };

/** Everything that gets milled into one panel. */
export function designPanel(panel: Panel, design: Design, tool: GrooveTool = DEFAULT_GROOVE_TOOL): PanelDesign {
  const cut = cutOutline(panel);
  const warnings: string[] = [];
  const border = design.border.on && design.border.inset > 0 ? insetCut(panel, design.border.inset) : null;
  if (border?.warnings.some((w) => /too large|disappears/.test(w))) warnings.push('The border does not fit inside this panel at this distance from the edge.');

  // the pattern fills the inside of the border (or the whole panel), but never an opening
  const area = border ?? cut;
  const rings = [area.flat, ...(panel.cutouts ?? []).map((c) => cutoutOutline(c).flat)];
  const pattern = design.pattern.kind === 'none' ? [] : clipLines(patternLines(design.pattern, bounds(area.flat)), rings);

  const width = grooveWidth(tool, design.depth);
  const size = design.pattern.params.size;
  if (design.pattern.kind !== 'none' && size !== undefined && size < 2.5 * width) {
    warnings.push(`The pattern is very fine for this cutter: grooves are ${width.toFixed(1)} mm wide, leaving little material between them.`);
  }
  return { cut, border, pattern, millLength: (border ? closedLength(border.flat) : 0) + linesLength(pattern), warnings };
}

/** DXF of one panel with its design: OUTER_CUT, INNER_CUT, MILL_LINE (tool centre lines), REFERENCE. */
export function designedPanelToDxf(panel: Panel, surface: Surface | undefined, design: Design | undefined): string {
  const d = design ? designPanel(panel, design) : null;
  const cut = d?.cut ?? cutOutline(panel);
  const reference = surface ? outlinePolygonOf(surface) : [];
  // origin from the surface, so all panels of one surface share it and patterns line up
  const b = bounds(reference.length ? reference : cut.flat);
  const shift = (pts: ArrayLike<number>) => Array.from(pts, (v, i) => v - (i % 2 === 0 ? b.minX : b.minY));
  const polylines: DxfPolyline[] = [
    { layer: 'OUTER_CUT', points: shift(cut.points), bulges: cut.bulges },
    ...(panel.cutouts ?? []).map((c) => { const o = cutoutOutline(c); return { layer: 'INNER_CUT', points: shift(o.points), bulges: o.bulges }; }),
  ];
  if (d?.border) polylines.push({ layer: 'MILL_LINE', points: shift(d.border.points), bulges: d.border.bulges });
  for (const l of d?.pattern ?? []) polylines.push({ layer: 'MILL_LINE', points: shift(l), closed: false });
  if (reference.length) polylines.push({ layer: 'REFERENCE', points: shift(reference) });
  return writeDxf(
    [{ name: 'OUTER_CUT', color: 1 }, { name: 'INNER_CUT', color: 5 }, { name: 'MILL_LINE', color: 3 }, { name: 'REFERENCE', color: 8 }],
    polylines,
  );
}
