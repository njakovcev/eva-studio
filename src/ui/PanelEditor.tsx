import { useEffect, useMemo, useRef } from 'react';
import { outlinePolygon, sidePath } from '../core/cleanOutline';
import { addCorner, cutOutline, moveCorner, removeCorner, type Panel } from '../core/panel';
import { bounds } from '../core/poly';
import { outlinePolygonOf, type Surface } from '../core/surface';
import { useApp } from '../store';
import { distToPath, svgPath, usePanZoom, type View } from './usePanZoom';

/**
 * 2D editor for a panel. Shows the surface (grey), the panel's shape (dashed, with corners
 * that can be moved, removed and added) and the resulting cut line (solid).
 */
export function PanelEditor({ panel, surface }: { panel: Panel; surface: Surface | undefined }) {
  const updatePanel = useApp((s) => s.updatePanel);
  const focus = useApp((s) => s.panelFocus);
  const setFocus = useApp((s) => s.setPanelFocus);
  const defaultRadius = useApp((s) => s.project?.settings.defaultCornerRadius ?? 20);
  const svg = useRef<SVGSVGElement>(null);
  const latest = useRef(panel);
  latest.current = panel;

  const surfacePolygon = useMemo(() => (surface ? outlinePolygonOf(surface) : []), [surface]);
  const fit = useMemo<View>(() => {
    const b = bounds([...surfacePolygon, ...outlinePolygon(panel.shape)]);
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.08 + 20;
    return { x: b.minX - pad, y: -b.maxY - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad };
    // refit only when another panel is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id]);
  const { view, setView, px, toPlane } = usePanZoom(svg, fit);

  const cut = useMemo(() => cutOutline(panel), [panel]);
  const { corners } = panel.shape;

  const drag = useRef<{ kind: 'pan'; x: number; y: number; view: View } | { kind: 'corner'; x: number; y: number; index: number; moved: boolean } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const nearest = (x: number, y: number): NonNullable<typeof focus> | null => {
    let corner = -1, cornerD = 9 * px;
    corners.forEach((c, i) => { const d = Math.hypot(c[0] - x, c[1] - y); if (d < cornerD) { cornerD = d; corner = i; } });
    if (corner >= 0) return { kind: 'corner', index: corner };
    let side = -1, sideD = 12 * px;
    corners.forEach((_, i) => { const d = distToPath(x, y, sidePath(panel.shape, i)); if (d < sideD) { sideD = d; side = i; } });
    return side >= 0 ? { kind: 'side', index: side } : null;
  };

  const doubleClick = (e: { clientX: number; clientY: number }) => {
    const [x, y] = toPlane(e);
    const hit = nearest(x, y);
    if (!hit) return;
    setFocus(null);
    if (hit.kind === 'corner') { if (corners.length > 3) void updatePanel(removeCorner(panel, hit.index)); }
    else void updatePanel(addCorner(panel, hit.index, [x, y], defaultRadius));
  };

  // Delete key removes the focused corner
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && focus?.kind === 'corner' && !(e.target instanceof HTMLInputElement) && corners.length > 3) {
        e.preventDefault(); setFocus(null); void updatePanel(removeCorner(panel, focus.index));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="editor">
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          const [x, y] = toPlane(e);
          const hit = nearest(x, y);
          if (hit?.kind === 'corner') { drag.current = { kind: 'corner', x: e.clientX, y: e.clientY, index: hit.index, moved: false }; setFocus(hit); }
          else { drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, view }; setFocus(hit); }
        }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          if (d.kind === 'pan') {
            setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * px, y: d.view.y - (e.clientY - d.y) * px });
          } else {
            if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
            d.moved = true;
            void updatePanel(moveCorner(latest.current, d.index, toPlane(e)), false);
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current; drag.current = null;
          if (!d) return;
          if (d.kind === 'corner' && d.moved) { void updatePanel(latest.current, true); lastTap.current = null; return; }
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) { lastTap.current = null; return; }
          // two presses without movement close together are a double-click (see OutlineEditor)
          const prev = lastTap.current;
          if (prev && e.timeStamp - prev.t < 450 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8) { lastTap.current = null; doubleClick(e); }
          else lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
        }}
      >
        {surfacePolygon.length > 0 && <path className="pe-surface" d={svgPath(surfacePolygon)} strokeWidth={1 * px} />}
        {surface?.raw.holes.map((h, i) => <path key={i} className="ed-marker" d={svgPath(h.points)} strokeWidth={1 * px} strokeDasharray={`${3 * px} ${3 * px}`} />)}
        <path className="pe-cut" d={svgPath(cut.flat)} strokeWidth={2 * px} />
        <path className="pe-shape" d={svgPath(outlinePolygon(panel.shape))} strokeWidth={1 * px} strokeDasharray={`${5 * px} ${4 * px}`} />
        {corners.map((_, i) => {
          const sp = sidePath(panel.shape, i);
          const on = focus?.kind === 'side' && focus.index === i;
          const mid = Math.floor(sp.length / 4) * 2;
          const mx = sp.length === 4 ? (sp[0] + sp[2]) / 2 : sp[mid], my = sp.length === 4 ? (sp[1] + sp[3]) / 2 : sp[mid + 1];
          let d = '';
          for (let k = 0; k < sp.length; k += 2) d += `${k ? 'L' : 'M'}${sp[k]},${-sp[k + 1]}`;
          return (
            <g key={`s${i}`}>
              {on && <path className="pe-focus" d={d} strokeWidth={5 * px} />}
              <text className={`ed-label${on ? ' on' : ''}`} x={mx} y={-my} fontSize={12 * px} dy={-6 * px} textAnchor="middle" strokeWidth={3 * px}>S{i + 1}</text>
            </g>
          );
        })}
        {corners.map((c, i) => {
          const on = focus?.kind === 'corner' && focus.index === i;
          return (
            <g key={`c${i}`}>
              <circle data-corner={i} className={`ed-corner${on ? ' on' : ''}`} cx={c[0]} cy={-c[1]} r={6 * px} strokeWidth={2 * px} />
              <text className={`ed-label${on ? ' on' : ''}`} x={c[0]} y={-c[1]} fontSize={11 * px} dx={10 * px} dy={-8 * px} strokeWidth={3 * px}>C{i + 1}</text>
            </g>
          );
        })}
      </svg>
      <div className="viewer__views"><button onClick={() => setView(fit)}>Fit</button></div>
      <div className="editor__legend">
        <span><i className="lg lg-surface" />Surface</span><span><i className="lg lg-shape" />Panel shape</span><span><i className="lg lg-cut" />Cut line</span>
      </div>
      <div className="viewer__hint">
        Drag a corner to reshape · Double-click a corner to remove it · Double-click a side to add a corner · Wheel: zoom · Drag background: move
      </div>
    </div>
  );
}
