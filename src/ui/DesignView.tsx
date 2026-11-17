import { useEffect, useMemo, useRef } from 'react';
import { placeArtwork, type Graphic } from '../core/artwork';
import { designPanel, type Design } from '../core/design';
import { cutoutOutline, pointInPolygon, type Panel } from '../core/panel';
import { bounds } from '../core/poly';
import { outlinePolygonOf, type Surface } from '../core/surface';
import { DEFAULT_GROOVE_TOOL, grooveWidth } from '../core/tools';
import { libraryOf, useApp } from '../store';
import { svgPath, usePanZoom, type View } from './usePanZoom';

const open = (l: number[]) => { let d = ''; for (let k = 0; k < l.length; k += 2) d += `${k ? 'L' : 'M'}${l[k]},${-l[k + 1]}`; return d; };

type Drag =
  | { kind: 'pan'; x: number; y: number; view: View }
  | { kind: 'pattern'; last: [number, number] }
  | { kind: 'graphic'; id: string; grab: [number, number]; moved: boolean };

/**
 * Preview of a surface with all its panels as they will look: top colour,
 * with the bottom colour showing where material is milled away, grooves at their real width.
 */
export function DesignView({ surface, panels, design }: { surface: Surface; panels: Panel[]; design: Design }) {
  const project = useApp((s) => s.project!);
  const updateDesign = useApp((s) => s.updateDesign);
  const updateGraphic = useApp((s) => s.updateGraphic);
  const removeGraphic = useApp((s) => s.removeGraphic);
  const focus = useApp((s) => s.graphicFocus);
  const setFocus = useApp((s) => s.setGraphicFocus);
  const material = project.settings.material;
  const library = libraryOf(project);
  const svg = useRef<SVGSVGElement>(null);
  const surfacePolygon = useMemo(() => outlinePolygonOf(surface), [surface]);
  const fit = useMemo<View>(() => {
    const b = bounds(surfacePolygon);
    const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.06 + 20;
    return { x: b.minX - pad, y: -b.maxY - pad, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad };
  }, [surfacePolygon]);
  const { view, setView, px, toPlane } = usePanZoom(svg, fit);
  const drawn = useMemo(() => panels.map((p) => ({ panel: p, d: designPanel(p, design, library) })), [panels, design, library]);
  const width = grooveWidth(DEFAULT_GROOVE_TOOL, design.depth);
  const latest = useRef(design); latest.current = design;
  const drag = useRef<Drag | null>(null);

  // frames of the placed logos and texts, for picking and showing the selection
  const frames = useMemo(() => (design.graphics ?? []).flatMap((g) => {
    const art = library.artworks.find((a) => a.id === g.artworkId);
    return art ? [{ g, corners: placeArtwork({ ...art, rings: [], lines: [] }, g).corners }] : [];
  }), [design.graphics, library]);
  const graphicAt = (x: number, y: number): Graphic | null => {
    for (let i = frames.length - 1; i >= 0; i--) if (pointInPolygon(x, y, frames[i].corners)) return frames[i].g;
    return null;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && focus && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); void removeGraphic(focus); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, removeGraphic]);

  return (
    <div className="editor">
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          const [x, y] = toPlane(e);
          const g = e.shiftKey ? null : graphicAt(x, y);
          // a logo or text is dragged by itself; Shift + drag slides the pattern; anything else moves the view
          if (g) { drag.current = { kind: 'graphic', id: g.id, grab: [x - g.x, y - g.y], moved: false }; setFocus(g.id); }
          else if (e.shiftKey) drag.current = { kind: 'pattern', last: [x, y] };
          else { drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, view }; setFocus(null); }
        }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          if (d.kind === 'pan') { setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * px, y: d.view.y - (e.clientY - d.y) * px }); return; }
          const [x, y] = toPlane(e), cur = latest.current;
          if (d.kind === 'pattern') {
            void updateDesign({ ...cur, pattern: { ...cur.pattern, originX: cur.pattern.originX + x - d.last[0], originY: cur.pattern.originY + y - d.last[1] } }, false);
            d.last = [x, y];
          } else {
            const g = (cur.graphics ?? []).find((q) => q.id === d.id);
            if (g) { d.moved = true; void updateGraphic({ ...g, x: x - d.grab[0], y: y - d.grab[1] }, false); }
          }
        }}
        onPointerUp={() => {
          const d = drag.current; drag.current = null;
          const cur = latest.current; // land on whole millimetres
          if (d?.kind === 'pattern') void updateDesign({ ...cur, pattern: { ...cur.pattern, originX: Math.round(cur.pattern.originX), originY: Math.round(cur.pattern.originY) } }, true);
          if (d?.kind === 'graphic' && d.moved) { const g = (cur.graphics ?? []).find((q) => q.id === d.id); if (g) void updateGraphic({ ...g, x: Math.round(g.x), y: Math.round(g.y) }, true); }
        }}
      >
        <path className="pe-surface" d={svgPath(surfacePolygon)} strokeWidth={1 * px} />
        {drawn.map(({ panel, d }) => (
          <g key={panel.id}>
            <path fillRule="evenodd" fill={material.topColor} d={svgPath(d.cut.flat) + (panel.cutouts ?? []).map((c) => svgPath(cutoutOutline(c).flat)).join('')} />
            {d.pockets.length > 0 && <path fillRule="evenodd" fill={material.bottomColor} d={d.pockets.map(svgPath).join('')} />}
            <g fill="none" stroke={material.bottomColor} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
              {d.border && <path d={svgPath(d.border.flat)} />}
              <path d={[...(d.borderLines ?? []), ...d.pattern, ...d.graphicLines].map(open).join('')} />
            </g>
          </g>
        ))}
        {frames.map(({ g, corners }) => (
          <path key={g.id} className={`dv-frame${focus === g.id ? ' on' : ''}`} d={svgPath(corners)} strokeWidth={1.5 * px} strokeDasharray={`${6 * px} ${4 * px}`} />
        ))}
      </svg>
      <div className="viewer__views"><button onClick={() => setView(fit)}>Fit</button></div>
      <div className="viewer__hint">Drag a logo or text to move it · Shift + drag: slide the pattern · Drag elsewhere: move the view · Wheel: zoom · Grooves are drawn at their real width</div>
    </div>
  );
}
