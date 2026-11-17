/**
 * The CNC operations, in the order they are run, and the DXF layer each one
 * is written to. One layer = one operation with one tool, so the CAM program
 * (or later the G-code generator) can pick them up one by one.
 *
 *   0_REFERENCE          not machined: sheet edge, surface outline, labels
 *   1_T21_GROOVE_3MM     groove cutter along these centre lines, 3 mm deep
 *   2_T21_POCKET_3MM     clear out the inside of these closed shapes, 3 mm deep
 *   3_KNIFE_INNER        knife: openings inside panels (before the outer cut)
 *   4_KNIFE_OUTER        knife: panel outlines, last, so parts stay put while milling
 */
import type { DxfLayer } from './dxf';
import type { GrooveTool } from './tools';

const mmText = (v: number) => String(Math.round(v * 10) / 10).replace('.', '_');

export const LAYER = {
  reference: '0_REFERENCE',
  groove: (tool: GrooveTool, depth: number) => `1_T${tool.number}_GROOVE_${mmText(depth)}MM`,
  pocket: (tool: GrooveTool, depth: number) => `2_T${tool.number}_POCKET_${mmText(depth)}MM`,
  innerCut: '3_KNIFE_INNER',
  outerCut: '4_KNIFE_OUTER',
};

export function operationLayers(tool: GrooveTool, depth: number): DxfLayer[] {
  return [
    { name: LAYER.reference, color: 8 },
    { name: LAYER.groove(tool, depth), color: 3 },
    { name: LAYER.pocket(tool, depth), color: 6 },
    { name: LAYER.innerCut, color: 5 },
    { name: LAYER.outerCut, color: 1 },
  ];
}
