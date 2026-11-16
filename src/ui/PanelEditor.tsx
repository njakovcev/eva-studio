import { useEffect, useMemo, useRef, useState } from 'react';
import { outlinePolygon, sidePath } from '../core/cleanOutline';
import {
  addCorner, cutOutline, cutoutDistances, cutoutOutline, distancesAlongSide, moveCorner, pointAlongSide, nearestEdgePoint, pointInPolygon, removeCorner, straightAcross,
  type EdgePoint, type Panel,
} from '../core/panel';
import { bounds } from '../core/poly';
import { MARKER_MAX_AREA, outlinePolygonOf, type Surface } from '../core/surface';
import type { Vec2 } from '../core/vec';
import { useApp } from '../store';
import { distToPath, svgPath, usePanZoom, type View } from './usePanZoom';

type Drag =
  | { kind: 'pan'; x: number; y: number; view: View }
  | { kind: 'corner'; x: number; y: number; index: number; moved: boolean }
  | { kind: 'cutout'; x: number; y: number; index: number; moved: boolean; grab: Vec2 };

/**
 * 2D editor for a panel. Shows the surface (grey), the panel's shape (dashed, with corners
 * that can be moved, removed and added), the resulting cut line (solid), its openings,
 * and the other panels on the same surface.
 */
