/**
 * The design milled into the panels of one surface: a border line along the
 * edge, a pattern inside it, and artwork (logos, text) laid over everything.
 * It all goes into the top layer, so a design is two-coloured: top colour,
 * with the bottom colour showing where material is milled away.
 */
import { placeArtwork, type Graphic, type StoredArtwork } from './artwork';
import { clipLines, linesLength } from './clip';
import { writeDxf, type DxfPolyline } from './dxf';
import { LAYER, operationLayers } from './operations';
import { cutOutline, cutoutOutline, insetCut, type CutOutline, type Panel } from './panel';
import { defaultParams, patternById, patternLines, type PatternPlacement, type StoredPattern } from './patterns';
import { bounds } from './poly';
import { grow, intersect, regionArea, subtract, thicken, union, type Region } from './region';
import { outlinePolygonOf, type Surface } from './surface';
import { DEFAULT_GROOVE_TOOL, grooveWidth, type GrooveTool } from './tools';

export interface Design {
  id: string;
  surfaceId: string;
  /** a line following the panel edge, `inset` mm inside it */
  border: { on: boolean; inset: number };
  pattern: PatternPlacement;
  /** how deep everything is milled, mm (3 = through the whole top layer) */
  depth: number;
  /** logos and text placed on this surface */
  graphics?: Graphic[];
}

/** What a design draws on, besides itself: the project's artwork and custom patterns. */
export interface DesignLibrary { artworks: StoredArtwork[]; patterns: StoredPattern[] }
export const EMPTY_LIBRARY: DesignLibrary = { artworks: [], patterns: [] };

export function createDesign(id: string, surfaceId: string): Design {
  const def = patternById('lines')!;
  return {
    id, surfaceId,
    border: { on: true, inset: 15 },
    pattern: { kind: 'lines', params: defaultParams(def), angle: 0, originX: 0, originY: 0 },
    depth: 3,
    graphics: [],
  };
}

export interface PanelDesign {
  cut: CutOutline;
  /** the border as one closed line with true arcs, when nothing interrupts it */
  border: CutOutline | null;
  /** the border in pieces, when artwork interrupts it */
  borderLines: number[][] | null;
  /** pattern lines cut to the panel (open) */
  pattern: number[][];
  /** outlines of 'line' artwork, cut to the panel (open) */
  graphicLines: number[][];
  /** shapes to be milled out completely ('area' artwork), cut to the panel */
  pockets: Region;
  /** total length of groove milling, mm */
  millLength: number;
  /** total area milled out, mm² */
  pocketArea: number;
  warnings: string[];
}

const closedLength = (flat: number[]) => { let s = 0; const n = flat.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += Math.hypot(flat[j * 2] - flat[i * 2], flat[j * 2 + 1] - flat[i * 2 + 1]); } return s; };
const closeLine = (r: number[]) => [...r, r[0], r[1]];

const cache = new WeakMap<Panel, { design: Design; library: DesignLibrary; tool: GrooveTool; result: PanelDesign }>();

