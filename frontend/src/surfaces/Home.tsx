import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type ConnectStatus, type Svc } from '../lib/api.ts';
import { Panel, Badge, Dot, SectionLabel } from '../components/ui.tsx';

const rise = (i: number) => ({ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.05 * i, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const } });

const SURFACES = [
  { path: '/migrate', title: 'Dashboard migration', body: 'Translate a Grafana dashboard to SigNoz faithfully — deterministic for the mechanical parts, the agent for the tail. Every write behind your approval.', tag: 'the deep workflow', color: 'var(--color-signal)' },
  { path: '/slo', title: 'SLO copilot', body: 'Evidence-based reliability targets. Otto reads live traffic, proposes an achievable objective, and builds the SLI + error-budget dashboard and burn alert.', tag: 'reliability', color: 'var(--color-phosphor)' },
  { path: '/agent', title: 'AgentOtto 🕵️', body: 'A conversational teammate over your telemetry. Ask in plain English; Otto investigates traces, logs and metrics — and acts only after you confirm.', tag: 'the teammate', color: 'var(--color-cyan)' },
  { path: '/ops', title: 'Otto Ops', body: 'The tool that manages your observability is itself observable. Every run is a trace, every LLM call metered — dashboarded in the same SigNoz.', tag: 'self-observability', color: 'var(--color-warn)' },
] as const;

function ServiceChip({ s }: { s: Svc }) {
  const healthy = (s.errorRate ?? 0) <= 0.001;
  const color = healthy ? 'var(--color-phosphor)' : (s.errorRate ?? 0) > 0.05 ? 'var(--color-danger)' : 'var(--color-warn)';
  return (
    <div className="group flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-2)] px-2.5 py-1.5 transition-colors hover:border-[var(--color-line-2)]" title={`${(s.callRate ?? 0).toFixed(2)} req/s · ${((s.errorRate ?? 0) * 100).toFixed(1)}% err · p99 ${((s.p99Ns ?? 0) / 1e6).toFixed(0)}ms`}>
      <Dot color={color} />
      <span className="text-[12.5px] text-[var(--color-fg-dim)] group-hover:text-[var(--color-fg)]">{s.name}</span>
      <span className="mono text-[10px] text-[var(--color-fg-faint)]">{(s.callRate ?? 0).toFixed(1)}/s</span>
    </div>
  );
}

