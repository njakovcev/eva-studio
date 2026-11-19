/**
 * Sheets ready for the machine: every panel with its design, moved to its
 * place on a sheet, written as DXF with one layer per CNC operation.
 */
import { designPanel, edgePaths, panelOperations, type DesignLibrary } from './design';
import { writeDxf, type DxfPolyline, type DxfText } from './dxf';
import { applyPlacement, type NestOptions, type NestResult, type Placement } from './nest';
import { LAYER, operationLayers, withUsedLayers } from './operations';
import { cutOutline, type Panel } from './panel';
import { bounds } from './poly';
import type { Project, ProjectSettings } from './project';
import { machiningOf, minimumGap } from './tools';

/** The space between panels actually used: at least what the edge tool needs. */
export function effectiveGap(settings: ProjectSettings): number {
  return Math.max(settings.nestGap, minimumGap(machiningOf(settings).machining.edge));
}

export function nestOptionsOf(settings: ProjectSettings): NestOptions {
  return {
    sheetLength: Math.max(settings.sheet.width, settings.sheet.height),
    sheetWidth: Math.min(settings.sheet.width, settings.sheet.height),
    margin: settings.sheetMargin, gap: effectiveGap(settings),
    rotations: settings.turning === 'none' ? [0] : settings.turning === 'quarter' ? [0, 90, 180, 270] : [0, 180],
  };
}

export const nestParts = (panels: Panel[]) => panels.map((p) => ({ id: p.id, outline: cutOutline(p).flat }));

export interface SheetSummary {
  sheet: number;
  panels: number;
  usedLength: number;
  /** how far across the sheet the panels reach, mm (including the edge margin): with usedLength, the corner of the used piece */
  usedWidth: number;
  /** share of the used length that is actually panel, 0…1 */
  fill: number;
  /** what is left of the sheet beyond the used length, mm (a piece of full sheet width) */
  offcut: number;
  /** the piece beside the panels, within the used length: usedLength × this, mm */
  sideOffcut: number;
}

/** Per sheet: how far across the sheet the placed panels reach, edge margin included. */
export function usedWidths(project: Project, result: NestResult): number[] {
  const o = nestOptionsOf(project.settings);
  const outline = new Map(project.panels.map((p) => [p.id, cutOutline(p).flat] as const));
  return result.usedLength.map((_, sheet) => {
    let top = 0;
    for (const pl of result.placements) {
      const f = pl.sheet === sheet ? outline.get(pl.partId) : undefined;
      if (f) top = Math.max(top, bounds(applyPlacement(pl, f)).maxY);
    }
    return top > 0 ? Math.min(o.sheetWidth, top + o.margin) : 0;
  });
}

export function summarize(project: Project, result: NestResult): SheetSummary[] {
  const o = nestOptionsOf(project.settings);
  const area = new Map(project.panels.map((p) => { const f = cutOutline(p).flat; let a = 0; const n = f.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += f[i * 2] * f[j * 2 + 1] - f[j * 2] * f[i * 2 + 1]; } return [p.id, Math.abs(a / 2)] as const; }));
  const widths = usedWidths(project, result);
  return result.usedLength.map((used, sheet) => {
    const here = result.placements.filter((p) => p.sheet === sheet);
    const panelArea = here.reduce((s, p) => s + (area.get(p.partId) ?? 0), 0);
    return { sheet, panels: here.length, usedLength: used, usedWidth: widths[sheet], fill: used > 0 ? panelArea / (used * o.sheetWidth) : 0, offcut: Math.max(0, o.sheetLength - used), sideOffcut: Math.max(0, o.sheetWidth - widths[sheet]) };
  });
}

/** One sheet as DXF. Layers are operations in running order; labels and the sheet edge are reference only. */
export function sheetToDxf(project: Project, library: DesignLibrary, placements: Placement[], sheet: number): string {
  const o = nestOptionsOf(project.settings);
  const { machining } = machiningOf(project.settings);
  const polylines: DxfPolyline[] = [{ layer: LAYER.reference, points: [0, 0, o.sheetLength, 0, o.sheetLength, o.sheetWidth, 0, o.sheetWidth] }];
  const texts: DxfText[] = [];
  const depths = new Set<number>();
  for (const pl of placements) {
    if (pl.sheet !== sheet) continue;
    const panel = project.panels.find((p) => p.id === pl.partId);
    if (!panel) continue;
    const design = project.designs.find((d) => d.surfaceId === panel.surfaceId);
    depths.add(design?.depth ?? 3);
    for (const op of panelOperations(panel, design, library, machining)) polylines.push({ ...op, points: applyPlacement(pl, op.points) }); // turning keeps arcs as they are
    const b = bounds(applyPlacement(pl, cutOutline(panel).flat));
    texts.push({ layer: LAYER.reference, x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, height: 20, text: panel.name });
  }
  // a layer for every depth used on this sheet
  const layers = [...depths].flatMap((d) => operationLayers(machining, d)).filter((l, i, all) => all.findIndex((x) => x.name === l.name) === i);
  return writeDxf(withUsedLayers(layers.length ? layers : operationLayers(machining, 3), polylines), polylines, texts);
}

/** For each operation layer on a sheet: how much there is to do (for a quick look before cutting). */
export function operationTotals(project: Project, library: DesignLibrary, placements: Placement[]): { grooves: number; pocketArea: number; edge: number; knife: number } {
  let grooves = 0, pocketArea = 0, knife = 0, edge = 0;
  const { machining } = machiningOf(project.settings);
  const length = (f: number[]) => { let s = 0; const n = f.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += Math.hypot(f[j * 2] - f[i * 2], f[j * 2 + 1] - f[i * 2 + 1]); } return s; };
  for (const pl of placements) {
    const panel = project.panels.find((p) => p.id === pl.partId);
    if (!panel) continue;
    const design = project.designs.find((d) => d.surfaceId === panel.surfaceId);
    if (design) { const d = designPanel(panel, design, library, machining); grooves += d.millLength; pocketArea += d.pocketArea; }
    if (machining.edge) for (const r of edgePaths(panel, machining.edge).paths) edge += length(r);
    const f = cutOutline(panel).flat, n = f.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; knife += Math.hypot(f[j * 2] - f[i * 2], f[j * 2 + 1] - f[i * 2 + 1]); }
  }
  return { grooves, pocketArea, edge, knife };
}
