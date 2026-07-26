import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Panel, Badge, SectionLabel } from '../components/ui.tsx';
import { OttoMark } from '../components/Logo.tsx';
import { SURFACES } from './registry.ts';

const rise = (i: number) => ({ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.04 * i, duration: 0.45, ease: [0.22, 1, 0.36, 1] as const } });

export function About() {
  return (
    <div className="flex flex-col gap-7">
      <motion.header {...rise(0)} className="relative overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-panel)_50%,transparent)] px-9 py-9">
        <div className="flex items-center gap-4">
          <OttoMark size={40} />
          <div>
            <Badge color="var(--color-signal)">what is otto</Badge>
            <h1 className="font-display mt-2 text-[30px] font-black tracking-tight text-[var(--color-fg)]">A self-hosted agentic copilot for SigNoz</h1>
          </div>
        </div>
        <p className="mt-4 max-w-3xl text-[14.5px] leading-relaxed text-[var(--color-fg-dim)]">
          SigNoz gets you 80% of the way to great observability and leaves the hardest 20% as expert-judgment work — knowing what your telemetry supports, migrating your Grafana dashboards, defining what "reliable" means, and investigating day-to-day. Otto is one LangGraph engine —
          <span className="text-[var(--color-fg)]"> analyze → propose → approve → apply → verify</span> — that does that work over the live SigNoz MCP, and never writes without your approval.
        </p>
      </motion.header>

      <div className="grid grid-cols-2 gap-4">
        {SURFACES.map((s, i) => (
          <motion.div key={s.id} {...rise(1 + i)}>
            <Panel className="flex h-full flex-col p-6">
              <div className="flex items-center gap-2.5">
                {s.emoji && <span className="text-[18px]">{s.emoji}</span>}
                <span className="font-display text-[17px] font-bold text-[var(--color-fg)]">{s.label}</span>
                <span className="mono ml-auto text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">{s.hint}</span>
              </div>
              <p className="mt-3 flex-1 text-[13px] leading-relaxed text-[var(--color-fg-dim)]">{s.what}</p>
              <div className="mt-4">
                <SectionLabel>use it to</SectionLabel>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {s.useCases.map((u, k) => (
                    <li key={k} className="flex gap-2 text-[12.5px] text-[var(--color-fg-dim)]"><span className="text-[var(--color-signal)]">›</span><span>{u}</span></li>
                  ))}
                </ul>
              </div>
              <Link to={s.path} className="mono mt-4 self-start text-[12px] text-[var(--color-signal)] hover:underline">open {s.label} →</Link>
            </Panel>
          </motion.div>
        ))}
      </div>

      <motion.div {...rise(SURFACES.length + 1)}>
        <Panel className="p-6">
          <SectionLabel>how it works — every surface, no exceptions</SectionLabel>
          <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 text-[13px] text-[var(--color-fg-dim)]">
            <Principle title="Human-in-the-loop">The agent pauses before any write; nothing is created until you approve the previewed change. Reads are free.</Principle>
            <Principle title="Evidence &amp; scoring">Every generated query is verified by execution; every run produces a scored receipt (see Run history).</Principle>
            <Principle title="Fully self-observable">Otto instruments itself with OpenTelemetry to the same SigNoz it manages (see Otto Ops).</Principle>
            <Principle title="Privacy by architecture">Only metadata (metric names, query shapes, aggregate stats) ever reaches the LLM — never raw log bodies or data values.</Principle>
          </div>
        </Panel>
      </motion.div>
    </div>
  );
}

function Principle({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mono text-[11px] uppercase tracking-wider text-[var(--color-fg)]">{title}</div>
      <p className="mt-1 leading-relaxed">{children}</p>
    </div>
  );
}
