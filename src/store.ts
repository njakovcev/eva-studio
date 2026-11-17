import { create } from 'zustand';
import { createProject, newId, uniqueName, type Project, type ScanRef } from './core/project';
import { createSurface, surfaceToDxf, type Surface } from './core/surface';
import { createPanel, splitPanel, type EdgePoint, type Panel } from './core/panel';
import { createDesign, designedPanelToDxf, type Design, type DesignLibrary } from './core/design';
import type { Graphic, StoredArtwork } from './core/artwork';
import { CUSTOM_PREFIX, type StoredPattern } from './core/patterns';
import { parseSvg } from './core/svg';
import { outlinePolygonOf } from './core/surface';
import { bounds } from './core/poly';
import { textArtwork } from './io/fonts';
import type { NestResult } from './core/nest';
import { nestOptionsOf, nestParts, sheetToDxf } from './core/sheets';
import type { ProjectSettings } from './core/project';
import { loadScanFile, type LoadedScan } from './io/loadScan';
import {
  copyScanIntoProject, createProjectFolder, ensurePermission, openProjectFolder,
  copyGraphicIntoProject, readProjectFile, rememberProject, saveProject, writeExport,
} from './io/projectFolder';

let lastLibrary: DesignLibrary = { artworks: [], patterns: [] };
/** The project's artwork and patterns as one object that stays the same until one of them changes. */
export function libraryOf(project: Project): DesignLibrary {
  if (lastLibrary.artworks !== project.artworks || lastLibrary.patterns !== project.patterns) lastLibrary = { artworks: project.artworks, patterns: project.patterns };
  return lastLibrary;
}

export interface OpenScan extends LoadedScan { id: string; name: string }
export type Step = 'scans' | 'surfaces' | 'panels' | 'design' | 'export';
/** a side or corner of the open panel that is pointed at (in the table or in the drawing) */
export type PanelFocus = { kind: 'side' | 'corner' | 'cutout'; index: number } | null;

interface State {
  project: Project | null;
  dir: FileSystemDirectoryHandle | null;
  /** The scan currently shown in 3D. Without a project this is a "quick view". */
  scan: OpenScan | null;
  step: Step;
  /** flat area highlighted in 3D (index into scan.regions) */
  selectedRegion: number | null;
  /** surface open in the 2D outline editor */
  openSurfaceId: string | null;
  /** true while the user is picking two corners for a tape-measurement check */
  measuring: boolean;
  /** panel open in the 2D panel editor */
  openPanelId: string | null;
  panelFocus: PanelFocus;
  /** true while the user is picking the two points of a split */
  splitting: boolean;
  /** surface whose design is shown in the Design step */
  designSurfaceId: string | null;
  /** the logo or text selected in the design view */
  graphicFocus: string | null;
  /** the current arrangement of panels on sheets (not saved; recomputed when panels or rules change) */
  nest: NestResult | null;
  arranging: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
  saveState: 'saved' | 'saving' | 'failed';
  canUndo: boolean;
  canRedo: boolean;

