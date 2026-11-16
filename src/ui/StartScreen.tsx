import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { folderAccessSupported, forgetProject, listRecent, pickFolder } from '../io/projectFolder';

type Recent = Awaited<ReturnType<typeof listRecent>>[number];

export function StartScreen() {
  const { newProject, openProject, quickView, busy } = useApp();
  const [form, setForm] = useState({ name: '', client: '', boat: '' });
  const [recent, setRecent] = useState<Recent[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { void listRecent().then(setRecent); }, []);

  const withFolder = async (then: (dir: FileSystemDirectoryHandle) => Promise<void>) => {
    try { await then(await pickFolder()); }
    catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) throw e; }
  };

  return (
    <div className="start">
      <div className="start__head">
        <h1>EVA Studio</h1>
        <p>From boat scan to cut-ready EVA panels.</p>
      </div>

      {!folderAccessSupported && (
        <div className="notice">
          Projects need <strong>Chrome</strong> or <strong>Edge</strong> on a computer, because the app reads and saves
          files straight on your disk. In this browser you can still view a scan.
        </div>
      )}

      <div className="start__grid">
        <section className="card">
          <h2>New project</h2>
          <form onSubmit={(e) => { e.preventDefault(); void withFolder((dir) => newProject(form, dir)); }}>
            <label>Project name
              <input required value={form.name} placeholder="e.g. Elan 350 – cockpit" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>Client
              <input value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} />
            </label>
            <label>Boat
              <input value={form.boat} onChange={(e) => setForm({ ...form, boat: e.target.value })} />
            </label>
            <button className="primary" disabled={!folderAccessSupported || !form.name.trim() || !!busy}>Choose folder and create</button>
            <small>Pick where the project should live. If the folder is not empty, a sub-folder is made for it.</small>
          </form>
        </section>

        <section className="card">
          <h2>Open</h2>
          <button disabled={!folderAccessSupported || !!busy} onClick={() => void withFolder(openProject)}>Open project folder…</button>
          {recent.length > 0 && (
            <>
              <h3>Recent</h3>
              <ul className="recent">
                {recent.map((r) => (
                  <li key={r.id}>
                    <button className="link" disabled={!!busy} onClick={() => void openProject(r.handle)}>{r.name}</button>
                    <button className="ghost" title="Remove from this list" onClick={() => { void forgetProject(r.id); setRecent(recent.filter((x) => x.id !== r.id)); }}>×</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Just look at a scan</h3>
          <button disabled={!!busy} onClick={() => fileInput.current?.click()}>View an OBJ file…</button>
          <small>Nothing is saved and nothing is uploaded.</small>
          <input ref={fileInput} type="file" accept=".obj" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void quickView(f); e.target.value = ''; }} />
        </section>
      </div>
      {busy && <div className="start__busy"><span className="spinner" />{busy}</div>}
    </div>
  );
}
