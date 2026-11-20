import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BowArrow, centreOf } from './Bow';
import { bowOf } from '../core/surface';
import { newId } from '../core/project';
import type { SkConstraint, SkDimension, SkEntity, Sketch } from '../core/sketch/model';
import { constraintRefs, isDimension } from '../core/sketch/model';
import { addConstraint, analyse, measure, setDimension, signedNow, solve } from '../core/sketch/solver';
import { distanceToEntity, entityPath, filletCorner, pointMap, removeItems, sketchOutline } from '../core/sketch/geometry';
import {
  circumcentre, dimensionChoice, dimensionDrawing, drawArc3, drawCircle, drawLine, drawSpline, drawTangentArc,
  entityEndingAt, levelPhoto, movePhoto, nearAxis, offsetThrough, photoToDrawing, scalePhoto, type DimensionKind, type PointRef,
} from '../core/sketch/draw';
import { readProjectFile } from '../io/projectFolder';
import { useApp } from '../store';
import { usePanZoom, type View } from './usePanZoom';

/** A click target after snapping: an existing point, or a position (held on a line if dropped on one). */
interface Snap { ref: PointRef; x: number; y: number; onLine?: string }

interface Popover {
  /** position in the editor, in screen pixels */
  left: number; top: number;
  title: string; value: string; unit: string;
  kinds?: DimensionKind[]; kind?: DimensionKind;
  /** the value as drawn now, for each kind */
  valueFor?: (kind: DimensionKind) => string;
  note?: string;
  apply(value: number, kind: DimensionKind): void;
}

type Drag =
  | { kind: 'pan'; view: View }
  | { kind: 'point'; id: string }
  | { kind: 'entity'; ids: { id: string; x: number; y: number }[]; x: number; y: number }
  | { kind: 'label'; id: string }
  | { kind: 'photo'; x: number; y: number; from: { x: number; y: number } };

interface Press { clientX: number; clientY: number; x: number; y: number; grab: Drag | null; moved: boolean; drag: Drag | null }

const GLYPH: Partial<Record<SkConstraint['kind'], string>> = {
  horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', equalLength: '=', equalRadius: '=', tangent: 'T',
  pointOnLine: '•', pointOnCurve: '•', midpoint: 'M', symmetric: 'S', fix: '⚓',
};

const openPath = (p: number[]) => { let d = ''; for (let i = 0; i + 1 < p.length; i += 2) d += `${i ? 'L' : 'M'}${p[i]},${-p[i + 1]}`; return d; };
const round1 = (v: number) => String(Math.round(v * 10) / 10);

/**
 * 2D sketch editor: a photo underneath, lines, arcs, circles and splines drawn over it,
 * and relations and tape measurements that the solver keeps true.
 */