  newProject(info: { name: string; client: string; boat: string }, parent: FileSystemDirectoryHandle): Promise<void>;
  openProject(dir: FileSystemDirectoryHandle): Promise<void>;
  closeProject(): void;
  addScan(file: File): Promise<void>;
  showScan(id: string): Promise<void>;
  removeScan(id: string): Promise<void>;
  quickView(file: File): Promise<void>;
  setStep(step: Step): void;
  selectRegion(id: number | null): void;
  addSurfaceFromRegion(): Promise<void>;
  openSurface(id: string | null): void;
  setMeasuring(on: boolean): void;
  /** `save: false` while dragging; the last change of a gesture must save. */
  updateSurface(surface: Surface, save?: boolean): Promise<void>;
  deleteSurface(id: string): Promise<void>;
  exportSurfaceDxf(id: string): Promise<void>;
  addPanel(surfaceId: string): Promise<void>;
  openPanel(id: string | null): void;
  setPanelFocus(focus: PanelFocus): void;
  updatePanel(panel: Panel, save?: boolean): Promise<void>;
  deletePanel(id: string): Promise<void>;
  exportPanelDxf(id: string): Promise<void>;
  setSplitting(on: boolean): void;
  openDesign(surfaceId: string | null): Promise<void>;
  updateDesign(design: Design, save?: boolean): Promise<void>;
  exportDesignDxfs(surfaceId: string): Promise<void>;
  setGraphicFocus(id: string | null): void;
  addLogo(file: File): Promise<void>;
  addText(): Promise<void>;
  /** Changes the wording or font of a text; its outlines are rebuilt. */
  editText(artworkId: string, content: string, font: string): Promise<void>;
  updateGraphic(graphic: Graphic, save?: boolean): Promise<void>;
  removeGraphic(id: string): Promise<void>;
  addPatternFromSvg(file: File): Promise<void>;
  arrange(): Promise<void>;
  exportSheets(): Promise<void>;
  splitOpenPanel(from: EdgePoint, to: EdgePoint): Promise<void>;
  updateSettings(change: Partial<ProjectSettings>): Promise<void>;
  /** Steps back / forward through the changes made to surfaces, panels and settings since the project was opened. */
  undo(): Promise<void>;
  redo(): Promise<void>;
  clearError(): void;
  clearNotice(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isCancel = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export const useApp = create<State>((set, get) => {
  /** Runs a task with a busy label and turns any failure into a visible message. */
  const run = async (label: string, task: () => Promise<void>) => {
    set({ busy: label, error: null });
    try { await task(); }
    catch (e) { if (!isCancel(e)) set({ error: message(e) }); }
    finally { set({ busy: null }); }
  };

  let arrangeTicket = 0;

  // ---- undo history: earlier saved states of the project (kept in memory only) ----
  const HISTORY_LIMIT = 100;
  let undoStack: Project[] = [], redoStack: Project[] = [];
  /** the project as last saved; while a corner is being dragged the screen is ahead of this */
  let lastSaved: Project | null = null;
  const resetHistory = (project: Project | null) => {
    undoStack = []; redoStack = []; lastSaved = project;
    set({ canUndo: false, canRedo: false });
  };

  const persist = async (project: Project, history = true) => {
    const dir = get().dir;
    if (!dir) return;
    if (history && lastSaved && lastSaved !== project) {
      undoStack.push(lastSaved);
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
    }
    lastSaved = project;
    set({ project, saveState: 'saving', canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
    try { await saveProject(dir, project); set({ saveState: 'saved' }); }
    catch (e) { set({ saveState: 'failed', error: `The project could not be saved: ${message(e)}` }); }
  };

  /** Shows an earlier (or later) state. Keeps the same surface or panel open where it still exists. */
  const travel = async (from: Project[], to: Project[]) => {
    const target = from.pop();
    const now = lastSaved;
    if (!target || !now) return;
    to.push(now);
    const { openSurfaceId, openPanelId } = get();
    const fix = <T extends { id: string }>(open: string | null, before: T[], after: T[], sameGroup: (a: T, b: T) => boolean) => {
      if (!open || after.some((x) => x.id === open)) return open;
      // the open item no longer exists (e.g. a split was undone): open what took its place
      const was = before.find((x) => x.id === open);
      const fresh = after.filter((x) => !before.some((y) => y.id === x.id));
      return (fresh.find((x) => !was || sameGroup(x, was)) ?? fresh[0])?.id ?? null;
    };
    set({
      openSurfaceId: fix(openSurfaceId, now.surfaces, target.surfaces, () => true),
      openPanelId: fix(openPanelId, now.panels, target.panels, (a, b) => a.surfaceId === b.surfaceId),
      panelFocus: null, measuring: false, splitting: false, graphicFocus: null,
    });
    await persist(target, false);
  };

  const load = async (ref: ScanRef) => {
    const file = await readProjectFile(get().dir!, ref.file);
    set({ scan: { id: ref.id, name: ref.name, ...(await loadScanFile(file)) }, selectedRegion: null });
  };

  /** A new logo or text goes to the middle of the surface, at about a third of its width. */
  const placeNew = (art: StoredArtwork, surface: Project['surfaces'][number], mode: Graphic['mode']): Graphic => {
    const b = bounds(outlinePolygonOf(surface));
    const width = Math.round(Math.min((b.maxX - b.minX) / 3, ((b.maxY - b.minY) / 3) * (art.width / art.height)));
    return { id: newId(), artworkId: art.id, x: Math.round((b.minX + b.maxX) / 2), y: Math.round((b.minY + b.maxY) / 2), width: Math.max(20, width), angle: 0, mode, clearance: 10 };
  };

  const closed = { project: null, dir: null, scan: null, step: 'scans' as Step, selectedRegion: null, openSurfaceId: null, measuring: false, openPanelId: null, panelFocus: null as PanelFocus, splitting: false, designSurfaceId: null, graphicFocus: null, nest: null, arranging: false, error: null, notice: null };

  return {
    ...closed, busy: null, saveState: 'saved', canUndo: false, canRedo: false,

    newProject: (info, parent) => run('Creating project…', async () => {
      const project = createProject(info);
      const dir = await createProjectFolder(parent, project);
      set({ ...closed, project, dir, saveState: 'saved' });
      resetHistory(project);
      await rememberProject(project, dir);
    }),

    openProject: (dir) => run('Opening project…', async () => {
      if (!(await ensurePermission(dir))) throw new Error('Access to the folder was not allowed.');
      const project = await openProjectFolder(dir);
      set({ ...closed, project, dir, saveState: 'saved' });
      resetHistory(project);
      await rememberProject(project, dir);
      if (project.scans.length) await load(project.scans[0]);
    }),

    closeProject: () => { set(closed); resetHistory(null); },

    addScan: (file) => run(`Reading ${file.name}…`, async () => {
      const { project, dir } = get();
      if (!project || !dir) return;
      // Parse first: a file that cannot be read is never copied into the project.
      const loaded = await loadScanFile(file);
      const path = await copyScanIntoProject(dir, file);
      const ref: ScanRef = {
        id: newId(), name: path.split('/').pop()!, file: path, units: 'mm',
        addedAt: new Date().toISOString(), stats: loaded.stats,
      };
      set({ scan: { id: ref.id, name: ref.name, ...loaded }, selectedRegion: null });
      // adding or removing a scan is not part of the undo history (the file on disk would not follow)
      await persist({ ...project, scans: [...project.scans, ref] }, false);
      resetHistory(get().project);
    }),

    showScan: (id) => run('Loading scan…', async () => {
      const ref = get().project?.scans.find((s) => s.id === id);
      if (ref && get().scan?.id !== id) await load(ref);
    }),

    // Removes the scan from the project list only. The file stays in scans/.
    removeScan: async (id) => {
      const { project, scan } = get();
      if (!project) return;
      if (scan?.id === id) set({ scan: null, selectedRegion: null });
      await persist({ ...project, scans: project.scans.filter((s) => s.id !== id) }, false);
      resetHistory(get().project);
    },

    quickView: (file) => run(`Reading ${file.name}…`, async () => {
      set({ scan: { id: 'quick', name: file.name, ...(await loadScanFile(file)) }, selectedRegion: null });
    }),

    setStep: (step) => set({ step, openSurfaceId: null, measuring: false, openPanelId: null, panelFocus: null, splitting: false, designSurfaceId: null, graphicFocus: null }),
    selectRegion: (id) => set({ selectedRegion: id }),

    addSurfaceFromRegion: async () => {
      const { project, scan, selectedRegion } = get();
      if (!project || !scan || selectedRegion === null) return;
      const region = scan.regions[selectedRegion];
      try {
        const name = uniqueName(`Surface ${project.surfaces.length + 1}`, project.surfaces.map((s) => s.name));
        const surface = createSurface({ id: newId(), name, scanId: scan.id, region, raw: region.raw });
        set({ openSurfaceId: surface.id, selectedRegion: null });
        await persist({ ...project, surfaces: [...project.surfaces, surface] });
      } catch (e) {
        set({ error: `This area could not be turned into a surface: ${message(e)}` });
      }
    },

    openSurface: (id) => set({ openSurfaceId: id, measuring: false }),
    setMeasuring: (on) => set({ measuring: on }),

    updateSurface: async (surface, save = true) => {
      const { project } = get();
      if (!project) return;
      const next = { ...project, surfaces: project.surfaces.map((s) => (s.id === surface.id ? surface : s)) };
      if (save) await persist(next); else set({ project: next });
    },

    deleteSurface: async (id) => {
      const { project, openSurfaceId } = get();
      if (!project) return;
      if (openSurfaceId === id) set({ openSurfaceId: null });
      await persist({ ...project, surfaces: project.surfaces.filter((s) => s.id !== id) });
    },

    exportSurfaceDxf: async (id) => {
      const { project, dir } = get();
      const surface = project?.surfaces.find((s) => s.id === id);
      if (!surface || !dir) return;
      try {
        const path = await writeExport(dir, `${surface.name}.dxf`, surfaceToDxf(surface));
        set({ notice: `Saved to ${path} in the project folder.` });
      } catch (e) {
        set({ error: `The DXF could not be saved: ${message(e)}` });
      }
    },

    addPanel: async (surfaceId) => {
      const { project } = get();
      const surface = project?.surfaces.find((s) => s.id === surfaceId);
      if (!project || !surface) return;
      const name = uniqueName(`Panel ${project.panels.length + 1}`, project.panels.map((p) => p.name));
      const panel = createPanel({ id: newId(), name, surface, settings: project.settings });
      set({ openPanelId: panel.id, panelFocus: null });
      await persist({ ...project, panels: [...project.panels, panel] });
    },

    openPanel: (id) => set({ openPanelId: id, panelFocus: null, splitting: false }),
    setSplitting: (on) => set({ splitting: on, panelFocus: null }),
    setPanelFocus: (focus) => set({ panelFocus: focus }),

    updatePanel: async (panel, save = true) => {
      const { project } = get();
      if (!project) return;
      const next = { ...project, panels: project.panels.map((p) => (p.id === panel.id ? panel : p)) };
      if (save) await persist(next); else set({ project: next });
    },

    deletePanel: async (id) => {
      const { project, openPanelId } = get();
      if (!project) return;
      if (openPanelId === id) set({ openPanelId: null });
      await persist({ ...project, panels: project.panels.filter((p) => p.id !== id) });
    },

    splitOpenPanel: async (from, to) => {
      const { project, openPanelId } = get();
      const panel = project?.panels.find((p) => p.id === openPanelId);
      if (!project || !panel) return;
      try {
        const taken = project.panels.filter((p) => p.id !== panel.id).map((p) => p.name);
        const nameA = uniqueName(`${panel.name} A`, taken), nameB = uniqueName(`${panel.name} B`, [...taken, nameA]);
        const [a, b] = splitPanel(panel, from, to, {
          gap: project.settings.panelGap, radius: Math.min(project.settings.defaultCornerRadius, 5),
          ids: [newId(), newId()], names: [nameA, nameB],
        });
        set({ splitting: false, openPanelId: a.id, panelFocus: null });
        await persist({ ...project, panels: project.panels.flatMap((p) => (p.id === panel.id ? [a, b] : [p])) });
      } catch (e) {
        set({ splitting: false, error: message(e) });
      }
    },

    updateSettings: async (change) => {
      const { project } = get();
      if (project) await persist({ ...project, settings: { ...project.settings, ...change } });
    },

    openDesign: async (surfaceId) => {
      const { project } = get();
      set({ designSurfaceId: surfaceId, graphicFocus: null });
      if (!project || !surfaceId || project.designs.some((d) => d.surfaceId === surfaceId)) return;
      // first visit: start this surface with the default design
      await persist({ ...project, designs: [...project.designs, createDesign(newId(), surfaceId)] });
    },

    updateDesign: async (design, save = true) => {
      const { project } = get();
      if (!project) return;
      const next = { ...project, designs: project.designs.map((d) => (d.id === design.id ? design : d)) };
      if (save) await persist(next); else set({ project: next });
    },

    exportDesignDxfs: async (surfaceId) => {
      const { project, dir } = get();
      if (!project || !dir) return;
      const surface = project.surfaces.find((s) => s.id === surfaceId);
      const design = project.designs.find((d) => d.surfaceId === surfaceId);
      const panels = project.panels.filter((p) => p.surfaceId === surfaceId);
      try {
        for (const panel of panels) await writeExport(dir, `${panel.name}.dxf`, designedPanelToDxf(panel, surface, design, libraryOf(project)));
        set({ notice: `Saved ${panels.length} DXF file${panels.length === 1 ? '' : 's'} to the export folder of the project.` });
      } catch (e) {
        set({ error: `The DXF files could not be saved: ${message(e)}` });
      }
    },

    setGraphicFocus: (id) => set({ graphicFocus: id }),

    addLogo: (file) => run(`Reading ${file.name}…`, async () => {
      const { project, dir, designSurfaceId } = get();
      const design = project?.designs.find((d) => d.surfaceId === designSurfaceId);
      const surface = project?.surfaces.find((s) => s.id === designSurfaceId);
      if (!project || !dir || !design || !surface) return;
      const art = parseSvg(await file.text());
      await copyGraphicIntoProject(dir, file);
      const stored: StoredArtwork = { id: newId(), name: file.name.replace(/\.svg$/i, ''), width: art.width, height: art.height, rings: art.rings, lines: art.lines };
      const graphic = placeNew(stored, surface, art.rings.length ? 'area' : 'line');
      set({ graphicFocus: graphic.id });
      if (art.skipped.length) set({ notice: `Left out of this logo: ${art.skipped.join(', ')}.` });
      await persist({ ...project, artworks: [...project.artworks, stored], designs: project.designs.map((d) => (d.id === design.id ? { ...d, graphics: [...(d.graphics ?? []), graphic] } : d)) });
    }),

    addText: () => run('Preparing the font…', async () => {
      const { project, designSurfaceId } = get();
      const design = project?.designs.find((d) => d.surfaceId === designSurfaceId);
      const surface = project?.surfaces.find((s) => s.id === designSurfaceId);
      if (!project || !design || !surface) return;
      const text = { content: project.project.boat || project.project.name || 'TEXT', font: 'montserrat' };
      const o = await textArtwork(text.content, text.font);
      const stored: StoredArtwork = { id: newId(), name: text.content, width: o.width, height: o.height, rings: o.rings, lines: [], text };
      const graphic = placeNew(stored, surface, 'area');
      set({ graphicFocus: graphic.id });
      await persist({ ...project, artworks: [...project.artworks, stored], designs: project.designs.map((d) => (d.id === design.id ? { ...d, graphics: [...(d.graphics ?? []), graphic] } : d)) });
    }),

    editText: async (artworkId, content, font) => {
      const { project } = get();
      const art = project?.artworks.find((a) => a.id === artworkId);
      if (!project || !art || !content.trim()) return;
      try {
        const o = await textArtwork(content, font);
        if (o.missing.length) set({ notice: `This font has no ${o.missing.map((c) => `“${c}”`).join(', ')}: left out.` });
        // keep the letter height: the width of every placement follows the new length of the text
        const grow = (o.width / o.height) / (art.width / art.height);
        const uses = (g: Graphic) => (g.artworkId === artworkId ? { ...g, width: Math.round(g.width * grow) } : g);
        await persist({
          ...project,
          artworks: project.artworks.map((a) => (a.id === artworkId ? { ...a, name: content, width: o.width, height: o.height, rings: o.rings, text: { content, font } } : a)),
          designs: project.designs.map((d) => ({ ...d, graphics: (d.graphics ?? []).map(uses) })),
        });
      } catch (e) { set({ error: message(e) }); }
    },

    updateGraphic: async (graphic, save = true) => {
      const { project } = get();
      if (!project) return;
      const next = { ...project, designs: project.designs.map((d) => ((d.graphics ?? []).some((g) => g.id === graphic.id) ? { ...d, graphics: d.graphics!.map((g) => (g.id === graphic.id ? graphic : g)) } : d)) };
      if (save) await persist(next); else set({ project: next });
    },

    removeGraphic: async (id) => {
      const { project } = get();
      if (!project) return;
      set({ graphicFocus: null });
      const designs = project.designs.map((d) => ({ ...d, graphics: (d.graphics ?? []).filter((g) => g.id !== id) }));
      // artwork nobody uses any more leaves the project file too
      const used = new Set(designs.flatMap((d) => d.graphics.map((g) => g.artworkId)));
      await persist({ ...project, designs, artworks: project.artworks.filter((a) => used.has(a.id)) });
    },

    addPatternFromSvg: (file) => run(`Reading ${file.name}…`, async () => {
      const { project, dir, designSurfaceId } = get();
      const design = project?.designs.find((d) => d.surfaceId === designSurfaceId);
      if (!project || !dir || !design) return;
      const art = parseSvg(await file.text());
      await copyGraphicIntoProject(dir, file);
      // a tile is used as lines: outlines of filled shapes count as lines too
      const stored: StoredPattern = {
        id: newId(), name: file.name.replace(/\.svg$/i, ''), tileWidth: art.width, tileHeight: art.height,
        lines: [...art.rings.map((r) => [...r, r[0], r[1]]), ...art.lines],
      };
      await persist({
        ...project, patterns: [...project.patterns, stored],
        designs: project.designs.map((d) => (d.id === design.id ? { ...d, pattern: { ...d.pattern, kind: CUSTOM_PREFIX + stored.id, params: { size: 100, brick: 0 } } } : d)),
      });
    }),

    arrange: async () => {
      const { project } = get();
      if (!project) return;
      if (!project.panels.length) { set({ nest: null }); return; }
      const ticket = ++arrangeTicket;
      set({ arranging: true });
      try {
        const worker = new Worker(new URL('./core/nestWorker.ts', import.meta.url), { type: 'module' });
        const result = await new Promise<NestResult>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent<{ ok: true; result: NestResult } | { ok: false; error: string }>) => (e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error)));
          worker.onerror = (e) => reject(new Error(e.message || 'The panels could not be arranged.'));
          worker.postMessage({ parts: nestParts(project.panels), options: nestOptionsOf(project.settings) });
        }).finally(() => worker.terminate());
        if (ticket === arrangeTicket) set({ nest: result }); // a newer request has taken over otherwise
      } catch (e) {
        if (ticket === arrangeTicket) set({ nest: null, error: message(e) });
      } finally {
        if (ticket === arrangeTicket) set({ arranging: false });
      }
    },

    exportSheets: async () => {
      const { project, dir, nest: result } = get();
      if (!project || !dir || !result) return;
      try {
        for (let i = 0; i < result.sheets; i++) await writeExport(dir, `Sheet ${i + 1}.dxf`, sheetToDxf(project, libraryOf(project), result.placements, i));
        set({ notice: `Saved ${result.sheets} sheet file${result.sheets === 1 ? '' : 's'} (Sheet 1.dxf…) to the export folder of the project.` });
      } catch (e) {
        set({ error: `The sheet files could not be saved: ${message(e)}` });
      }
    },

    exportPanelDxf: async (id) => {
      const { project, dir } = get();
      const panel = project?.panels.find((p) => p.id === id);
      if (!project || !panel || !dir) return;
      try {
        const surface = project.surfaces.find((s) => s.id === panel.surfaceId);
        // if this surface already has a design, its milling lines are part of the file
        const design = project.designs.find((d) => d.surfaceId === panel.surfaceId);
        const path = await writeExport(dir, `${panel.name}.dxf`, designedPanelToDxf(panel, surface, design, libraryOf(project)));
        set({ notice: `Saved to ${path} in the project folder.` });
      } catch (e) {
        set({ error: `The DXF could not be saved: ${message(e)}` });
      }
    },

    undo: () => travel(undoStack, redoStack),
    redo: () => travel(redoStack, undoStack),

    clearError: () => set({ error: null }),
    clearNotice: () => set({ notice: null }),
  };
});
