import { useEffect, useRef } from 'react';
import { useApp, type Step } from '../store';
import { DesignSide } from './DesignSide';
import { DesignView } from './DesignView';
import { OutlineEditor } from './OutlineEditor';
import { PanelEditor } from './PanelEditor';
import { PanelsSide } from './PanelsSide';
import { StartScreen } from './StartScreen';
import { SurfacesSide } from './SurfacesSide';
import { ViewerPane } from './ViewerPane';
import { count, size, squareMetres } from './format';

const STEPS: { id: string; label: string; ready: boolean }[] = [
  { id: 'scans', label: 'Scans', ready: true },
  { id: 'surfaces', label: 'Surfaces', ready: true },
  { id: 'panels', label: 'Panels', ready: true },
  { id: 'design', label: 'Design', ready: true },
  { id: 'export', label: 'Export', ready: false },
];

export function App() {
  const {
    project, scan, step, openSurfaceId, openPanelId, designSurfaceId, error, notice, saveState, busy,
    clearError, clearNotice, closeProject, addScan, showScan, removeScan, quickView, setStep, undo, redo, canUndo, canRedo,
  } = useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const inWorkspace = project !== null || scan !== null;
  const openSurface = project?.surfaces.find((s) => s.id === openSurfaceId);
  const openPanel = project?.panels.find((p) => p.id === openPanelId);
  const designSurface = step === 'design' ? project?.surfaces.find((s) => s.id === designSurfaceId) : undefined;
  const openDesign = designSurface && project?.designs.find((d) => d.surfaceId === designSurface.id);
  const editing = openSurface ?? openPanel ?? openDesign;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 6000);
    return () => clearTimeout(t);
  }, [notice, clearNotice]);

  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes. Inside a text box the browser's own undo is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.target instanceof HTMLInputElement) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); void undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); void redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const takeFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.obj')) {
      useApp.setState({ error: `"${file.name}" is not an OBJ file. Export the scan as OBJ from the scanner software.` });
      return;
    }
    void (project ? addScan(file) : quickView(file));
  };

  return (
    <div className="app">
      {error && (
        <div className="error" role="alert">
          <span>{error}</span>
          <button className="ghost" onClick={clearError}>Dismiss</button>
        </div>
      )}
      {notice && <div className="toast" role="status">{notice}</div>}

      {!inWorkspace ? <StartScreen /> : (
        <>
          <header className="bar">
            <button className="bar__brand" onClick={closeProject} title="Back to start">EVA Studio</button>
            <div className="bar__title">
              {project ? <><strong>{project.project.name}</strong>{project.project.client && <span> · {project.project.client}</span>}</> : <strong>Quick view (not saved)</strong>}
            </div>
            <nav className="steps">
              {STEPS.map((s, i) => {
                const usable = s.ready && (s.id === 'scans' || project !== null);
                return (
                  <button
                    key={s.id} className={step === s.id ? 'step step--on' : 'step'} disabled={!usable}
                    title={!s.ready ? 'Coming in a later version' : !usable ? 'Create or open a project first' : ''}
                    onClick={() => setStep(s.id as Step)}
                  >
                    <span>{i + 1}</span>{s.label}
                  </button>
                );
              })}
            </nav>
            {project && (
              <div className="history">
                <button className="small" disabled={!canUndo} onClick={() => void undo()} title="Undo (Ctrl+Z / ⌘Z)">↶ Undo</button>
                <button className="small" disabled={!canRedo} onClick={() => void redo()} title="Redo (Ctrl+Shift+Z / ⇧⌘Z)">↷ Redo</button>
              </div>
            )}
            {project && (
              <div className={`save save--${saveState}`}>
                {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Not saved'}
              </div>
            )}
          </header>

          <main className="work">
            <aside className="side">
              {step === 'surfaces' ? <SurfacesSide /> : step === 'panels' ? <PanelsSide /> : step === 'design' ? <DesignSide /> : (
                <>
                  <div className="side__head">
                    <h2>Scans</h2>
                    {project && <button className="primary small" disabled={!!busy} onClick={() => fileInput.current?.click()}>Add scan</button>}
                  </div>
                  <input ref={fileInput} type="file" accept=".obj" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) takeFile(f); e.target.value = ''; }} />

                  {project && project.scans.length === 0 && <p className="muted">No scans yet. Export an OBJ from the scanner software and add it here.</p>}
                  {project && (
                    <ul className="list">
                      {project.scans.map((s) => (
                        <li key={s.id} className={scan?.id === s.id ? 'on' : ''}>
                          <button className="list__main" onClick={() => void showScan(s.id)}>
                            <strong>{s.name}</strong>
                            <span>{size(s.stats)}</span>
                          </button>
                          <button className="ghost" title="Remove from project (the file stays in the scans folder)" onClick={() => { if (confirm(`Remove "${s.name}" from the project?\nThe file stays in the scans folder.`)) void removeScan(s.id); }}>×</button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {scan && (
                    <dl className="facts">
                      <dt>File</dt><dd>{scan.name}</dd>
                      <dt>Size (X × Y × Z)</dt><dd>{size(scan.stats)}</dd>
                      <dt>Scanned area</dt><dd>{squareMetres(scan.stats.area)}</dd>
                      <dt>Triangles</dt><dd>{count(scan.stats.triangles)}</dd>
                      <dt>Flat areas found</dt><dd>{scan.regions.length}</dd>
                    </dl>
                  )}
                  {project && scan && scan.regions.length > 0 && <button onClick={() => setStep('surfaces')}>Next: pick surfaces →</button>}
                  <p className="muted side__foot">Scans are read as millimetres.</p>
                </>
              )}
            </aside>
            {/* the 3D view stays mounted (hidden) while the 2D editor is open, so the scan is not rebuilt */}
            <div className={editing ? 'pane pane--hidden' : 'pane'}><ViewerPane onDropFile={takeFile} /></div>
            {openSurface && <div className="pane"><OutlineEditor surface={openSurface} /></div>}
            {openPanel && <div className="pane"><PanelEditor panel={openPanel} surface={project?.surfaces.find((s) => s.id === openPanel.surfaceId)} /></div>}
            {designSurface && openDesign && <div className="pane"><DesignView surface={designSurface} design={openDesign} panels={project!.panels.filter((p) => p.surfaceId === designSurface.id)} /></div>}
          </main>
        </>
      )}
    </div>
  );
}
