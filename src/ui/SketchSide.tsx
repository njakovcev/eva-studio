import { useMemo, useRef, useState } from 'react';
import { newId } from '../core/project';
import { isDimension, type SkDimension, type Sketch } from '../core/sketch/model';
import { addConstraint, analyse, measure, setDimension } from '../core/sketch/solver';
import { constraintsOn, mergePoints, mirrorEntities, removeItems, sketchOutline } from '../core/sketch/geometry';
import { classify, relationChoices } from '../core/sketch/draw';
import { useApp, type SketchTool } from '../store';

const TOOLS: { id: SketchTool; label: string; key: string; title: string }[] = [
  { id: 'select', label: 'Select', key: 'S', title: 'Select and drag' },
  { id: 'line', label: 'Line', key: 'L', title: 'Draw lines corner to corner' },
  { id: 'tangentArc', label: 'Tangent arc', key: 'T', title: 'An arc that continues smoothly from a line or arc' },
  { id: 'arc', label: '3-point arc', key: 'A', title: 'An arc through start, end and one more point' },
  { id: 'circle', label: 'Circle', key: 'C', title: 'Centre, then size' },
  { id: 'spline', label: 'Curve', key: 'P', title: 'A smooth curve through points' },
  { id: 'dimension', label: 'Measure', key: 'D', title: 'Add a tape measurement (like Smart Dimension)' },
  { id: 'fillet', label: 'Round corner', key: 'F', title: 'Round a corner with an arc' },
];

const RELATION_NAMES: Record<string, string> = {
  horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular', equalLength: 'Equal length',
  equalRadius: 'Equal radius', tangent: 'Tangent', pointOnLine: 'On line', pointOnCurve: 'On curve', midpoint: 'Midpoint', symmetric: 'Symmetric', fix: 'Fixed',
};

function describe(s: Sketch, d: SkDimension): string {
  const lineOf = (p: string, q: string) => s.entities.some((e) => e.kind === 'line' && ((e.a === p && e.b === q) || (e.a === q && e.b === p)));
  switch (d.kind) {
    case 'distance': return lineOf(d.p, d.q) ? 'Length' : 'Distance';
    case 'hDistance': return 'Horizontal';
    case 'vDistance': return 'Vertical';
    case 'pointLine': return 'To line';
    case 'angle': return 'Angle';
    case 'radius': return d.diameter ? 'Diameter' : 'Radius';
  }
}