export function SketchEditor({ sketch }: { sketch: Sketch }) {
  const tool = useApp((s) => s.sketchTool);
  const selection = useApp((s) => s.sketchSelection);
  const dir = useApp((s) => s.dir);
  const surface = useApp((s) => s.project?.surfaces.find((x) => x.id === sketch.surfaceId));
  const { updateSketch, setSketchTool, setSketchSelection } = useApp.getState();
  const svg = useRef<SVGSVGElement>(null);
  const latest = useRef(sketch);
  latest.current = sketch;

  // ---- view ----
  const fit = useMemo<View>(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
    for (const p of sketch.points) add(p.x, p.y);
    const ph = sketch.photo;
    if (ph && !ph.hidden) for (const [u, v] of [[0, 0], [ph.widthPx, 0], [0, ph.heightPx], [ph.widthPx, ph.heightPx]]) { const q = photoToDrawing(ph, u, v); add(q.x, q.y); }
    if (!(maxX > minX) || !(maxY > minY)) { minX = -500; maxX = 4500; minY = -500; maxY = 2500; }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.08;
    return { x: minX - pad, y: -maxY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
    // refit only when another sketch is opened or a photo is added
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch.id, sketch.photo?.file]);
  const { view, setView, px, toPlane } = usePanZoom(svg, fit);

  // ---- photo ----
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  useEffect(() => {
    const file = sketch.photo?.file;
    if (!file || !dir) { setPhotoUrl(null); return; }
    let url: string | null = null, gone = false;
    readProjectFile(dir, file).then((f) => { if (gone) return; url = URL.createObjectURL(f); setPhotoUrl(url); })
      .catch(() => useApp.setState({ error: `The photo “${file}” was not found in the project folder. Add it again.` }));
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [sketch.photo?.file, dir]);

  // ---- analysis (a moment behind while dragging, so dragging stays smooth) ----
  const settled = useDeferredValue(sketch);
  const analysis = useMemo(() => analyse(settled), [settled]);
  const outline = useMemo(() => sketchOutline(settled), [settled]);
  const openEnds = useMemo(() => new Set(outline.ok ? [] : outline.openPoints), [outline]);
  const pts = useMemo(() => pointMap(sketch), [sketch]);
  const paths = useMemo(() => new Map(sketch.entities.map((e) => [e.id, entityPath(sketch, e, pts)])), [sketch, pts]);

  // ---- tool state ----
  const [chain, setChain] = useState<Snap | null>(null); // line / tangent arc: where the next one starts
  const [picks, setPicks] = useState<Snap[]>([]); // arc, circle, spline, photo tools
  const [dimPick, setDimPick] = useState<string[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const press = useRef<Press | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const reset = () => { setChain(null); setPicks([]); setDimPick([]); setPopover(null); };
  // switching between line and tangent arc keeps drawing from the same end
  const prevTool = useRef(tool);
  useEffect(() => {
    const drawing = (t: string) => t === 'line' || t === 'tangentArc';
    if (drawing(prevTool.current) && drawing(tool)) { setPicks([]); setPopover(null); } else reset();
    prevTool.current = tool;
  }, [tool]);
  useEffect(reset, [sketch.id]);

  const fail = (message: string) => useApp.setState({ error: message });
  const save = (s: Sketch) => void updateSketch(s, true);

  // ---- hit testing (tolerances in screen pixels) ----
  const hitPoint = (x: number, y: number, skip?: string) => {
    let best: string | null = null, bd = 9 * px;
    for (const p of sketch.points) { if (p.id === skip) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p.id; } }
    return best;
  };
  const hitEntity = (x: number, y: number, only?: (e: SkEntity) => boolean) => {
    let best: string | null = null, bd = 7 * px;
    for (const e of sketch.entities) { if (only && !only(e)) continue; const d = distanceToEntity(sketch, e, x, y, pts); if (d < bd) { bd = d; best = e.id; } }
    return best;
  };
  const gap = 32 * px;
  const dims = useMemo(() => sketch.constraints.filter(isDimension).map((d) => ({ d, g: dimensionDrawing(sketch, d, measure(sketch, d), gap) })), [sketch, gap]);
  const hitLabel = (x: number, y: number) => {
    for (const { d, g } of dims) if (g && Math.abs(g.label.x - x) < (g.label.text.length * 4 + 6) * px && Math.abs(g.label.y - y) < 10 * px) return d.id;
    return null;
  };
  const glyphs = useMemo(() => {
    const out: { id: string; x: number; y: number; text: string }[] = [];
    const count = new Map<string, number>();
    const at = (id: string, x: number, y: number, text: string) => {
      const key = `${Math.round(x / (20 * px))},${Math.round(y / (20 * px))}`, k = count.get(key) ?? 0;
      count.set(key, k + 1);
      out.push({ id, x: x + (12 + k * 16) * px, y: y - 12 * px, text });
    };
    const mid = (eid: string) => { const p = paths.get(eid); if (!p || p.length < 4) return null; const i = Math.floor(p.length / 4) * 2; return p.length === 4 ? { x: (p[0] + p[2]) / 2, y: (p[1] + p[3]) / 2 } : { x: p[i], y: p[i + 1] }; };
    for (const c of sketch.constraints) {
      const text = GLYPH[c.kind];
      if (!text || isDimension(c)) continue;
      if (c.kind === 'horizontal' || c.kind === 'vertical') {
        const p = pts.get(c.p), q = pts.get(c.q);
        if (p && q) at(c.id, (p.x + q.x) / 2, (p.y + q.y) / 2, text);
      } else if (c.kind === 'pointOnLine' || c.kind === 'pointOnCurve' || c.kind === 'midpoint' || c.kind === 'fix') {
        const p = pts.get(c.p);
        if (p) at(c.id, p.x, p.y, text);
      } else if (c.kind === 'symmetric') {
        for (const id of [c.p, c.q]) { const p = pts.get(id); if (p) at(c.id, p.x, p.y, text); }
      } else if (c.kind === 'tangent') {
        const m = mid(c.e2); if (m) at(c.id, m.x, m.y, text);
      } else {
        for (const id of constraintRefs(c)) { const m = mid(id); if (m) at(c.id, m.x, m.y, text); }
      }
    }
    return out;
  }, [sketch, pts, paths, px]);
  const hitGlyph = (x: number, y: number) => glyphs.find((g) => Math.abs(g.x - x) < 7 * px && Math.abs(g.y - y) < 7 * px)?.id ?? null;

  /** Where a click lands: on an existing point, on a line, or free. */
  const snap = (x: number, y: number, skip?: string): Snap => {
    const p = hitPoint(x, y, skip);
    if (p) { const q = pts.get(p)!; return { ref: { id: p }, x: q.x, y: q.y }; }
    const l = hitEntity(x, y, (e) => e.kind === 'line');
    if (l) {
      const e = sketch.entities.find((k) => k.id === l) as Extract<SkEntity, { kind: 'line' }>;
      const a = pts.get(e.a)!, b = pts.get(e.b)!, dx = b.x - a.x, dy = b.y - a.y, t = ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1);
      return { ref: { x: a.x + dx * t, y: a.y + dy * t }, x: a.x + dx * t, y: a.y + dy * t, onLine: l };
    }
    return { ref: { x, y }, x, y };
  };
  /** A new end close to level or plumb with its start is put exactly level or plumb. */
  const straighten = (from: Snap, to: Snap): Snap => {
    if ('id' in to.ref || to.onLine) return to;
    const axis = nearAxis(from, to);
    if (axis === 'horizontal') return { ref: { x: to.x, y: from.y }, x: to.x, y: from.y };
    if (axis === 'vertical') return { ref: { x: from.x, y: to.y }, x: from.x, y: to.y };
    return to;
  };

  const screenOf = (clientX: number, clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    return { left: Math.min(clientX - r.left + 12, r.width - 240), top: Math.min(clientY - r.top + 12, r.height - 150) };
  };

  // ---- measurements ----
  const askDimension = (ids: string[], clientX: number, clientY: number) => {
    const s = latest.current, choice = dimensionChoice(s, ids);
    if (!choice) return false;
    const preview = (kind: DimensionKind) => measure(s, signedNow(s, choice.make(kind, () => 'preview')));
    const first = choice.make('aligned', () => 'preview');
    const unit = first.kind === 'angle' ? '°' : 'mm';
    setPopover({
      ...screenOf(clientX, clientY),
      title: first.kind === 'angle' ? 'Angle' : first.kind === 'radius' ? (first.diameter ? 'Diameter' : 'Radius') : 'Measured distance',
      value: round1(first.kind === 'radius' && first.diameter ? preview('aligned') * 2 : preview('aligned')), unit,
      kinds: choice.kinds.length > 1 ? choice.kinds : undefined, kind: 'aligned', valueFor: (k) => round1(preview(k)),
      apply: (value: number, kind: DimensionKind) => {
        const now = latest.current;
        const d = signedNow(now, choice.make(kind, newId)) as SkDimension;
        const r = addConstraint(now, d);
        if (r.status === 'refused') { fail(r.message); return; }
        if (r.status === 'reference') { useApp.setState({ notice: r.message }); save(r.sketch); return; }
        const target = d.kind === 'radius' && d.diameter ? value / 2 : value;
        if (Math.abs(target - measure(r.sketch, d)) < 1e-6) { save(r.sketch); return; }
        const set = setDimension(r.sketch, d.id, target);
        if (!set.ok) { fail(set.message); return; }
        save(set.sketch);
      },
    });
    return true;
  };
  const editDimension = (id: string, clientX: number, clientY: number) => {
    const d = latest.current.constraints.find((c) => c.id === id) as SkDimension | undefined;
    if (!d) return;
    const shown = measure(latest.current, d);
    setPopover({
      ...screenOf(clientX, clientY),
      title: d.reference ? 'Reference measurement' : 'Change measurement',
      note: d.reference ? 'Shown in brackets: the other measurements already decide it. Type a value to make it set the drawing instead (another measurement must then go).' : undefined,
      value: round1(d.kind === 'radius' && d.diameter ? shown * 2 : shown), unit: d.kind === 'angle' ? '°' : 'mm',
      apply: (value) => {
        const now = latest.current;
        if (d.reference) { fail('This measurement only shows a value. Delete one of the measurements that decide it first, then type the value here.'); return; }
        const set = setDimension(now, id, d.kind === 'radius' && d.diameter ? value / 2 : value);
        if (!set.ok) { fail(set.message); return; }
        save(set.sketch);
      },
    });
  };

  // ---- clicks per tool ----
  const click = (e: { clientX: number; clientY: number; shiftKey: boolean }, x: number, y: number, double: boolean) => {
    const s = latest.current;
    switch (tool) {
      case 'select': {
        const hit = hitPoint(x, y) ?? hitLabel(x, y) ?? hitGlyph(x, y) ?? hitEntity(x, y);
        if (double && hit && s.constraints.some((c) => c.id === hit && isDimension(c))) { editDimension(hit, e.clientX, e.clientY); return; }
        if (!hit) { setSketchSelection([]); return; }
        if (e.shiftKey) setSketchSelection(selection.includes(hit) ? selection.filter((i) => i !== hit) : [...selection, hit]);
        else setSketchSelection([hit]);
        return;
      }
      case 'line': case 'tangentArc': {
        const raw = snap(x, y, chain && 'id' in chain.ref ? chain.ref.id : undefined);
        if (!chain) {
          if (tool === 'tangentArc' && !('id' in raw.ref && entityEndingAt(s, raw.ref.id))) { fail('A tangent arc starts at the end of a line or arc. Click such an end.'); return; }
          setChain(raw); return;
        }
        if (double || Math.hypot(raw.x - chain.x, raw.y - chain.y) < 2 * px) { setChain(null); return; }
        if (tool === 'tangentArc') {
          if (!('id' in chain.ref)) { fail('A tangent arc continues from the end of a line or arc. Draw a line first.'); return; }
          const r = drawTangentArc(s, chain.ref.id, raw.ref, newId);
          if (!r) { fail('That point is straight ahead: draw a line there instead.'); return; }
          save(r.sketch);
          setChain('id' in raw.ref ? null : { ref: { id: r.b }, x: raw.x, y: raw.y });
          return;
        }
        const to = straighten(chain, raw);
        const onLine: { end: 'from' | 'to'; line: string }[] = [];
        if (chain.onLine && !('id' in chain.ref)) onLine.push({ end: 'from', line: chain.onLine });
        if (to.onLine) onLine.push({ end: 'to', line: to.onLine });
        const r = drawLine(s, chain.ref, to.ref, newId, { onLine });
        save(r.sketch);
        const end = pointMap(r.sketch).get(r.b)!;
        // joining an existing point ends the chain (e.g. closing the outline)
        setChain('id' in to.ref ? null : { ref: { id: r.b }, x: end.x, y: end.y });
        return;
      }
      case 'arc': {
        const p = snap(x, y);
        const next = [...picks, p];
        if (next.length < 3) { setPicks(next); return; }
        const r = drawArc3(s, next[0].ref, next[1].ref, { x: p.x, y: p.y }, newId);
        if (!r) fail('These three points are in one line: there is no arc through them.'); else save(r.sketch);
        setPicks([]);
        return;
      }
      case 'circle': {
        const p = snap(x, y);
        if (!picks.length) { setPicks([p]); return; }
        const r = drawCircle(s, picks[0].ref, Math.hypot(p.x - picks[0].x, p.y - picks[0].y), newId);
        save(r.sketch); setPicks([]);
        return;
      }
      case 'spline': {
        const p = snap(x, y);
        const finish = (list: Snap[]) => { const r = drawSpline(s, list.map((q) => q.ref), newId); if (r) save(r.sketch); setPicks([]); };
        if (double) { finish(picks); return; }
        if (picks.length && 'id' in p.ref) { finish([...picks, p]); return; }
        setPicks([...picks, p]);
        return;
      }
      case 'dimension': {
        const hit = hitLabel(x, y);
        if (hit) { editDimension(hit, e.clientX, e.clientY); return; }
        const item = hitPoint(x, y) ?? hitEntity(x, y);
        if (!item) { setDimPick([]); setPopover(null); return; }
        const next = dimPick.length === 1 && dimPick[0] !== item ? [dimPick[0], item] : [item];
        setDimPick(next);
        if (!askDimension(next, e.clientX, e.clientY)) setPopover(null);
        return;
      }
      case 'fillet': {
        const p = hitPoint(x, y);
        if (!p) return;
        setPopover({
          ...screenOf(e.clientX, e.clientY), title: 'Round this corner', value: '50', unit: 'mm',
          apply: (radius) => { const r = filletCorner(latest.current, p, radius, newId); if (!r.ok) fail(r.message); else save(r.sketch); },
        });
        return;
      }
      case 'photoScale': case 'photoAlign': {
        const ph = s.photo;
        if (!ph) return;
        const next = [...picks, { ref: { x, y }, x, y }];
        if (next.length < 2) { setPicks(next); return; }
        if (tool === 'photoAlign') { save({ ...s, photo: levelPhoto(ph, next[0], next[1]) }); setPicks([]); setSketchTool('select'); return; }
        setPicks(next);
        setPopover({
          ...screenOf(e.clientX, e.clientY), title: 'Real distance between the two points', value: '', unit: 'mm',
          note: 'Measure it on the boat with a tape, or use a known size (e.g. a hatch).',
          apply: (d) => { const now = latest.current; if (now.photo) save({ ...now, photo: scalePhoto(now.photo, next[0], next[1], d) }); setPicks([]); setSketchTool('select'); },
        });
        return;
      }
      default: return;
    }
  };

  // ---- keys ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        if (popover || chain || picks.length || dimPick.length) reset();
        else if (tool !== 'select') setSketchTool('select');
        else setSketchSelection([]);
        return;
      }
      if (key === 'enter' && tool === 'spline' && picks.length >= 2) { const r = drawSpline(latest.current, picks.map((q) => q.ref), newId); if (r) save(r.sketch); setPicks([]); return; }
      if ((key === 'delete' || key === 'backspace') && selection.length) {
        e.preventDefault();
        save(removeItems(latest.current, new Set(selection)));
        setSketchSelection([]);
        return;
      }
      const tools: Record<string, typeof tool> = { l: 'line', a: 'arc', t: 'tangentArc', c: 'circle', p: 'spline', d: 'dimension', f: 'fillet', s: 'select' };
      if (tools[key]) setSketchTool(tools[key]);
      if (key === 'x' && selection.length) {
        const ids = new Set(selection), s = latest.current;
        const on = !s.entities.filter((k) => ids.has(k.id)).every((k) => k.construction);
        save({ ...s, entities: s.entities.map((k) => (ids.has(k.id) ? { ...k, construction: on || undefined } : k)) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- pointer ----
  const grabAt = (x: number, y: number): Drag | null => {
    if (tool === 'photoMove') return latest.current.photo ? { kind: 'photo', x, y, from: { x: latest.current.photo.x, y: latest.current.photo.y } } : null;
    if (tool !== 'select' && tool !== 'dimension') return null;
    const label = hitLabel(x, y);
    if (label) return { kind: 'label', id: label };
    if (tool !== 'select') return null;
    const p = hitPoint(x, y);
    if (p) return { kind: 'point', id: p };
    const e = hitEntity(x, y);
    if (e) {
      const ent = sketch.entities.find((k) => k.id === e)!;
      const ids = (ent.kind === 'line' ? [ent.a, ent.b] : ent.kind === 'arc' ? [ent.c, ent.a, ent.b] : ent.kind === 'circle' ? [ent.c] : ent.pts).map((id) => ({ id, x: pts.get(id)!.x, y: pts.get(id)!.y }));
      return { kind: 'entity', ids, x, y };
    }
    return null;
  };

  const onDrag = (d: Drag, e: { clientX: number; clientY: number }, x: number, y: number, start: Press) => {
    const s = latest.current;
    if (d.kind === 'pan') { setView({ ...d.view, x: d.view.x - (e.clientX - start.clientX) * px, y: d.view.y - (e.clientY - start.clientY) * px }); return; }
    if (d.kind === 'photo') { if (s.photo) void updateSketch({ ...s, photo: movePhoto({ ...s.photo, ...d.from }, x - d.x, y - d.y) }, false); return; }
    if (d.kind === 'label') {
      const dim = s.constraints.find((c) => c.id === d.id) as SkDimension;
      const off = offsetThrough(s, dim, x, y);
      if (off !== undefined) void updateSketch({ ...s, constraints: s.constraints.map((c) => (c.id === d.id ? ({ ...c, offset: off } as SkDimension) : c)) }, false);
      return;
    }
    const targets = d.kind === 'point' ? [{ point: d.id, x, y }] : d.ids.map((p) => ({ point: p.id, x: p.x + x - d.x, y: p.y + y - d.y }));
    void updateSketch(solve(s, targets).sketch, false);
  };

  // ---- previews ----
  const preview: ReactNode[] = [];
  const hv = hover;
  if (hv && (tool === 'line' || tool === 'tangentArc') && chain) {
    const to = tool === 'line' ? straighten(chain, snap(hv.x, hv.y)) : snap(hv.x, hv.y);
    if (tool === 'line') {
      const axis = nearAxis(chain, to);
      preview.push(<line key="pl" className="sk-preview" x1={chain.x} y1={-chain.y} x2={to.x} y2={-to.y} strokeWidth={1.5 * px} />);
      preview.push(<text key="pt" className="ed-label" x={(chain.x + to.x) / 2} y={-(chain.y + to.y) / 2} dy={-8 * px} fontSize={12 * px} textAnchor="middle" strokeWidth={3 * px}>{Math.round(Math.hypot(to.x - chain.x, to.y - chain.y))}{axis ? ` ${axis === 'horizontal' ? 'H' : 'V'}` : ''}</text>);
    } else if ('id' in chain.ref) {
      const r = drawTangentArc(latest.current, chain.ref.id, to.ref, () => `preview${Math.random()}`);
      const arc = r?.sketch.entities.find((k) => k.id === r.arcId);
      if (r && arc) preview.push(<path key="pa" className="sk-preview" d={openPath(entityPath(r.sketch, arc))} strokeWidth={1.5 * px} />);
    }
  }
  if (hv && tool === 'arc' && picks.length === 2) {
    const c = circumcentre(picks[0], picks[1], hv);
    if (c) {
      const tmp = drawArc3(latest.current, { x: picks[0].x, y: picks[0].y }, { x: picks[1].x, y: picks[1].y }, hv, () => `preview${Math.random()}`);
      const arc = tmp?.sketch.entities.find((k) => k.id === tmp.arcId);
      if (tmp && arc) preview.push(<path key="pa" className="sk-preview" d={openPath(entityPath(tmp.sketch, arc))} strokeWidth={1.5 * px} />);
    }
  }
  if (hv && tool === 'arc' && picks.length === 1) preview.push(<line key="pl" className="sk-preview" x1={picks[0].x} y1={-picks[0].y} x2={hv.x} y2={-hv.y} strokeWidth={1 * px} strokeDasharray={`${4 * px} ${4 * px}`} />);
  if (hv && tool === 'circle' && picks.length === 1) {
    const r = Math.hypot(hv.x - picks[0].x, hv.y - picks[0].y);
    preview.push(<circle key="pc" className="sk-preview" cx={picks[0].x} cy={-picks[0].y} r={r} strokeWidth={1.5 * px} />);
    preview.push(<text key="pt" className="ed-label" x={hv.x} y={-hv.y} dx={10 * px} fontSize={12 * px} strokeWidth={3 * px}>Ø{Math.round(2 * r)}</text>);
  }
  if (tool === 'spline' && picks.length) {
    const all = hv ? [...picks, { x: hv.x, y: hv.y }] : picks;
    preview.push(<path key="ps" className="sk-preview" d={openPath(all.flatMap((p) => [p.x, p.y]))} strokeWidth={1 * px} strokeDasharray={`${4 * px} ${4 * px}`} />);
  }
  if ((tool === 'photoScale' || tool === 'photoAlign') && picks.length) {
    const b = picks[1] ?? hv;
    preview.push(<circle key="p0" className="sk-pick" cx={picks[0].x} cy={-picks[0].y} r={5 * px} strokeWidth={2 * px} />);
    if (b) {
      preview.push(<line key="pl" className="sk-pick" x1={picks[0].x} y1={-picks[0].y} x2={b.x} y2={-b.y} strokeWidth={2 * px} />);
      preview.push(<circle key="p1" className="sk-pick" cx={b.x} cy={-b.y} r={5 * px} strokeWidth={2 * px} />);
    }
  }
  for (const p of picks) if (tool === 'arc' || tool === 'circle' || tool === 'spline') preview.push(<circle key={`k${p.x},${p.y}`} className="sk-pick" cx={p.x} cy={-p.y} r={4 * px} strokeWidth={1.5 * px} />);
  if (chain) preview.push(<circle key="chain" className="sk-pick" cx={chain.x} cy={-chain.y} r={5 * px} strokeWidth={2 * px} />);
  // where a click would snap to
  const snapTarget = hv && tool !== 'select' && tool !== 'photoMove' && tool !== 'photoScale' && tool !== 'photoAlign' && tool !== 'dimension' ? snap(hv.x, hv.y) : null;

  const selected = new Set([...selection, ...dimPick]);
  const ph = sketch.photo;
  const freeEntity = (e: SkEntity) => (e.kind === 'circle' && analysis.freeRadius.has(e.id)) || (e.kind === 'line' ? [e.a, e.b] : e.kind === 'arc' ? [e.c, e.a, e.b] : e.kind === 'circle' ? [e.c] : e.pts).some((p) => analysis.freePoints.has(p));
  const ends = new Set(sketch.entities.flatMap((e) => (e.kind === 'line' ? [e.a, e.b] : e.kind === 'arc' ? [e.a, e.b] : e.kind === 'spline' ? [e.pts[0], e.pts[e.pts.length - 1]] : [])));

  const hint: Record<string, string> = {
    select: 'Drag points or lines to shape the drawing · Click to select (Shift: add) · Double-click a measurement to change it · Delete removes what is selected',
    line: chain ? 'Click the next corner · Click an existing point to join it · T: continue with a tangent arc · Esc: stop' : 'Click where the line starts (on a point to join it, on a line to start on it)',
    tangentArc: chain ? 'Click where the arc ends · L: continue with a line · Esc: stop' : 'Click the end of a line or arc to continue from it',
    arc: ['Click where the arc starts', 'Click where the arc ends', 'Click a point the arc passes through'][picks.length] ?? '',
    circle: picks.length ? 'Click to set the size' : 'Click the centre',
    spline: picks.length ? 'Click more points · Double-click or Enter to finish' : 'Click the points the curve passes through',
    dimension: dimPick.length ? 'Type the measured value, or click a second item to measure between the two' : 'Click a line, two points, a point and a line, two lines (angle) or an arc',
    fillet: 'Click a corner where two lines meet to round it',
    photoScale: picks.length ? 'Click the second point' : 'Click two points on the photo whose real distance you know',
    photoAlign: picks.length ? 'Click the second point' : 'Click two points along an edge that should be level (or upright)',
    photoMove: 'Drag the photo to move it under the drawing',
  };

  return (
    <div className={`editor${tool !== 'select' ? ' editor--pick' : ''}`}>
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          const [x, y] = toPlane(e);
          const grab = e.button === 1 ? { kind: 'pan' as const, view } : grabAt(x, y);
          press.current = { clientX: e.clientX, clientY: e.clientY, x, y, grab, moved: false, drag: e.button === 1 ? grab : null };
        }}
        onPointerMove={(e) => {
          const [x, y] = toPlane(e);
          const p = press.current;
          if (!p) { setHover({ x, y }); return; }
          if (!p.moved && Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) < 4) return;
          if (!p.moved) { p.moved = true; p.drag = p.drag ?? p.grab ?? { kind: 'pan', view }; }
          onDrag(p.drag!, e, x, y, p);
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          const p = press.current; press.current = null;
          if (!p) return;
          if (p.moved) {
            if (p.drag && p.drag.kind !== 'pan') setTimeout(() => save(latest.current), 0);
            lastTap.current = null;
            return;
          }
          const [x, y] = toPlane(e);
          const prev = lastTap.current;
          const double = !!prev && e.timeStamp - prev.t < 450 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8;
          lastTap.current = double ? null : { t: e.timeStamp, x: e.clientX, y: e.clientY };
          click(e, x, y, double);
        }}
      >
        {ph && photoUrl && !ph.hidden && (
          <image href={photoUrl} x={0} y={0} width={ph.widthPx * ph.scale} height={ph.heightPx * ph.scale} opacity={ph.opacity}
            transform={`translate(${ph.x},${-ph.y}) rotate(${-ph.angle})`} preserveAspectRatio="none" style={{ pointerEvents: 'none' }} />
        )}
        {outline.ok && <path className="sk-fill" d={openPath(outline.outline.polygon) + 'Z'} />}
        {sketch.entities.map((e) => {
          const on = selected.has(e.id);
          const cls = `sk-ent${e.construction ? ' sk-construction' : freeEntity(e) ? ' sk-free' : ''}${on ? ' on' : ''}`;
          const d = e.kind === 'circle' ? undefined : openPath(paths.get(e.id) ?? []);
          return e.kind === 'circle'
            ? <circle key={e.id} className={cls} cx={pts.get(e.c)!.x} cy={-pts.get(e.c)!.y} r={e.r} strokeWidth={(on ? 3 : 2) * px} strokeDasharray={e.construction ? `${8 * px} ${5 * px}` : undefined} />
            : <path key={e.id} className={cls} d={d} strokeWidth={(on ? 3 : 2) * px} strokeDasharray={e.construction ? `${8 * px} ${5 * px}` : undefined} />;
        })}
        {dims.map(({ d, g }) => {
          if (!g) return null;
          const on = selected.has(d.id);
          return (
            <g key={d.id} className={`sk-dim${d.reference ? ' ref' : ''}${on ? ' on' : ''}`}>
              {g.lines.map((l, i) => <line key={i} x1={l[0]} y1={-l[1]} x2={l[2]} y2={-l[3]} strokeWidth={1 * px} />)}
              {g.arc && (() => {
                const a = g.arc, x1 = a.x + Math.cos(a.from) * a.r, y1 = a.y + Math.sin(a.from) * a.r, x2 = a.x + Math.cos(a.to) * a.r, y2 = a.y + Math.sin(a.to) * a.r;
                let span = a.to - a.from; while (span < 0) span += 2 * Math.PI;
                return <path d={`M${x1},${-y1}A${a.r},${a.r} 0 ${span > Math.PI ? 1 : 0} 0 ${x2},${-y2}`} fill="none" strokeWidth={1 * px} />;
              })()}
              <text x={g.label.x} y={-g.label.y} dy={4 * px} fontSize={13 * px} textAnchor="middle" strokeWidth={4 * px}>{g.label.text}</text>
            </g>
          );
        })}
        {glyphs.map((g, i) => (
          <g key={`${g.id}-${i}`} className={`sk-glyph${selected.has(g.id) ? ' on' : ''}`}>
            <rect x={g.x - 7 * px} y={-g.y - 7 * px} width={14 * px} height={14 * px} rx={3 * px} strokeWidth={1 * px} />
            <text x={g.x} y={-g.y} dy={3.5 * px} fontSize={10 * px} textAnchor="middle">{g.text}</text>
          </g>
        ))}
        {sketch.points.map((p) => {
          const on = selected.has(p.id), open = openEnds.has(p.id);
          if (!on && !open && !ends.has(p.id) && !sketch.entities.some((e) => (e.kind === 'arc' || e.kind === 'circle') && e.c === p.id)) {
            return <circle key={p.id} className="sk-pt sk-pt--aux" cx={p.x} cy={-p.y} r={2.5 * px} />;
          }
          return <circle key={p.id} className={`sk-pt${analysis.freePoints.has(p.id) ? ' sk-free' : ''}${open ? ' open' : ''}${on ? ' on' : ''}`} cx={p.x} cy={-p.y} r={(open ? 5 : 3.5) * px} strokeWidth={1.5 * px} />;
        })}
        {preview}
        {surface && <BowArrow angle={bowOf(surface)} at={centreOf(surface.outline.corners)} px={px} />}
        {snapTarget && ('id' in snapTarget.ref || snapTarget.onLine) && <circle className="sk-snap" cx={snapTarget.x} cy={-snapTarget.y} r={7 * px} strokeWidth={2 * px} />}
      </svg>
      <div className="viewer__views"><button onClick={() => setView(fit)}>Fit</button></div>
      <div className="editor__legend">
        <span><i className="lg lg-free" />Not yet set by measurements</span><span><i className="lg lg-def" />Fully set</span><span><i className="lg lg-open" />Open end</span>
      </div>
      {popover && <ValuePopover p={popover} onClose={() => { setPopover(null); setDimPick([]); }} />}
      <div className="viewer__hint">{hint[tool]}</div>
    </div>
  );
}

