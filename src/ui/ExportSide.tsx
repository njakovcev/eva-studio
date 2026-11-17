import { useEffect, useState } from 'react';
import { edgePaths } from '../core/design';
import { LAYER } from '../core/operations';
import { cutOutline } from '../core/panel';
import type { ProjectSettings } from '../core/project';
import { effectiveGap, nestOptionsOf, operationTotals, summarize } from '../core/sheets';
import { colourWidth, describeTool, grooveWidth, machiningOf, minimumGap, type Tool } from '../core/tools';
import { libraryOf, useApp } from '../store';
import { mm } from './format';

function Num({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => { const v = Number(text.replace(',', '.')); if (text.trim() === '' || !Number.isFinite(v) || v < 0) setText(String(value)); else if (v !== value) onCommit(v); };
  return <input className="num" inputMode="decimal" value={text} onFocus={(e) => e.target.select()} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

export function ExportSide() {
  const { project, nest, arranging, arrange, exportSheets, updateSettings, setStep } = useApp();
  const settings = project?.settings;
  const panels = project?.panels;
  // arrange again whenever the panels or the rules change
  const gap = settings ? effectiveGap(settings) : 0;
  useEffect(() => { void arrange(); }, [arrange, panels, gap, settings?.sheetMargin, settings?.turning, settings?.sheet.width, settings?.sheet.height]);
  if (!project || !settings) return null;

  const o = nestOptionsOf(settings);
  const rows = nest ? summarize(project, nest) : [];
  const totals = nest ? operationTotals(project, libraryOf(project), nest.placements) : null;
  const depths = [...new Set(project.panels.map((p) => project.designs.find((d) => d.surfaceId === p.surfaceId)?.depth ?? 3))];
  const designed = project.panels.filter((p) => project.designs.some((d) => d.surfaceId === p.surfaceId)).length;
  const faulty = project.panels.map((p) => ({ name: p.name, warnings: cutOutline(p).warnings.filter((w) => /crosses itself|too large|disappears/.test(w)) })).filter((x) => x.warnings.length);
  const name = (id: string) => project.panels.find((p) => p.id === id)?.name ?? 'panel';
  const { machining, problems } = machiningOf(settings);
  const edgeWarnings = machining.edge ? project.panels.flatMap((p) => edgePaths(p, machining.edge!).warnings.map((w) => `${p.name}: ${w}`)) : [];

  return (
    <>
      <div className="side__head"><h2>Sheets</h2></div>
      {project.panels.length === 0 ? (
        <>
          <p className="muted">There are no panels to arrange yet.</p>
          <button onClick={() => setStep('panels')}>← Go to Panels</button>
        </>
      ) : (
        <>
          <p className="muted">All {project.panels.length} panels of the project, arranged to use as little sheet length as possible.</p>

          <h3>Rules</h3>
          <div className="row"><span>Sheet</span><Num value={o.sheetLength} onCommit={(v) => v > 100 && void updateSettings({ sheet: { width: v, height: o.sheetWidth } })} /><span>×</span><Num value={o.sheetWidth} onCommit={(v) => v > 100 && void updateSettings({ sheet: { width: o.sheetLength, height: v } })} /><span>mm</span></div>
          <div className="row"><span>Space between panels</span><Num value={settings.nestGap} onCommit={(v) => void updateSettings({ nestGap: v })} /><span>mm</span></div>
          {gap > settings.nestGap && <small>The rounded edge needs {gap} mm between panels, so {gap} mm is used.</small>}
          <div className="row"><span>Distance from sheet edge</span><Num value={settings.sheetMargin} onCommit={(v) => void updateSettings({ sheetMargin: v })} /><span>mm</span></div>
          <label className="field">Turning panels
            <select value={settings.turning} onChange={(e) => void updateSettings({ turning: e.target.value as typeof settings.turning })}>
              <option value="half">Only half-way round (keeps the brushing direction)</option>
              <option value="quarter">Any quarter turn (tighter, but the brushing runs across on some)</option>
              <option value="none">Never turned</option>
            </select>
          </label>
          <small>Panels are never mirrored. Everything is milled first and cut out last, so panels stay in place while they are milled.</small>

          <h3>Result</h3>
          {arranging && !nest && <p className="muted">Arranging…</p>}
          {nest && (
            <>
              <table className="sides">
                <thead><tr><th>Sheet</th><th>Panels</th><th>Used</th><th>Filled</th><th>Left over</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.sheet}><td>{r.sheet + 1}</td><td>{r.panels}</td><td>{mm(r.usedLength)}</td><td>{Math.round(r.fill * 100)} %</td><td>{r.offcut > 1 ? mm(r.offcut) : '–'}</td></tr>
                  ))}
                </tbody>
              </table>
              <small>“Filled” is the share of the used length that is panel. “Left over” is the full-width piece of sheet that remains.</small>
              {faulty.map((f) => <div key={f.name} className="notice notice--warn">{f.name} cannot be cut as it is: {f.warnings[0]}</div>)}
              {nest.unplaced.map((u) => <div key={u.partId} className="notice notice--warn">{name(u.partId)}: {u.reason}</div>)}
              {designed < project.panels.length && <div className="notice notice--warn">{project.panels.length - designed} panel{project.panels.length - designed === 1 ? ' has' : 's have'} no design yet: only the outline will be cut.</div>}
            </>
          )}

          <MachiningSettings settings={settings} depths={depths} />
          {problems.map((w) => <div key={w} className="notice notice--warn">{w}</div>)}
          {edgeWarnings.map((w) => <div key={w} className="notice notice--warn">{w}</div>)}

          <h3>Operations in the files</h3>
          <table className="sides ops">
            <tbody>
              {depths.map((d) => <tr key={`g${d}`}><td><code>{LAYER.groove(machining.groove, d)}</code></td><td>grooves, T{machining.groove.number}, {d} mm deep</td></tr>)}
              {depths.map((d) => <tr key={`p${d}`}><td><code>{LAYER.pocket(machining.pocket, d)}</code></td><td>filled shapes to clear out, T{machining.pocket.number}, {d} mm deep</td></tr>)}
              {machining.edge && <tr><td><code>{LAYER.edge(machining.edge.tool, machining.edge.bottomDepth)}</code></td><td>rounded edge, T{machining.edge.tool.number}: tool centre on these lines, lowest point {machining.edge.bottomDepth} mm deep</td></tr>}
              <tr><td><code>{LAYER.innerCut}</code></td><td>knife: openings</td></tr>
              <tr><td><code>{LAYER.outerCut}</code></td><td>knife: panel outlines, last</td></tr>
              <tr><td><code>{LAYER.reference}</code></td><td>sheet edge and panel names, not machined</td></tr>
            </tbody>
          </table>
          {totals && (
            <dl className="facts">
              <dt>Grooves to mill</dt><dd>{mm(totals.grooves)}</dd>
              {totals.pocketArea > 0 && <><dt>Area to clear out</dt><dd>{(totals.pocketArea / 100).toFixed(0)} cm²</dd></>}
              {totals.edge > 0 && <><dt>Rounded edge</dt><dd>{mm(totals.edge)}</dd></>}
              <dt>Knife cut (outlines)</dt><dd>{mm(totals.knife)}</dd>
            </dl>
          )}

          <div className="side__actions">
            <button className="primary" disabled={!nest || arranging || nest.sheets === 0} onClick={() => void exportSheets()}>Export {nest && nest.sheets > 1 ? `${nest.sheets} sheet files` : 'the sheet file'} (DXF)</button>
            <button disabled={arranging} onClick={() => void arrange()}>Arrange again</button>
          </div>
        </>
      )}
    </>
  );
}

