/**
 * The CNC operations, in the order they are run, and the DXF layer each one
 * is written to. One layer = one operation with one tool, so the CAM program
 * (or later the G-code generator) can pick them up one by one.
 *
 *   0_REFERENCE          not machined: sheet edge, surface outline, labels
 *   1_T21_GROOVE_3MM     groove cutter along these centre lines, 3 mm deep
 *   2_T21_POCKET_3MM     clear out the inside of these closed shapes, 3 mm deep
 *   3_T20_EDGE_5MM       rounded edge: tool centre along these lines (just outside every
 *                        knife cut), lowest point 5 mm deep
 *   4_KNIFE_INNER        knife: openings inside panels (before the outer cut)
 *   5_KNIFE_OUTER        knife: panel outlines, last, so parts stay put while milling
 *
 * The tool numbers come from the project's machining settings.
 */
import type { DxfLayer } from './dxf';
import type { Machining, Tool } from './tools';

const mmText = (v: number) => String(Math.round(v * 10) / 10).replace('.', '_');

export const LAYER = {
  reference: '0_REFERENCE',
  groove: (tool: Tool, depth: number) => `1_T${tool.number}_GROOVE_${mmText(depth)}MM`,
  pocket: (tool: Tool, depth: number) => `2_T${tool.number}_POCKET_${mmText(depth)}MM`,
  edge: (tool: Tool, depth: number) => `3_T${tool.number}_EDGE_${mmText(depth)}MM`,
  innerCut: '4_KNIFE_INNER',
  outerCut: '5_KNIFE_OUTER',
};

export function operationLayers(m: Machining, depth: number): DxfLayer[] {
  return [
    { name: LAYER.reference, color: 8 },
    { name: LAYER.groove(m.groove, depth), color: 3 },
    { name: LAYER.pocket(m.pocket, depth), color: 6 },
    ...(m.edge ? [{ name: LAYER.edge(m.edge.tool, m.edge.bottomDepth), color: 2 }] : []),
    { name: LAYER.innerCut, color: 5 },
    { name: LAYER.outerCut, color: 1 },
  ];
}