function ValuePopover({ p, onClose }: { p: Popover; onClose: () => void }) {
  const [value, setValue] = useState(p.value);
  const [kind, setKind] = useState<DimensionKind>(p.kind ?? 'aligned');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setValue(p.value); setKind(p.kind ?? 'aligned'); setTimeout(() => input.current?.select()); }, [p]);
  const apply = () => {
    const v = Number(value.replace(',', '.'));
    if (!(v > 0)) { useApp.setState({ error: 'Type a number larger than zero.' }); return; }
    p.apply(v, kind);
    onClose();
  };
  return (
    <div className="sk-popover" style={{ left: p.left, top: p.top }} onPointerDown={(e) => e.stopPropagation()}>
      <strong>{p.title}</strong>
      {p.kinds && (
        <div className="sk-popover__kinds">
          {p.kinds.map((k) => <button key={k} className={k === kind ? 'on' : ''} onClick={() => { setKind(k); if (p.valueFor) setValue(p.valueFor(k)); input.current?.focus(); }}>{k === 'aligned' ? 'Along' : k === 'horizontal' ? 'Horizontal' : 'Vertical'}</button>)}
        </div>
      )}
      <div className="sk-popover__row">
        <input ref={input} autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') onClose(); e.stopPropagation(); }} />
        <span>{p.unit}</span>
        <button className="primary small" onClick={apply}>OK</button>
        <button className="ghost small" onClick={onClose}>×</button>
      </div>
      {p.note && <p className="muted">{p.note}</p>}
    </div>
  );
}