export function SketchSide({ sketch }: { sketch: Sketch }) {
  const { project, sketchTool, sketchSelection, setSketchTool, setSketchSelection, updateSketch, openSketch, makeSurfaceFromSketch, deleteSketch, setSketchPhoto, setStep } = useApp();
  const [name, setName] = useState(sketch.name);
  const photoInput = useRef<HTMLInputElement>(null);
  const analysis = useMemo(() => analyse(sketch), [sketch]);
  const outline = useMemo(() => sketchOutline(sketch), [sketch]);
  const surface = project?.surfaces.find((s) => s.id === sketch.surfaceId);
  const save = (s: Sketch) => void updateSketch(s, true);
  const fail = (message: string) => useApp.setState({ error: message });

  const sel = classify(sketch, sketchSelection);
  const choices = relationChoices(sketch, sketchSelection);
  const selectedEntities = sketch.entities.filter((e) => sketchSelection.includes(e.id));
  const relations = constraintsOn(sketch, new Set(sketchSelection)).filter((c) => !isDimension(c));
  const axis = selectedEntities.filter((e) => e.kind === 'line' && e.construction);
  const dims = sketch.constraints.filter(isDimension);
  const ph = sketch.photo;

  return (
    <>
      <div className="side__head">
        <button className="ghost" onClick={() => openSketch(null)}>← All surfaces</button>
      </div>
      <label className="field">Name
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { const n = name.trim(); if (n && n !== sketch.name) save({ ...sketch, name: n }); else setName(sketch.name); }} />
      </label>

      <div className="sk-tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={sketchTool === t.id ? 'on' : ''} title={`${t.title} (${t.key})`} onClick={() => setSketchTool(t.id)}>
            {t.label}<kbd>{t.key}</kbd>
          </button>
        ))}
      </div>

      <div className={`notice ${analysis.dof === 0 && sketch.points.length ? 'notice--ok' : 'notice--info'}`}>
        {!sketch.points.length ? 'Draw the outline of the surface: Line (L) from corner to corner, back to the first corner.'
          : analysis.dof === 0 ? 'Fully set: every line is decided by measurements and relations.'
            : `${analysis.dof} more measurement${analysis.dof === 1 ? '' : 's'} or relation${analysis.dof === 1 ? '' : 's'} needed to fully set the drawing (blue parts can still move).`}
      </div>
      {sketch.points.length > 0 && !outline.ok && <div className="notice notice--warn">{outline.message}</div>}

      {sketchSelection.length > 0 && (
        <>
          <h3>Selected</h3>
          <small>{[sel.points.length && `${sel.points.length} point${sel.points.length > 1 ? 's' : ''}`, sel.lines.length && `${sel.lines.length} line${sel.lines.length > 1 ? 's' : ''}`, sel.curves.length && `${sel.curves.length} arc/circle`, sel.splines.length && `${sel.splines.length} curve`].filter(Boolean).join(', ') || 'a measurement or relation'}</small>
          {choices.length > 0 && (
            <div className="sk-actions">
              {choices.map((c) => (
                <button key={c.label} onClick={() => {
                  const r = addConstraint(sketch, c.make(newId));
                  if (r.status === 'refused') fail(r.message); else save(r.sketch);
                }}>{c.label}</button>
              ))}
            </div>
          )}
          <div className="sk-actions">
            {sel.points.length === 2 && sketchSelection.length === 2 && <button onClick={() => { save(mergePoints(sketch, sel.points[0], sel.points[1])); setSketchSelection([sel.points[0]]); }}>Join points</button>}
            {selectedEntities.length > 0 && (
              <button title="Construction lines help the drawing (e.g. a centre line) but are not part of the outline (X)" onClick={() => {
                const on = !selectedEntities.every((e) => e.construction), ids = new Set(sketchSelection);
                save({ ...sketch, entities: sketch.entities.map((e) => (ids.has(e.id) ? { ...e, construction: on || undefined } : e)) });
              }}>{selectedEntities.every((e) => e.construction) ? 'Make solid' : 'Make construction'}</button>
            )}
            {axis.length === 1 && selectedEntities.length > 1 && (
              <button title="Copies the other selected parts to the other side of the construction line, and keeps them mirrored" onClick={() => {
                save(mirrorEntities(sketch, selectedEntities.filter((e) => e.id !== axis[0].id).map((e) => e.id), axis[0].id, newId));
              }}>Mirror about centre line</button>
            )}
            <button className="danger" onClick={() => { save(removeItems(sketch, new Set(sketchSelection))); setSketchSelection([]); }}>Delete</button>
          </div>
          {relations.length > 0 && (
            <ul className="list list--tight">
              {relations.map((c) => (
                <li key={c.id}>
                  <span className="list__main">{RELATION_NAMES[c.kind] ?? c.kind}</span>
                  <button className="ghost" title="Remove this relation" onClick={() => save({ ...sketch, constraints: sketch.constraints.filter((x) => x.id !== c.id) })}>×</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3>Measurements ({dims.length})</h3>
      {dims.length === 0 ? <small>Use Measure (D): click a line (or two points, a point and a line, two lines, an arc) and type what the tape says.</small> : (
        <table className="sides">
          <tbody>
            {dims.map((d) => {
              const shown = measure(sketch, d) * (d.kind === 'radius' && d.diameter ? 2 : 1);
              const on = sketchSelection.includes(d.id);
              return (
                <tr key={d.id} className={on ? 'on' : ''} onClick={() => setSketchSelection([d.id])}>
                  <td>{describe(sketch, d)}</td>
                  <td>
                    {d.reference ? <span className="muted" title="Decided by the other measurements">({Math.round(shown * 10) / 10})</span> : (
                      <input
                        key={`${d.id}-${shown.toFixed(2)}`} className="num" inputMode="decimal" defaultValue={Math.round(shown * 10) / 10}
                        onBlur={(e) => {
                          const v = Number(e.target.value.replace(',', '.'));
                          if (!(v > 0) || Math.abs(v - shown) < 1e-6) { e.target.value = String(Math.round(shown * 10) / 10); return; }
                          const r = setDimension(sketch, d.id, d.kind === 'radius' && d.diameter ? v / 2 : v);
                          if (!r.ok) { fail(r.message); e.target.value = String(Math.round(shown * 10) / 10); } else save(r.sketch);
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      />
                    )}
                  </td>
                  <td>{d.kind === 'angle' ? '°' : 'mm'}</td>
                  <td><button className="ghost" title="Remove this measurement" onClick={(e) => { e.stopPropagation(); save({ ...sketch, constraints: sketch.constraints.filter((x) => x.id !== d.id) }); }}>×</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3>Photo underneath</h3>
      <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void setSketchPhoto(f); e.target.value = ''; }} />
      {!ph ? (
        <>
          <small>A photo taken from straight above (e.g. with a drone) to draw over. It is copied into the project; the original stays where it is.</small>
          <button onClick={() => photoInput.current?.click()}>Add a photo…</button>
        </>
      ) : (
        <>
          <small>{ph.file.split('/').pop()} · 1 pixel = {ph.scale.toFixed(2)} mm</small>
          <div className="sk-actions">
            <button className={sketchTool === 'photoScale' ? 'on' : ''} title="Click two points on the photo whose real distance you know" onClick={() => setSketchTool('photoScale')}>Set scale</button>
            <button className={sketchTool === 'photoAlign' ? 'on' : ''} title="Click two points along an edge that should be level" onClick={() => setSketchTool('photoAlign')}>Level</button>
            <button className={sketchTool === 'photoMove' ? 'on' : ''} title="Drag the photo" onClick={() => setSketchTool('photoMove')}>Move</button>
          </div>
          <label className="field">See-through: {Math.round((1 - ph.opacity) * 100)} %
            <input type="range" min={0.1} max={1} step={0.05} value={ph.opacity} onChange={(e) => void updateSketch({ ...sketch, photo: { ...ph, opacity: Number(e.target.value) } }, false)} onPointerUp={() => save(useApp.getState().project!.sketches.find((k) => k.id === sketch.id)!)} />
          </label>
          <div className="sk-actions">
            <button onClick={() => save({ ...sketch, photo: { ...ph, hidden: !ph.hidden || undefined } })}>{ph.hidden ? 'Show photo' : 'Hide photo'}</button>
            <button onClick={() => photoInput.current?.click()}>Other photo…</button>
            <button className="ghost" onClick={() => { if (confirm('Remove the photo from this drawing? The file stays in the photos folder.')) save({ ...sketch, photo: undefined }); }}>Remove</button>
          </div>
          <small>Photos shot at an angle are stretched: measurements typed in always win over the photo.</small>
        </>
      )}

      <div className="side__actions">
        {surface ? (
          <>
            <div className="notice notice--ok">This drawing is surface “{surface.name}”. Changes carry over while the outline is closed.</div>
            <button className="primary" onClick={() => setStep('panels')}>Next: make a panel →</button>
          </>
        ) : (
          <button className="primary" disabled={!outline.ok} title={outline.ok ? '' : outline.message} onClick={() => void makeSurfaceFromSketch(sketch.id)}>Use as surface</button>
        )}
        <button className="danger" onClick={() => { if (confirm(`Delete drawing "${sketch.name}"?${surface ? ' Its surface stays, but can no longer be changed through the drawing.' : ''}`)) void deleteSketch(sketch.id); }}>Delete drawing</button>
      </div>
    </>
  );
}
