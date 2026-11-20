/**
 * Turning the drawing of a scanned surface: everything that lives in its flat coordinates
 * (outline, scan edge, holes, measurements, bow, its panels and its design) turns together,
 * and the surface's axes in the scan turn the opposite way, so nothing moves on the boat.
 */
import type { Design } from './design';
import type { Panel } from './panel';
import type { Project } from './project';
import { normalAngle, type Surface } from './surface';
import type { Vec2, Vec3 } from './vec';

function rotation(degrees: number) {
  const a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const point = (p: Vec2): Vec2 => [c * p[0] - s * p[1], s * p[0] + c * p[1]];
  const flat = (xs: number[]): number[] => { const out = xs.slice(); for (let k = 0; k + 1 < xs.length; k += 2) { out[k] = c * xs[k] - s * xs[k + 1]; out[k + 1] = s * xs[k] + c * xs[k + 1]; } return out; };
  return { c, s, point, flat };
}

/** The surface itself, turned by `degrees` (anticlockwise as drawn). */
export function turnSurface(s: Surface, degrees: number): Surface {
  const r = rotation(degrees), { u, v } = s.plane;
  // a point x·u + y·v must stay where it is: the axes turn the other way
  const mix = (p: Vec3, q: Vec3, a: number, b: number): Vec3 => [a * p[0] + b * q[0], a * p[1] + b * q[1], a * p[2] + b * q[2]];
  return {
    ...s,
    plane: { ...s.plane, u: mix(u, v, r.c, -r.s), v: mix(u, v, r.s, r.c) },
    raw: { outer: r.flat(s.raw.outer), holes: s.raw.holes.map((h) => ({ ...h, points: r.flat(h.points) })) },
    outline: {
      ...s.outline,
      edge: r.flat(s.outline.edge),
      anchors: s.outline.anchors.map((a) => (a.manual ? { ...a, manual: r.point(a.manual) } : a)),
      corners: s.outline.corners.map(r.point),
      ...(s.outline.curves ? { curves: s.outline.curves.map((c) => (c ? r.flat(c) : c)) } : {}),
    },
    ...(s.checks ? { checks: s.checks.map((c) => ({ ...c, a: r.point(c.a), b: r.point(c.b) })) } : {}),
    ...(s.bow !== undefined ? { bow: normalAngle(s.bow + degrees) } : {}),
  };
}

function turnPanel(p: Panel, degrees: number): Panel {
  const r = rotation(degrees);
  return {
    ...p,
    shape: { corners: p.shape.corners.map(r.point), curves: p.shape.curves.map((c) => (c ? r.flat(c) : c)) },
    ...(p.cutouts ? { cutouts: p.cutouts.map((c) => (c.kind === 'rect' ? { ...c, center: r.point(c.center), angle: c.angle + degrees } : { ...c, center: r.point(c.center) })) } : {}),
    ...(p.bow !== undefined ? { bow: normalAngle(p.bow + degrees) } : {}),
  };
}

function turnDesign(d: Design, degrees: number): Design {
  const r = rotation(degrees);
  const [ox, oy] = r.point([d.pattern.originX, d.pattern.originY]);
  return {
    ...d,
    pattern: { ...d.pattern, angle: d.pattern.angle + degrees, originX: ox, originY: oy },
    ...(d.graphics ? { graphics: d.graphics.map((g) => { const [x, y] = r.point([g.x, g.y]); return { ...g, x, y, angle: g.angle + degrees }; }) } : {}),
  };
}

/** Turns a scanned surface with its panels and design. Throws for a surface drawn by hand. */
export function turnSurfaceInProject(project: Project, surfaceId: string, degrees: number): Project {
  const s = project.surfaces.find((x) => x.id === surfaceId);
  if (!s) throw new Error('That surface no longer exists.');
  if (s.sketchId) throw new Error('This surface is drawn by hand: turn it in its drawing instead.');
  if (Math.abs(degrees) < 1e-9) return project;
  return {
    ...project,
    surfaces: project.surfaces.map((x) => (x.id === surfaceId ? turnSurface(x, degrees) : x)),
    panels: project.panels.map((p) => (p.surfaceId === surfaceId ? turnPanel(p, degrees) : p)),
    designs: project.designs.map((d) => (d.surfaceId === surfaceId ? turnDesign(d, degrees) : d)),
  };
}

/** The smallest turn (degrees) that lays side i of the outline level or upright. */
export function straightenAngle(s: Surface, i: number): number {
  const c = s.outline.corners, n = c.length;
  const a = c[i], b = c[(i + 1) % n];
  const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const target = Math.round(angle / 90) * 90;
  return target - angle;
}

/** Index of the longest straight side (the best one to straighten a new surface by). */
export function longestStraightSide(s: Surface): number {
  const c = s.outline.corners, n = c.length, curves = s.outline.curves ?? [];
  let best = 0, bestL = -1;
  for (let i = 0; i < n; i++) {
    if (curves[i]) continue;
    const l = Math.hypot(c[(i + 1) % n][0] - c[i][0], c[(i + 1) % n][1] - c[i][1]);
    if (l > bestL) { bestL = l; best = i; }
  }
  return best;
}
