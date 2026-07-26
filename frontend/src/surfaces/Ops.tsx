import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api } from '../lib/api.ts';
import { Panel, Button, Badge, Dot, SectionLabel, Spinner } from '../components/ui.tsx';
import { InfoButton } from '../components/InfoButton.tsx';

// illustrative span waterfall — the shape Otto actually emits (verified in SigNoz)
const SPANS = [
  { name: 'otto.run', depth: 0, start: 0, len: 100, color: 'var(--color-signal)' },
  { name: 'semantic.recover', depth: 1, start: 2, len: 8, color: 'var(--color-cyan)' },
  { name: 'panel.migrate', depth: 1, start: 12, len: 30, color: 'var(--color-phosphor)' },
  { name: 'llm.call', depth: 2, start: 14, len: 26, color: 'var(--color-warn)' },
  { name: 'panel.migrate', depth: 1, start: 44, len: 34, color: 'var(--color-phosphor)' },
  { name: 'llm.call', depth: 2, start: 46, len: 30, color: 'var(--color-warn)' },
  { name: 'panel.migrate', depth: 1, start: 80, len: 18, color: 'var(--color-phosphor)' },
];

const METRICS = [
  { name: 'otto.panels', desc: 'panels processed, by status', kind: 'counter' },
  { name: 'otto.llm.tokens', desc: 'tokens consumed, by direction', kind: 'counter' },
  { name: 'otto.run.duration', desc: 'end-to-end run latency', kind: 'histogram' },
];

export function Ops() {
  const [url, setUrl] = useState<string>();
  const create = useMutation({
    mutationFn: () => api.opsDashboard({ apply: true }),
    onSuccess: (r) => setUrl(r.webUrl),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Badge color="var(--color-warn)">self-observability</Badge>
        <div className="mt-3 flex items-center gap-2.5"><h1 className="font-display text-[28px] font-black tracking-tight text-[var(--color-fg)]">Otto Ops</h1><InfoButton surfaceId="ops" /></div>
        <p className="mt-1.5 max-w-2xl text-[14px] text-[var(--color-fg-dim)]">The tool that manages your observability is itself observable. Otto exports its own OpenTelemetry — every migration a trace, every LLM call metered — to the same SigNoz it manages.</p>
      </div>

      {/* span waterfall */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <Panel className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><Dot color="var(--color-signal)" pulse /><SectionLabel>one migration, as a trace</SectionLabel></div>
            <span className="mono text-[11px] text-[var(--color-fg-faint)]">service.name = otto</span>
          </div>
          <div className="mt-5 flex flex-col gap-1.5">
            {SPANS.map((s, i) => (
              <motion.div key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.06 }}
                className="flex items-center gap-3" style={{ paddingLeft: s.depth * 22 }}>
                <span className="mono w-[130px] shrink-0 text-right text-[11.5px] text-[var(--color-fg-dim)]">{s.name}</span>
                <div className="relative h-6 flex-1 rounded bg-[var(--color-ink)]">
                  <div className="absolute top-0 flex h-full items-center rounded px-2"
                    style={{ left: `${s.start}%`, width: `${s.len}%`, background: `color-mix(in oklab, ${s.color} 22%, transparent)`, borderLeft: `2px solid ${s.color}` }}>
                    <span className="mono text-[10px]" style={{ color: s.color }}>{s.name === 'llm.call' ? 'gpt-5.6' : ''}</span>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </Panel>
      </motion.div>

      {/* metrics + build dashboard */}
      <div className="grid grid-cols-[1fr_360px] gap-6">
        <Panel className="p-6">
          <SectionLabel>metrics emitted</SectionLabel>
          <div className="mt-4 flex flex-col divide-y divide-[var(--color-line)]">
            {METRICS.map((m) => (
              <div key={m.name} className="flex items-center gap-3 py-3">
                <Dot color="var(--color-phosphor)" />
                <span className="mono text-[13px] text-[var(--color-fg)]">{m.name}</span>
                <span className="text-[12.5px] text-[var(--color-fg-dim)]">{m.desc}</span>
                <Badge color="var(--color-fg-faint)">{m.kind}</Badge>
              </div>
            ))}
          </div>
        </Panel>

        <Panel glow className="flex flex-col p-6">
          <SectionLabel>the ops dashboard</SectionLabel>
          <p className="mt-3 flex-1 text-[13px] leading-relaxed text-[var(--color-fg-dim)]">
            Otto builds its own self-observability dashboard in SigNoz — runs over time, panels by outcome, LLM spend, run latency, and the slowest panels. After a migration, flip here and see the trace &amp; cost of the run you just watched.
          </p>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="mono mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-signal)] px-4 text-[13px] font-semibold text-black hover:bg-[var(--color-signal-deep)] hover:text-white">Open Otto Ops ↗</a>
          ) : (
            <Button variant="primary" className="mt-4" onClick={() => create.mutate()} disabled={create.isPending}>{create.isPending ? <Spinner /> : 'Build Otto Ops dashboard'}</Button>
          )}
          {create.isError && <span className="mono mt-2 text-[12px] text-[var(--color-danger)]">{(create.error as Error).message}</span>}
          <div className="mono mt-3 text-[10.5px] leading-relaxed text-[var(--color-fg-faint)]">Run the engine with OTTO_OTEL=1 to populate live data.</div>
        </Panel>
      </div>
    </div>
  );
}
