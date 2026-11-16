import { create } from 'zustand';
import type { MeshData } from './core/obj';
import type { MeshStats } from './core/mesh';
import { createProject, newId, type Project, type ScanRef } from './core/project';
import { loadScanFile } from './io/loadScan';
import {
  copyScanIntoProject, createProjectFolder, ensurePermission, openProjectFolder,
  readProjectFile, rememberProject, saveProject,
} from './io/projectFolder';

export interface OpenScan { id: string; name: string; mesh: MeshData; stats: MeshStats }

interface State {
  project: Project | null;
  dir: FileSystemDirectoryHandle | null;
  /** The scan currently shown in 3D. Without a project this is a "quick view". */
  scan: OpenScan | null;
  busy: string | null;
  error: string | null;
  saveState: 'saved' | 'saving' | 'failed';

  newProject(info: { name: string; client: string; boat: string }, parent: FileSystemDirectoryHandle): Promise<void>;
  openProject(dir: FileSystemDirectoryHandle): Promise<void>;
  closeProject(): void;
  addScan(file: File): Promise<void>;
  showScan(id: string): Promise<void>;
  removeScan(id: string): Promise<void>;
  quickView(file: File): Promise<void>;
  clearError(): void;
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
    const dir = get().dir!;
    const file = await readProjectFile(dir, ref.file);
    const { mesh, stats } = await loadScanFile(file);
    set({ scan: { id: ref.id, name: ref.name, mesh, stats } });
  };

  return {
    project: null, dir: null, scan: null, busy: null, error: null, saveState: 'saved',

    newProject: (info, parent) => run('Creating project…', async () => {
      const project = createProject(info);
      const dir = await createProjectFolder(parent, project);
      set({ project, dir, scan: null, saveState: 'saved' });
      await rememberProject(project, dir);
    }),

    openProject: (dir) => run('Opening project…', async () => {
      if (!(await ensurePermission(dir))) throw new Error('Access to the folder was not allowed.');
      const project = await openProjectFolder(dir);
      set({ project, dir, scan: null, saveState: 'saved' });
      await rememberProject(project, dir);
      if (project.scans.length) await load(project.scans[0]);
    }),

    closeProject: () => set({ project: null, dir: null, scan: null, error: null }),

    addScan: (file) => run(`Reading ${file.name}…`, async () => {
      const { project, dir } = get();
      if (!project || !dir) return;
      // Parse first: a file that cannot be read is never copied into the project.
      const { mesh, stats } = await loadScanFile(file);
      const path = await copyScanIntoProject(dir, file);
      const ref: ScanRef = {
        id: newId(), name: path.split('/').pop()!, file: path, units: 'mm',
        addedAt: new Date().toISOString(), stats,
      };
      set({ scan: { id: ref.id, name: ref.name, mesh, stats } });
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
      if (scan?.id === id) set({ scan: null });
      await persist({ ...project, scans: project.scans.filter((s) => s.id !== id) });
    },

    quickView: (file) => run(`Reading ${file.name}…`, async () => {
      const { mesh, stats } = await loadScanFile(file);
      set({ scan: { id: 'quick', name: file.name, mesh, stats } });
    }),

    clearError: () => set({ error: null }),
  };
});
