/**
 * The project file (project.json). This is the contract between all steps
 * of the app: Surfaces, Panels, Design, Export.
 *
 * Rules:
 *  - All lengths are millimetres.
 *  - Never remove or rename a field without bumping FORMAT_VERSION and
 *    adding a step to `migrate`, so that old projects always open.
 */
import type { MeshStats } from './mesh';
import type { Surface } from './surface';
import type { Panel } from './panel';
import type { Design } from './design';
import type { StoredArtwork } from './artwork';
import type { StoredPattern } from './patterns';
import type { Sketch } from './sketch/model';
import { DEFAULT_TOOLS, defaultMachiningSettings, type MachiningSettings, type Tool } from './tools';

export const FORMAT_VERSION = 3;
export const PROJECT_FILE = 'project.json';
export const FOLDERS = { scans: 'scans', graphics: 'graphics', photos: 'photos', export: 'export' } as const;

export interface ScanRef {
  id: string;
  name: string;
  /** path inside the project folder, e.g. "scans/deck.obj" */
  file: string;
  units: 'mm';
  addedAt: string;
  stats: MeshStats;
}

export interface ProjectSettings {
  sheet: { width: number; height: number };
  material: { thickness: number; topLayer: number; topColor: string; bottomColor: string };
  defaultEdgeOffset: number;
  defaultCornerRadius: number;
  /** gap left between neighbouring panels when one is split, mm */
  panelGap: number;
  /** arranging panels on sheets: space between parts, distance from the sheet edge (mm), and how parts may be turned */
  nestGap: number;
  sheetMargin: number;
  /** 'half': only half-way round (keeps the brushing direction); 'quarter': any quarter turn; 'none': never */
  turning: 'half' | 'quarter' | 'none';
  /** the milling tools available (v2: was an unused list of another shape; v3: renumbered T20/21/22 → T10/11/12) */
  tools: Tool[];
  /** which tool does which job, and how the outer edge is rounded */
  machining: MachiningSettings;
}

export interface Project {
  app: 'eva-studio';
  formatVersion: number;
  project: {
    id: string;
    name: string;
    client: string;
    boat: string;
    notes: string;
    createdAt: string;
    updatedAt: string;
  };
  settings: ProjectSettings;
  scans: ScanRef[];
  /** Flat surfaces picked from scans. */
  surfaces: Surface[];
  /** EVA panels laid on surfaces. */
  panels: Panel[];
  /** One design per surface. */
  designs: Design[];
  /** Logos, drawings and text used in designs. */
  artworks: StoredArtwork[];
  /** The user's own repeating patterns. */
  patterns: StoredPattern[];
  /** Surfaces drawn by hand (over a photo, with tape measurements). */
  sketches: Sketch[];
}

