/// <reference lib="webworker" />
import { parseObj, type MeshData } from './obj';
import { computeStats, type MeshStats } from './mesh';
import { segmentFlatRegions, type Region } from './segment';
import { extractOutline, type RawOutline } from './outline';

export interface DetectedRegion extends Region { raw: RawOutline }
export type WorkerReply =
  | { ok: true; mesh: MeshData; stats: MeshStats; labels: Int32Array; regions: DetectedRegion[] }
  | { ok: false; error: string };

// Reads a scan and finds its flat areas off the main thread, so the screen never freezes.
self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  const post = (reply: WorkerReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(reply, transfer);
  try {
    const mesh = parseObj(new Uint8Array(e.data));
    const stats = computeStats(mesh);
    const seg = segmentFlatRegions(mesh);
    const regions: DetectedRegion[] = [];
    const renumber = new Int32Array(seg.regions.length).fill(-1);
    for (const r of seg.regions) {
      try {
        const raw = extractOutline(mesh, seg, r.id);
        renumber[r.id] = regions.length;
        regions.push({ ...r, id: regions.length, raw });
      } catch { /* an area without a usable edge is left out */ }
    }
    const labels = seg.labels.map((l) => (l < 0 ? -1 : renumber[l]));
    post({ ok: true, mesh, stats, labels, regions }, [mesh.positions.buffer, mesh.indices.buffer, labels.buffer]);
  } catch (err) {
    post({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
