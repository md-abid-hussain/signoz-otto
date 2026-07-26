import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { api, streamPost, ms, pct, type SloResult, type SloStreamEvent } from '../lib/api.ts';
import { Panel, Button, Badge, Dot, Stat, SectionLabel, Spinner, Select } from '../components/ui.tsx';
import { InfoButton } from '../components/InfoButton.tsx';

interface StepLine { step: string; status: 'start' | 'done'; note?: string }

export function Slo() {
  const [service, setService] = useState('');
  const [operation, setOperation] = useState('');
  const [channel, setChannel] = useState('');
  const [result, setResult] = useState<SloResult>();
  const [applied, setApplied] = useState(false);
  const [running, setRunning] = useState<false | 'analyze' | 'apply'>(false);
  const [steps, setSteps] = useState<StepLine[]>([]);
  const [error, setError] = useState<string>();

  const services = useQuery({ queryKey: ['services'], queryFn: api.services });
  const operations = useQuery({ queryKey: ['operations', service], queryFn: () => api.operations(service), enabled: !!service });
  const channels = useQuery({ queryKey: ['channels'], queryFn: api.channels });

  const pickService = (s: string) => { setService(s); setOperation(''); setResult(undefined); setApplied(false); setSteps([]); setError(undefined); };

  const run = async (apply: boolean) => {
    setRunning(apply ? 'apply' : 'analyze'); setError(undefined);
    if (!apply) { setSteps([]); setResult(undefined); setApplied(false); }
    try {
      await streamPost<SloStreamEvent>('/slo/stream', { service, operation, timeRange: '6h', apply, channel: channel || undefined }, (e) => {
        if (e.type === 'step') setSteps((s) => [...s.filter((x) => x.step !== e.step || x.status !== 'start' || e.status !== 'done'), { step: e.step, status: e.status, note: e.note }]);
        else if (e.type === 'done') { setResult(e.result); if (apply) setApplied(true); }
        else if (e.type === 'error') setError(e.error);
      });
    } catch (err) { setError((err as Error).message); }
    finally { setRunning(false); }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Badge color="var(--color-phosphor)">reliability</Badge>
        <div className="mt-3 flex items-center gap-2.5"><h1 className="font-display text-[28px] font-black tracking-tight text-[var(--color-fg)]">SLO copilot</h1><InfoButton surfaceId="slo" /></div>
        <p className="mt-1.5 max-w-2xl text-[14px] text-[var(--color-fg-dim)]">Otto reads live traffic for an operation, proposes an achievable objective with its reasoning, and builds the SLI + error-budget dashboard and fast-burn alert.</p>
      </div>

      <Panel className="grid grid-cols-[1fr_1.3fr_170px_auto] items-end gap-4 px-6 py-5">
        <Select label="service" value={service} onChange={pickService}
          placeholder={services.isLoading ? 'loading…' : 'select a service'}
          options={(services.data?.observed ?? []).map((s) => ({ value: s.name, label: s.name, hint: `${(s.callRate ?? 0).toFixed(1)}/s` }))} />
        <Select label="operation" value={operation} onChange={setOperation} disabled={!service}
          placeholder={!service ? 'pick a service first' : operations.isLoading ? 'loading…' : 'select an operation'}
          options={(operations.data?.operations ?? []).map((o) => ({ value: o.name, label: o.name, hint: `${(o.p95Ns / 1e6).toFixed(0)}ms p95` }))} />
        <Select label="alert channel (opt)" value={channel} onChange={setChannel}
          placeholder={channels.isLoading ? 'loading…' : channels.data?.channels.length ? 'no alert' : 'none configured'}
          options={(channels.data?.channels ?? []).map((c) => ({ value: c.name, label: c.name, hint: c.type }))} />
        <Button variant="primary" onClick={() => run(false)} disabled={!!running || !service || !operation}>
          {running === 'analyze' ? <Spinner /> : 'Analyze'}
        </Button>
      </Panel>
      {services.data?.copilot && (
        <div className="mono -mt-3 flex items-center gap-2 px-1 text-[11px] text-[var(--color-fg-faint)]">
          <Dot color="var(--color-signal)" />
          <span>{services.data.copilot.name} (Otto, the copilot) is excluded — it's the tool, not the app under observation.</span>
        </div>
      )}

      {/* live steps — the analysis is multi-step; show it, don't just spin */}
      {(running || steps.length > 0) && !result && (
        <Panel className="p-5">
          <div className="flex items-center gap-2.5">{running ? <Spinner /> : <Dot color="var(--color-phosphor)" />}<SectionLabel>analysing · {running ? 'working' : 'done'}</SectionLabel></div>
          <div className="mono mt-3 flex flex-col gap-1 text-[12px]">
            {steps.map((l, i) => (
              <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2">
                <span style={{ color: l.status === 'done' ? 'var(--color-phosphor)' : 'var(--color-signal)' }}>{l.status === 'done' ? '✓' : '▸'}</span>
                <span className="text-[var(--color-fg)]">{l.step}</span>
                {l.note && <span className="text-[var(--color-fg-faint)]">— {l.note}</span>}
              </motion.div>
            ))}
          </div>
        </Panel>
      )}

      {error && <Panel className="px-5 py-4"><span className="mono text-[13px] text-[var(--color-danger)]">{error}</span></Panel>}

      <AnimatePresence>
        {result && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }} className="flex flex-col gap-6">
            <Panel className="grid grid-cols-5 gap-6 px-6 py-5">
              <Stat label="requests" value={result.evidence.total.toLocaleString()} unit={`/ ${result.evidence.windowLabel}`} />
              <Stat label="success" value={pct(result.evidence.successPct, 2)} accent="var(--color-phosphor)" />
              <Stat label="p50" value={ms(result.evidence.p50Ns)} />
              <Stat label="p95" value={ms(result.evidence.p95Ns)} accent="var(--color-warn)" />
              <Stat label="p99" value={ms(result.evidence.p99Ns)} />
            </Panel>

            {/* the deeper analysis — explains the operation and reasons like an SRE before proposing */}
            <Panel className="px-6 py-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Dot color="var(--color-cyan)" /><SectionLabel>analysis</SectionLabel></div>
                <div className="flex items-center gap-2">
                  <Badge color="var(--color-cyan)">binding SLI · {result.analysis.sliType}</Badge>
                  <Badge color={trendColor(result.analysis.trend.verdict)}>latency {result.analysis.trend.verdict}</Badge>
                </div>
              </div>
              <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-fg)]">{result.analysis.operationExplanation}</p>
              <div className="mono mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-2)] px-3 py-2 text-[12.5px] text-[var(--color-cyan)]">SLI · {result.analysis.sliDefinition}</div>
              <p className="mt-3 max-w-3xl text-[13.5px] leading-relaxed text-[var(--color-fg-dim)]">{result.analysis.reasoning}</p>

              {result.analysis.alternatives.length > 0 && (
                <div className="mt-5">
                  <SectionLabel>alternatives considered</SectionLabel>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {result.analysis.alternatives.map((a, i) => (
                      <div key={i} className="flex gap-2.5 text-[13px]"><span className="mono text-[var(--color-cyan)]">›</span><span><span className="text-[var(--color-fg)]">{a.label}</span> <span className="text-[var(--color-fg-dim)]">— {a.note}</span></span></div>
                    ))}
                  </div>
                </div>
              )}
              {result.analysis.sreNotes.length > 0 && (
                <div className="mt-5 flex flex-col gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-2)] p-3">
                  {result.analysis.sreNotes.map((n, i) => (
                    <div key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]"><span className="mono shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-phosphor)]">sre</span><span>{n}</span></div>
                  ))}
                </div>
              )}
              <div className="mono mt-4 text-[11px] text-[var(--color-fg-faint)]">latency trend ({result.analysis.trend.windowLabel}): recent {result.analysis.trend.recentP95Ms.toFixed(0)}ms vs {result.analysis.trend.olderP95Ms.toFixed(0)}ms baseline</div>
            </Panel>

            <Panel glow className="px-6 py-6">
              <div className="flex items-center gap-2"><Dot color="var(--color-signal)" /><SectionLabel>proposed objective</SectionLabel></div>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-display text-[34px] font-black text-[var(--color-fg)]">{result.proposal.objectivePct}%</span>
                <span className="text-[15px] text-[var(--color-fg-dim)]">of requests succeed <span className="text-[var(--color-fg)]">and</span> complete under</span>
                <span className="mono text-[22px] font-semibold text-[var(--color-signal)]">{result.proposal.latencyThresholdMs} ms</span>
                <span className="text-[15px] text-[var(--color-fg-dim)]">over {result.proposal.windowDays} days</span>
              </div>
              <p className="mt-4 max-w-3xl text-[13.5px] leading-relaxed text-[var(--color-fg-dim)]">{result.proposal.reasoning}</p>
              <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[var(--color-line)] px-3 py-2">
                <SectionLabel>error budget</SectionLabel>
                <span className="mono text-[13px] text-[var(--color-fg)]">{result.proposal.budgetHoursPerWindow.toFixed(1)} h degraded / {result.proposal.windowDays}d</span>
              </div>
            </Panel>

            {applied && result.applied ? (
              <Panel glow className="px-6 py-5">
                <div className="flex items-center gap-2"><Dot color="var(--color-phosphor)" pulse /><SectionLabel>applied</SectionLabel></div>
                <div className="mt-3 flex flex-col gap-1.5 text-[13.5px] text-[var(--color-fg-dim)]">
                  <div><span className="mono text-[var(--color-phosphor)]">✓</span> SLI + error-budget dashboard created</div>
                  <div>
                    {result.applied.alertCreated
                      ? <><span className="mono text-[var(--color-phosphor)]">✓</span> fast-burn alert wired to <span className="mono text-[var(--color-fg)]">{channel}</span></>
                      : <><span className="mono text-[var(--color-fg-faint)]">○</span> alert skipped {result.applied.alertError ? `(${result.applied.alertError})` : '(no channel given)'}</>}
                  </div>
                </div>
                {result.webUrl && <a href={result.webUrl} target="_blank" rel="noreferrer" className="mono mt-4 inline-flex h-10 items-center rounded-lg border border-[var(--color-line-2)] px-4 text-[13px] text-[var(--color-fg)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]">Open in SigNoz ↗</a>}
              </Panel>
            ) : (
              <Panel className="flex items-center justify-between border-[color-mix(in_oklab,var(--color-warn)_35%,var(--color-line))] px-6 py-5">
                <div>
                  <Badge color="var(--color-warn)">approval required</Badge>
                  <div className="mt-2 text-[14px] text-[var(--color-fg)]">Create the SLO dashboard{channel ? ' + fast-burn alert' : ''} in SigNoz.</div>
                  <div className="mono mt-1 text-[12px] text-[var(--color-fg-dim)]">Nothing written yet.</div>
                </div>
                <Button variant="primary" onClick={() => run(true)} disabled={!!running}>{running === 'apply' ? <Spinner /> : 'Approve & create ✓'}</Button>
              </Panel>
            )}
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

function trendColor(v: 'stable' | 'degrading' | 'improving'): string {
  return v === 'degrading' ? 'var(--color-danger)' : v === 'improving' ? 'var(--color-phosphor)' : 'var(--color-fg-dim)';
}
