import { useEffect, useMemo, useRef, useState } from 'react';
import { nearestEdgeIndex } from '../core/cleanOutline';
import { bounds, distToSegment } from '../core/poly';
import { MARKER_MAX_AREA, withAnchors, type Surface } from '../core/surface';
import { useApp } from '../store';

interface View { x: number; y: number; w: number; h: number }

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
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const drag = useRef<{ kind: 'pan'; x: number; y: number; view: View } | { kind: 'corner'; x: number; y: number; index: number; moved: boolean } | null>(null);
  /** last quick press without movement, to recognise a double-click ourselves */
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const latest = useRef(surface);
  latest.current = surface;

  const fit = useMemo(() => {
    const b = bounds([...surface.raw.outer, ...surface.outline.corners.flat()]);
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.08 + 20;
    return { x: b.minX - pad, y: -b.maxY - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad };
    // refit only when another surface is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id]);
  useEffect(() => { setView(fit); setSelected(null); }, [fit]);

  // mm per screen pixel, so handles and line widths keep the same size on screen at any zoom
  const [px, setPx] = useState(1);
  useEffect(() => {
    const el = svg.current; if (!el || !view) return;
    const measure = () => setPx(Math.max(view.w / el.clientWidth, view.h / el.clientHeight) || 1);
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

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

  const doubleClick = (e: { clientX: number; clientY: number }) => {
    const [x, y] = toPlane(e);
    let corner = -1, cornerD = 9 * px;
    corners.forEach((c, i) => { const dd = Math.hypot(c[0] - x, c[1] - y); if (dd < cornerD) { cornerD = dd; corner = i; } });
    if (corner >= 0) { removeCorner(corner); return; }
    let side = -1, sideD = 12 * px;
    corners.forEach((c, i) => {
      const n = corners[(i + 1) % corners.length];
      const dd = distToSegment(x, y, c[0], c[1], n[0], n[1]);
      if (dd < sideD) { sideD = dd; side = i; }
    });
    if (side >= 0) addCorner(side, x, y);
  };

  // Delete key removes the selected corner
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault(); removeCorner(selected);
      }
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
        onWheel={(e) => {
          const [mx, my] = toPlane(e); const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
          setView({ x: mx - (mx - view.x) * k, y: -my - (-my - view.y) * k, w: view.w * k, h: view.h * k });
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-corner]')) return;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, view };
          setSelected(null);
        }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          if (d.kind === 'pan') {
            setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * px, y: d.view.y - (e.clientY - d.y) * px });
          } else {
            if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
            d.moved = true;
            const s = latest.current;
            const next = s.outline.anchors.map((a, k) => (k === d.index ? { ...a, manual: toPlane(e) } : a));
            void updateSurface(withAnchors(s, next), false);
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current; drag.current = null;
          if (!d) return;
          if (d.kind === 'corner' && d.moved) { void updateSurface(latest.current, true); lastTap.current = null; return; }
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) { lastTap.current = null; return; }
          // A press without movement. Two of them close together are a double-click.
          // (The browser's own double-click event is unreliable here because the pointer is captured while pressed.)
          const prev = lastTap.current;
          if (prev && e.timeStamp - prev.t < 450 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8) {
            lastTap.current = null;
            doubleClick(e);
          } else {
            lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
          }
        }}
      >
        <path className="ed-raw" d={path(surface.raw.outer)} strokeWidth={1 * px} />
        {surface.raw.holes.map((h, i) => (
          <path key={i} className={h.area <= MARKER_MAX_AREA ? 'ed-marker' : 'ed-hole'} d={path(h.points)} strokeWidth={1 * px} strokeDasharray={`${3 * px} ${3 * px}`} />
        ))}
        <path className="ed-clean" d={path(corners.flat())} strokeWidth={2 * px} />
        {corners.map((c, i) => {
          const n = corners[(i + 1) % corners.length];
          return (
            <text key={`l${i}`} className="ed-label" x={(c[0] + n[0]) / 2} y={-(c[1] + n[1]) / 2} fontSize={12 * px} dy={-6 * px} textAnchor="middle" strokeWidth={3 * px}>
              {Math.round(sides[i].length)}
            </text>
          );
        })}
        {corners.map((c, i) => (
          <circle
            key={`c${i}`} data-corner={i}
            className={`ed-corner${selected === i ? ' on' : ''}${anchors[i].manual ? ' manual' : ''}`}
            cx={c[0]} cy={-c[1]} r={6 * px} strokeWidth={2 * px}
            onPointerDown={(e) => {
              e.stopPropagation();
              svg.current!.setPointerCapture(e.pointerId);
              drag.current = { kind: 'corner', x: e.clientX, y: e.clientY, index: i, moved: false };
              setSelected(i);
            }}
          />
        ))}
      </svg>
      <div className="viewer__views"><button onClick={() => setView(fit)}>Fit</button></div>
      <div className="viewer__hint">
        Drag a corner to move it · Double-click a corner to remove it · Double-click a side to add a corner · Wheel: zoom · Drag background: move
      </div>
    </div>
  );
}
