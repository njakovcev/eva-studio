import { useEffect, useState } from 'react';
import { cutLength, cutOutline, createPanel, smallestBox, type Panel } from '../core/panel';
import { polygonArea } from '../core/poly';
import { useApp } from '../store';
import { mm, squareMetres } from './format';

/** A number box that applies its value when you leave it or press Enter. */
function NumberField({ value, onCommit, title }: { value: number; onCommit: (v: number) => void; title?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(v) || v < 0) { setText(String(value)); return; }
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
                <span>{squareMetres(polygonArea(cut.flat))} · on {surfaceName(p.surfaceId)}</span>
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
  const { project, updatePanel, deletePanel, openPanel, exportPanelDxf, panelFocus, setPanelFocus } = useApp();
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
  const isOn = (kind: 'side' | 'corner', i: number) => panelFocus?.kind === kind && panelFocus.index === i;
  const set = <K extends 'offsets' | 'radii'>(key: K, i: number, v: number) => void updatePanel({ ...panel, [key]: panel[key].map((x, k) => (k === i ? v : x)) });

  const resetShape = () => {
    if (!surface) return;
    if (!confirm('This puts the panel shape back on the surface outline and resets all offsets and radii. Continue?')) return;
    const fresh = createPanel({ id: panel.id, name: panel.name, surface, settings: project.settings });
    void updatePanel({ ...fresh, createdAt: panel.createdAt });
  };

  return (
    <>
      <div className="side__head"><button className="ghost" onClick={() => openPanel(null)}>← All panels</button></div>
      <label className="field">Name
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { const v = name.trim(); if (v && v !== panel.name) void updatePanel({ ...panel, name: v }); else setName(panel.name); }} />
      </label>

      <dl className="facts">
        <dt>Panel area</dt><dd>{squareMetres(polygonArea(cut.flat))}</dd>
        <dt>Length of cut</dt><dd>{mm(cutLength(cut))}</dd>
        <dt>Smallest box</dt><dd>{mm(long).replace(' mm', '')} × {mm(short)}</dd>
      </dl>
      {!fits && <div className="notice notice--warn">Does not fit on one {sheet.width} × {sheet.height} mm sheet. It will have to be split into several panels.</div>}
      {cut.warnings.map((w, i) => <div key={i} className="notice notice--warn">{w}</div>)}
      {!surface && <div className="notice notice--warn">The surface this panel was made from has been deleted. The panel keeps its shape.</div>}

      <h3>Distance from the edge</h3>
      <div className="row">
        <span>All sides</span><NumberField value={allOffset} onCommit={setAllOffset} /><span>mm</span>
        <button className="small" onClick={() => void updatePanel({ ...panel, offsets: new Array(n).fill(allOffset) })}>Apply</button>
      </div>
      <table className="sides">
        <thead><tr><th>Side</th><th>Offset (mm)</th></tr></thead>
        <tbody>
          {panel.offsets.map((v, i) => (
            <tr key={i} className={isOn('side', i) ? 'on' : ''} onMouseEnter={() => setPanelFocus({ kind: 'side', index: i })}>
              <td>S{i + 1}</td><td><NumberField value={v} onCommit={(x) => set('offsets', i, x)} /></td>
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

      <div className="side__actions">
        <button className="primary" onClick={() => void exportPanelDxf(panel.id)}>Export DXF</button>
        {surface && <button onClick={resetShape}>Reset shape to the surface</button>}
        <button className="danger" onClick={() => { if (confirm(`Delete panel "${panel.name}"?`)) void deletePanel(panel.id); }}>Delete panel</button>
      </div>
    </>
  );
}