export function Home({ connect }: { connect?: ConnectStatus }) {
  const services = useQuery({ queryKey: ['services'], queryFn: api.services });
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-8">
      {/* hero */}
      <motion.header {...rise(0)} className="relative overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-panel)_50%,transparent)] px-9 py-11">
        <div className="scanline pointer-events-none absolute inset-x-0 top-0 h-px opacity-60" />
        <Badge color="var(--color-signal)">agentic copilot · self-hosted</Badge>
        <h1 className="font-display mt-4 max-w-3xl text-[42px] font-black leading-[1.02] tracking-tight text-[var(--color-fg)]">
          Bring the <span className="text-[var(--color-signal)]">agent</span> to your SigNoz.
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--color-fg-dim)]">
          One LangGraph engine — <span className="text-[var(--color-fg)]">analyze → propose → approve → apply → verify</span> — powering four surfaces over the live
          SigNoz MCP. Deterministic where it can be, agentic where it must be, and nothing written without your say-so.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <button onClick={() => navigate('/migrate')} className="mono inline-flex h-11 items-center gap-2 rounded-lg bg-[var(--color-signal)] px-5 text-sm font-semibold text-black transition-colors hover:bg-[var(--color-signal-deep)] hover:text-white">
            Start a migration →
          </button>
          <button onClick={() => navigate('/agent')} className="mono inline-flex h-11 items-center gap-2 rounded-lg border border-[var(--color-line-2)] px-5 text-sm text-[var(--color-fg)] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]">
            Ask the teammate
          </button>
        </div>
      </motion.header>

      {/* live instance strip */}
      <motion.div {...rise(1)}>
        <Panel className="flex flex-wrap items-center gap-x-10 gap-y-4 px-6 py-5">
          <div className="flex items-center gap-2.5">
            <Dot color={connect?.signoz.ok ? 'var(--color-phosphor)' : 'var(--color-danger)'} pulse={connect?.signoz.ok} />
            <SectionLabel>SigNoz instance</SectionLabel>
            <span className="mono text-[13px] text-[var(--color-fg)]">{connect?.signoz.ok ? `${connect.signoz.services} services live` : 'not connected'}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <Dot color={connect?.grafana.ok ? 'var(--color-phosphor)' : 'var(--color-fg-faint)'} />
            <SectionLabel>Grafana source</SectionLabel>
            <span className="mono text-[13px] text-[var(--color-fg-dim)]">{connect?.grafana.ok ? `${connect.grafana.count} dashboards` : 'optional'}</span>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            <SectionLabel>write policy</SectionLabel>
            <Badge color="var(--color-warn)">human-gated</Badge>
          </div>
        </Panel>
      </motion.div>

      {/* service map — Grafana source → SigNoz observed, Otto held apart */}
      <motion.div {...rise(2)}>
        <Panel className="p-6">
          <div className="flex items-center justify-between">
            <SectionLabel>service map · Grafana → SigNoz</SectionLabel>
            <div className="mono flex items-center gap-4 text-[11px] text-[var(--color-fg-faint)]">
              <span>{connect?.grafana.count ?? '—'} grafana dashboards</span>
              <span className="text-[var(--color-line-2)]">·</span>
              <span>{services.data?.observed.length ?? connect?.signoz.services ?? '—'} observed services</span>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-[1fr_auto_240px] items-stretch gap-6">
            {/* observed application services */}
            <div>
              <div className="mono mb-3 text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-faint)]">observed application</div>
              <div className="flex flex-wrap gap-2">
                {services.isLoading && <span className="mono text-[12px] text-[var(--color-fg-faint)]">discovering services…</span>}
                {services.data?.observed.map((s) => <ServiceChip key={s.name} s={s} />)}
              </div>
            </div>

            {/* divider */}
            <div className="w-px bg-[var(--color-line)]" />

            {/* Otto — the copilot, self-observed, kept separate */}
            <div className="flex flex-col rounded-xl border border-[color-mix(in_oklab,var(--color-signal)_35%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-signal)_6%,transparent)] p-4">
              <div className="mono mb-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-signal)]">the copilot</div>
              {services.data?.copilot ? (
                <>
                  <div className="flex items-center gap-2">
                    <Dot color="var(--color-signal)" pulse />
                    <span className="mono text-[14px] font-semibold text-[var(--color-fg)]">{services.data.copilot.name}</span>
                  </div>
                  <p className="mt-2 flex-1 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">Otto self-instruments and reports here too — but it's the tool, not your application. Kept out of the observed set on purpose.</p>
                  <button onClick={() => navigate('/ops')} className="mono mt-3 self-start text-[11px] text-[var(--color-signal)] hover:underline">view Otto Ops →</button>
                </>
              ) : (
                <p className="text-[12px] leading-relaxed text-[var(--color-fg-dim)]">Run the engine with <span className="mono text-[var(--color-fg)]">OTTO_OTEL=1</span> and Otto appears here as its own service — separate from the app it observes.</p>
              )}
            </div>
          </div>
        </Panel>
      </motion.div>

      {/* surfaces */}
      <div className="grid grid-cols-2 gap-4">
        {SURFACES.map((s, i) => (
          <motion.button key={s.path} {...rise(3 + i)} onClick={() => navigate(s.path)}
            className="group panel relative overflow-hidden px-6 py-6 text-left transition-transform hover:-translate-y-0.5">
            <span className="absolute inset-x-0 top-0 h-px opacity-0 transition-opacity group-hover:opacity-100" style={{ background: `linear-gradient(90deg, transparent, ${s.color}, transparent)` }} />
            <div className="flex items-center justify-between">
              <Badge color={s.color}>{s.tag}</Badge>
              <span className="text-[var(--color-fg-faint)] transition-transform group-hover:translate-x-1 group-hover:text-[var(--color-fg-dim)]">→</span>
            </div>
            <h3 className="font-display mt-4 text-[19px] font-bold text-[var(--color-fg)]">{s.title}</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-dim)]">{s.body}</p>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
