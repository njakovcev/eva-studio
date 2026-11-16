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
  const [dragging, setDragging] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  useEffect(() => {
    try { viewer.current = new Viewer3D(host.current!); }
    catch { setGlError('3D graphics (WebGL) is not available in this browser.'); }
    return () => { viewer.current?.dispose(); viewer.current = null; };
  }, []);

  useEffect(() => { viewer.current?.setMesh(scan?.mesh ?? null); }, [scan]);

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
            {VIEWS.map((v) => <button key={v.id} onClick={() => viewer.current?.setView(v.id)}>{v.label}</button>)}
          </div>
          <div className="viewer__hint">Drag: rotate · Right-drag: move · Wheel: zoom</div>
        </>
      )}
    </div>
  );
}