/** Which tool does which job, the rounded edge, and the list of tools. */
function MachiningSettings({ settings, depths }: { settings: ProjectSettings; depths: number[] }) {
  const { updateSettings } = useApp();
  const m = settings.machining, tools = settings.tools;
  const { machining } = machiningOf(settings);
  const setM = (change: Partial<typeof m>) => void updateSettings({ machining: { ...m, ...change } });
  const setEdge = (change: Partial<typeof m.edge>) => setM({ edge: { ...m.edge, ...change } });
  const pick = (value: number, onPick: (n: number) => void) => (
    <select value={value} onChange={(e) => onPick(Number(e.target.value))}>
      {!tools.some((t) => t.number === value) && <option value={value}>T{value} (not in the list)</option>}
      {tools.map((t) => <option key={t.number} value={t.number}>{describeTool(t)}</option>)}
    </select>
  );
  const widths = (t: Tool) => depths.map((d) => `at ${d} mm deep: ${grooveWidth(t, d).toFixed(1)} mm wide, colour line ${colourWidth(t, d, settings.material.topLayer).toFixed(1)} mm`).join('; ');
  const e = machining.edge;
  return (
    <>
      <h3>Tools</h3>
      <label className="field">Grooves (lines)
        {pick(m.groove, (n) => setM({ groove: n }))}
        <small>{widths(machining.groove)}</small>
      </label>
      <label className="field">Clearing out (filled shapes)
        {pick(m.pocket, (n) => setM({ pocket: n }))}
        <small>{widths(machining.pocket)}</small>
      </label>
      <label className="check"><input type="checkbox" checked={m.edge.on} onChange={(ev) => setEdge({ on: ev.target.checked })} /> Rounded outer edge (before the knife)</label>
      {m.edge.on && (
        <>
          <label className="field">Edge tool
            {pick(m.edge.tool, (n) => setEdge({ tool: n }))}
          </label>
          <div className="row"><span>Lowest point of the tool</span><Num value={m.edge.bottomDepth} onCommit={(v) => setEdge({ bottomDepth: v })} /><span>mm deep</span></div>
          <div className="row"><span>Thickness left at the knife line</span><Num value={m.edge.leftAtEdge} onCommit={(v) => setEdge({ leftAtEdge: v })} /><span>mm</span></div>
          {e && (
            <small>
              The tool runs {e.offset.toFixed(1)} mm outside every knife cut (inside the openings).
              After cutting, the edge is {e.leftAtEdge} mm thick, the bottom colour shows for {e.band.toFixed(1)} mm and the rounding ends {e.slope.toFixed(1)} mm in.
              Panels are kept at least {minimumGap(e)} mm apart.
            </small>
          )}
        </>
      )}
      <ToolList settings={settings} />
    </>
  );
}

