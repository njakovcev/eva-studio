import type { MeshData } from '../core/obj';
import type { MeshStats } from '../core/mesh';
import type { DetectedRegion, WorkerReply } from '../core/objWorker';
import type { Orientation } from '../core/orientation';

export interface LoadedScan { mesh: MeshData; stats: MeshStats; labels: Int32Array; regions: DetectedRegion[]; orientation: Orientation }

/** Reads an OBJ file and finds its flat areas, in a background worker. */
export async function loadScanFile(file: Blob): Promise<LoadedScan> {
  const buffer = await file.arrayBuffer();
  const worker = new Worker(new URL('../core/objWorker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<LoadedScan>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        if (e.data.ok) resolve({ mesh: e.data.mesh, stats: e.data.stats, labels: e.data.labels, regions: e.data.regions, orientation: e.data.orientation });
        else reject(new Error(e.data.error));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The scan could not be read.'));
      worker.postMessage(buffer, [buffer]);
    });
  } finally {
    worker.terminate();
  }
}
