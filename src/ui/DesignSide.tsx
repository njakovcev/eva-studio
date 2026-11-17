import { useEffect, useRef, useState } from 'react';
import { graphicHeight, type Graphic } from '../core/artwork';
import { designPanel, type Design } from '../core/design';
import { CUSTOM_PREFIX, PATTERNS, defaultParams, findPattern } from '../core/patterns';
import { FONTS } from '../io/fonts';
import { DEFAULT_GROOVE_TOOL, grooveWidth } from '../core/tools';
import { libraryOf, useApp } from '../store';
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
  const { project, updateDesign, updateSettings, openDesign, exportDesignDxfs, addLogo, addText, addPatternFromSvg, busy } = useApp();
  const logoInput = useRef<HTMLInputElement>(null), tileInput = useRef<HTMLInputElement>(null);
  if (!project) return null;
  const surface = project.surfaces.find((s) => s.id === design.surfaceId);
  const panels = project.panels.filter((p) => p.surfaceId === design.surfaceId);
  const material = project.settings.material;
  const library = libraryOf(project);
  const def = findPattern(design.pattern.kind, project.patterns);
  const width = grooveWidth(DEFAULT_GROOVE_TOOL, design.depth);
  const results = panels.map((p) => ({ name: p.name, d: designPanel(p, design, library) }));
  const milling = results.reduce((s, r) => s + r.d.millLength, 0);
  const pocketed = results.reduce((s, r) => s + r.d.pocketArea, 0);
  const pickSvg = (input: HTMLInputElement, then: (f: File) => void) => { const f = input.files?.[0]; input.value = ''; if (!f) return; if (!f.name.toLowerCase().endsWith('.svg')) useApp.setState({ error: `“${f.name}” is not an SVG file. Save the drawing as SVG (with text converted to outlines).` }); else then(f); };
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
      <select value={design.pattern.kind} onChange={(e) => { const d = findPattern(e.target.value, project.patterns); setPattern({ kind: e.target.value, params: d ? defaultParams(d) : {} }); }}>
        <option value="none">None (plain)</option>
        {PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        {project.patterns.length > 0 && <optgroup label="Your own">{project.patterns.map((p) => <option key={p.id} value={CUSTOM_PREFIX + p.id}>{p.name}</option>)}</optgroup>}
      </select>
      <button className="small" disabled={!!busy} onClick={() => tileInput.current?.click()}>+ Your own pattern (SVG tile)…</button>
      <input ref={tileInput} type="file" accept=".svg" hidden onChange={(e) => pickSvg(e.target, (f) => void addPatternFromSvg(f))} />
      <small>Draw one tile; it is repeated side by side. The whole drawing is the tile.</small>
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

      <h3>Logos and text</h3>
      {(design.graphics ?? []).map((g) => <GraphicCard key={g.id} graphic={g} />)}
      <div className="row">
        <button className="small" disabled={!!busy} onClick={() => logoInput.current?.click()}>+ Logo or drawing (SVG)…</button>
        <button className="small" disabled={!!busy} onClick={() => void addText()}>+ Text</button>
      </div>
      <input ref={logoInput} type="file" accept=".svg" hidden onChange={(e) => pickSvg(e.target, (f) => void addLogo(f))} />
      <small>They lie over all panels of this surface and are cut at each panel edge. Drag them in the picture.</small>

      <h3>Milling</h3>
      <div className="row"><span>Depth</span><Num value={design.depth} step={0.5} onCommit={(v) => v > 0 && v <= material.thickness && void updateDesign({ ...design, depth: v })} /><span>mm</span></div>
      <dl className="facts">
        <dt>Groove width at the surface</dt><dd>{width.toFixed(1)} mm <span className="muted">(tool T{DEFAULT_GROOVE_TOOL.number})</span></dd>
        <dt>Length of grooves, all panels</dt><dd>{mm(milling)}</dd>
        {pocketed > 0 && <><dt>Area milled out</dt><dd>{(pocketed / 100).toFixed(0)} cm²</dd></>}
      </dl>
      {design.depth < material.topLayer && <div className="notice notice--warn">Shallower than the top layer ({material.topLayer} mm): the bottom colour will not show in the grooves.</div>}
      {results.flatMap((r) => r.d.warnings.map((w, i) => <div key={r.name + i} className="notice notice--warn">{r.name}: {w}</div>))}

      <div className="side__actions">
        <button className="primary" onClick={() => useApp.getState().setStep('export')}>Next: arrange on sheets →</button>
        <button onClick={() => void exportDesignDxfs(design.surfaceId)}>Export DXF for {panels.length === 1 ? 'the panel' : `all ${panels.length} panels`} (one file each)</button>
      </div>
    </>
  );
}

function GraphicCard({ graphic: g }: { graphic: Graphic }) {
  const { project, updateGraphic, removeGraphic, editText, graphicFocus, setGraphicFocus } = useApp();
  const art = project?.artworks.find((a) => a.id === g.artworkId);
  const [content, setContent] = useState(art?.text?.content ?? '');
  useEffect(() => { setContent(art?.text?.content ?? ''); }, [art?.text?.content]);
  if (!art) return null;
  const set = (change: Partial<Graphic>) => void updateGraphic({ ...g, ...change });
  const hasAreas = art.rings.length > 0;
  return (
    <div className={`opening${graphicFocus === g.id ? ' on' : ''}`} onMouseDown={() => setGraphicFocus(g.id)}>
      <strong className="opening__name">{art.text ? 'Text' : art.name}</strong>
      <button className="ghost" title="Remove" onClick={() => void removeGraphic(g.id)}>×</button>
      {art.text && (
        <div className="opening__dist">
          <input value={content} onChange={(e) => setContent(e.target.value)} onBlur={() => { if (content.trim() && content !== art.text!.content) void editText(art.id, content, art.text!.font); else setContent(art.text!.content); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          <select value={art.text.font} onChange={(e) => void editText(art.id, art.text!.content, e.target.value)}>
            {FONTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      )}
      <div className="opening__dist">
        <label>Width <Num value={g.width} onCommit={(v) => v > 0 && set({ width: v })} /></label>
        <span>× {Math.round(graphicHeight(art, g))} mm</span>
        <label>Turn ° <Num value={g.angle} onCommit={(v) => set({ angle: v })} /></label>
      </div>
      <div className="opening__dist">
        <label>X <Num value={g.x} onCommit={(v) => set({ x: v })} /></label>
        <label>Y <Num value={g.y} onCommit={(v) => set({ y: v })} /></label>
      </div>
      <div className="opening__dist">
        <label>Milled as
          <select value={g.mode} onChange={(e) => set({ mode: e.target.value as Graphic['mode'] })}>
            <option value="line">Lines (grooves along the outlines)</option>
            {hasAreas && <option value="area">Filled (shapes milled out)</option>}
          </select>
        </label>
        <label>Pattern stays <Num value={g.clearance} onCommit={(v) => v >= 0 && set({ clearance: v })} /> mm away</label>
      </div>
    </div>
  );
}
