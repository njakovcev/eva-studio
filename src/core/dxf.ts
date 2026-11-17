/**
 * Minimal DXF writer (R12 ASCII: the oldest, most widely readable flavour).
 * Closed polylines on named layers, millimetres.
 */
export interface DxfPolyline {
  layer: string;
  /** x0,y0,x1,y1… */
  points: ArrayLike<number>;
  /** optional arc bulge after each point (0 = straight) */
  bulges?: ArrayLike<number>;
  closed?: boolean;
}

export interface DxfLayer { name: string; color: number }

/** A line of text (for labels; not machined). `x, y` is the middle of the text. */
export interface DxfText { layer: string; x: number; y: number; height: number; text: string }

const num = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Shortest segment written, mm: shorter ones have no clear direction (a knife cannot turn on them). */
export const MIN_SEGMENT = 0.05;
/** Shortest arc written as an arc, mm: shorter arcs are written as straight lines. */
export const MIN_ARC = 1;

/**
 * Tidies a polyline for the machine: drops points closer than MIN_SEGMENT to the one before
 * (the next segment's arc is kept), and writes arcs shorter than MIN_ARC as straight lines.
 */
export function tidyPolyline(points: ArrayLike<number>, bulges: ArrayLike<number> | undefined, closed: boolean): { points: number[]; bulges: number[] } {
  const pts: number[] = [], bs: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i], y = points[i + 1], b = bulges?.[i / 2] ?? 0;
    const n = pts.length;
    if (n && Math.hypot(x - pts[n - 2], y - pts[n - 1]) < MIN_SEGMENT) { bs[bs.length - 1] = b; continue; }
    pts.push(x, y); bs.push(b);
  }
  if (closed) {
    // the closing segment back to the first point is too short: the point before the end goes
    while (pts.length >= 6 && Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]) < MIN_SEGMENT) { pts.length -= 2; bs.length -= 1; }
    // (a full circle written as two half-circle arcs has two points that are far apart: kept)
  }
  const n = pts.length / 2;
  for (let k = 0; k < n; k++) {
    if (!bs[k]) continue;
    if (!closed && k === n - 1) { bs[k] = 0; continue; }
    const j = (k + 1) % n, c = Math.hypot(pts[j * 2] - pts[k * 2], pts[j * 2 + 1] - pts[k * 2 + 1]);
    const b = Math.abs(bs[k]), length = ((c * (1 + b * b)) / (4 * b)) * 4 * Math.atan(b);
    if (length < MIN_ARC) bs[k] = 0;
  }
  return { points: pts, bulges: bs };
}

export function writeDxf(layers: DxfLayer[], polylines: DxfPolyline[], texts: DxfText[] = []): string {
  const out: string[] = [];
  const add = (code: number, value: string | number) => { out.push(String(code), String(value)); };

  add(0, 'SECTION'); add(2, 'HEADER');
  add(9, '$ACADVER'); add(1, 'AC1009');
  add(9, '$INSUNITS'); add(70, 4); // millimetres
  add(9, '$MEASUREMENT'); add(70, 1); // metric
  add(0, 'ENDSEC');

  add(0, 'SECTION'); add(2, 'TABLES');
  add(0, 'TABLE'); add(2, 'LTYPE'); add(70, 1);
  add(0, 'LTYPE'); add(2, 'CONTINUOUS'); add(70, 0); add(3, 'Solid line'); add(72, 65); add(73, 0); add(40, 0);
  add(0, 'ENDTAB');
  add(0, 'TABLE'); add(2, 'LAYER'); add(70, layers.length);
  for (const l of layers) { add(0, 'LAYER'); add(2, l.name); add(70, 0); add(62, l.color); add(6, 'CONTINUOUS'); }
  add(0, 'ENDTAB');
  add(0, 'ENDSEC');

  add(0, 'SECTION'); add(2, 'ENTITIES');
  for (const p of polylines) {
    const closed = p.closed !== false;
    const t = tidyPolyline(p.points, p.bulges, closed);
    // nothing left to cut (a closed line needs 3 points, or 2 joined by arcs, like a circle)
    if (t.points.length < 4 || (closed && t.points.length < 6 && !t.bulges.some((b) => b))) continue;
    add(0, 'POLYLINE'); add(8, p.layer); add(66, 1); add(70, closed ? 1 : 0);
    add(10, 0); add(20, 0); add(30, 0);
    for (let i = 0; i < t.points.length; i += 2) {
      add(0, 'VERTEX'); add(8, p.layer); add(10, num(t.points[i])); add(20, num(t.points[i + 1])); add(30, 0);
      const b = t.bulges[i / 2];
      if (b) add(42, b);
    }
    add(0, 'SEQEND'); add(8, p.layer);
  }
  for (const t of texts) {
    // plain letters only: DXF R12 has no reliable way to carry accents
    const plain = t.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
    add(0, 'TEXT'); add(8, t.layer); add(10, num(t.x)); add(20, num(t.y)); add(30, 0); add(40, num(t.height)); add(1, plain);
    add(72, 1); add(73, 2); add(11, num(t.x)); add(21, num(t.y)); add(31, 0); // centred on x, y
  }
  add(0, 'ENDSEC');
  add(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}
