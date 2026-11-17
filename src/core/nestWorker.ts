/// <reference lib="webworker" />
import { nest, type NestOptions, type NestPart, type NestResult } from './nest';

// Arranging panels takes a few seconds for a whole boat: done off the main thread.
self.onmessage = (e: MessageEvent<{ parts: NestPart[]; options: NestOptions }>) => {
  let reply: { ok: true; result: NestResult } | { ok: false; error: string };
  try { reply = { ok: true, result: nest(e.data.parts, e.data.options) }; }
  catch (err) { reply = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  (self as DedicatedWorkerGlobalScope).postMessage(reply);
};
