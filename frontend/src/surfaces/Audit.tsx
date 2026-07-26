import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api, type CoverageRow } from '../lib/api.ts';
import { Panel, Badge, Dot, Stat, SectionLabel, Spinner, EmptyHint } from '../components/ui.tsx';
import { InfoButton } from '../components/InfoButton.tsx';

const SIGNALS = ['traces', 'metrics', 'logs'] as const;

export function Audit() {
  const cov = useQuery({ queryKey: ['coverage'], queryFn: api.auditCoverage });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Badge color="var(--color-phosphor)">readiness · telemetry audit</Badge>
        <div className="mt-3 flex items-center gap-2.5"><h1 className="font-display text-[28px] font-black tracking-tight text-[var(--color-fg)]">Coverage audit</h1><InfoButton surfaceId="audit" /></div>
        <p className="mt-1.5 max-w-2xl text-[14px] text-[var(--color-fg-dim)]">Which services emit which signals into SigNoz — traces, metrics, logs — discovered live via <span className="mono text-[var(--color-fg)]">get_field_values(service.name)</span> per signal. Otto surfaces the gap; fixing ingestion stays a collector change.</p>
      </div>

      {cov.isLoading && <Panel className="p-6"><Spinner label="auditing signal coverage…" /></Panel>}
      {cov.isError && <Panel className="px-5 py-4"><span className="mono text-[13px] text-[var(--color-danger)]">{(cov.error as Error).message}</span></Panel>}

      {cov.data && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }} className="flex flex-col gap-6">
          <Panel className="grid grid-cols-4 gap-6 px-6 py-5">
            <Stat label="services" value={cov.data.services.length} />
            <Stat label="with traces" value={cov.data.totals.traces} accent="var(--color-phosphor)" />
            <Stat label="with metrics" value={cov.data.totals.metrics} accent="var(--color-cyan)" />
            <Stat label="with logs" value={cov.data.totals.logs} accent={cov.data.gaps.some((g) => g.missing.includes('logs')) ? 'var(--color-warn)' : 'var(--color-phosphor)'} />
          </Panel>

          {/* coverage matrix */}
          <Panel className="overflow-hidden">
            <div className="grid grid-cols-[1fr_90px_90px_90px_120px] items-center border-b border-[var(--color-line)] px-5 py-3">
              <SectionLabel>service</SectionLabel>
              {SIGNALS.map((s) => <div key={s} className="mono text-center text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">{s}</div>)}
              <div className="mono text-right text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">rate · err</div>
            </div>
            <div className="divide-y divide-[var(--color-line)]">
              {cov.data.services.map((s) => <Row key={s.name} s={s} />)}
            </div>
          </Panel>

          {/* gaps */}
          {cov.data.gaps.length > 0 ? (
            <Panel className="border-[color-mix(in_oklab,var(--color-warn)_30%,var(--color-line))] p-6">
              <div className="flex items-center gap-2"><Dot color="var(--color-warn)" /><SectionLabel>coverage gaps ({cov.data.gaps.length})</SectionLabel></div>
              <div className="mt-4 flex flex-col gap-2.5">
                {cov.data.gaps.map((g) => (
                  <div key={g.service} className="flex items-center gap-3">
                    <span className="mono w-40 shrink-0 text-[13px] text-[var(--color-fg)]">{g.service}</span>
                    <span className="text-[13px] text-[var(--color-fg-dim)]">missing</span>
                    {g.missing.map((m) => <Badge key={m} color="var(--color-danger)">{m}</Badge>)}
                  </div>
                ))}
              </div>
              <div className="mono mt-5 rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-2)] p-4 text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]">
                <span className="text-[var(--color-warn)]"># fix (collector):</span> route these services' signals into the SigNoz export pipeline —{'\n'}
                add the missing signal to the OTel Collector <span className="text-[var(--color-fg)]">service.pipelines.&lt;signal&gt;.exporters</span> that targets SigNoz{'\n'}
                (e.g. logs currently reaching OpenSearch only need the SigNoz OTLP exporter added to the logs pipeline).
              </div>
            </Panel>
          ) : (
            <EmptyHint>Full coverage — every observed service emits traces, metrics, and logs into SigNoz.</EmptyHint>
          )}

          {/* self, separated */}
          {cov.data.self.length > 0 && (
            <Panel className="border-[color-mix(in_oklab,var(--color-signal)_30%,var(--color-line))] p-6">
              <div className="flex items-center gap-2"><Dot color="var(--color-signal)" pulse /><SectionLabel>otto · the copilot (self-observed, kept apart)</SectionLabel></div>
              <div className="mt-4 grid grid-cols-[1fr_90px_90px_90px_120px]">
                {cov.data.self.map((s) => <Row key={s.name} s={s} bare />)}
              </div>
            </Panel>
          )}
        </motion.div>
      )}
    </div>
  );
}

function Row({ s, bare }: { s: CoverageRow; bare?: boolean }) {
  return (
    <div className={`grid grid-cols-[1fr_90px_90px_90px_120px] items-center ${bare ? 'py-2' : 'px-5 py-2.5'}`}>
      <span className="text-[13.5px] text-[var(--color-fg)]">{s.name}</span>
      {SIGNALS.map((sig) => (
        <div key={sig} className="flex justify-center">
          {s[sig]
            ? <span className="mono text-[13px] text-[var(--color-phosphor)]">✓</span>
            : <span className="mono text-[13px] text-[var(--color-danger)]">✕</span>}
        </div>
      ))}
      <span className="mono text-right text-[11px] text-[var(--color-fg-faint)]">
        {s.callRate != null ? `${s.callRate.toFixed(1)}/s` : '—'} · {s.errorRate != null ? `${(s.errorRate * 100).toFixed(1)}%` : '—'}
      </span>
    </div>
  );
}
