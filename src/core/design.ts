/**
 * The design milled into the panels of one surface: a border line along the
 * edge, a pattern inside it, and artwork (logos, text) laid over everything.
 * It all goes into the top layer, so a design is two-coloured: top colour,
 * with the bottom colour showing where material is milled away.
 */
import { placeArtwork, type Graphic, type StoredArtwork } from './artwork';
import { clipLines, linesLength } from './clip';
import { writeDxf, type DxfPolyline } from './dxf';
import { LAYER, operationLayers, withUsedLayers } from './operations';
import { cutOutline, cutoutOutline, insetCut, pointInPolygon, type CutOutline, type Panel } from './panel';
import { defaultParams, patternById, patternLines, type PatternPlacement, type StoredPattern } from './patterns';
import { bounds } from './poly';
import { grow, intersect, regionArea, subtract, thicken, union, type Region } from './region';
import { outlinePolygonOf, type Surface } from './surface';
import { DEFAULT_MACHINING, grooveFootprint, radiusAtHeight, type EdgeMilling, type Machining, type Tool } from './tools';
import { firstPassShift, reverseBulged, twoWay } from './passes';

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
    depth: 3.5, // 3.0 sits exactly on the boundary between the layers; 3.5 shows the bottom colour reliably (tried on the machine 17. 11.)
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
  /** logos and text that have their own tool: their lines and filled shapes, per tool */
  byTool: { tool: Tool; lines: number[][]; pockets: Region }[];
  /** total length of groove milling, mm */
  millLength: number;
  /** total area milled out, mm² */
  pocketArea: number;
  /** where the top colour that is left is narrower than the project's narrowest strip (shown red) */
  thinStrips: Region;
  warnings: string[];
}

const closedLength = (flat: number[]) => { let s = 0; const n = flat.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += Math.hypot(flat[j * 2] - flat[i * 2], flat[j * 2 + 1] - flat[i * 2 + 1]); } return s; };
const closeLine = (r: number[]) => [...r, r[0], r[1]];

const cache = new WeakMap<Panel, { design: Design; library: DesignLibrary; key: string; result: PanelDesign }>();
const toolKey = (m: Machining) => `${JSON.stringify(m.groove)}|${JSON.stringify(m.pocket)}|${m.topLayer}|${JSON.stringify(m.tools)}|${JSON.stringify(m.passes)}|${m.minStrip}|${JSON.stringify(m.edge)}`;

