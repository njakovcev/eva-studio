/**
 * Reading and writing a project folder on the user's disk
 * (File System Access API: Chrome and Edge on Windows and macOS).
 *
 *   Boat-name/
 *     project.json
 *     scans/      original scanner files, never modified
 *     graphics/   client logos and custom patterns
 *     export/     DXF, PDF, later G-code
 */
import { FOLDERS, PROJECT_FILE, parseProject, safeFileName, serializeProject, uniqueName, type Project } from '../core/project';

export const folderAccessSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

async function isEmpty(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const name of dir.keys()) { if (!name.startsWith('.')) return false; }
  return true;
}

async function writeText(dir: FileSystemDirectoryHandle, name: string, text: string) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

export async function saveProject(dir: FileSystemDirectoryHandle, project: Project) {
  await writeText(dir, PROJECT_FILE, serializeProject(project));
}

/**
 * Creates a project in the chosen folder. If that folder already has other
 * files in it, the project goes into a new sub-folder named after the project,
 * so nothing existing is ever mixed with or overwritten by project files.
 */
export async function createProjectFolder(parent: FileSystemDirectoryHandle, project: Project): Promise<FileSystemDirectoryHandle> {
  if (await exists(parent, PROJECT_FILE)) {
    throw new Error('This folder already contains a project. Use "Open project" instead, or pick another folder.');
  }
  let dir = parent;
  if (!(await isEmpty(parent))) {
    const taken: string[] = [];
    for await (const name of parent.keys()) taken.push(name);
    dir = await parent.getDirectoryHandle(uniqueName(safeFileName(project.project.name), taken), { create: true });
  }
  for (const f of Object.values(FOLDERS)) await dir.getDirectoryHandle(f, { create: true });
  await saveProject(dir, project);
  return dir;
}

export async function openProjectFolder(dir: FileSystemDirectoryHandle): Promise<Project> {
  let file: File;
  try {
    file = await (await dir.getFileHandle(PROJECT_FILE)).getFile();
  } catch {
    throw new Error(`No ${PROJECT_FILE} in "${dir.name}". Pick the folder of an existing project.`);
  }
  return parseProject(await file.text());
}

/** Copies a scan into scans/ and returns its path inside the project. The original is left untouched. */
export async function copyScanIntoProject(dir: FileSystemDirectoryHandle, file: File): Promise<string> {
  const scans = await dir.getDirectoryHandle(FOLDERS.scans, { create: true });
  const taken: string[] = [];
  for await (const name of scans.keys()) taken.push(name);
  const name = uniqueName(safeFileName(file.name), taken);
  const handle = await scans.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(file);
  await w.close();
  return `${FOLDERS.scans}/${name}`;
}

/** Writes a text file into export/ (replacing an older export of the same name) and returns its path. */
export async function writeExport(dir: FileSystemDirectoryHandle, fileName: string, text: string): Promise<string> {
  const folder = await dir.getDirectoryHandle(FOLDERS.export, { create: true });
  const name = safeFileName(fileName);
  await writeText(folder, name, text);
  return `${FOLDERS.export}/${name}`;
}

export async function readProjectFile(dir: FileSystemDirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/');
  let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  try {
    return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
  } catch {
    throw new Error(`File "${path}" is missing from the project folder.`);
  }
}

// ---- remembering recent projects (folder handles kept in the browser) ----

interface Recent { id: string; name: string; handle: FileSystemDirectoryHandle; openedAt: number }

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('eva-studio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('recent', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberProject(project: Project, handle: FileSystemDirectoryHandle) {
  try {
    const d = await db();
    const rec: Recent = { id: project.project.id, name: project.project.name, handle, openedAt: Date.now() };
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction('recent', 'readwrite');
      tx.objectStore('recent').put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* a convenience only: never block work */ }
}

export async function listRecent(): Promise<Recent[]> {
  try {
    const d = await db();
    const all = await new Promise<Recent[]>((resolve, reject) => {
      const req = d.transaction('recent').objectStore('recent').getAll();
      req.onsuccess = () => resolve(req.result as Recent[]);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => b.openedAt - a.openedAt).slice(0, 8);
  } catch { return []; }
}

export async function forgetProject(id: string) {
  try {
    const d = await db();
    d.transaction('recent', 'readwrite').objectStore('recent').delete(id);
  } catch { /* ignore */ }
}

/** Browsers ask again for folder permission after a restart; this must run from a click. */
export async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