/** Everything that gets milled into one panel. */
export function designPanel(panel: Panel, design: Design, library: DesignLibrary = EMPTY_LIBRARY, tool: GrooveTool = DEFAULT_GROOVE_TOOL): PanelDesign {
  const hit = cache.get(panel);
  if (hit && hit.design === design && hit.library === library && hit.tool === tool) return hit.result;

  const cut = cutOutline(panel);
  const warnings: string[] = [];
  const holes = (panel.cutouts ?? []).map((c) => cutoutOutline(c).flat);
  /** the EVA of this panel: inside the cut line, outside the openings */
  const body = holes.length ? subtract([cut.flat], holes) : [cut.flat];
  const width = grooveWidth(tool, design.depth);

  let border = design.border.on && design.border.inset > 0 ? insetCut(panel, design.border.inset) : null;
  if (border?.warnings.some((w) => /too large|disappears/.test(w))) warnings.push('The border does not fit inside this panel at this distance from the edge.');

  // --- artwork ---
  let keepOut: Region = [];        // where the pattern (and border) must not run
  const graphicLines: number[][] = [];
  let pockets: Region = [];
  for (const g of design.graphics ?? []) {
    const art = library.artworks.find((a) => a.id === g.artworkId);
    if (!art) continue;
    const placed = placeArtwork(art, g);
    const separate = (g.separation ?? 0) > 0 && placed.layers.length > 1;
    if (g.mode === 'area' && placed.rings.length) {
      let wanted: Region;
      if (separate) {
        // From the top shape down: each shape keeps what is not covered by the shapes above it,
        // and those are grown by the separation so an unmilled strip stays between them.
        wanted = []; let above: Region = [];
        for (let i = placed.layers.length - 1; i >= 0; i--) {
          const own = placed.layers[i];
          wanted = union(wanted, above.length ? subtract(own, above) : own);
          above = union(above, grow(own, g.separation!));
        }
      } else wanted = placed.rings;
      const mine = intersect(wanted, body);
      if (mine.length) {
        // what the cutter can actually reach: anything narrower than its tip stays unmilled
        const r = tool.profile.tipDiameter / 2;
        const lost = regionArea(mine) - regionArea(grow(grow(mine, -r), r));
        if (lost > Math.max(20, 0.03 * regionArea(mine))) warnings.push(`Parts of “${art.name}” are narrower than the cutter (${tool.profile.tipDiameter} mm) and cannot be milled out fully. Make it larger, use a smaller gap between shapes, or use lines instead of filled.`);
        pockets = union(pockets, mine);
      }
      keepOut = union(keepOut, union(grow(placed.rings, Math.max(0, g.clearance)), thicken(placed.lines, g.clearance)));
      if (placed.lines.length) graphicLines.push(...clipLines(placed.lines, body));
    } else {
      let outlines: number[][];
      if (separate) {
        // every shape drawn as its own outline, hidden where a shape above covers it
        outlines = [];
        let above: Region = [];
        const b = bounds(placed.corners), far = [b.minX - 10, b.minY - 10, b.maxX + 10, b.minY - 10, b.maxX + 10, b.maxY + 10, b.minX - 10, b.maxY + 10];
        for (let i = placed.layers.length - 1; i >= 0; i--) {
          const own = placed.layers[i].map(closeLine);
          outlines.push(...(above.length ? clipLines(own, [far, ...above]) : own));
          above = union(above, placed.layers[i]);
        }
        outlines.push(...placed.lines);
      } else outlines = [...placed.rings.map(closeLine), ...placed.lines];
      graphicLines.push(...clipLines(outlines, body));
      if (g.clearance > 0) keepOut = union(keepOut, union(grow(placed.rings, g.clearance), thicken(placed.lines, g.clearance)));
    }
  }

  // --- border: interrupted where artwork is in the way ---
  let borderLines: number[][] | null = null;
  if (border && keepOut.length) {
    const pieces = clipLines([closeLine(border.flat)], subtract([cut.flat], keepOut));
    if (Math.abs(linesLength(pieces) - closedLength(border.flat)) > 0.5) { borderLines = pieces; }
  }

  // --- pattern: inside the border (or the whole panel), never in an opening or over artwork ---
  const frame = border ?? cut;
  let patternArea: Region = holes.length ? subtract([frame.flat], holes) : [frame.flat];
  if (keepOut.length) patternArea = subtract(patternArea, keepOut);
  // stubs shorter than about one and a half groove widths are left out: they would only be dots
  const pattern = design.pattern.kind === 'none' || !patternArea.length ? []
    : clipLines(patternLines(design.pattern, bounds(frame.flat), library.patterns), patternArea).filter((l) => linesLength([l]) >= 1.5 * width);

  const size = design.pattern.params.size;
  if (design.pattern.kind !== 'none' && size !== undefined && size < 2.5 * width) {
    warnings.push(`The pattern is very fine for this cutter: grooves are ${width.toFixed(1)} mm wide, leaving little material between them.`);
  }

  const shownBorder = borderLines ? null : border;
  const result: PanelDesign = {
    cut, border: shownBorder, borderLines, pattern, graphicLines, pockets,
    millLength: (shownBorder ? closedLength(shownBorder.flat) : 0) + linesLength(borderLines ?? []) + linesLength(pattern) + linesLength(graphicLines),
    pocketArea: regionArea(pockets),
    warnings,
  };
  border = shownBorder;
  cache.set(panel, { design, library, tool, result });
  return result;
}

/** One panel as DXF polylines on operation layers, in surface coordinates (not yet moved anywhere). */
export function panelOperations(panel: Panel, design: Design | undefined, library: DesignLibrary = EMPTY_LIBRARY, tool: GrooveTool = DEFAULT_GROOVE_TOOL): DxfPolyline[] {
  const d = design ? designPanel(panel, design, library, tool) : null;
  const cut = d?.cut ?? cutOutline(panel);
  const depth = design?.depth ?? 3;
  const groove = LAYER.groove(tool, depth), pocket = LAYER.pocket(tool, depth);
  const out: DxfPolyline[] = [];
  if (d?.border) out.push({ layer: groove, points: d.border.points, bulges: d.border.bulges });
  for (const l of [...(d?.borderLines ?? []), ...(d?.pattern ?? []), ...(d?.graphicLines ?? [])]) out.push({ layer: groove, points: l, closed: false });
  for (const r of d?.pockets ?? []) out.push({ layer: pocket, points: r });
  for (const c of panel.cutouts ?? []) { const o = cutoutOutline(c); out.push({ layer: LAYER.innerCut, points: o.points, bulges: o.bulges }); }
  out.push({ layer: LAYER.outerCut, points: cut.points, bulges: cut.bulges });
  return out;
}

/** DXF of one panel with its design, one layer per CNC operation (see operations.ts). */
export function designedPanelToDxf(panel: Panel, surface: Surface | undefined, design: Design | undefined, library: DesignLibrary = EMPTY_LIBRARY, tool: GrooveTool = DEFAULT_GROOVE_TOOL): string {
  const ops = panelOperations(panel, design, library, tool);
  const reference = surface ? outlinePolygonOf(surface) : [];
  // origin from the surface, so all panels of one surface share it and patterns line up
  const b = bounds(reference.length ? reference : cutOutline(panel).flat);
  const shift = (pts: ArrayLike<number>) => Array.from(pts, (v, i) => v - (i % 2 === 0 ? b.minX : b.minY));
  const polylines = ops.map((o) => ({ ...o, points: shift(o.points) }));
  if (reference.length) polylines.push({ layer: LAYER.reference, points: shift(reference) });
  return writeDxf(operationLayers(tool, design?.depth ?? 3), polylines);
}
