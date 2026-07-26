import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { api, streamPost, statusColor, statusLabel, type GrafanaDash, type MigrateResult, type MigrateStreamEvent, type PanelStatus } from '../lib/api.ts';
import { Panel, Button, Badge, Dot, Stat, SectionLabel, Spinner, EmptyHint, cx } from '../components/ui.tsx';
import { InfoButton } from '../components/InfoButton.tsx';

const STAGES = ['parse', 'readiness', 'translate', 'assemble', 'apply', 'verify'] as const;
type Stage = (typeof STAGES)[number];
interface LogLine { stage: string; status: 'start' | 'done'; note?: string }
interface LivePanel { title: string; path: string; status: string; note?: string }

export function Migrate() {
  const [uid, setUid] = useState<string>();
  const [uploaded, setUploaded] = useState<{ name: string; json: unknown }>();
  const [result, setResult] = useState<MigrateResult>();
  const [applied, setApplied] = useState(false);
  const [running, setRunning] = useState<false | 'analyze' | 'apply'>(false);
  const [stageStatus, setStageStatus] = useState<Record<string, 'start' | 'done'>>({});
  const [log, setLog] = useState<LogLine[]>([]);
  const [livePanels, setLivePanels] = useState<LivePanel[]>([]);
  const [error, setError] = useState<string>();
  const hasSource = !!uid || !!uploaded;

  const dashes = useQuery({ queryKey: ['grafana'], queryFn: api.grafanaDashboards });

  const reset = () => { setResult(undefined); setApplied(false); setStageStatus({}); setLog([]); setLivePanels([]); setError(undefined); };
  const select = (u: string) => { setUid(u); setUploaded(undefined); reset(); };
  const onUpload = async (file: File) => {
    try { const json = JSON.parse(await file.text()); setUploaded({ name: file.name, json }); setUid(undefined); reset(); }
    catch { alert('Not valid JSON — export the dashboard from Grafana (Share → Export → Save to file).'); }
  };

  const run = async (apply: boolean) => {
    setRunning(apply ? 'apply' : 'analyze'); setError(undefined);
    if (!apply) { setStageStatus({}); setLog([]); setLivePanels([]); }
    const body = uploaded ? { dashboard: uploaded.json, apply } : { uid, apply };
    try {
      await streamPost<MigrateStreamEvent>('/migrate/stream', body, (e) => {
        if (e.type === 'stage') { setStageStatus((s) => ({ ...s, [e.stage]: e.status })); setLog((l) => [...l, { stage: e.stage, status: e.status, note: e.note }]); }
        else if (e.type === 'panel') setLivePanels((p) => [...p, { title: e.title, path: e.path, status: e.status, note: e.note }]);
        else if (e.type === 'done') { setResult(e.result); if (apply) setApplied(true); }
        else if (e.type === 'error') setError(e.error);
      });
    } catch (err) { setError((err as Error).message); }
    finally { setRunning(false); }
  };

  const stageState = (s: Stage): 'done' | 'active' | 'idle' => {
    let maxTouched = -1;
    STAGES.forEach((st, i) => { if (stageStatus[st]) maxTouched = i; });
    const idx = STAGES.indexOf(s);
    if (idx < maxTouched) return 'done';
    if (idx === maxTouched) return stageStatus[s] === 'done' ? 'done' : 'active';
    return 'idle';
  };

  return (
    <div className="flex flex-col gap-6">
      <Header />

      <div className="grid grid-cols-[300px_1fr] gap-6">
        {/* source picker */}
        <Panel className="h-fit p-4">
          <div className="flex items-center justify-between px-1 pb-3">
            <SectionLabel>Grafana source</SectionLabel>
            {dashes.data && <span className="mono text-[11px] text-[var(--color-fg-faint)]">{dashes.data.dashboards.length}</span>}
          </div>
          {dashes.isLoading && <div className="p-3"><Spinner label="listing…" /></div>}
          {dashes.isError && <div className="px-1 pb-2"><div className="mono text-[11px] text-[var(--color-fg-faint)]">Grafana not connected — upload a dashboard JSON instead.</div></div>}
          <div className="flex flex-col gap-1">
            {dashes.data?.dashboards.map((d: GrafanaDash) => (
              <button key={d.uid} onClick={() => select(d.uid)}
                className={cx('rounded-lg border px-3 py-2.5 text-left transition-colors',
                  uid === d.uid ? 'border-[var(--color-signal)] bg-[color-mix(in_oklab,var(--color-signal)_8%,transparent)]' : 'border-transparent hover:bg-[var(--color-panel-2)]')}>
                <div className="text-[13.5px] font-medium text-[var(--color-fg)]">{d.title}</div>
                <div className="mono mt-0.5 text-[10.5px] text-[var(--color-fg-faint)]">{d.uid}</div>
              </button>
            ))}
          </div>

          {/* file-upload ingest mode (the browser reaches Grafana even when the backend can't) */}
          <label className="mt-3 block border-t border-[var(--color-line)] pt-3">
            <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
            <div className={cx('cursor-pointer rounded-lg border border-dashed px-3 py-3 text-center transition-colors',
              uploaded ? 'border-[var(--color-signal)] bg-[color-mix(in_oklab,var(--color-signal)_8%,transparent)]' : 'border-[var(--color-line-2)] hover:border-[var(--color-signal)]')}>
              <div className="mono text-[12px] text-[var(--color-fg-dim)]">{uploaded ? uploaded.name : '⬆ upload dashboard JSON'}</div>
              {!uploaded && <div className="mono mt-0.5 text-[10px] text-[var(--color-fg-faint)]">Grafana → Share → Export</div>}
            </div>
          </label>
        </Panel>

        {/* workspace */}
        <div className="flex min-w-0 flex-col gap-6">
          <Pipeline stageState={stageState} />

          {!hasSource && <EmptyHint>Select a Grafana dashboard or upload a dashboard JSON to begin. Otto will audit it against your live SigNoz before proposing anything.</EmptyHint>}

          {hasSource && !result && !running && (
            <Panel className="flex items-center justify-between px-6 py-5">
              <div>
                <div className="text-[15px] font-medium text-[var(--color-fg)]">Ready to analyze</div>
                <div className="mono mt-1 text-[12px] text-[var(--color-fg-dim)]">Dry-run: parse, audit readiness, translate & validate every panel against live SigNoz — nothing written.</div>
              </div>
              <Button variant="primary" onClick={() => run(false)}>Analyze dashboard</Button>
            </Panel>
          )}

          {/* live steps — stream, don't just wait */}
          {(running || log.length > 0) && !result && <LiveSteps log={log} livePanels={livePanels} running={!!running} />}

          {error && <Panel className="px-5 py-4"><span className="mono text-[13px] text-[var(--color-danger)]">{error}</span></Panel>}

          <AnimatePresence>
            {result && (
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }} className="flex flex-col gap-6">
                <ReceiptRow result={result} />
                <Outcomes result={result} />
                <ApprovalGate result={result} applied={applied} pending={running === 'apply'} onApply={() => run(true)} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function LiveSteps({ log, livePanels, running }: { log: LogLine[]; livePanels: LivePanel[]; running: boolean }) {
  return (
    <Panel className="p-5">
      <div className="flex items-center gap-2.5">
        {running ? <Spinner /> : <Dot color="var(--color-phosphor)" />}
        <SectionLabel>engine · {running ? 'working' : 'done'}</SectionLabel>
      </div>
      <div className="mono mt-3 flex flex-col gap-1 text-[12px]">
        {log.map((l, i) => (
          <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2">
            <span style={{ color: l.status === 'done' ? 'var(--color-phosphor)' : 'var(--color-signal)' }}>{l.status === 'done' ? '✓' : '▸'}</span>
            <span className="text-[var(--color-fg)]">{l.stage}</span>
            {l.note && <span className="text-[var(--color-fg-faint)]">— {l.note}</span>}
          </motion.div>
        ))}
      </div>
      {livePanels.length > 0 && (
        <div className="mt-3 flex flex-col gap-1 border-t border-[var(--color-line)] pt-3">
          {livePanels.map((p, i) => (
            <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2 text-[12px]">
              <Dot color={statusColor[p.status as PanelStatus] ?? 'var(--color-fg-faint)'} />
              <span className="truncate text-[var(--color-fg-dim)]">{p.title}</span>
              <span className="mono ml-auto text-[10px]" style={{ color: statusColor[p.status as PanelStatus] ?? 'var(--color-fg-faint)' }}>{statusLabel[p.status as PanelStatus] ?? p.status}</span>
            </motion.div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Header() {
  return (
    <div>
      <Badge color="var(--color-signal)">the deep workflow</Badge>
      <div className="mt-3 flex items-center gap-2.5"><h1 className="font-display text-[28px] font-black tracking-tight text-[var(--color-fg)]">Dashboard migration</h1><InfoButton surfaceId="migrate" /></div>
      <p className="mt-1.5 max-w-2xl text-[14px] text-[var(--color-fg-dim)]">Grafana → SigNoz, faithfully. Deterministic translation for the mechanical parts, the agent for the tail, and a replication check against the original before you keep it.</p>
    </div>
  );
}

function Pipeline({ stageState }: { stageState: (s: (typeof STAGES)[number]) => 'done' | 'active' | 'idle' }) {
  return (
    <div className="flex items-center gap-2">
      {STAGES.map((s, i) => {
        const st = stageState(s);
        const color = st === 'done' ? 'var(--color-phosphor)' : st === 'active' ? 'var(--color-signal)' : 'var(--color-fg-faint)';
        return (
          <div key={s} className="flex flex-1 items-center gap-2">
            <div className={cx('flex flex-1 flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5', st === 'active' && 'scanline')}
              style={{ borderColor: st === 'idle' ? 'var(--color-line)' : `color-mix(in oklab, ${color} 40%, transparent)`, background: st === 'idle' ? 'transparent' : `color-mix(in oklab, ${color} 8%, transparent)` }}>
              <Dot color={color} pulse={st === 'active'} />
              <span className="mono text-[10px] uppercase tracking-wider" style={{ color: st === 'idle' ? 'var(--color-fg-faint)' : color }}>{s}</span>
            </div>
            {i < STAGES.length - 1 && <span className="text-[var(--color-fg-faint)]">›</span>}
          </div>
        );
      })}
    </div>
  );
}

function ReceiptRow({ result }: { result: MigrateResult }) {
  const r = result.receipt;
  return (
    <Panel className="grid grid-cols-4 gap-6 px-6 py-5">
      <Stat label="panels migrated" value={<>{result.summary.migrated}<span className="text-[var(--color-fg-faint)]">/{result.summary.total}</span></>} accent="var(--color-signal)" />
      <Stat label="run time" value={(r.durationMs / 1000).toFixed(1)} unit="s" />
      <Stat label="llm calls" value={r.llm.calls} unit={`· ${(r.llm.inputTokens + r.llm.outputTokens).toLocaleString()} tok`} />
      <Stat label="recovered" value={r.recovered.length} unit="renames" accent={r.recovered.length ? 'var(--color-phosphor)' : undefined} />
    </Panel>
  );
}

function Outcomes({ result }: { result: MigrateResult }) {
  const order: PanelStatus[] = ['validated', 'validated_with_renames', 'needs_review', 'unsupported', 'missing'];
  const sorted = [...result.outcomes].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-3">
        <SectionLabel>per-panel outcomes</SectionLabel>
        <div className="flex gap-2">
          {order.map((s) => {
            const n = result.outcomes.filter((o) => o.status === s).length;
            return n ? <Badge key={s} color={statusColor[s]}>{n} {statusLabel[s]}</Badge> : null;
          })}
        </div>
      </div>
      <div className="divide-y divide-[var(--color-line)]">
        {sorted.map((o) => (
          <div key={o.panelId} className="flex items-center gap-4 px-5 py-3">
            <Dot color={statusColor[o.status]} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] text-[var(--color-fg)]">{o.title}</div>
              {o.notes && <div className="mono mt-0.5 truncate text-[11px] text-[var(--color-fg-faint)]">{o.notes}</div>}
            </div>
            {o.seriesCount != null && <span className="mono text-[11px] text-[var(--color-fg-dim)]">{o.seriesCount} series</span>}
            <Badge color={o.path === 'agent' ? 'var(--color-cyan)' : o.path === 'deterministic' ? 'var(--color-fg-dim)' : 'var(--color-fg-faint)'}>{o.path === 'none' ? '—' : o.path}</Badge>
            <span className="mono w-[92px] text-right text-[11px]" style={{ color: statusColor[o.status] }}>{statusLabel[o.status]}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ApprovalGate({ result, applied, pending, onApply }: { result: MigrateResult; applied: boolean; pending: boolean; onApply: () => void }) {
  if (applied && result.createdId) {
    const f = result.receipt.fidelity;
    const checks = f ? [
      ['title matches original', f.titleMatch],
      ['tags carried over', f.tagsCarried],
      ['description present', f.descriptionPresent],
      [`sections reproduced (${f.sectionsCreated}/${f.sectionsExpected})`, f.sectionsCreated >= f.sectionsExpected],
      [`panels (${f.panelsMigrated}/${f.panelsTotal})`, f.panelsMigrated === f.panelsTotal],
    ] as const : [];
    return (
      <Panel glow className="px-6 py-5">
        <div className="flex items-center gap-2"><Dot color="var(--color-phosphor)" pulse /><SectionLabel>created & verified</SectionLabel></div>
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2">
          {checks.map(([label, ok]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="mono text-[13px]" style={{ color: ok ? 'var(--color-phosphor)' : 'var(--color-danger)' }}>{ok ? '✓' : '✕'}</span>
              <span className="text-[13px] text-[var(--color-fg-dim)]">{label}</span>
            </div>
          ))}
        </div>
        {result.webUrl && (
          <a href={result.webUrl} target="_blank" rel="noreferrer" className="mono mt-4 inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--color-line-2)] px-4 text-[13px] text-[var(--color-fg)] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]">
            Open in SigNoz ↗
          </a>
        )}
      </Panel>
    );
  }
  return (
    <Panel className="flex items-center justify-between border-[color-mix(in_oklab,var(--color-warn)_35%,var(--color-line))] px-6 py-5">
      <div>
        <div className="flex items-center gap-2"><Badge color="var(--color-warn)">approval required</Badge></div>
        <div className="mt-2 text-[14px] text-[var(--color-fg)]">Create this dashboard in SigNoz — {result.summary.migrated} panels, faithful metadata & section layout.</div>
        <div className="mono mt-1 text-[12px] text-[var(--color-fg-dim)]">Nothing has been written yet. This is the human gate.</div>
      </div>
      <Button variant="primary" onClick={onApply} disabled={pending}>{pending ? <Spinner /> : 'Approve & create ✓'}</Button>
    </Panel>
  );
}
