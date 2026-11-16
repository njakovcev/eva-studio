import { useEffect, useState } from 'react';
import { designPanel, type Design } from '../core/design';
import { PATTERNS, defaultParams, patternById } from '../core/patterns';
import { DEFAULT_GROOVE_TOOL, grooveWidth } from '../core/tools';
import { useApp } from '../store';
import { mm } from './format';

/** Colour pairs to start from: [name, top, bottom]. */
const PRESETS: [string, string, string][] = [
  ['Grey / black', '#8a8f94', '#1c1c1c'], ['Teak / black', '#b07a45', '#1c1c1c'], ['Dark grey / white', '#4a4f55', '#f1f1ee'],
  ['Light grey / dark grey', '#c9ccce', '#4a4f55'], ['Black / grey', '#222426', '#9a9ea3'], ['Sand / brown', '#d8c39a', '#5b3d24'],
];

function Num({ value, onCommit, step }: { value: number; onCommit: (v: number) => void; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => { const v = Number(text.replace(',', '.')); if (text.trim() === '' || !Number.isFinite(v)) setText(String(value)); else if (v !== value) onCommit(v); };
  return <input className="num" inputMode="decimal" step={step} value={text} onFocus={(e) => e.target.select()} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

export function DesignSide() {
  const { project, designSurfaceId } = useApp();
  if (!project) return null;
  const design = project.designs.find((d) => d.surfaceId === designSurfaceId);
  if (design) return <DesignDetails design={design} />;
  const withPanels = project.surfaces.filter((s) => project.panels.some((p) => p.surfaceId === s.id));
  return <SurfacePicker surfaces={withPanels} />;
}

function SurfacePicker({ surfaces: withPanels }: { surfaces: { id: string; name: string }[] }) {
  const { project, openDesign, setStep } = useApp();
  // with a single surface there is nothing to choose: go straight to its design
  const only = withPanels.length === 1 ? withPanels[0].id : null;
  useEffect(() => { if (only) void openDesign(only); }, [only, openDesign]);
  if (!project) return null;
  return (
    <>
      <div className="side__head"><h2>Design</h2></div>
      <p className="muted">A design belongs to a surface: its border and pattern run across all panels of that surface.</p>
      {withPanels.length === 0 ? (
        <>
          <p className="muted">There are no panels yet. Make a panel first.</p>
          <button onClick={() => setStep('panels')}>← Go to Panels</button>
        </>
      ) : (
        <ul className="list">
          {withPanels.map((s) => {
            const n = project.panels.filter((p) => p.surfaceId === s.id).length;
            return (
              <li key={s.id}>
                <button className="list__main" onClick={() => void openDesign(s.id)}>
                  <strong>{s.name}</strong><span>{n} panel{n === 1 ? '' : 's'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function DesignDetails({ design }: { design: Design }) {
  const { project, updateDesign, updateSettings, openDesign, exportDesignDxfs } = useApp();
  if (!project) return null;
  const surface = project.surfaces.find((s) => s.id === design.surfaceId);
  const panels = project.panels.filter((p) => p.surfaceId === design.surfaceId);
  const material = project.settings.material;
  const def = patternById(design.pattern.kind);
  const width = grooveWidth(DEFAULT_GROOVE_TOOL, design.depth);
  const results = panels.map((p) => ({ name: p.name, d: designPanel(p, design) }));
  const milling = results.reduce((s, r) => s + r.d.millLength, 0);
  const setPattern = (change: Partial<Design['pattern']>, save = true) => void updateDesign({ ...design, pattern: { ...design.pattern, ...change } }, save);

  return (
    <>
      <div className="side__head"><button className="ghost" onClick={() => void openDesign(null)}>← All surfaces</button></div>
      <h2>{surface?.name ?? 'Surface'}</h2>

      <h3>Colours</h3>
      <div className="row">
        <label className="swatch">Top <input type="color" value={material.topColor} onChange={(e) => void updateSettings({ material: { ...material, topColor: e.target.value } })} /></label>
        <label className="swatch">Bottom (grooves) <input type="color" value={material.bottomColor} onChange={(e) => void updateSettings({ material: { ...material, bottomColor: e.target.value } })} /></label>
      </div>
      <div className="presets">
        {PRESETS.map(([name, top, bottom]) => (
          <button key={name} title={name} onClick={() => void updateSettings({ material: { ...material, topColor: top, bottomColor: bottom } })}>
            <i style={{ background: top }} /><i style={{ background: bottom }} />
          </button>
        ))}
      </div>
      <small>Colours are for the preview only; use the ones of the sheets you order.</small>

      <h3>Border</h3>
      <label className="check"><input type="checkbox" checked={design.border.on} onChange={(e) => void updateDesign({ ...design, border: { ...design.border, on: e.target.checked } })} /> Line along the edge</label>
      {design.border.on && (
        <div className="row"><span>Distance from the edge</span><Num value={design.border.inset} onCommit={(v) => v >= 0 && void updateDesign({ ...design, border: { ...design.border, inset: v } })} /><span>mm</span></div>
      )}

      <h3>Pattern</h3>
      <select value={design.pattern.kind} onChange={(e) => { const d = patternById(e.target.value); setPattern({ kind: e.target.value, params: d ? defaultParams(d) : {} }); }}>
        <option value="none">None (plain)</option>
        {PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {def && (
        <>
          {def.params.map((prm) => {
            const v = design.pattern.params[prm.key] ?? prm.default;
            const set = (x: number, save: boolean) => setPattern({ params: { ...design.pattern.params, [prm.key]: Math.max(prm.min, Math.min(prm.max, x)) } }, save);
            return (
              <label key={prm.key} className="field">{prm.label}
                <div className="row">
                  <input type="range" min={prm.min} max={prm.max} step={prm.step} value={v} onChange={(e) => set(Number(e.target.value), false)} onPointerUp={(e) => set(Number((e.target as HTMLInputElement).value), true)} onKeyUp={(e) => set(Number((e.target as HTMLInputElement).value), true)} />
                  <Num value={v} onCommit={(x) => set(x, true)} /><span>{prm.unit}</span>
                </div>
              </label>
            );
          })}
          <label className="field">Direction
            <div className="row">
              <input type="range" min={-90} max={90} step={1} value={design.pattern.angle} onChange={(e) => setPattern({ angle: Number(e.target.value) }, false)} onPointerUp={(e) => setPattern({ angle: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => setPattern({ angle: Number((e.target as HTMLInputElement).value) })} />
              <Num value={design.pattern.angle} onCommit={(v) => setPattern({ angle: v })} /><span>°</span>
            </div>
          </label>
          <div className="row"><span>Position</span><span>X</span><Num value={design.pattern.originX} onCommit={(v) => setPattern({ originX: v })} /><span>Y</span><Num value={design.pattern.originY} onCommit={(v) => setPattern({ originY: v })} /><span>mm</span></div>
          <small>Or hold Shift and drag in the picture to slide the pattern.</small>
        </>
      )}

      <h3>Milling</h3>
      <div className="row"><span>Depth</span><Num value={design.depth} step={0.5} onCommit={(v) => v > 0 && v <= material.thickness && void updateDesign({ ...design, depth: v })} /><span>mm</span></div>
      <dl className="facts">
        <dt>Groove width at the surface</dt><dd>{width.toFixed(1)} mm <span className="muted">(tool T{DEFAULT_GROOVE_TOOL.number})</span></dd>
        <dt>Length of milling, all panels</dt><dd>{mm(milling)}</dd>
      </dl>
      {design.depth < material.topLayer && <div className="notice notice--warn">Shallower than the top layer ({material.topLayer} mm): the bottom colour will not show in the grooves.</div>}
      {results.flatMap((r) => r.d.warnings.map((w, i) => <div key={r.name + i} className="notice notice--warn">{r.name}: {w}</div>))}

      <div className="side__actions">
        <button className="primary" onClick={() => void exportDesignDxfs(design.surfaceId)}>Export DXF for {panels.length === 1 ? 'the panel' : `all ${panels.length} panels`}</button>
      </div>
    </>
  );
}
