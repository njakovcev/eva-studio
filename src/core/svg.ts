/**
 * Reads artwork from an SVG file: filled shapes become closed regions, stroked
 * lines become open lines. Curves are turned into short straight pieces.
 *
 * Supported: path, rect, circle, ellipse, line, polyline, polygon, groups and
 * transforms, fill / stroke / fill-rule given as attributes or inline style.
 * Not supported (ignored, and reported): text that has not been converted to
 * outlines, images, <use>, and colours set through a style sheet.
 */
import { cleanRegion, type Region } from './region';

export interface Artwork {
  /** size of the drawing in its own units */
  width: number;
  height: number;
  /** filled shapes, tidied and merged into one; y points up, lower-left corner at 0,0 */
  rings: Region;
  /** the same filled shapes one by one, in drawing order (first = lowest), so overlaps can be kept apart */
  layers: Region[];
  /** stroked lines (open; a closed stroke repeats its first point) */
  lines: number[][];
  /** things in the file that were skipped */
  skipped: string[];
}

type Matrix = [number, number, number, number, number, number]; // a b c d e f
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const numbers = (s: string): number[] => (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);

function parseTransform(s: string | undefined): Matrix {
  let m = IDENTITY;
  if (!s) return m;
  for (const [, name, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = numbers(args);
    let t: Matrix = IDENTITY;
    if (name === 'matrix' && v.length === 6) t = v as Matrix;
    else if (name === 'translate') t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (name === 'scale') t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (name === 'rotate') {
      const a = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a), cx = v[1] ?? 0, cy = v[2] ?? 0;
      t = mul(mul([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (name === 'skewX') t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (name === 'skewY') t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, t);
  }
  return m;
}

/** One subpath: its points, and whether it closes back on itself. */
export interface SubPath { points: number[]; closed: boolean }

const CURVE_STEPS = 24;

/** Turns SVG path data (the `d` attribute) into subpaths of straight pieces. */
export function flattenPathData(d: string): SubPath[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: SubPath[] = [];
  let cur: number[] = [];
  let x = 0, y = 0, startX = 0, startY = 0, lastCx = 0, lastCy = 0, lastCmd = '';
  let i = 0, cmd = '';
  const num = () => Number(tokens[i++]);
  const finish = (closed: boolean) => { if (cur.length >= 4) out.push({ points: cur, closed }); cur = []; };
  const lineTo = (nx: number, ny: number) => { if (cur.length === 0) cur.push(x, y); cur.push(nx, ny); x = nx; y = ny; };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    if (cur.length === 0) cur.push(x, y);
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      cur.push(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
    x = ex; y = ey;
  };
  const arc = (rx: number, ry: number, rot: number, large: number, sweep: number, ex: number, ey: number) => {
    if (rx === 0 || ry === 0) { lineTo(ex, ey); return; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = (rot * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x - ex) / 2, dy = (y - ey) / 2;
    const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const sign = large !== sweep ? 1 : -1;
    const k = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
    const cxp = (k * rx * y1) / ry, cyp = (-k * ry * x1) / rx;
    const cx = cp * cxp - sp * cyp + (x + ex) / 2, cy = sp * cxp + cp * cyp + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
    const steps = Math.max(4, Math.ceil((Math.abs(dt) / (2 * Math.PI)) * 72));
    if (cur.length === 0) cur.push(x, y);
    for (let s = 1; s <= steps; s++) {
      const t = t1 + (dt * s) / steps;
      cur.push(cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp);
    }
    x = ex; y = ey;
  };

  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    else if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l'; // extra pairs after a move are lines
    const rel = cmd === cmd.toLowerCase(), ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': finish(false); x = ox + num(); y = oy + num(); startX = x; startY = y; break;
      case 'L': lineTo(ox + num(), oy + num()); break;
      case 'H': lineTo(ox + num(), y); break;
      case 'V': lineTo(x, oy + num()); break;
      case 'C': { const a = ox + num(), b = oy + num(), c = ox + num(), dd = oy + num(), e = ox + num(), f = oy + num(); cubic(a, b, c, dd, e, f); lastCx = c; lastCy = dd; break; }
      case 'S': {
        const rx1 = /[CS]/i.test(lastCmd) ? 2 * x - lastCx : x, ry1 = /[CS]/i.test(lastCmd) ? 2 * y - lastCy : y;
        const c = ox + num(), dd = oy + num(), e = ox + num(), f = oy + num(); cubic(rx1, ry1, c, dd, e, f); lastCx = c; lastCy = dd; break;
      }
      case 'Q': {
        const qx = ox + num(), qy = oy + num(), e = ox + num(), f = oy + num();
        cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), e + (2 / 3) * (qx - e), f + (2 / 3) * (qy - f), e, f); lastCx = qx; lastCy = qy; break;
      }
      case 'T': {
        const qx = /[QT]/i.test(lastCmd) ? 2 * x - lastCx : x, qy = /[QT]/i.test(lastCmd) ? 2 * y - lastCy : y;
        const e = ox + num(), f = oy + num(), px = x, py = y;
        cubic(px + (2 / 3) * (qx - px), py + (2 / 3) * (qy - py), e + (2 / 3) * (qx - e), f + (2 / 3) * (qy - f), e, f); lastCx = qx; lastCy = qy; break;
      }
      case 'A': { const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(); arc(rx, ry, rot, large, sweep, ox + num(), oy + num()); break; }
      case 'Z': if (cur.length === 0) cur.push(x, y); finish(true); x = startX; y = startY; break;
      default: i++; // unknown command: skip a token rather than loop forever
    }
    lastCmd = cmd;
  }
  finish(false);
  return out;
}

interface Style { fill: string; stroke: string; evenOdd: boolean }