/** Everything that gets milled into one panel. */
export function designPanel(panel: Panel, design: Design, library: DesignLibrary = EMPTY_LIBRARY, machining: Machining = DEFAULT_MACHINING): PanelDesign {
  const key = toolKey(machining);
  const hit = cache.get(panel);
  if (hit && hit.design === design && hit.library === library && hit.key === key) return hit.result;
  const tool = machining.groove;

  const cut = cutOutline(panel);
  const warnings: string[] = [];
  const holes = (panel.cutouts ?? []).map((c) => cutoutOutline(c).flat);
  /** the EVA of this panel: inside the cut line, outside the openings */
  const body = holes.length ? subtract([cut.flat], holes) : [cut.flat];
  const width = grooveFootprint(machining, tool, design.depth).width;

  let border = design.border.on && design.border.inset > 0 ? insetCut(panel, design.border.inset) : null;
  if (border?.warnings.some((w) => /too large|disappears/.test(w))) warnings.push('The border does not fit inside this panel at this distance from the edge.');

  // --- artwork ---
  let keepOut: Region = [];        // where the pattern (and border) must not run
  const graphicLines: number[][] = [];
  let pockets: Region = [];
  // logos and text with a tool of their own go to that tool's layers
  const extra = new Map<number, { tool: Tool; lines: number[][]; pockets: Region }>();
  const forTool = (t: Tool) => { let e = extra.get(t.number); if (!e) { e = { tool: t, lines: [], pockets: [] }; extra.set(t.number, e); } return e; };
  for (const g of design.graphics ?? []) {
    const art = library.artworks.find((a) => a.id === g.artworkId);
    if (!art) continue;
    const find = (n: number | undefined) => {
      if (n === undefined) return undefined;
      const t = machining.tools.find((x) => x.number === n);
      if (!t) warnings.push(`T${n}, chosen for “${art.text ? art.text.content : art.name}”, is not in the tool list any more. The project's tool is used instead.`);
      return t;
    };
    // filled: `tool` clears the shapes, `lineTool` mills the stroked lines; lines: `tool` mills everything
    const areaChoice = g.mode === 'area' ? find(g.tool) : undefined, lineChoice = find(g.mode === 'area' ? g.lineTool : g.tool);
    const areaTool = areaChoice ?? machining.pocket;
    const own = areaChoice && areaChoice.number !== machining.pocket.number ? areaChoice : undefined;
    const lineOwn = lineChoice && lineChoice.number !== machining.groove.number ? lineChoice : undefined;
    const addLines = (lines: number[][]) => { if (lineOwn) forTool(lineOwn).lines.push(...lines); else graphicLines.push(...lines); };
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
        // what the cutter can actually reach: anything narrower than it cuts at this depth stays unmilled
        // the cutter's narrowest part that still reaches the bottom colour (for T11: its 4.6 mm tip)
        const r = Math.max(0.5, radiusAtHeight(areaTool, Math.max(0, design.depth - machining.topLayer)));
        const lost = regionArea(mine) - regionArea(grow(grow(mine, -r), r));
        if (lost > Math.max(20, 0.03 * regionArea(mine))) warnings.push(`Parts of “${art.text ? art.text.content : art.name}” are narrower than the cutter (T${areaTool.number}, ${(2 * r).toFixed(1)} mm) and cannot be milled out fully. Make it larger, choose a smaller tool for it, use a smaller gap between shapes, or use lines instead of filled.`);
        if (own) { const e = forTool(own); e.pockets = union(e.pockets, mine); } else pockets = union(pockets, mine);
      }
      keepOut = union(keepOut, union(grow(placed.rings, Math.max(0, g.clearance)), thicken(placed.lines, g.clearance)));
      if (placed.lines.length) addLines(clipLines(placed.lines, body));
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
      addLines(clipLines(outlines, body));
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
  const byTool = [...extra.values()].sort((a, b) => a.tool.number - b.tool.number);

  // --- what is left of the top colour, and where it gets too thin to hold ---
  const thinStrips = machining.minStrip > 0 ? findThinStrips() : [];
  function findThinStrips(): Region {
    const holes = (panel.cutouts ?? []).map((c) => cutoutOutline(c).flat);
    const body = holes.length ? subtract([cut.flat], holes) : [cut.flat];
    const loop = (f: number[]) => [...f, f[0], f[1]];
    const grooves = (lines: number[][], t: Tool) => thicken(lines, grooveFootprint(machining, t, design.depth).width / 2);
    // a cleared shape reaches further at the surface: its sloped sides (2.6 mm for T11 at 3.5 deep)
    const slope = (t: Tool) => Math.max(0, radiusAtHeight(t, design.depth) - radiusAtHeight(t, Math.max(0, design.depth - machining.topLayer)));
    let milled = union(
      grooves([...(shownBorder ? [loop(shownBorder.flat)] : []), ...(borderLines ?? []), ...pattern, ...graphicLines], machining.groove),
      grow(pockets, slope(machining.pocket)),
    );
    for (const b of byTool) milled = union(milled, union(grooves(b.lines, b.tool), grow(b.pockets, slope(b.tool))));
    // the rounded outer edge lowers the top all along the cut
    if (machining.edge) milled = union(milled, subtract(body, grow(body, -machining.edge.slope)));
    const top = subtract(body, milled);
    const r = machining.minStrip / 2, thin = subtract(top, grow(grow(top, -r), r));
    // leave out the slivers every sharp corner loses
    return thin.filter((ring) => regionArea([ring]) > machining.minStrip * machining.minStrip);
  }
  if (thinStrips.length) warnings.push(`The top colour left between the milled parts is narrower than ${machining.minStrip} mm in ${thinStrips.length} place${thinStrips.length === 1 ? '' : 's'} (red in the preview). Such strips tear or break off. Move things apart, use a smaller tool for logos and text, or mill less deep.`);
  const result: PanelDesign = {
    cut, border: shownBorder, borderLines, pattern, graphicLines, pockets, byTool, thinStrips,
    millLength: (machining.passes.on ? 2 : 1) * ((shownBorder ? closedLength(shownBorder.flat) : 0) + linesLength(borderLines ?? []) + linesLength(pattern) + linesLength(graphicLines) + byTool.reduce((s, b) => s + linesLength(b.lines), 0)),
    pocketArea: regionArea(pockets) + byTool.reduce((s, b) => s + regionArea(b.pockets), 0),
    warnings,
  };
  border = shownBorder;
  cache.set(panel, { design, library, key, result });
  return result;
}

export interface EdgePaths {
  /** closed lines the edge tool's centre follows: around the panel, and inside each opening big enough */
  paths: number[][];
  /** the strip along every knife cut where the bottom colour shows after rounding */
  band: Region;
  warnings: string[];
}

const edgeCache = new WeakMap<Panel, { key: string; result: EdgePaths }>();

/**
 * The rounded edge: the tool runs `offset` mm outside the knife line (into the waste,
 * or into the opening), so after the knife cut the panel edge is rounded.
 */
