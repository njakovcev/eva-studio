import { useMemo, useRef } from 'react';
import { designPanel, edgePaths } from '../core/design';
import { applyPlacement } from '../core/nest';
import { cutOutline, cutoutOutline } from '../core/panel';
import { bounds } from '../core/poly';
import { nestOptionsOf } from '../core/sheets';
import { grooveWidth, machiningOf } from '../core/tools';
import { libraryOf, useApp } from '../store';
import { svgPath, usePanZoom, type View } from './usePanZoom';

const open = (l: number[]) => { let d = ''; for (let k = 0; k < l.length; k += 2) d += `${k ? 'L' : 'M'}${l[k]},${-l[k + 1]}`; return d; };
const SPACE = 160; // between sheets in the picture, mm

/** The sheets as they will be machined: every panel in place, with its design. */
export function ExportView() {
  const project = useApp((s) => s.project!);
  const result = useApp((s) => s.nest);
  const arranging = useApp((s) => s.arranging);
  const o = nestOptionsOf(project.settings);
  const library = libraryOf(project);
  const material = project.settings.material;
  const svg = useRef<SVGSVGElement>(null);
  const sheets = Math.max(1, result?.sheets ?? 1);
  const fit = useMemo<View>(() => {
    const h = sheets * o.sheetWidth + (sheets - 1) * SPACE, pad = 80;
    return { x: -pad, y: -h - pad, w: o.sheetLength + 2 * pad, h: h + 2 * pad };
  }, [sheets, o.sheetLength, o.sheetWidth]);
  const { view, setView, px } = usePanZoom(svg, fit);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);
  // sheet 1 on top: sheet i sits (sheets − 1 − i) rows up
  const lift = (sheet: number) => (sheets - 1 - sheet) * (o.sheetWidth + SPACE);

  return (
    <div className="editor">
      <svg
        ref={svg} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, view }; }}
        onPointerMove={(e) => { const d = drag.current; if (d) setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * px, y: d.view.y - (e.clientY - d.y) * px }); }}
        onPointerUp={() => { drag.current = null; }}
      >
        {Array.from({ length: sheets }, (_, i) => {
          const used = result?.usedLength[i] ?? 0;
          return (
            <g key={i} transform={`translate(0 ${-lift(i)})`}>
              <rect className="sheet" x={0} y={-o.sheetWidth} width={o.sheetLength} height={o.sheetWidth} strokeWidth={2 * px} />
              <rect className="sheet__margin" x={o.margin} y={-o.sheetWidth + o.margin} width={o.sheetLength - 2 * o.margin} height={o.sheetWidth - 2 * o.margin} strokeWidth={1 * px} strokeDasharray={`${6 * px} ${5 * px}`} />
              {used > 0 && used < o.sheetLength - 1 && <line className="sheet__used" x1={used} y1={0} x2={used} y2={-o.sheetWidth} strokeWidth={1.5 * px} strokeDasharray={`${10 * px} ${6 * px}`} />}
              <text className="sheet__title" x={0} y={-o.sheetWidth} dy={-10 * px} fontSize={14 * px}>Sheet {i + 1} · {o.sheetLength} × {o.sheetWidth} mm{used > 0 ? ` · used ${Math.round(used)} mm` : ''}</text>
            </g>
          );
        })}
        {(result?.placements ?? []).map((pl) => {
          const panel = project.panels.find((p) => p.id === pl.partId);
          if (!panel) return null;
          const design = project.designs.find((d) => d.surfaceId === panel.surfaceId);
          const { machining } = machiningOf(project.settings);
          const d = design ? designPanel(panel, design, library, machining) : null;
          const cut = d?.cut ?? cutOutline(panel);
          const width = grooveWidth(machining.groove, design?.depth ?? 3);
          const band = machining.edge ? edgePaths(panel, machining.edge).band : [];
          const b = bounds(applyPlacement(pl, cut.flat));
          return (
            <g key={pl.partId} transform={`translate(0 ${-lift(pl.sheet)})`}>
              {/* the drawing is y-down, so a counter-clockwise turn is written as a negative angle */}
              <g transform={`translate(${pl.tx} ${-pl.ty}) rotate(${-pl.angle})`}>
                <path fillRule="evenodd" fill={material.topColor} d={svgPath(cut.flat) + (panel.cutouts ?? []).map((c) => svgPath(cutoutOutline(c).flat)).join('')} />
                {band.length > 0 && <path fillRule="evenodd" fill={material.bottomColor} d={band.map(svgPath).join('')} />}
                {d && d.pockets.length > 0 && <path fillRule="evenodd" fill={material.bottomColor} d={d.pockets.map(svgPath).join('')} />}
                {d && (
                  <g fill="none" stroke={material.bottomColor} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
                    {d.border && <path d={svgPath(d.border.flat)} />}
                    <path d={[...(d.borderLines ?? []), ...d.pattern, ...d.graphicLines].map(open).join('')} />
                  </g>
                )}
                <path className="sheet__cut" d={svgPath(cut.flat)} strokeWidth={1.5 * px} />
              </g>
              <text className="sheet__label" x={(b.minX + b.maxX) / 2} y={-(b.minY + b.maxY) / 2} fontSize={13 * px} textAnchor="middle" strokeWidth={3 * px}>{panel.name}</text>
            </g>
          );
        })}
      </svg>
      {arranging && <div className="viewer__busy"><span className="spinner" />Arranging the panels…</div>}
      <div className="viewer__views"><button onClick={() => setView(fit)}>Fit</button></div>
      <div className="viewer__hint">Drag: move the view · Wheel: zoom · Dashed frame: distance kept from the sheet edge</div>
    </div>
  );
}
