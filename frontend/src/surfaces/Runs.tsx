import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api, type RunRecord } from '../lib/api.ts';
import { Panel, Badge, Dot, Spinner, EmptyHint } from '../components/ui.tsx';
import { InfoButton } from '../components/InfoButton.tsx';

const ago = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function Runs() {
  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs, refetchInterval: 10_000 });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Badge color="var(--color-warn)">receipts</Badge>
        <div className="mt-3 flex items-center gap-2.5"><h1 className="font-display text-[28px] font-black tracking-tight text-[var(--color-fg)]">Run history</h1><InfoButton surfaceId="runs" /></div>
        <p className="mt-1.5 max-w-2xl text-[14px] text-[var(--color-fg-dim)]">Every applied migration and SLO — what Otto did, scored and linked. Nothing happens that isn't recorded and approved. (Also traced end-to-end in Otto Ops.)</p>
      </div>

      {runs.isLoading && <Panel className="p-6"><Spinner label="loading receipts…" /></Panel>}
      {runs.data && runs.data.runs.length === 0 && (
        <EmptyHint>No runs yet. Apply a migration or an SLO and it'll appear here as a scored receipt.</EmptyHint>
      )}

      <div className="flex flex-col gap-3">
        {runs.data?.runs.map((r, i) => <Row key={r.id} r={r} i={i} />)}
      </div>
    </div>
  );
}

function Row({ r, i }: { r: RunRecord; i: number }) {
  const color = r.playbook === 'migration' ? 'var(--color-signal)' : 'var(--color-phosphor)';
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03, duration: 0.35 }}>
      <Panel className="flex items-center gap-5 px-6 py-4">
        <Dot color={color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <Badge color={color}>{r.playbook}</Badge>
            <span className="truncate text-[14px] font-medium text-[var(--color-fg)]">{r.title}</span>
          </div>
          <div className="mono mt-1 text-[12px] text-[var(--color-fg-dim)]">{r.summary}</div>
        </div>
        <div className="hidden items-center gap-5 md:flex">
          {Object.entries(r.stats).slice(0, 3).map(([k, v]) => (
            <div key={k} className="text-right">
              <div className="mono text-[13px] tabular-nums text-[var(--color-fg)]">{typeof v === 'number' ? v.toLocaleString() : v}</div>
              <div className="mono text-[9.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">{k}</div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="mono text-[11px] text-[var(--color-fg-faint)]">{ago(r.at)}</span>
          {r.webUrl && <a href={r.webUrl} target="_blank" rel="noreferrer" className="mono text-[12px] text-[var(--color-signal)] hover:underline">open ↗</a>}
        </div>
      </Panel>
    </motion.div>
  );
}
