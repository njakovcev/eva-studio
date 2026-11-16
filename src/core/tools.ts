/**
 * Milling tools. The groove cutter's profile decides how wide a milled line
 * looks at a given depth, which the design preview and the checks rely on.
 */
export interface GrooveProfile {
  /** straight tip: diameter and height, mm */
  tipDiameter: number;
  tipHeight: number;
  /** above the tip the cutter widens along a quarter circle of this radius, mm */
  radius: number;
}

export interface GrooveTool {
  number: number;
  name: string;
  profile: GrooveProfile;
  rpm: number;
  feed: number;
  plunge: number;
}

/** T21 from the machine's tool list: form cutter 4.6*2H*R3.05 (see alati/Glodala-HS1330 in the project notes). */
export const DEFAULT_GROOVE_TOOL: GrooveTool = {
  number: 21,
  name: 'EVA groove form cutter',
  profile: { tipDiameter: 4.6, tipHeight: 2, radius: 3.05 },
  rpm: 18000, feed: 3500, plunge: 800,
};

/** Width of the groove at the surface of the sheet when milled `depth` mm deep. */
export function grooveWidth(tool: GrooveTool, depth: number): number {
  const { tipDiameter, tipHeight, radius } = tool.profile;
  if (depth <= tipHeight) return tipDiameter;
  const h = Math.min(depth - tipHeight, radius);
  return tipDiameter + 2 * (radius - Math.sqrt(radius * radius - h * h));
}