export function defaultSettings(): ProjectSettings {
  return {
    sheet: { width: 2400, height: 1200 },
    material: { thickness: 6, topLayer: 3, topColor: '#8a8f94', bottomColor: '#1c1c1c' },
    defaultEdgeOffset: 15,
    defaultCornerRadius: 20,
    panelGap: 4,
    nestGap: 8,
    sheetMargin: 10,
    turning: 'half',
    tools: DEFAULT_TOOLS.map((t) => ({ ...t, profile: { ...t.profile } })),
    machining: defaultMachiningSettings(),
  };
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function createProject(info: { name: string; client?: string; boat?: string }, now = new Date()): Project {
  const stamp = now.toISOString();
  return {
    app: 'eva-studio',
    formatVersion: FORMAT_VERSION,
    project: {
      id: newId(),
      name: info.name.trim(),
      client: (info.client ?? '').trim(),
      boat: (info.boat ?? '').trim(),
      notes: '',
      createdAt: stamp,
      updatedAt: stamp,
    },
    settings: defaultSettings(),
    scans: [],
    surfaces: [],
    panels: [],
    designs: [],
    artworks: [],
    patterns: [],
    sketches: [],
  };
}

/** Brings a project written by an older version up to the current format. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let version = raw.formatVersion as number;
  if (version === 1) {
    // v2: `settings.tools` became the machine's milling tools (it was an unused, always empty list),
    // and `settings.machining` says which tool does which job.
    const settings = { ...((raw.settings as Record<string, unknown>) ?? {}) };
    settings.tools = DEFAULT_TOOLS.map((t) => ({ ...t, profile: { ...t.profile } }));
    settings.machining = defaultMachiningSettings();
    raw = { ...raw, settings, formatVersion: 2 };
    version = 2;
  }
  if (version === 2) {
    // v3: the tools were renumbered on the machine: T20 → T10, T21 → T11, T22 → T12
    const renumber = (n: unknown) => (n === 20 ? 10 : n === 21 ? 11 : n === 22 ? 12 : n);
    const settings = { ...((raw.settings as Record<string, unknown>) ?? {}) };
    if (Array.isArray(settings.tools)) settings.tools = settings.tools.map((t: Record<string, unknown>) => ({ ...t, number: renumber(t.number) }));
    const m = settings.machining as Record<string, unknown> | undefined;
    if (m) {
      const edge = m.edge as Record<string, unknown> | undefined;
      settings.machining = { ...m, groove: renumber(m.groove), pocket: renumber(m.pocket), ...(edge ? { edge: { ...edge, tool: renumber(edge.tool) } } : {}) };
    }
    raw = { ...raw, settings, formatVersion: 3 };
    version = 3;
  }
  return raw;
}

/** Reads project.json text. Throws a readable error if it is not a valid project. */
export function parseProject(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('project.json is not readable (invalid JSON).');
  }
  if (typeof raw !== 'object' || raw === null || (raw as Project).app !== 'eva-studio') {
    throw new Error('This folder does not contain an EVA Studio project.');
  }
  const version = (raw as Project).formatVersion;
  if (typeof version !== 'number') throw new Error('project.json has no format version.');
  if (version > FORMAT_VERSION) {
    throw new Error('This project was saved by a newer version of EVA Studio. Reload the app to update it.');
  }
  const p = migrate(raw as Record<string, unknown>) as unknown as Project;
  if (!p.project || typeof p.project.name !== 'string') throw new Error('project.json is missing the project name.');
  // Fill anything missing with defaults, so partial files still open.
  p.settings = { ...defaultSettings(), ...(p.settings ?? {}) };
  p.settings.machining = { ...defaultMachiningSettings(), ...p.settings.machining, edge: { ...defaultMachiningSettings().edge, ...p.settings.machining?.edge } };
  p.scans = Array.isArray(p.scans) ? p.scans : [];
  p.surfaces = Array.isArray(p.surfaces) ? p.surfaces : [];
  p.panels = Array.isArray(p.panels) ? p.panels : [];
  p.designs = Array.isArray(p.designs) ? p.designs : [];
  p.artworks = Array.isArray(p.artworks) ? p.artworks : [];
  p.patterns = Array.isArray(p.patterns) ? p.patterns : [];
  p.sketches = Array.isArray(p.sketches) ? p.sketches : [];
  p.formatVersion = FORMAT_VERSION;
  return p;
}

export function serializeProject(p: Project, now = new Date()): string {
  const out: Project = { ...p, project: { ...p.project, updatedAt: now.toISOString() } };
  return JSON.stringify(out, null, 2) + '\n';
}

/** Makes a file name that is safe on Windows and macOS. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return cleaned || 'untitled';
}

/** Picks a name not already used, by adding " (2)", " (3)" … before the extension. */
export function uniqueName(wanted: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(wanted.toLowerCase())) return wanted;
  const dot = wanted.lastIndexOf('.');
  const base = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : '';
  for (let k = 2; ; k++) {
    const candidate = `${base} (${k})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}
