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

const num = (v: number) => (Math.round(v * 1000) / 1000).toString();

export function writeDxf(layers: DxfLayer[], polylines: DxfPolyline[]): string {
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
    add(0, 'POLYLINE'); add(8, p.layer); add(66, 1); add(70, p.closed === false ? 0 : 1);
    add(10, 0); add(20, 0); add(30, 0);
    for (let i = 0; i < p.points.length; i += 2) {
      add(0, 'VERTEX'); add(8, p.layer); add(10, num(p.points[i])); add(20, num(p.points[i + 1])); add(30, 0);
      const b = p.bulges?.[i / 2];
      if (b) add(42, b);
    }
    add(0, 'SEQEND'); add(8, p.layer);
  }
  add(0, 'ENDSEC');
  add(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}
