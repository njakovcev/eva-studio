/// <reference lib="webworker" />
import { parseObj } from './obj';
import { computeStats } from './mesh';

// Parses a scan off the main thread so the screen never freezes.
self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const mesh = parseObj(new Uint8Array(e.data));
    const stats = computeStats(mesh);
    (self as DedicatedWorkerGlobalScope).postMessage(
      { ok: true, mesh, stats },
      [mesh.positions.buffer, mesh.indices.buffer],
    );
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
