import { useEffect, useMemo, useRef, useState } from 'react';
import { BowArrow, centreOf } from './Bow';
import { bowOf } from '../core/surface';
import { nearestEdgeIndex, outlinePolygon, sidePath } from '../core/cleanOutline';
import { newId } from '../core/project';
import { bounds, distToSegment, slideAlongSides } from '../core/poly';
import { MARKER_MAX_AREA, checkLength, removeSideExtend, snapToCorner, withAnchors, type Surface } from '../core/surface';
import type { Vec2 } from '../core/vec';
import { useApp } from '../store';

interface View { x: number; y: number; w: number; h: number }

const distToPath = (x: number, y: number, pts: number[]) => {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) best = Math.min(best, distToSegment(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]));
  return best;
};

const path = (pts: ArrayLike<number>) => {
  let d = '';
  for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]},${-pts[i + 1]}`;
  return d + 'Z';
};

/**
 * 2D editor for a surface outline. Drawing units are millimetres; the picture
 * is the surface seen straight on. (SVG's y axis points down, so y is negated.)
 */
export function OutlineEditor({ surface }: { surface: Surface }) {
  const updateSurface = useApp((s) => s.updateSurface);
  const measuring = useApp((s) => s.measuring);
  const setMeasuring = useApp((s) => s.setMeasuring);
  const [checkFirst, setCheckFirst] = useState<number | null>(null);
  useEffect(() => { if (!measuring) setCheckFirst(null); }, [measuring]);
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedSide, setSelectedSide] = useState<number | null>(null);
  const drag = useRef<{ kind: 'pan'; x: number; y: number; view: View } | { kind: 'corner'; x: number; y: number; index: number; moved: boolean; from: Vec2; prev: Vec2; next: Vec2 } | null>(null);
  /** last quick press without movement, to recognise a double-click ourselves */
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const latest = useRef(surface);
  latest.current = surface;

  const fit = useMemo(() => {
    const b = bounds([...surface.raw.outer, ...outlinePolygon(surface.outline)]);
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.08 + 20;
    return { x: b.minX - pad, y: -b.maxY - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad };
    // refit only when another surface is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id]);
  useEffect(() => { setView(fit); setSelected(null); setSelectedSide(null); }, [fit]);

  // mm per screen pixel, so handles and line widths keep the same size on screen at any zoom
  const [px, setPx] = useState(1);
  useEffect(() => {
    const el = svg.current; if (!el || !view) return;
    const measure = () => setPx(Math.max(view.w / el.clientWidth, view.h / el.clientHeight) || 1);
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  // Wheel, two-finger scroll and trackpad pinch all zoom around the pointer. Registered directly
  // (not through React) so the browser can be told not to scroll or magnify the page.
  useEffect(() => {
    const el = svg.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = el.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
      const q = p.matrixTransform(el.getScreenCTM()!.inverse());
      const k = Math.exp(Math.max(-50, Math.min(50, e.deltaY)) * (e.ctrlKey ? 0.01 : 0.0015));
      setView((v) => (v ? { x: q.x - (q.x - v.x) * k, y: q.y - (q.y - v.y) * k, w: v.w * k, h: v.h * k } : v));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view === null]);

  const toPlane = (e: { clientX: number; clientY: number }): [number, number] => {
    const p = svg.current!.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return [q.x, -q.y];
  };

  const { corners, anchors, edge, sides } = surface.outline;

  const removeCorner = (i: number) => {
    if (anchors.length <= 3) return;
    setSelected(null);
    void updateSurface(withAnchors(surface, anchors.filter((_, k) => k !== i)));
  };

  const addCorner = (side: number, x: number, y: number) => {
    const n = edge.length / 2;
    const a = anchors[side].at, b = anchors[(side + 1) % anchors.length].at;
    const room = (b - a + n) % n;
    if (room < 2) return; // no scan point between these two corners
    let at = nearestEdgeIndex(edge, x, y);
    const offset = (at - a + n) % n;
    if (offset <= 0 || offset >= room) at = (a + Math.floor(room / 2)) % n;
    void updateSurface(withAnchors(surface, [...anchors, { at, manual: [x, y] }]));
  };

  const sideAt = (x: number, y: number) => {
    let side = -1, sideD = 12 * px;
    corners.forEach((_, i) => { const dd = distToPath(x, y, sidePath(surface.outline, i)); if (dd < sideD) { sideD = dd; side = i; } });
    return side;
  };

  /** Removes a side by extending its two neighbours until they meet. */
  const removeSide = (i: number) => {
    setSelectedSide(null);
    try { void updateSurface(removeSideExtend(surface, i)); }
    catch (e) { useApp.setState({ error: e instanceof Error ? e.message : String(e) }); }
  };

  const doubleClick = (e: { clientX: number; clientY: number }) => {
    const [x, y] = toPlane(e);
    let corner = -1, cornerD = 9 * px;
    corners.forEach((c, i) => { const dd = Math.hypot(c[0] - x, c[1] - y); if (dd < cornerD) { cornerD = dd; corner = i; } });
    if (corner >= 0) { removeCorner(corner); return; }
    let side = -1, sideD = 12 * px;
    corners.forEach((_, i) => {
      const dd = distToPath(x, y, sidePath(surface.outline, i));
      if (dd < sideD) { sideD = dd; side = i; }
    });
    if (side >= 0) addCorner(side, x, y);
  };

  /** While measuring: the first corner clicked starts the measurement, the second finishes it. */
  const pickForCheck = (i: number) => {
    if (checkFirst === null) { setCheckFirst(i); return; }
    if (checkFirst !== i) {
      const check = { id: newId(), a: corners[checkFirst], b: corners[i], measured: null };
      void updateSurface({ ...surface, checks: [...(surface.checks ?? []), check] });
    }
    setMeasuring(false);
  };

  // Delete key removes the selected corner
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.target instanceof HTMLInputElement) return;
      if (selected !== null) { e.preventDefault(); removeCorner(selected); }
      else if (selectedSide !== null) { e.preventDefault(); removeSide(selectedSide); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!view) return <div className="editor" />;

  return (
    <div className="editor">
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-corner]')) return;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, view };
          setSelected(null); setSelectedSide(null);
        }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          if (d.kind === 'pan') {
            setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * px, y: d.view.y - (e.clientY - d.y) * px });
          } else {
            if (measuring || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3)) return;
            d.moved = true;
            const s = latest.current;
            // Shift: the corner only slides along one of its two sides, so that side keeps its direction
            const to = e.shiftKey ? slideAlongSides(d.from, d.prev, d.next, toPlane(e)) : toPlane(e);
            const next = s.outline.anchors.map((a, k) => (k === d.index ? { ...a, manual: to } : a));
            void updateSurface(withAnchors(s, next), false);
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current; drag.current = null;
          if (!d) return;
          if (d.kind === 'corner' && d.moved) { void updateSurface(latest.current, true); lastTap.current = null; return; }
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) { lastTap.current = null; return; }
          if (measuring) { if (d.kind === 'corner') pickForCheck(d.index); return; }
          // A press without movement. Two of them close together are a double-click.
          // (The browser's own double-click event is unreliable here because the pointer is captured while pressed.)
          const prev = lastTap.current;
          if (prev && e.timeStamp - prev.t < 450 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8) {
            lastTap.current = null;
            doubleClick(e);
          } else {
            lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
            // a single click on a side selects it (Delete then removes it)
            if (d.kind === 'pan' && !measuring) { const [x, y] = toPlane(e); const side = sideAt(x, y); setSelectedSide(side >= 0 ? side : null); }
          }
        }}
      >
        <path className="ed-raw" d={path(surface.raw.outer)} strokeWidth={1 * px} />
        {surface.raw.holes.map((h, i) => (
          <path key={i} className={h.area <= MARKER_MAX_AREA ? 'ed-marker' : 'ed-hole'} d={path(h.points)} strokeWidth={1 * px} strokeDasharray={`${3 * px} ${3 * px}`} />
        ))}
        <path className="ed-clean" d={path(outlinePolygon(surface.outline))} strokeWidth={2 * px} />
        <BowArrow angle={bowOf(surface)} at={centreOf(surface.outline.corners)} px={px} />
        {selectedSide !== null && selectedSide < corners.length && (
          <path className="pe-focus" strokeWidth={5 * px} d={sidePath(surface.outline, selectedSide).reduce((d, v, k, a) => (k % 2 ? d : `${d}${k ? 'L' : 'M'}${v},${-a[k + 1]}`), '')} />
        )}
        {corners.map((_, i) => {
          const sp = sidePath(surface.outline, i);
          const mid = Math.floor(sp.length / 4) * 2; // middle point of the side (for a straight side: between its two corners)
          const mx = sp.length === 4 ? (sp[0] + sp[2]) / 2 : sp[mid], my = sp.length === 4 ? (sp[1] + sp[3]) / 2 : sp[mid + 1];
          return (
            <text key={`l${i}`} className="ed-label" x={mx} y={-my} fontSize={12 * px} dy={-6 * px} textAnchor="middle" strokeWidth={3 * px}>
              {Math.round(sides[i].length)}
            </text>
          );
        })}
        {(surface.checks ?? []).map((c, i) => {
          const a = snapToCorner(surface, c.a), b = snapToCorner(surface, c.b);
          const diff = c.measured === null ? null : c.measured - checkLength(surface, c);
          return (
            <g key={c.id} className={`ed-check${diff !== null && Math.abs(diff) > 3 ? ' warn' : ''}`}>
              <line x1={a[0]} y1={-a[1]} x2={b[0]} y2={-b[1]} strokeWidth={1.5 * px} strokeDasharray={`${6 * px} ${4 * px}`} />
              <text x={(a[0] + b[0]) / 2} y={-(a[1] + b[1]) / 2} fontSize={12 * px} dy={-5 * px} textAnchor="middle" strokeWidth={3 * px}>
                {`M${i + 1}: ${Math.round(checkLength(surface, c))}`}
              </text>
            </g>
          );
        })}
        {corners.map((c, i) => (
          <circle
            key={`c${i}`} data-corner={i}
            className={`ed-corner${selected === i || checkFirst === i ? ' on' : ''}${anchors[i].manual ? ' manual' : ''}`}
            cx={c[0]} cy={-c[1]} r={6 * px} strokeWidth={2 * px}
            onPointerDown={(e) => {
              e.stopPropagation();
              svg.current!.setPointerCapture(e.pointerId);
              const m = corners.length;
              drag.current = { kind: 'corner', x: e.clientX, y: e.clientY, index: i, moved: false, from: c, prev: corners[(i - 1 + m) % m], next: corners[(i + 1) % m] };
              setSelected(i); setSelectedSide(null);
            }}
          />
        ))}
      </svg>
      <div className="viewer__views"><button onClick={() => setView(fit)}>Fit</button></div>
      {measuring && <div className="viewer__busy">{checkFirst === null ? 'Click the first corner of the measurement' : 'Now click the second corner'}</div>}
      <div className="viewer__hint">
        Drag a corner to move it (Shift: slide along its side) · Double-click a corner to remove it · Double-click a side to add a corner · Click a side + Delete: remove it and extend its neighbours until they meet
      </div>
    </div>
  );
}