const SKIP_INSIDE = new Set(['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'style', 'metadata', 'title', 'desc', 'script', 'linearGradient', 'radialGradient', 'filter']);

export function parseSvg(text: string): Artwork {
  const filled: { rings: number[][]; evenOdd: boolean }[] = [];
  const stroked: number[][] = [];
  const skipped = new Set<string>();
  const stack: { name: string; matrix: Matrix; style: Style }[] = [];
  let matrix = IDENTITY, style: Style = { fill: 'black', stroke: 'none', evenOdd: false };
  let skipDepth = 0;

  const source = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  if (!/<svg[\s>]/i.test(source)) throw new Error('This file is not an SVG drawing.');

  for (const m of source.matchAll(tag)) {
    const closing = m[1] === '/', name = m[2].replace(/^svg:/, ''), selfClosing = m[4] === '/';
    if (closing) {
      const top = stack.pop();
      if (top) { matrix = top.matrix; style = top.style; if (SKIP_INSIDE.has(top.name)) skipDepth--; }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3] ?? '';
    for (const part of (attrs.style ?? '').split(';')) { const [k, v] = part.split(':'); if (k && v) attrs[k.trim()] = v.trim(); }

    const before = { name, matrix, style };
    const here = mul(matrix, parseTransform(attrs.transform));
    const st: Style = {
      fill: attrs.fill ?? style.fill,
      stroke: attrs.stroke ?? style.stroke,
      evenOdd: attrs['fill-rule'] ? attrs['fill-rule'] === 'evenodd' : style.evenOdd,
    };
    const inSkipped = skipDepth > 0 || SKIP_INSIDE.has(name);

    if (!inSkipped) {
      let subs: SubPath[] | null = null;
      const n = (k: string, d = 0) => (attrs[k] !== undefined ? parseFloat(attrs[k]) : d);
      if (name === 'path' && attrs.d) subs = flattenPathData(attrs.d);
      else if (name === 'rect') {
        const x = n('x'), y = n('y'), w = n('width'), h = n('height');
        let rx = attrs.rx !== undefined ? n('rx') : n('ry'), ry = attrs.ry !== undefined ? n('ry') : rx;
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        if (w > 0 && h > 0) {
          subs = flattenPathData(rx > 0 && ry > 0
            ? `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`
            : `M${x},${y} H${x + w} V${y + h} H${x} Z`);
        }
      } else if (name === 'circle' || name === 'ellipse') {
        const cx = n('cx'), cy = n('cy'), rx = name === 'circle' ? n('r') : n('rx'), ry = name === 'circle' ? n('r') : n('ry');
        if (rx > 0 && ry > 0) subs = flattenPathData(`M${cx - rx},${cy} A${rx},${ry} 0 1 0 ${cx + rx},${cy} A${rx},${ry} 0 1 0 ${cx - rx},${cy} Z`);
      } else if (name === 'line') subs = [{ points: [n('x1'), n('y1'), n('x2'), n('y2')], closed: false }];
      else if (name === 'polyline' || name === 'polygon') { const p = numbers(attrs.points ?? ''); if (p.length >= 4) subs = [{ points: p.slice(0, p.length - (p.length % 2)), closed: name === 'polygon' }]; }
      else if (name === 'text' || name === 'tspan') skipped.add('text that is not converted to outlines');
      else if (name === 'image') skipped.add('pictures (bitmaps)');
      else if (name === 'use') skipped.add('reused symbols (<use>)');

      if (subs) {
        const moved = subs.map((s) => {
          const pts: number[] = [];
          for (let k = 0; k < s.points.length; k += 2) { const [px, py] = apply(here, s.points[k], s.points[k + 1]); pts.push(px, py); }
          return { points: pts, closed: s.closed };
        });
        if (st.fill !== 'none' && name !== 'line' && name !== 'polyline') {
          filled.push({ rings: moved.filter((s) => s.points.length >= 6).map((s) => s.points), evenOdd: st.evenOdd });
        } else if (st.stroke !== 'none' || name === 'line' || name === 'polyline') {
          for (const s of moved) stroked.push(s.closed ? [...s.points, s.points[0], s.points[1]] : s.points);
        }
      }
    }

    if (!selfClosing) {
      stack.push(before);
      matrix = here; style = st;
      if (SKIP_INSIDE.has(name)) skipDepth++;
    }
  }

  // everything into one tidy drawing: y up, lower-left corner at 0,0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (p: number[]) => { for (let k = 0; k < p.length; k += 2) { minX = Math.min(minX, p[k]); maxX = Math.max(maxX, p[k]); minY = Math.min(minY, p[k + 1]); maxY = Math.max(maxY, p[k + 1]); } };
  filled.forEach((f) => f.rings.forEach(see)); stroked.forEach(see);
  if (!Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0) throw new Error('No shapes were found in this SVG. If it contains text, convert the text to outlines (paths) first.');
  const place = (p: number[]) => p.map((v, k) => (k % 2 === 0 ? v - minX : maxY - v));
  // work in a comfortable number range for tidying, then return in the drawing's own units
  const k = 1000 / Math.max(maxX - minX, maxY - minY);
  const scale = (p: number[], f: number) => p.map((v) => v * f);
  const layers: Region[] = [];
  for (const f of filled) {
    const layer = cleanRegion(f.rings.map((r) => scale(place(r), k)), !f.evenOdd);
    if (layer.length) layers.push(layer);
  }
  const rings = cleanRegion(layers.flat(), true).map((r) => scale(r, 1 / k));
  return {
    width: maxX - minX, height: maxY - minY, rings,
    layers: layers.map((l) => l.map((r) => scale(r, 1 / k))),
    lines: stroked.map(place), skipped: [...skipped],
  };
}
