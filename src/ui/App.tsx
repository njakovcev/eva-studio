import { useRef } from 'react';
import { useApp } from '../store';
import { StartScreen } from './StartScreen';
import { ViewerPane } from './ViewerPane';
import { count, size, squareMetres } from './format';

const STEPS = [
  { id: 'scans', label: 'Scans', ready: true },
  { id: 'surfaces', label: 'Surfaces', ready: false },
  { id: 'panels', label: 'Panels', ready: false },
  { id: 'design', label: 'Design', ready: false },
  { id: 'export', label: 'Export', ready: false },
];

export function App() {
  const { project, scan, error, saveState, busy, clearError, closeProject, addScan, showScan, removeScan, quickView } = useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const inWorkspace = project !== null || scan !== null;

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

      {!inWorkspace ? <StartScreen /> : (
        <>
          <header className="bar">
            <button className="bar__brand" onClick={closeProject} title="Back to start">EVA Studio</button>
            <div className="bar__title">
              {project ? <><strong>{project.project.name}</strong>{project.project.client && <span> · {project.project.client}</span>}</> : <strong>Quick view (not saved)</strong>}
            </div>
            <nav className="steps">
              {STEPS.map((s, i) => (
                <button key={s.id} className={i === 0 ? 'step step--on' : 'step'} disabled={!s.ready} title={s.ready ? '' : 'Coming in a later version'}>
                  <span>{i + 1}</span>{s.label}
                </button>
              ))}
            </nav>
            {project && (
              <div className={`save save--${saveState}`}>
                {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Not saved'}
              </div>
            )}
          </header>

          <main className="work">
            <aside className="side">
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
                  <dt>Points</dt><dd>{count(scan.stats.vertices)}</dd>
                </dl>
              )}
              <p className="muted side__foot">Scans are read as millimetres.</p>
            </aside>
            <ViewerPane onDropFile={takeFile} />
          </main>
        </>
      )}
    </div>
  );
}