export function edgePaths(panel: Panel, edge: EdgeMilling): EdgePaths {
  const key = JSON.stringify(edge);
  const hit = edgeCache.get(panel);
  if (hit && hit.key === key) return hit.result;
  const cut = cutOutline(panel);
  const holes = (panel.cutouts ?? []).map((c) => cutoutOutline(c).flat);
  const body = holes.length ? subtract([cut.flat], holes) : [cut.flat];
  const paths = grow(body, edge.offset);
  const warnings: string[] = [];
  holes.forEach((h, i) => {
    const inside = paths.some((r) => pointInPolygon(r[0], r[1], h));
    if (!inside) warnings.push(`Opening O${i + 1} is too small for the rounded edge with T${edge.tool.number} (it needs to be wider than ${Math.ceil(2 * edge.offset)} mm). It is only cut with the knife.`);
  });
  const band = edge.band > 0 ? subtract(body, grow(body, -edge.band)) : [];
  const result = { paths, band, warnings };
  edgeCache.set(panel, { key, result });
  return result;
}

/** One panel as DXF polylines on operation layers, in surface coordinates (not yet moved anywhere). */
export function panelOperations(panel: Panel, design: Design | undefined, library: DesignLibrary = EMPTY_LIBRARY, machining: Machining = DEFAULT_MACHINING): DxfPolyline[] {
  const d = design ? designPanel(panel, design, library, machining) : null;
  const cut = d?.cut ?? cutOutline(panel);
  const depth = design?.depth ?? 3;
  const groove = LAYER.groove(machining.groove, depth), pocket = LAYER.pocket(machining.pocket, depth);
  const out: DxfPolyline[] = [];
  // grooves: each line as it is, or as two passes (each line's points are in the direction to cut)
  const passes = machining.passes;
  const lines = (layer: string, ls: number[][]) => {
    for (const l of ls) {
      if (!passes.on) { out.push({ layer, points: l, closed: false }); continue; }
      // a line that ends where it starts (a logo outline) goes round as a closed loop
      const n = l.length, loop = n >= 8 && Math.hypot(l[0] - l[n - 2], l[1] - l[n - 1]) < 1e-6;
      for (const pass of twoWay(l, loop, passes)) out.push({ layer, points: pass, closed: loop });
    }
  };
  if (d?.border && design) {
    if (!passes.on) out.push({ layer: groove, points: d.border.points, bulges: d.border.bulges });
    else {
      // the border keeps its true arcs: the first pass moved inwards (to the left, counter-clockwise), the second outwards and run clockwise
      const shift = firstPassShift(passes);
      const first = insetCut(panel, design.border.inset + shift), second = insetCut(panel, design.border.inset - shift);
      out.push({ layer: groove, points: first.points, bulges: first.bulges });
      const back = reverseBulged(second.points, second.bulges);
      out.push({ layer: groove, points: back.points, bulges: back.bulges });
    }
  }
  lines(groove, [...(d?.borderLines ?? []), ...(d?.pattern ?? []), ...(d?.graphicLines ?? [])]);
  for (const r of d?.pockets ?? []) out.push({ layer: pocket, points: r });
  for (const b of d?.byTool ?? []) {
    lines(LAYER.groove(b.tool, depth), b.lines);
    for (const r of b.pockets) out.push({ layer: LAYER.pocket(b.tool, depth), points: r });
  }
  if (machining.edge) {
    const layer = LAYER.edge(machining.edge.tool, machining.edge.bottomDepth);
    for (const r of edgePaths(panel, machining.edge).paths) out.push({ layer, points: r });
  }
  for (const c of panel.cutouts ?? []) { const o = cutoutOutline(c); out.push({ layer: LAYER.innerCut, points: o.points, bulges: o.bulges }); }
  out.push({ layer: LAYER.outerCut, points: cut.points, bulges: cut.bulges });
  return out;
}

/** DXF of one panel with its design, one layer per CNC operation (see operations.ts). */
export function designedPanelToDxf(panel: Panel, surface: Surface | undefined, design: Design | undefined, library: DesignLibrary = EMPTY_LIBRARY, machining: Machining = DEFAULT_MACHINING): string {
  const ops = panelOperations(panel, design, library, machining);
  const reference = surface ? outlinePolygonOf(surface) : [];
  // origin from the surface, so all panels of one surface share it and patterns line up
  const b = bounds(reference.length ? reference : cutOutline(panel).flat);
  const shift = (pts: ArrayLike<number>) => Array.from(pts, (v, i) => v - (i % 2 === 0 ? b.minX : b.minY));
  const polylines = ops.map((o) => ({ ...o, points: shift(o.points) }));
  if (reference.length) polylines.push({ layer: LAYER.reference, points: shift(reference) });
  return writeDxf(withUsedLayers(operationLayers(machining, design?.depth ?? 3), polylines), polylines);
}
