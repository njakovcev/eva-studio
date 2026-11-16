import { useState } from 'react';
import { recleanSurface, lengthErrorFromBulge, surfaceArea, MARKER_MAX_AREA, type Surface } from '../core/surface';
import { useApp } from '../store';
import { mm, squareMetres } from './format';

/** Above this, an area is called out as not flat (mm). */
const FLAT_LIMIT = 3;

export function SurfacesSide() {
  const { project, scan, selectedRegion, openSurfaceId, selectRegion, addSurfaceFromRegion, openSurface } = useApp();
  if (!project) return null;
  const surface = project.surfaces.find((s) => s.id === openSurfaceId);
  if (surface) return <SurfaceDetails surface={surface} />;

  const region = scan && selectedRegion !== null ? scan.regions[selectedRegion] : null;
  return (
    <>
      <div className="side__head"><h2>Surfaces</h2></div>
      {project.surfaces.length === 0 && <p className="muted">No surfaces yet. Pick a flat area of the scan below or by clicking it in 3D, then add it.</p>}
      <ul className="list">
        {project.surfaces.map((s) => (
          <li key={s.id}>
            <button className="list__main" onClick={() => openSurface(s.id)}>
              <strong>{s.name}</strong>
              <span>{squareMetres(surfaceArea(s))} · {s.outline.corners.length} corners</span>
            </button>
          </li>
        ))}
      </ul>

      <h3>Flat areas found in this scan</h3>
      {!scan && <p className="muted">Open a scan first (step 1).</p>}
      {scan && scan.regions.length === 0 && <p className="muted">No flat areas were found in this scan.</p>}
      {scan && (
        <ul className="list">
          {scan.regions.map((r) => (
            <li key={r.id} className={selectedRegion === r.id ? 'on' : ''}>
              <button className="list__main" onClick={() => selectRegion(selectedRegion === r.id ? null : r.id)}>
                <strong>Area {r.id + 1} · {squareMetres(r.area)}</strong>
                <span>{r.flatness.max <= FLAT_LIMIT ? `flat within ${r.flatness.max.toFixed(1)} mm` : `not flat: ${r.flatness.max.toFixed(1)} mm`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {region && (
        <>
          {region.flatness.max > FLAT_LIMIT && (
            <div className="notice notice--warn">This area bulges by {region.flatness.max.toFixed(1)} mm. It will be drawn as if it were flat, so measurements can be slightly off.</div>
          )}
          <button className="primary" onClick={() => void addSurfaceFromRegion()}>Add area {region.id + 1} as a surface</button>
        </>
      )}
    </>
  );
}

function SurfaceDetails({ surface }: { surface: Surface }) {
  const { updateSurface, deleteSurface, openSurface, exportSurfaceDxf } = useApp();
  const [name, setName] = useState(surface.name);
  const { options, corners, sides, anchors } = surface.outline;
  const manual = anchors.some((a) => a.manual);
  const markers = surface.raw.holes.filter((h) => h.area <= MARKER_MAX_AREA).length;
  const openings = surface.raw.holes.length - markers;
  const lengthError = lengthErrorFromBulge(surface);

  const reclean = (next: Partial<typeof options>) => {
    if (manual && !confirm('This finds the corners again and discards the corners you moved or added. Continue?')) return;
    try { void updateSurface(recleanSurface(surface, { ...options, ...next })); }
    catch (e) { useApp.setState({ error: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <>
      <div className="side__head">
        <button className="ghost" onClick={() => openSurface(null)}>← All surfaces</button>
      </div>
      <label className="field">Name
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { const n = name.trim(); if (n && n !== surface.name) void updateSurface({ ...surface, name: n }); else setName(surface.name); }} />
      </label>

      <dl className="facts">
        <dt>Area</dt><dd>{squareMetres(surfaceArea(surface))}</dd>
        <dt>Flatness of the scan</dt><dd>within {surface.flatness.max.toFixed(1)} mm</dd>
        <dt>Holes in the scan (markers, unread spots)</dt><dd>{markers} ignored{openings > 0 ? ` · ${openings} larger opening${openings > 1 ? 's' : ''}` : ''}</dd>
      </dl>
      {surface.flatness.max > FLAT_LIMIT && (
        <div className="notice notice--warn">Not flat: the scan bulges by {surface.flatness.max.toFixed(1)} mm. Over the longest side that is about {lengthError.toFixed(1)} mm of length error.</div>
      )}

      <h3>Corners</h3>
      <label className="field">Detail: {options.tolerance} mm
        <input type="range" min={5} max={60} step={1} value={options.tolerance} onChange={(e) => reclean({ tolerance: Number(e.target.value) })} />
        <small>Lower finds more corners, higher fewer.</small>
      </label>
      <label className="field">Bridge scan gaps up to: {options.bridgeWidth} mm
        <input type="range" min={0} max={120} step={5} value={options.bridgeWidth} onChange={(e) => reclean({ bridgeWidth: Number(e.target.value) })} />
        <small>Closes narrow cuts where the scanner missed a spot. 0 turns it off.</small>
      </label>
      {manual && <button onClick={() => reclean({})}>Reset to automatic corners</button>}

      <h3>Sides ({corners.length})</h3>
      <table className="sides">
        <thead><tr><th>#</th><th>Length</th><th>Scan differs by</th></tr></thead>
        <tbody>
          {sides.map((s, i) => (
            <tr key={i} className={s.maxDeviation > 5 ? 'warn' : ''}><td>{i + 1}</td><td>{mm(s.length)}</td><td>{s.maxDeviation.toFixed(1)} mm</td></tr>
          ))}
        </tbody>
      </table>
      <small>“Scan differs by” over 5 mm means the scanned edge is not straight there: add a corner or check the scan.</small>

      <div className="side__actions">
        <button className="primary" onClick={() => void exportSurfaceDxf(surface.id)}>Export DXF</button>
        <button className="danger" onClick={() => { if (confirm(`Delete surface "${surface.name}"? The scan is not affected.`)) void deleteSurface(surface.id); }}>Delete surface</button>
      </div>
    </>
  );
}
