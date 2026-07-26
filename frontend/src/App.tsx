import { useQuery } from '@tanstack/react-query';
import { Routes, Route, NavLink, Link } from 'react-router-dom';
import { api } from './lib/api.ts';
import { cx, Dot } from './components/ui.tsx';
import { Wordmark } from './components/Logo.tsx';
import { SURFACES } from './surfaces/registry.ts';
import { Home } from './surfaces/Home.tsx';
import { Audit } from './surfaces/Audit.tsx';
import { Migrate } from './surfaces/Migrate.tsx';
import { Slo } from './surfaces/Slo.tsx';
import { Ask } from './surfaces/Ask.tsx';
import { Runs } from './surfaces/Runs.tsx';
import { Ops } from './surfaces/Ops.tsx';
import { About } from './surfaces/About.tsx';

export function App() {
  const connect = useQuery({ queryKey: ['connect'], queryFn: api.connect, refetchInterval: 20_000 });
  const signozOk = connect.data?.signoz.ok;
  const grafanaOk = connect.data?.grafana.ok;

  return (
    <div className="otto-canvas otto-grain flex min-h-screen">
      {/* ── sidebar ─────────────────────────────────────────── */}
      <aside className="sticky top-0 flex h-screen w-[248px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-ink-2)_80%,transparent)] px-4 py-5 backdrop-blur-sm">
        <Link to="/" className="px-2"><Wordmark /></Link>

        <nav className="mt-9 flex flex-col gap-1">
          {SURFACES.map((n) => (
            <NavLink key={n.id} to={n.path} end={n.path === '/'}
              className={({ isActive }) => cx(
                'group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all',
                isActive ? 'bg-[var(--color-panel-2)]' : 'hover:bg-[color-mix(in_oklab,var(--color-panel)_60%,transparent)]',
              )}>
              {({ isActive }) => (
                <>
                  {isActive && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-[var(--color-signal)]" />}
                  {n.emoji
                    ? <span className="w-[18px] text-center text-[15px] leading-none">{n.emoji}</span>
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                        stroke={isActive ? 'var(--color-signal)' : 'var(--color-fg-faint)'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                        className="transition-colors group-hover:[stroke:var(--color-fg-dim)]"><path d={n.icon} /></svg>}
                  <div className="leading-tight">
                    <div className={cx('text-[14px] font-medium', isActive ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-dim)]')}>{n.label}</div>
                    <div className="mono text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">{n.hint}</div>
                  </div>
                </>
              )}
            </NavLink>
          ))}
          <NavLink to="/about"
            className={({ isActive }) => cx('mt-1 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all',
              isActive ? 'bg-[var(--color-panel-2)]' : 'hover:bg-[color-mix(in_oklab,var(--color-panel)_60%,transparent)]')}>
            <span className="w-[18px] text-center text-[var(--color-fg-faint)]">ⓘ</span>
            <div className="text-[14px] font-medium text-[var(--color-fg-dim)]">About</div>
          </NavLink>
        </nav>

        <div className="mt-auto flex flex-col gap-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-ink-2)] p-3">
          <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-faint)]">connection</div>
          <ConnRow label="SigNoz" ok={signozOk} detail={connect.data?.signoz.services != null ? `${connect.data.signoz.services} services` : undefined} loading={connect.isLoading} />
          <ConnRow label="Grafana" ok={grafanaOk} detail={connect.data?.grafana.count != null ? `${connect.data.grafana.count} dashboards` : 'optional'} loading={connect.isLoading} />
        </div>
      </aside>

      {/* ── content ─────────────────────────────────────────── */}
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-[1120px] px-8 py-8">
          <Routes>
            <Route path="/" element={<Home connect={connect.data} />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/migrate" element={<Migrate />} />
            <Route path="/slo" element={<Slo />} />
            <Route path="/agent" element={<Ask />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/ops" element={<Ops />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function ConnRow({ label, ok, detail, loading }: { label: string; ok?: boolean; detail?: string; loading?: boolean }) {
  const color = loading ? 'var(--color-fg-faint)' : ok ? 'var(--color-phosphor)' : 'var(--color-danger)';
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Dot color={color} pulse={ok} />
        <span className="text-[13px] text-[var(--color-fg-dim)]">{label}</span>
      </div>
      <span className="mono text-[11px] text-[var(--color-fg-faint)]">{loading ? '···' : detail ?? (ok ? 'ok' : 'down')}</span>
    </div>
  );
}