export function PanelEditor({ panel, surface }: { panel: Panel; surface: Surface | undefined }) {
  const updatePanel = useApp((s) => s.updatePanel);
  const focus = useApp((s) => s.panelFocus);
  const setFocus = useApp((s) => s.setPanelFocus);
  const splitting = useApp((s) => s.splitting);
  const setSplitting = useApp((s) => s.setSplitting);
  const splitOpenPanel = useApp((s) => s.splitOpenPanel);
  const openPanel = useApp((s) => s.openPanel);
  const allPanels = useApp((s) => s.project?.panels);
  const defaultRadius = useApp((s) => s.project?.settings.defaultCornerRadius ?? 20);
  const svg = useRef<SVGSVGElement>(null);
  const latest = useRef(panel);
  latest.current = panel;

  const surfacePolygon = useMemo(() => (surface ? outlinePolygonOf(surface) : []), [surface]);
  const fit = useMemo<View>(() => {
    const b = bounds([...surfacePolygon, ...outlinePolygon(panel.shape)]);
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.08 + 20;
    return { x: b.minX - pad, y: -b.maxY - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad };
    // refit only when another surface is shown (so the view stays put when a panel is split or a sibling is opened)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.surfaceId]);
  const { view, setView, px, toPlane } = usePanZoom(svg, fit);

  const cut = useMemo(() => cutOutline(panel), [panel]);
  const cutouts = useMemo(() => (panel.cutouts ?? []).map(cutoutOutline), [panel.cutouts]);
  const siblings = useMemo(
    () => (allPanels ?? []).filter((p) => p.surfaceId === panel.surfaceId && p.id !== panel.id).map((p) => ({ id: p.id, name: p.name, flat: cutOutline(p).flat, holes: (p.cutouts ?? []).map((c) => cutoutOutline(c).flat) })),
    [allPanels, panel.surfaceId, panel.id],
  );
  const { corners } = panel.shape;
  // while an opening is selected: how far it is from the panel edges it faces
  const distances = useMemo(() => (focus?.kind === 'cutout' ? cutoutDistances(panel, focus.index) : []), [panel, focus]);

  const drag = useRef<Drag | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  // splitting: first point picked, and where the second would land right now
  const [splitFrom, setSplitFrom] = useState<EdgePoint | null>(null);
  const [splitHover, setSplitHover] = useState<EdgePoint | null>(null);
  useEffect(() => { if (!splitting) { setSplitFrom(null); setSplitHover(null); } }, [splitting]);

  /** The edge point under the pointer while splitting: snaps to corners, and to a square cut straight across. */
  const edgePointAt = (x: number, y: number): EdgePoint => {
    const near = nearestEdgePoint(panel.shape, x, y);
    for (let i = 0; i < corners.length; i++) {
      if (Math.hypot(corners[i][0] - near.point[0], corners[i][1] - near.point[1]) < 10 * px) return { side: i, point: corners[i] };
    }
    if (splitFrom) {
      const square = straightAcross(panel.shape, splitFrom);
      if (square && Math.hypot(square.point[0] - near.point[0], square.point[1] - near.point[1]) < 14 * px) return square;
    }
    // land on whole millimetres from the start of the side, so the numbers shown are round
    const whole = Math.round(distancesAlongSide(panel.shape, near).before);
    return { side: near.side, point: pointAlongSide(panel.shape, near.side, whole) };
  };

  /** For a split point: its distance to each end of the side it sits on, with a place to write each number. */
  const splitLabels = (q: EdgePoint) => {
    const { before, after } = distancesAlongSide(panel.shape, q);
    const out: { x: number; y: number; text: string }[] = [];
    if (before > 0.5) { const m = pointAlongSide(panel.shape, q.side, before / 2); out.push({ x: m[0], y: m[1], text: String(Math.round(before)) }); }
    if (after > 0.5) { const m = pointAlongSide(panel.shape, q.side, before + after / 2); out.push({ x: m[0], y: m[1], text: String(Math.round(after)) }); }
    return out;
  };

  const nearest = (x: number, y: number): NonNullable<typeof focus> | null => {
    let corner = -1, cornerD = 9 * px;
    corners.forEach((c, i) => { const d = Math.hypot(c[0] - x, c[1] - y); if (d < cornerD) { cornerD = d; corner = i; } });
    if (corner >= 0) return { kind: 'corner', index: corner };
    for (let i = cutouts.length - 1; i >= 0; i--) if (pointInPolygon(x, y, cutouts[i].flat)) return { kind: 'cutout', index: i };
    let side = -1, sideD = 12 * px;
    corners.forEach((_, i) => { const d = distToPath(x, y, sidePath(panel.shape, i)); if (d < sideD) { sideD = d; side = i; } });
    return side >= 0 ? { kind: 'side', index: side } : null;
  };

  const tap = (e: { clientX: number; clientY: number }) => {
    const [x, y] = toPlane(e);
    if (splitting) {
      const at = edgePointAt(x, y);
      if (!splitFrom) setSplitFrom(at);
      else void splitOpenPanel(splitFrom, at);
      return;
    }
    // a click inside another panel of this surface opens that panel
    if (!nearest(x, y)) {
      const other = siblings.find((s) => pointInPolygon(x, y, s.flat));
      if (other && !pointInPolygon(x, y, cut.flat)) openPanel(other.id);
    }
  };

  const doubleClick = (e: { clientX: number; clientY: number }) => {
    if (splitting) return;
    const [x, y] = toPlane(e);
    const hit = nearest(x, y);
    if (!hit || hit.kind === 'cutout') return;
    setFocus(null);
    if (hit.kind === 'corner') { if (corners.length > 3) void updatePanel(removeCorner(panel, hit.index)); }
    else void updatePanel(addCorner(panel, hit.index, [x, y], defaultRadius));
  };

  // Delete removes the focused corner or opening; Escape leaves split mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape' && splitting) { setSplitting(false); return; }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (focus?.kind === 'corner' && corners.length > 3) { e.preventDefault(); setFocus(null); void updatePanel(removeCorner(panel, focus.index)); }
      if (focus?.kind === 'cutout') { e.preventDefault(); setFocus(null); void updatePanel({ ...panel, cutouts: (panel.cutouts ?? []).filter((_, k) => k !== focus.index) }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const splitTo = splitFrom ? splitHover : null;

  return (
    <div className={`editor${splitting ? ' editor--pick' : ''}`}>
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          const [x, y] = toPlane(e);
          const hit = splitting ? null : nearest(x, y);
          if (hit?.kind === 'corner') drag.current = { kind: 'corner', x: e.clientX, y: e.clientY, index: hit.index, moved: false };
          else if (hit?.kind === 'cutout') {
            const c = panel.cutouts![hit.index].center;
            drag.current = { kind: 'cutout', x: e.clientX, y: e.clientY, index: hit.index, moved: false, grab: [x - c[0], y - c[1]] };
          } else drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, view };
          if (!splitting) setFocus(hit);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) { if (splitting) { const [x, y] = toPlane(e); setSplitHover(edgePointAt(x, y)); } return; }
          if (d.kind === 'pan') { setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * px, y: d.view.y - (e.clientY - d.y) * px }); return; }
          if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
          d.moved = true;
          const p = latest.current, [x, y] = toPlane(e);
          if (d.kind === 'corner') void updatePanel(moveCorner(p, d.index, [x, y]), false);
          else void updatePanel({ ...p, cutouts: (p.cutouts ?? []).map((c, k) => (k === d.index ? { ...c, center: [x - d.grab[0], y - d.grab[1]] as Vec2 } : c)) }, false);
        }}
        onPointerUp={(e) => {
          const d = drag.current; drag.current = null;
          if (!d) return;
          if (d.kind !== 'pan' && d.moved) { void updatePanel(latest.current, true); lastTap.current = null; return; }
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) { lastTap.current = null; return; }
          // two presses without movement close together are a double-click (see OutlineEditor)
          const prev = lastTap.current;
          if (prev && e.timeStamp - prev.t < 450 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8) { lastTap.current = null; doubleClick(e); }
          else { lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY }; tap(e); }
        }}
      >
        {surfacePolygon.length > 0 && <path className="pe-surface" d={svgPath(surfacePolygon)} strokeWidth={1 * px} />}
        {surface?.raw.holes.map((h, i) => (
          <path key={i} className={h.area <= MARKER_MAX_AREA ? 'ed-marker' : 'ed-hole'} d={svgPath(h.points)} strokeWidth={1 * px} strokeDasharray={`${3 * px} ${3 * px}`} />
        ))}
        {siblings.map((s) => <path key={s.id} className="pe-sibling" fillRule="evenodd" d={svgPath(s.flat) + s.holes.map(svgPath).join('')} strokeWidth={1.5 * px}><title>{s.name}</title></path>)}
        <path className="pe-cut" fillRule="evenodd" d={svgPath(cut.flat) + cutouts.map((c) => svgPath(c.flat)).join('')} strokeWidth={2 * px} />
        {cutouts.map((c, i) => {
          const center = panel.cutouts![i].center, on = focus?.kind === 'cutout' && focus.index === i;
          return (
            <g key={`o${i}`}>
              {on && <path className="pe-focus" d={svgPath(c.flat)} strokeWidth={5 * px} />}
              <text className={`ed-label${on ? ' on' : ''}`} x={center[0]} y={-center[1]} fontSize={11 * px} dy={4 * px} textAnchor="middle" strokeWidth={3 * px}>O{i + 1}</text>
            </g>
          );
        })}
        {distances.map((d) => (
          <g key={`d${d.side}`} className="pe-dim">
            <line x1={d.from[0]} y1={-d.from[1]} x2={d.to[0]} y2={-d.to[1]} strokeWidth={1.5 * px} />
            <circle cx={d.from[0]} cy={-d.from[1]} r={2.5 * px} /><circle cx={d.to[0]} cy={-d.to[1]} r={2.5 * px} />
            <text x={(d.from[0] + d.to[0]) / 2} y={-(d.from[1] + d.to[1]) / 2} fontSize={12 * px} dy={-5 * px} textAnchor="middle" strokeWidth={3 * px}>{Math.round(d.distance)}</text>
          </g>
        ))}
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
        {splitting && (splitFrom ?? splitHover) && (
          <g className="pe-split">
            {splitFrom && splitTo && <line x1={splitFrom.point[0]} y1={-splitFrom.point[1]} x2={splitTo.point[0]} y2={-splitTo.point[1]} strokeWidth={2 * px} strokeDasharray={`${8 * px} ${5 * px}`} />}
            {[splitFrom, splitHover].map((q, i) => q && <circle key={i} cx={q.point[0]} cy={-q.point[1]} r={5 * px} />)}
            {[splitFrom, splitHover].flatMap((q, i) => (q ? splitLabels(q).map((l, k) => (
              <text key={`${i}-${k}`} className="pe-split__len" x={l.x} y={-l.y} fontSize={13 * px} dy={16 * px} textAnchor="middle" strokeWidth={4 * px}>{l.text}</text>
            )) : []))}
            {splitFrom && splitTo && (
              <text className="ed-label" x={(splitFrom.point[0] + splitTo.point[0]) / 2} y={-(splitFrom.point[1] + splitTo.point[1]) / 2} fontSize={12 * px} dy={-6 * px} textAnchor="middle" strokeWidth={3 * px}>
                {Math.round(Math.hypot(splitTo.point[0] - splitFrom.point[0], splitTo.point[1] - splitFrom.point[1]))} mm
              </text>
            )}
          </g>
        )}
      </svg>
      <div className="viewer__views"><button onClick={() => setView(fit)}>Fit</button></div>
      <div className="editor__legend">
        <span><i className="lg lg-surface" />Surface</span><span><i className="lg lg-shape" />Panel shape</span><span><i className="lg lg-cut" />Cut line</span>
        {siblings.length > 0 && <span><i className="lg lg-sibling" />Other panels</span>}
      </div>
      {splitting && <div className="viewer__busy">{splitFrom ? 'Click where the cut ends (it snaps to a square cut and to corners) · Esc to cancel' : 'Click on the panel edge where the cut starts · the numbers are the distances to both ends of that side · Esc to cancel'}</div>}
      <div className="viewer__hint">
        Drag a corner to reshape · Double-click a corner to remove it · Double-click a side to add a corner · Drag an opening to move it · Wheel: zoom
      </div>
    </div>
  );
}
