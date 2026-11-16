/**
 * Fast OBJ reader for scanner output.
 *
 * Works directly on the file's bytes (no string conversion), so a scan of
 * several hundred MB parses in seconds and never doubles its memory use.
 * Only geometry is read: `v` (positions) and `f` (faces). Texture
 * coordinates, normals, groups and materials are skipped.
 *
 * Pure code: no DOM, no three.js. Runs in the browser, a worker, or Node.
 */

export interface MeshData {
  /** x, y, z per vertex */
  positions: Float32Array;
  /** three vertex indices per triangle */
  indices: Uint32Array;
}

const SPACE = 32, TAB = 9, CR = 13, LF = 10, SLASH = 47, MINUS = 45, PLUS = 43, DOT = 46;
const CH_v = 118, CH_f = 102, CH_e = 101, CH_E = 69;

class FloatBuffer {
  data: Float32Array;
  length = 0;
  constructor(capacity: number) { this.data = new Float32Array(Math.max(capacity, 1024)); }
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const d = this.data; let n = this.length;
    d[n++] = a; d[n++] = b; d[n++] = c;
    this.length = n;
  }
  finish() { return this.data.slice(0, this.length); }
}

class IndexBuffer {
  data: Uint32Array;
  length = 0;
  constructor(capacity: number) { this.data = new Uint32Array(Math.max(capacity, 1024)); }
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const d = this.data; let n = this.length;
    d[n++] = a; d[n++] = b; d[n++] = c;
    this.length = n;
  }
  finish() { return this.data.slice(0, this.length); }
}

export function parseObj(bytes: Uint8Array): MeshData {
  const n = bytes.length;
  // Rough guess from typical scanner files (~35 bytes per vertex line).
  const positions = new FloatBuffer(Math.floor(n / 12));
  const indices = new IndexBuffer(Math.floor(n / 10));
  const face: number[] = [];
  let i = 0;

  // Reads one decimal number starting at i; leaves i just after it.
  const readNumber = (): number => {
    while (i < n && (bytes[i] === SPACE || bytes[i] === TAB)) i++;
    let sign = 1;
    if (bytes[i] === MINUS) { sign = -1; i++; } else if (bytes[i] === PLUS) i++;
    let value = 0;
    let c = bytes[i];
    while (c >= 48 && c <= 57) { value = value * 10 + (c - 48); c = bytes[++i]; }
    if (c === DOT) {
      c = bytes[++i];
      let scale = 0.1;
      while (c >= 48 && c <= 57) { value += (c - 48) * scale; scale *= 0.1; c = bytes[++i]; }
    }
    if (c === CH_e || c === CH_E) {
      c = bytes[++i];
      let esign = 1;
      if (c === MINUS) { esign = -1; c = bytes[++i]; } else if (c === PLUS) c = bytes[++i];
      let exp = 0;
      while (c >= 48 && c <= 57) { exp = exp * 10 + (c - 48); c = bytes[++i]; }
      value *= Math.pow(10, esign * exp);
    }
    return sign * value;
  };

  const skipLine = () => { while (i < n && bytes[i] !== LF) i++; i++; };

  while (i < n) {
    const c = bytes[i];
    const next = bytes[i + 1];
    if (c === CH_v && (next === SPACE || next === TAB)) {
      i += 2;
      const x = readNumber(), y = readNumber(), z = readNumber();
      positions.push3(x, y, z);
      skipLine();
    } else if (c === CH_f && (next === SPACE || next === TAB)) {
      i += 2;
      face.length = 0;
      const vertexCount = positions.length / 3;
      for (;;) {
        while (i < n && (bytes[i] === SPACE || bytes[i] === TAB)) i++;
        if (i >= n || bytes[i] === LF || bytes[i] === CR) break;
        let neg = false;
        if (bytes[i] === MINUS) { neg = true; i++; }
        let idx = 0;
        let d = bytes[i];
        if (!(d >= 48 && d <= 57)) break; // malformed token: stop this face
        while (d >= 48 && d <= 57) { idx = idx * 10 + (d - 48); d = bytes[++i]; }
        // skip "/vt/vn" part
        if (d === SLASH) {
          while (i < n && bytes[i] !== SPACE && bytes[i] !== TAB && bytes[i] !== LF && bytes[i] !== CR) i++;
        }
        face.push(neg ? vertexCount - idx : idx - 1);
      }
      // triangle fan for polygons
      for (let k = 1; k + 1 < face.length; k++) indices.push3(face[0], face[k], face[k + 1]);
      skipLine();
    } else {
      skipLine();
    }
  }

  const result = { positions: positions.finish(), indices: indices.finish() };
  const vertexCount = result.positions.length / 3;
  for (let k = 0; k < result.indices.length; k++) {
    if (result.indices[k] >= vertexCount) {
      throw new Error('The OBJ file refers to a vertex that does not exist. The file may be damaged or cut off.');
    }
  }
  if (vertexCount === 0) throw new Error('No geometry found. Is this an OBJ file?');
  return result;
}
