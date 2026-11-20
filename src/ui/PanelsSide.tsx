import { useEffect, useState } from 'react';
import { PanelBowControl } from './Bow';
import { cutLength, cutOutline, cutoutDistances, cutoutWarnings, createPanel, removeSide, setCutoutDistance, panelArea, smallestBox, type Cutout, type Panel } from '../core/panel';
import { bounds } from '../core/poly';
import { newId } from '../core/project';
import { useApp } from '../store';
import { mm, squareMetres } from './format';

/** A number box that applies its value when you leave it or press Enter. */
function NumberField({ value, onCommit, title, allowNegative }: { value: number; onCommit: (v: number) => void; title?: string; allowNegative?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(v) || (v < 0 && !allowNegative)) { setText(String(value)); return; }
    if (v !== value) onCommit(v);
  };
  return (
    <input
      className="num" inputMode="decimal" title={title} value={text}
      onFocus={(e) => e.target.select()} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function PanelsSide() {
  const { project, openPanelId, addPanel, openPanel, setStep } = useApp();
  if (!project) return null;
  const panel = project.panels.find((p) => p.id === openPanelId);
  if (panel) return <PanelDetails panel={panel} />;
  const surfaceName = (id: string) => project.surfaces.find((s) => s.id === id)?.name ?? 'deleted surface';

  return (
    <>
      <div className="side__head"><h2>Panels</h2></div>
      {project.panels.length === 0 && <p className="muted">No panels yet. A panel is the EVA piece cut for a surface: its edge sits a little inside the surface and its corners are rounded.</p>}
      <ul className="list">
        {project.panels.map((p) => {
          const cut = cutOutline(p);
          return (
            <li key={p.id}>
              <button className="list__main" onClick={() => openPanel(p.id)}>
                <strong>{p.name}</strong>
                <span>{squareMetres(panelArea(p, cut))} · on {surfaceName(p.surfaceId)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <h3>New panel</h3>
      {project.surfaces.length === 0 ? (
        <>
          <p className="muted">Panels are made from surfaces. Pick a surface from a scan first.</p>
          <button onClick={() => setStep('surfaces')}>← Go to Surfaces</button>
        </>
      ) : (
        <ul className="list">
          {project.surfaces.map((s) => (
            <li key={s.id}>
              <button className="list__main" onClick={() => void addPanel(s.id)}>
                <strong>+ Panel on {s.name}</strong>
                <span>{project.settings.defaultEdgeOffset} mm from the edge, {project.settings.defaultCornerRadius} mm corners</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PanelDetails({ panel }: { panel: Panel }) {
  const { project, updatePanel, deletePanel, openPanel, exportPanelDxf, panelFocus, setPanelFocus, splitting, setSplitting, updateSettings } = useApp();
  const [name, setName] = useState(panel.name);
  useEffect(() => { setName(panel.name); }, [panel.name]);
  const [allOffset, setAllOffset] = useState(project?.settings.defaultEdgeOffset ?? 15);
  const [allRadius, setAllRadius] = useState(project?.settings.defaultCornerRadius ?? 20);
  if (!project) return null;

  const surface = project.surfaces.find((s) => s.id === panel.surfaceId);
  const cut = cutOutline(panel);
  const [long, short] = smallestBox(cut.flat);
  const sheet = project.settings.sheet;
  const fits = long <= Math.max(sheet.width, sheet.height) && short <= Math.min(sheet.width, sheet.height);
  const n = panel.shape.corners.length;
  const cutouts = panel.cutouts ?? [];
  const setCutout = (i: number, change: Partial<Cutout>) => void updatePanel({ ...panel, cutouts: cutouts.map((c, k) => (k === i ? ({ ...c, ...change } as Cutout) : c)) });
  const addCutout = (kind: Cutout['kind']) => {
    const b = bounds(cut.flat), center: [number, number] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    const c: Cutout = kind === 'circle' ? { id: newId(), kind, center, diameter: 50 } : { id: newId(), kind, center, width: 200, height: 100, angle: 0, radius: 10 };
    setPanelFocus({ kind: 'cutout', index: cutouts.length });
    void updatePanel({ ...panel, cutouts: [...cutouts, c] });
  };
  const isOn = (kind: 'side' | 'corner' | 'cutout', i: number) => panelFocus?.kind === kind && panelFocus.index === i;
  const set = <K extends 'offsets' | 'radii'>(key: K, i: number, v: number) => void updatePanel({ ...panel, [key]: panel[key].map((x, k) => (k === i ? v : x)) });

  const resetShape = () => {
    if (!surface) return;
    if (!confirm('This puts the panel shape back on the surface outline and resets all offsets and radii. Continue?')) return;
    const fresh = createPanel({ id: panel.id, name: panel.name, surface, settings: project.settings });
    void updatePanel({ ...fresh, createdAt: panel.createdAt, ...(panel.bow !== undefined ? { bow: panel.bow } : {}) });
  };

  return (
    <>
      <div className="side__head"><button className="ghost" onClick={() => openPanel(null)}>← All panels</button></div>
      <label className="field">Name
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { const v = name.trim(); if (v && v !== panel.name) void updatePanel({ ...panel, name: v }); else setName(panel.name); }} />
      </label>

      <dl className="facts">
        <dt>Panel area</dt><dd>{squareMetres(panelArea(panel, cut))}</dd>
        <dt>Length of cut</dt><dd>{mm(cutLength(cut))}</dd>
        <dt>Smallest box</dt><dd>{mm(long).replace(' mm', '')} × {mm(short)}</dd>
      </dl>
      {!fits && <div className="notice notice--warn">Does not fit on one {sheet.width} × {sheet.height} mm sheet. It will have to be split into several panels.</div>}
      {[...cut.warnings, ...cutoutWarnings(panel, cut)].map((w, i) => <div key={i} className="notice notice--warn">{w}</div>)}
      {!surface && <div className="notice notice--warn">The surface this panel was made from has been deleted. The panel keeps its shape.</div>}

      <PanelBowControl panel={panel} surface={surface} />

      <h3>Distance from the edge</h3>
      <div className="row">
        <span>All sides</span><NumberField value={allOffset} onCommit={setAllOffset} /><span>mm</span>
        <button className="small" onClick={() => void updatePanel({ ...panel, offsets: new Array(n).fill(allOffset) })}>Apply</button>
      </div>
      <table className="sides">
        <thead><tr><th>Side</th><th>Offset (mm)</th><th></th></tr></thead>
        <tbody>
          {panel.offsets.map((v, i) => (
            <tr key={i} className={isOn('side', i) ? 'on' : ''} onMouseEnter={() => setPanelFocus({ kind: 'side', index: i })}>
              <td>S{i + 1}</td><td><NumberField value={v} onCommit={(x) => set('offsets', i, x)} /></td>
              <td>
                <button
                  className="ghost" title="Remove this side: its two neighbours are extended until they meet"
                  onClick={() => { setPanelFocus(null); try { void updatePanel(removeSide(panel, i)); } catch (e) { useApp.setState({ error: e instanceof Error ? e.message : String(e) }); } }}
                >×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Corner rounding</h3>
      <div className="row">
        <span>All corners</span><NumberField value={allRadius} onCommit={setAllRadius} /><span>mm</span>
        <button className="small" onClick={() => void updatePanel({ ...panel, radii: new Array(n).fill(allRadius) })}>Apply</button>
      </div>
      <table className="sides">
        <thead><tr><th>Corner</th><th>Radius (mm)</th><th></th></tr></thead>
        <tbody>
          {panel.radii.map((v, i) => (
            <tr key={i} className={isOn('corner', i) ? 'on' : ''} onMouseEnter={() => setPanelFocus({ kind: 'corner', index: i })}>
              <td>C{i + 1}</td><td><NumberField value={v} onCommit={(x) => set('radii', i, x)} /></td>
              <td className="muted">{cut.usedRadii[i] < v - 0.05 ? `uses ${cut.usedRadii[i].toFixed(0)}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <small>0 keeps a corner sharp. Side and corner numbers are shown in the drawing.</small>

      <h3>Openings</h3>
      <small>Drains, fittings, hatches. The size is the hole that gets cut. Drag an opening in the drawing, or type its distance from a panel edge (measured from the edge of the hole to the cut line).</small>
      {cutouts.map((c, i) => (
        <div key={c.id} className={`opening${isOn('cutout', i) ? ' on' : ''}`} onMouseEnter={() => setPanelFocus({ kind: 'cutout', index: i })}>
          <strong>O{i + 1}</strong>
          {c.kind === 'circle' ? (
            <label>Ø <NumberField value={c.diameter} onCommit={(v) => v > 0 && setCutout(i, { diameter: v })} /></label>
          ) : (
            <>
              <label>W <NumberField value={c.width} onCommit={(v) => v > 0 && setCutout(i, { width: v })} /></label>
              <label>H <NumberField value={c.height} onCommit={(v) => v > 0 && setCutout(i, { height: v })} /></label>
              <label>Turn ° <NumberField value={c.angle} onCommit={(v) => setCutout(i, { angle: v })} /></label>
              <label>Corner r <NumberField value={c.radius} onCommit={(v) => setCutout(i, { radius: v })} /></label>
            </>
          )}
          <button className="ghost" title="Remove this opening" onClick={() => { setPanelFocus(null); void updatePanel({ ...panel, cutouts: cutouts.filter((_, k) => k !== i) }); }}>×</button>
          <div className="opening__dist">
            <span>From the panel edge:</span>
            {cutoutDistances(panel, i).map((d) => (
              <label key={d.side}>S{d.side + 1} <NumberField value={Math.round(d.distance * 10) / 10} allowNegative onCommit={(v) => void updatePanel(setCutoutDistance(panel, i, d.side, v))} /></label>
            ))}
          </div>
        </div>
      ))}
      <div className="row">
        <button className="small" onClick={() => addCutout('circle')}>+ Round</button>
        <button className="small" onClick={() => addCutout('rect')}>+ Rectangular</button>
      </div>

      <h3>Split into two panels</h3>
      <div className="row">
        <span>Gap between panels</span><NumberField value={project.settings.panelGap} onCommit={(v) => void updateSettings({ panelGap: v })} /><span>mm</span>
      </div>
      <button onClick={() => setSplitting(!splitting)}>{splitting ? 'Cancel' : 'Split this panel…'}</button>
      <small>Click two points on the panel edge. Each half keeps its own offsets, corners and openings.</small>

      <div className="side__actions">
        <button className="primary" onClick={() => { const st = useApp.getState(); st.setStep('design'); void st.openDesign(panel.surfaceId); }}>Next: design →</button>
        <button onClick={() => void exportPanelDxf(panel.id)}>Export DXF</button>
        {surface && <button onClick={resetShape}>Reset shape to the surface</button>}
        <button className="danger" onClick={() => { if (confirm(`Delete panel "${panel.name}"?`)) void deletePanel(panel.id); }}>Delete panel</button>
      </div>
    </>
  );
}
