import { create } from 'zustand';
import { createProject, newId, uniqueName, type Project, type ScanRef } from './core/project';
import { createSurface, surfaceToDxf, type Surface } from './core/surface';
import { createPanel, panelToDxf, splitPanel, type EdgePoint, type Panel } from './core/panel';
import type { ProjectSettings } from './core/project';
import { loadScanFile, type LoadedScan } from './io/loadScan';
import {
  copyScanIntoProject, createProjectFolder, ensurePermission, openProjectFolder,
  readProjectFile, rememberProject, saveProject, writeExport,
} from './io/projectFolder';

export interface OpenScan extends LoadedScan { id: string; name: string }
export type Step = 'scans' | 'surfaces' | 'panels';
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
  busy: string | null;
  error: string | null;
  notice: string | null;
  saveState: 'saved' | 'saving' | 'failed';

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
  splitOpenPanel(from: EdgePoint, to: EdgePoint): Promise<void>;
  updateSettings(change: Partial<ProjectSettings>): Promise<void>;
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

  const persist = async (project: Project) => {
    const dir = get().dir;
    if (!dir) return;
    set({ project, saveState: 'saving' });
    try { await saveProject(dir, project); set({ saveState: 'saved' }); }
    catch (e) { set({ saveState: 'failed', error: `The project could not be saved: ${message(e)}` }); }
  };

  const load = async (ref: ScanRef) => {
    const file = await readProjectFile(get().dir!, ref.file);
    set({ scan: { id: ref.id, name: ref.name, ...(await loadScanFile(file)) }, selectedRegion: null });
  };

  const closed = { project: null, dir: null, scan: null, step: 'scans' as Step, selectedRegion: null, openSurfaceId: null, measuring: false, openPanelId: null, panelFocus: null as PanelFocus, splitting: false, error: null, notice: null };

  return {
    ...closed, busy: null, saveState: 'saved',

    newProject: (info, parent) => run('Creating project…', async () => {
      const project = createProject(info);
      const dir = await createProjectFolder(parent, project);
      set({ ...closed, project, dir, saveState: 'saved' });
      await rememberProject(project, dir);
    }),

    openProject: (dir) => run('Opening project…', async () => {
      if (!(await ensurePermission(dir))) throw new Error('Access to the folder was not allowed.');
      const project = await openProjectFolder(dir);
      set({ ...closed, project, dir, saveState: 'saved' });
      await rememberProject(project, dir);
      if (project.scans.length) await load(project.scans[0]);
    }),

    closeProject: () => set(closed),

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
      await persist({ ...project, scans: [...project.scans, ref] });
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
      await persist({ ...project, scans: project.scans.filter((s) => s.id !== id) });
    },

    quickView: (file) => run(`Reading ${file.name}…`, async () => {
      set({ scan: { id: 'quick', name: file.name, ...(await loadScanFile(file)) }, selectedRegion: null });
    }),

    setStep: (step) => set({ step, openSurfaceId: null, measuring: false, openPanelId: null, panelFocus: null, splitting: false }),
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

    exportPanelDxf: async (id) => {
      const { project, dir } = get();
      const panel = project?.panels.find((p) => p.id === id);
      if (!project || !panel || !dir) return;
      try {
        const surface = project.surfaces.find((s) => s.id === panel.surfaceId);
        const path = await writeExport(dir, `${panel.name}.dxf`, panelToDxf(panel, surface));
        set({ notice: `Saved to ${path} in the project folder.` });
      } catch (e) {
        set({ error: `The DXF could not be saved: ${message(e)}` });
      }
    },

    clearError: () => set({ error: null }),
    clearNotice: () => set({ notice: null }),
  };
});
