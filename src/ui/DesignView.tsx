import { useMemo, useRef } from 'react';
import { designPanel, type Design } from '../core/design';
import { cutoutOutline, type Panel } from '../core/panel';
import { bounds } from '../core/poly';
import { outlinePolygonOf, type Surface } from '../core/surface';
import { DEFAULT_GROOVE_TOOL, grooveWidth } from '../core/tools';
import { useApp } from '../store';
import { svgPath, usePanZoom, type View } from './usePanZoom';

const open = (l: number[]) => { let d = ''; for (let k = 0; k < l.length; k += 2) d += `${k ? 'L' : 'M'}${l[k]},${-l[k + 1]}`; return d; };

/**
 * Preview of a surface with all its panels as they will look: top colour,
 * with the bottom colour showing in the milled grooves at their real width.
 */
export function DesignView({ surface, panels, design }: { surface: Surface; panels: Panel[]; design: Design }) {
  const material = useApp((s) => s.project!.settings.material);
  const updateDesign = useApp((s) => s.updateDesign);
  const svg = useRef<SVGSVGElement>(null);
  const surfacePolygon = useMemo(() => outlinePolygonOf(surface), [surface]);
  const fit = useMemo<View>(() => {
    const b = bounds(surfacePolygon);
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.06 + 20;
    return { x: b.minX - pad, y: -b.maxY - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad };
  }, [surfacePolygon]);
  const { view, setView, px, toPlane } = usePanZoom(svg, fit);
  const drawn = useMemo(() => panels.map((p) => ({ panel: p, d: designPanel(p, design) })), [panels, design]);
  const width = grooveWidth(DEFAULT_GROOVE_TOOL, design.depth);
  const latest = useRef(design); latest.current = design;
  const drag = useRef<{ kind: 'pan'; x: number; y: number; view: View } | { kind: 'pattern'; last: [number, number] } | null>(null);

  return (
    <div className="editor">
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          // Shift + drag slides the pattern; a plain drag moves the view
          drag.current = e.shiftKey ? { kind: 'pattern', last: toPlane(e) } : { kind: 'pan', x: e.clientX, y: e.clientY, view };
        }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          if (d.kind === 'pan') { setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * px, y: d.view.y - (e.clientY - d.y) * px }); return; }
          const [x, y] = toPlane(e), cur = latest.current;
          void updateDesign({ ...cur, pattern: { ...cur.pattern, originX: cur.pattern.originX + x - d.last[0], originY: cur.pattern.originY + y - d.last[1] } }, false);
          d.last = [x, y];
        }}
        onPointerUp={() => {
          const d = drag.current; drag.current = null;
          if (d?.kind === 'pattern') {
            const cur = latest.current; // land on whole millimetres
            void updateDesign({ ...cur, pattern: { ...cur.pattern, originX: Math.round(cur.pattern.originX), originY: Math.round(cur.pattern.originY) } }, true);
          }
        }}
      >
        <path className="pe-surface" d={svgPath(surfacePolygon)} strokeWidth={1 * px} />
        {drawn.map(({ panel, d }) => (
          <g key={panel.id}>
            <path fillRule="evenodd" fill={material.topColor} d={svgPath(d.cut.flat) + (panel.cutouts ?? []).map((c) => svgPath(cutoutOutline(c).flat)).join('')} />
            <g fill="none" stroke={material.bottomColor} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
              {d.border && <path d={svgPath(d.border.flat)} />}
              <path d={d.pattern.map(open).join('')} />
            </g>
          </g>
        ))}
      </svg>
      <div className="viewer__views"><button onClick={() => setView(fit)}>Fit</button></div>
      <div className="viewer__hint">Shift + drag: slide the pattern · Drag: move the view · Wheel: zoom · Grooves are drawn at their real width</div>
    </div>
  );
}
