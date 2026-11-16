import { useEffect, useRef, useState } from 'react';
import { Viewer3D, type StandardView } from '../view/Viewer3D';
import { useApp } from '../store';

const VIEWS: { id: StandardView; label: string }[] = [
  { id: 'fit', label: 'Fit' }, { id: 'top', label: 'Top' }, { id: 'front', label: 'Front' }, { id: 'side', label: 'Side' },
];

export function ViewerPane({ onDropFile }: { onDropFile: (file: File) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer3D | null>(null);
  const scan = useApp((s) => s.scan);
  const busy = useApp((s) => s.busy);
  const step = useApp((s) => s.step);
  const selectedRegion = useApp((s) => s.selectedRegion);
  const [dragging, setDragging] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  useEffect(() => {
    try {
      viewer.current = new Viewer3D(host.current!);
      viewer.current.onPick = (region) => {
        const s = useApp.getState();
        if (s.step === 'surfaces') s.selectRegion(region >= 0 ? region : null);
      };
    } catch { setGlError('3D graphics (WebGL) is not available in this browser.'); }
    return () => { viewer.current?.dispose(); viewer.current = null; };
  }, []);

  useEffect(() => { viewer.current?.setScan(scan?.mesh ?? null, scan?.labels ?? null, scan?.orientation); }, [scan]);
  useEffect(() => { viewer.current?.setShowAreas(step === 'surfaces'); }, [step, scan]);
  useEffect(() => { viewer.current?.setSelected(selectedRegion); }, [selectedRegion, scan]);

  const faceSelected = () => {
    const region = scan && selectedRegion !== null ? scan.regions[selectedRegion] : null;
    if (region) viewer.current?.faceDirection(region.plane.normal, region.plane.v);
  };

  return (
    <div
      className={`viewer${dragging ? ' viewer--drop' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) onDropFile(f);
      }}
    >
      <div ref={host} className="viewer__canvas" />
      {glError && <div className="viewer__empty">{glError}</div>}
      {!scan && !busy && !glError && (
        <div className="viewer__empty">
          <strong>No scan open</strong>
          <span>Add a scan, or drop an OBJ file here.</span>
        </div>
      )}
      {busy && <div className="viewer__busy"><span className="spinner" />{busy}</div>}
      {scan && (
        <>
          <div className="viewer__views">
            {step === 'surfaces' && selectedRegion !== null && <button onClick={faceSelected}>Face selected</button>}
            {VIEWS.map((v) => <button key={v.id} onClick={() => viewer.current?.setView(v.id)}>{v.label}</button>)}
          </div>
          <div className="viewer__hint">
            {step === 'surfaces' ? 'Click a coloured area to select it · ' : ''}Drag: rotate · Right-drag: move · Wheel: zoom
          </div>
        </>
      )}
    </div>
  );
}
