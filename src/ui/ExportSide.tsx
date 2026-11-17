import { useEffect, useState } from 'react';
import { LAYER } from '../core/operations';
import { cutOutline } from '../core/panel';
import { nestOptionsOf, operationTotals, summarize } from '../core/sheets';
import { DEFAULT_GROOVE_TOOL } from '../core/tools';
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
  useEffect(() => { void arrange(); }, [arrange, panels, settings?.nestGap, settings?.sheetMargin, settings?.turning, settings?.sheet.width, settings?.sheet.height]);
  if (!project || !settings) return null;

  const o = nestOptionsOf(settings);
  const rows = nest ? summarize(project, nest) : [];
  const totals = nest ? operationTotals(project, libraryOf(project), nest.placements) : null;
  const depths = [...new Set(project.panels.map((p) => project.designs.find((d) => d.surfaceId === p.surfaceId)?.depth ?? 3))];
  const designed = project.panels.filter((p) => project.designs.some((d) => d.surfaceId === p.surfaceId)).length;
  const faulty = project.panels.map((p) => ({ name: p.name, warnings: cutOutline(p).warnings.filter((w) => /crosses itself|too large|disappears/.test(w)) })).filter((x) => x.warnings.length);
  const name = (id: string) => project.panels.find((p) => p.id === id)?.name ?? 'panel';

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

          <h3>Operations in the files</h3>
          <table className="sides ops">
            <tbody>
              {depths.map((d) => <tr key={`g${d}`}><td><code>{LAYER.groove(DEFAULT_GROOVE_TOOL, d)}</code></td><td>grooves, tool T{DEFAULT_GROOVE_TOOL.number}, {d} mm deep</td></tr>)}
              {depths.map((d) => <tr key={`p${d}`}><td><code>{LAYER.pocket(DEFAULT_GROOVE_TOOL, d)}</code></td><td>filled shapes to clear out, {d} mm deep</td></tr>)}
              <tr><td><code>{LAYER.innerCut}</code></td><td>knife: openings</td></tr>
              <tr><td><code>{LAYER.outerCut}</code></td><td>knife: panel outlines, last</td></tr>
              <tr><td><code>{LAYER.reference}</code></td><td>sheet edge and panel names, not machined</td></tr>
            </tbody>
          </table>
          {totals && (
            <dl className="facts">
              <dt>Grooves to mill</dt><dd>{mm(totals.grooves)}</dd>
              {totals.pocketArea > 0 && <><dt>Area to clear out</dt><dd>{(totals.pocketArea / 100).toFixed(0)} cm²</dd></>}
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
