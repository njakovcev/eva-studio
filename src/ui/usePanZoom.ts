import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface View { x: number; y: number; w: number; h: number }

/**
 * Zoom and coordinate helpers for a 2D drawing in an <svg>.
 * Drawing units are millimetres with y pointing up; SVG's y points down, so y is negated when drawing.
 */
export function usePanZoom(svg: RefObject<SVGSVGElement | null>, fit: View) {
  const [view, setView] = useState<View>(fit);
  useEffect(() => { setView(fit); }, [fit]);

  // mm per screen pixel, so handles and line widths keep the same size on screen at any zoom
  const [px, setPx] = useState(1);
  useEffect(() => {
    const el = svg.current; if (!el) return;
    const measure = () => setPx(Math.max(view.w / el.clientWidth, view.h / el.clientHeight) || 1);
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [svg, view]);

  // Wheel, two-finger scroll and trackpad pinch zoom around the pointer. Registered directly
  // (not through React) so the browser can be told not to scroll or magnify the page.
  useEffect(() => {
    const el = svg.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = el.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
      const q = p.matrixTransform(el.getScreenCTM()!.inverse());
      const k = Math.exp(Math.max(-50, Math.min(50, e.deltaY)) * (e.ctrlKey ? 0.01 : 0.0015));
      setView((v) => ({ x: q.x - (q.x - v.x) * k, y: q.y - (q.y - v.y) * k, w: v.w * k, h: v.h * k }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [svg]);

  /** screen position → drawing coordinates (mm, y up) */
  const toPlane = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const p = svg.current!.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return [q.x, -q.y];
  }, [svg]);

  return { view, setView, px, toPlane };
}

/** A colour made darker (0…1 of the original brightness), for the sloped sides of a groove. */
export function shade(hex: string, k = 0.72): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16), c = (v: number) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

export const svgPath = (pts: ArrayLike<number>) => {
  let d = '';
  for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]},${-pts[i + 1]}`;
  return d + 'Z';
};

export const distToPath = (x: number, y: number, pts: number[]) => {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], dx = pts[i + 2] - ax, dy = pts[i + 3] - ay;
    const len2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
};
