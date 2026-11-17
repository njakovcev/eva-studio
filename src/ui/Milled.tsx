import type { PanelDesign } from '../core/design';
import { colourWidth, grooveWidth, type Machining, type Tool } from '../core/tools';
import { shade, svgPath } from './usePanZoom';

const open = (l: number[]) => { let d = ''; for (let k = 0; k < l.length; k += 2) d += `${k ? 'L' : 'M'}${l[k]},${-l[k + 1]}`; return d; };

/**
 * What is milled into one panel, as it will look: filled shapes in the bottom colour, and every
 * groove drawn at its tool's width (the rounded sides darker, the line of bottom colour on top).
 */
export function Milled({ d, machining, depth, topColor, bottomColor }: { d: PanelDesign; machining: Machining; depth: number; topColor: string; bottomColor: string }) {
  const sets: { key: string; tool: Tool; paths: string }[] = [
    { key: 'main', tool: machining.groove, paths: (d.border ? svgPath(d.border.flat) : '') + [...(d.borderLines ?? []), ...d.pattern, ...d.graphicLines].map(open).join('') },
    ...d.byTool.map((b) => ({ key: `T${b.tool.number}`, tool: b.tool, paths: b.lines.map(open).join('') })),
  ];
  const pockets = [...d.pockets, ...d.byTool.flatMap((b) => b.pockets)];
  return (
    <>
      {pockets.length > 0 && <path fillRule="evenodd" fill={bottomColor} d={pockets.map(svgPath).join('')} />}
      {sets.filter((s) => s.paths).flatMap((s) => [
        { key: `${s.key}-side`, w: grooveWidth(s.tool, depth), c: shade(topColor), paths: s.paths },
        { key: `${s.key}-line`, w: colourWidth(s.tool, depth, machining.topLayer), c: bottomColor, paths: s.paths },
      ]).filter((x) => x.w > 0).map((x) => (
        <path key={x.key} d={x.paths} fill="none" stroke={x.c} strokeWidth={x.w} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </>
  );
}