function ToolList({ settings }: { settings: ProjectSettings }) {
  const { updateSettings } = useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ number: '', kind: 'ball' as 'ball' | 'form', a: '', b: '', c: '', name: '' });
  const used = new Set([settings.machining.groove, settings.machining.pocket, ...(settings.machining.edge.on ? [settings.machining.edge.tool] : [])]);
  const add = () => {
    const n = Number(draft.number), a = Number(draft.a.replace(',', '.')), b = Number(draft.b.replace(',', '.')), c = Number(draft.c.replace(',', '.'));
    if (!Number.isInteger(n) || n <= 0) { useApp.setState({ error: 'Give the tool its number from the machine’s tool list (e.g. 22).' }); return; }
    if (settings.tools.some((t) => t.number === n)) { useApp.setState({ error: `There is already a tool T${n}. Remove it first or use another number.` }); return; }
    const profile = draft.kind === 'ball' ? (a > 0 ? { kind: 'ball' as const, radius: a / 2 } : null)
      : (a > 0 && b >= 0 && c > 0 ? { kind: 'form' as const, tipDiameter: a, tipHeight: b, radius: c } : null);
    if (!profile) { useApp.setState({ error: draft.kind === 'ball' ? 'Enter the ball diameter.' : 'Enter the tip diameter, tip height and radius of the profile.' }); return; }
    const tool: Tool = { number: n, name: draft.name.trim() || `T${n}`, profile, rpm: 18000, feed: 3000, plunge: 800 };
    void updateSettings({ tools: [...settings.tools, tool].sort((x, y) => x.number - y.number) });
    setDraft({ number: '', kind: 'ball', a: '', b: '', c: '', name: '' }); setOpen(false);
  };
  return (
    <>
      <ul className="list list--tight">
        {settings.tools.map((t) => (
          <li key={t.number}>
            <span className="list__main"><strong>{describeTool(t)}</strong><span>{t.name}</span></span>
            <button className="ghost" disabled={used.has(t.number)} title={used.has(t.number) ? 'In use: choose another tool for that job first' : 'Remove this tool from the list'}
              onClick={() => void updateSettings({ tools: settings.tools.filter((x) => x.number !== t.number) })}>×</button>
          </li>
        ))}
      </ul>
      {!open ? <button className="small" onClick={() => setOpen(true)}>+ Add a tool</button> : (
        <div className="tool-form">
          <div className="row"><span>Number T</span><input className="num" inputMode="numeric" value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} />
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'ball' | 'form' })}><option value="ball">Ball</option><option value="form">Form cutter</option></select></div>
          {draft.kind === 'ball'
            ? <div className="row"><span>Ball diameter</span><input className="num" inputMode="decimal" value={draft.a} onChange={(e) => setDraft({ ...draft, a: e.target.value })} /><span>mm</span></div>
            : <>
              <div className="row"><span>Tip diameter</span><input className="num" inputMode="decimal" value={draft.a} onChange={(e) => setDraft({ ...draft, a: e.target.value })} /><span>mm</span></div>
              <div className="row"><span>Tip height (straight part)</span><input className="num" inputMode="decimal" value={draft.b} onChange={(e) => setDraft({ ...draft, b: e.target.value })} /><span>mm</span></div>
              <div className="row"><span>Profile radius above it</span><input className="num" inputMode="decimal" value={draft.c} onChange={(e) => setDraft({ ...draft, c: e.target.value })} /><span>mm</span></div>
            </>}
          <label className="field">Name (optional)<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <div className="row"><button className="primary small" onClick={add}>Add</button><button className="small" onClick={() => setOpen(false)}>Cancel</button></div>
        </div>
      )}
    </>
  );
}
