import { bowOf, normalAngle, type Surface } from '../core/surface';
import { useApp } from '../store';

/**
 * An arrow towards the bow, drawn in plane coordinates (y up) at a point, a fixed size on screen.
 * The drawing itself is y-down, so y is written negative.
 */
export function BowArrow({ angle, at, px, size = 70 }: { angle: number; at: [number, number]; px: number; size?: number }) {
  const a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
  const half = (size / 2) * px, head = 12 * px;
  const tail: [number, number] = [at[0] - dx * half, at[1] - dy * half], tip: [number, number] = [at[0] + dx * half, at[1] + dy * half];
  const side = (s: number): [number, number] => [tip[0] - dx * head - s * dy * head * 0.6, tip[1] - dy * head + s * dx * head * 0.6];
  const l = side(1), r = side(-1);
  return (
    <g className="bow" pointerEvents="none">
      <line x1={tail[0]} y1={-tail[1]} x2={tip[0] - dx * head * 0.5} y2={-(tip[1] - dy * head * 0.5)} strokeWidth={3 * px} />
      <path d={`M${tip[0]},${-tip[1]}L${l[0]},${-l[1]}L${r[0]},${-r[1]}Z`} />
      <text x={tip[0] + dx * 14 * px} y={-(tip[1] + dy * 14 * px)} fontSize={12 * px} textAnchor="middle" dominantBaseline="middle" strokeWidth={3 * px}>BOW</text>
    </g>
  );
}

/** Middle of the corners' bounding box: where the arrow goes. */
export function centreOf(corners: [number, number][] | number[][]): [number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of corners) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }
  return corners.length ? [(a + c) / 2, (b + d) / 2] : [0, 0];
}

/** Setting which way the bow is on a surface: panels go on the sheet with it along the brushing. */
export function BowControl({ surface }: { surface: Surface }) {
  const updateSurface = useApp((s) => s.updateSurface);
  const bow = bowOf(surface);
  const set = (a: number) => { const v = normalAngle(a); if (v !== bow) void updateSurface({ ...surface, bow: v }); };
  return (
    <>
      <h3>Bow</h3>
      <div className="row">
        <button title="Turn the arrow a quarter turn to the left" onClick={() => set(bow + 90)}>↺ 90°</button>
        <button title="Turn the arrow a quarter turn to the right" onClick={() => set(bow - 90)}>↻ 90°</button>
        <button title="Point the arrow the other way" onClick={() => set(bow + 180)}>Flip</button>
        <input
          key={bow} className="num" inputMode="decimal" defaultValue={bow} title="Angle of the arrow, degrees anticlockwise from pointing right"
          onFocus={(e) => e.target.select()}
          onBlur={(e) => { const v = Number(e.target.value.replace(',', '.')); if (Number.isFinite(v)) set(v); else e.target.value = String(bow); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <span>°</span>
      </div>
      <small>Point the arrow at the bow. On the sheet every panel of this surface is laid with this direction along the sheet length, the way the EVA is brushed, so the brushing runs fore-aft on the boat. On a wall, point it horizontally along the wall.</small>
    </>
  );
}
