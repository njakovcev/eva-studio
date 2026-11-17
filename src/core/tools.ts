/**
 * Milling tools and which one does which job. A tool's profile decides how wide
 * it cuts at a given depth, which the design preview, the checks and the edge
 * rounding rely on. (See alati/Glodala-HS1330 in the project notes.)
 */
import type { ProjectSettings } from './project';

export type ToolProfile =
  /** form cutter: a straight tip, then widening along a quarter circle */
  | { kind: 'form'; tipDiameter: number; tipHeight: number; radius: number }
  /** ball: a sphere of this radius */
  | { kind: 'ball'; radius: number };

export interface Tool {
  /** number in the machine's tool list (T21 → 21) */
  number: number;
  name: string;
  profile: ToolProfile;
  rpm: number;
  feed: number;
  plunge: number;
}
/** @deprecated older name */
export type GrooveTool = Tool;

/** T21: form cutter 4.6*2H*R3.05, for grooves (teak lines). */
export const T21: Tool = {
  number: 21, name: 'Groove form cutter 4.6',
  profile: { kind: 'form', tipDiameter: 4.6, tipHeight: 2, radius: 3.05 },
  rpm: 18000, feed: 3500, plunge: 800,
};
/** T20: ball burr Ø25, for the rounded outer edge. */
export const T20: Tool = {
  number: 20, name: 'Ball burr Ø25',
  profile: { kind: 'ball', radius: 12.5 },
  rpm: 12000, feed: 2000, plunge: 500,
};
export const DEFAULT_GROOVE_TOOL = T21;
export const DEFAULT_TOOLS: Tool[] = [T20, T21];

/** How far from its axis the tool cuts at `height` above its lowest point, mm. */
export function radiusAtHeight(tool: Tool, height: number): number {
  const p = tool.profile, h = Math.max(0, height);
  if (p.kind === 'ball') return h >= p.radius ? p.radius : Math.sqrt(p.radius * p.radius - (p.radius - h) ** 2);
  if (h <= p.tipHeight) return p.tipDiameter / 2;
  const k = Math.min(h - p.tipHeight, p.radius);
  return p.tipDiameter / 2 + p.radius - Math.sqrt(p.radius * p.radius - k * k);
}

/** Width of the groove at the surface of the sheet when milled `depth` mm deep. */
export const grooveWidth = (tool: Tool, depth: number) => 2 * radiusAtHeight(tool, depth);

/** Largest cutting diameter. */
export function maxDiameter(tool: Tool): number {
  const p = tool.profile;
  return p.kind === 'ball' ? 2 * p.radius : p.tipDiameter + 2 * p.radius;
}

export function describeTool(t: Tool): string {
  const p = t.profile;
  return p.kind === 'ball' ? `T${t.number} · ball Ø${2 * p.radius}` : `T${t.number} · form Ø${p.tipDiameter}, R${p.radius}`;
}

// ---------- which tool does which job ----------

/** Rounded outer edge: a tool running just outside every knife cut before the knife. */
export interface EdgeMilling {
  tool: Tool;
  /** how deep the tool's lowest point goes, mm */
  bottomDepth: number;
  /** thickness left where the knife cuts, mm */
  leftAtEdge: number;
  /** the tool's path runs this far outside the knife line, mm */
  offset: number;
  /** from the knife line inwards: bottom colour shows for `band` mm, the slope ends at `slope` mm */
  band: number;
  slope: number;
  /** on the surface the tool reaches this far outside the knife line, mm */
  reach: number;
}

export interface Machining {
  groove: Tool;
  pocket: Tool;
  edge: EdgeMilling | null;
}

export const DEFAULT_MACHINING: Machining = { groove: T21, pocket: T21, edge: null };

export interface MachiningSettings {
  /** tool numbers */
  groove: number;
  pocket: number;
  edge: { on: boolean; tool: number; bottomDepth: number; leftAtEdge: number };
}

export function defaultMachiningSettings(): MachiningSettings {
  return { groove: 21, pocket: 21, edge: { on: true, tool: 20, bottomDepth: 5, leftAtEdge: 2 } };
}

/**
 * Works out the edge path for a tool. Returns a reason instead when the numbers
 * cannot work (e.g. more left at the edge than the sheet is thick).
 */
export function edgeMilling(tool: Tool, bottomDepth: number, leftAtEdge: number, thickness: number, topLayer: number): EdgeMilling | string {
  const atEdge = thickness - leftAtEdge; // depth milled where the knife cuts
  if (!(bottomDepth > 0) || bottomDepth >= thickness) return `The edge tool must go less deep than the sheet is thick (${thickness} mm).`;
  if (!(leftAtEdge > 0) || leftAtEdge >= thickness) return `The thickness left at the edge must be between 0 and ${thickness} mm.`;
  if (atEdge > bottomDepth) return `To leave ${leftAtEdge} mm at the edge the tool must go at least ${atEdge} mm deep. Set the depth to ${atEdge} mm or more.`;
  const rise = bottomDepth - atEdge;
  const p = tool.profile;
  const maxRise = p.kind === 'ball' ? p.radius : p.tipHeight + p.radius;
  if (rise > maxRise) return `T${tool.number} is too small for this: its rounded part is only ${maxRise} mm high.`;
  const offset = radiusAtHeight(tool, rise);
  const band = Math.max(0, radiusAtHeight(tool, bottomDepth - topLayer) - offset);
  const reachInside = radiusAtHeight(tool, bottomDepth);
  return { tool, bottomDepth, leftAtEdge, offset, band, slope: Math.max(0, reachInside - offset), reach: reachInside + offset };
}

/** The tools chosen in the project settings, and any problem with the choice. */
const machiningCache = new WeakMap<object, { machining: Machining; problems: string[] }>();
export function machiningOf(settings: Pick<ProjectSettings, 'tools' | 'machining' | 'material'>): { machining: Machining; problems: string[] } {
  const hit = machiningCache.get(settings);
  if (hit) return hit;
  const result = workOutMachining(settings);
  machiningCache.set(settings, result);
  return result;
}

function workOutMachining(settings: Pick<ProjectSettings, 'tools' | 'machining' | 'material'>): { machining: Machining; problems: string[] } {
  const tools = settings.tools.length ? settings.tools : DEFAULT_TOOLS;
  const m = settings.machining ?? defaultMachiningSettings();
  const problems: string[] = [];
  const pick = (n: number, job: string) => {
    const t = tools.find((x) => x.number === n);
    if (!t) problems.push(`Tool T${n} for ${job} is not in the tool list. Pick another tool.`);
    return t ?? DEFAULT_GROOVE_TOOL;
  };
  const groove = pick(m.groove, 'grooves'), pocket = pick(m.pocket, 'clearing out');
  let edge: EdgeMilling | null = null;
  if (m.edge.on) {
    const t = pick(m.edge.tool, 'the outer edge');
    const e = edgeMilling(t, m.edge.bottomDepth, m.edge.leftAtEdge, settings.material.thickness, settings.material.topLayer);
    if (typeof e === 'string') problems.push(e); else edge = e;
  }
  return { machining: { groove, pocket, edge }, problems };
}

/** Space panels need between them on a sheet so the edge tool of one does not cut into its neighbour. */
export const minimumGap = (edge: EdgeMilling | null) => (edge ? Math.ceil(2 * edge.offset * 10) / 10 : 0);
