import { useState, useRef, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api, type PendingWrite } from '../lib/api.ts';
import { Badge, Dot, cx } from '../components/ui.tsx';
import { InfoButton } from '../components/InfoButton.tsx';
import { OttoMark } from '../components/Logo.tsx';

interface Msg { role: 'user' | 'otto' | 'pending'; text?: string; pending?: PendingWrite[] }

const SUGGESTIONS = [
  'Which services have the highest error rate in the last hour?',
  'What is the p95 latency of the checkout service?',
  'Which services emit no traces right now?',
  'Summarize traffic across the frontend services.',
];

const newThread = () => `web-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;

export function Ask() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [skills, setSkills] = useState<number>();
  const [thread, setThread] = useState(newThread); // stable per conversation → agent remembers the turns
  const scroller = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (b: { question?: string; approve?: boolean }) => api.ask({ ...b, threadId: thread }),
    onSuccess: (r) => {
      setSkills(r.skillsLoaded);
      // drop any prior pending card (it's been resolved), then append the result
      setMsgs((m) => {
        const base = m.filter((x) => x.role !== 'pending');
        return r.pending?.length ? [...base, { role: 'pending', pending: r.pending }] : [...base, { role: 'otto', text: r.answer ?? '(no response)' }];
      });
    },
    onError: (e) => setMsgs((m) => [...m.filter((x) => x.role !== 'pending'), { role: 'otto', text: `⚠ ${(e as Error).message}` }]),
  });

  const resetChat = () => { setThread(newThread()); setMsgs([]); ask.reset(); };

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }, [msgs, ask.isPending]);

  const send = (q: string) => {
    if (!q.trim() || ask.isPending) return;
    setMsgs((m) => [...m, { role: 'user', text: q }]);
    setInput('');
    ask.mutate({ question: q });
  };
  const respond = (approve: boolean) => {
    if (ask.isPending) return;
    setMsgs((m) => [...m.filter((x) => x.role !== 'pending'), { role: 'user', text: approve ? '✓ Approved' : '✕ Rejected' }]);
    ask.mutate({ approve });
  };

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <Badge color="var(--color-cyan)">the teammate</Badge>
          <div className="mt-3 flex items-center gap-2.5">
            <span className="text-[26px] leading-none">🕵️</span>
            <h1 className="font-display text-[28px] font-black tracking-tight text-[var(--color-fg)]">AgentOtto</h1>
            <InfoButton surfaceId="agent" />
          </div>
          <p className="mt-1.5 text-[14px] text-[var(--color-fg-dim)]">A deepagents teammate over your live SigNoz — full MCP toolset + skills. Reads freely; every write passes the approval gate.</p>
        </div>
        <div className="flex items-center gap-3">
          {msgs.length > 0 && (
            <button onClick={resetChat} className="mono rounded-lg border border-[var(--color-line-2)] px-3 py-1.5 text-[11px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-cyan)] hover:text-[var(--color-fg)]">+ new chat</button>
          )}
          <div className="flex items-center gap-2">
            <Dot color="var(--color-phosphor)" pulse />
            <span className="mono text-[11px] text-[var(--color-fg-faint)]">{skills != null ? `${skills} skills loaded` : 'read-only'}</span>
          </div>
        </div>
      </div>

      <div ref={scroller} className="panel flex-1 overflow-y-auto p-6">
        {msgs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
            <div className="opacity-80"><OttoMark size={44} /></div>
            <div>
              <div className="font-display text-[18px] font-bold text-[var(--color-fg)]">Ask about your telemetry.</div>
              <div className="mono mt-1 text-[12px] text-[var(--color-fg-faint)]">discovery-first · resource-attribute aware · observations, not root cause</div>
            </div>
            <div className="grid max-w-xl grid-cols-2 gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-lg border border-[var(--color-line)] px-3 py-2.5 text-left text-[12.5px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-cyan)] hover:text-[var(--color-fg)]">{s}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {msgs.map((m, i) => m.role === 'pending'
              ? <PendingCard key={i} writes={m.pending ?? []} onApprove={() => respond(true)} onReject={() => respond(false)} busy={ask.isPending} />
              : <Bubble key={i} msg={m} />)}
            {ask.isPending && (
              <div className="flex items-center gap-3">
                <OttoMark size={22} />
                <div className="mono flex items-center gap-1.5 text-[13px] text-[var(--color-fg-faint)]">
                  investigating<span className="inline-flex gap-0.5"><Dot color="var(--color-cyan)" /></span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-center gap-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask Otto about traces, logs, metrics…"
          className="mono h-12 flex-1 rounded-xl border border-[var(--color-line-2)] bg-[var(--color-ink-2)] px-4 text-[13.5px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-cyan)]" />
        <button type="submit" disabled={ask.isPending || !input.trim()}
          className="mono inline-flex h-12 items-center gap-2 rounded-xl bg-[var(--color-signal)] px-5 text-sm font-semibold text-black transition-colors hover:bg-[var(--color-signal-deep)] hover:text-white disabled:opacity-40">
          Send →
        </button>
      </form>
    </div>
  );
}

function PendingCard({ writes, onApprove, onReject, busy }: { writes: PendingWrite[]; onApprove: () => void; onReject: () => void; busy: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
      <div className="mt-0.5 shrink-0"><OttoMark size={22} /></div>
      <div className="w-full max-w-[86%] rounded-2xl border border-[color-mix(in_oklab,var(--color-warn)_40%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-warn)_7%,transparent)] px-4 py-3.5">
        <div className="flex items-center gap-2"><Dot color="var(--color-warn)" /><span className="mono text-[11px] uppercase tracking-wider text-[var(--color-warn)]">approval required · gated write</span></div>
        <div className="mt-3 flex flex-col gap-2.5">
          {writes.map((w, i) => (
            <div key={i} className="rounded-lg border border-[var(--color-line)] bg-[var(--color-ink-2)] p-3">
              <div className="mono text-[12.5px] text-[var(--color-fg)]">{w.tool}</div>
              {w.description && <div className="mt-1 text-[12px] text-[var(--color-fg-dim)]">{w.description}</div>}
              {w.args != null && (
                <pre className="mono mt-2 max-h-40 overflow-auto rounded bg-[var(--color-ink)] p-2 text-[11px] leading-relaxed text-[var(--color-fg-dim)]">{JSON.stringify(w.args, null, 2).slice(0, 1200)}</pre>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <button disabled={busy} onClick={onApprove} className="mono inline-flex h-9 items-center rounded-lg bg-[var(--color-signal)] px-4 text-[13px] font-semibold text-black transition-colors hover:bg-[var(--color-signal-deep)] hover:text-white disabled:opacity-40">Approve &amp; run ✓</button>
          <button disabled={busy} onClick={onReject} className="mono inline-flex h-9 items-center rounded-lg border border-[var(--color-line-2)] px-4 text-[13px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-40">Reject</button>
        </div>
      </div>
    </motion.div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  const isUser = msg.role === 'user';
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
      className={cx('flex gap-3', isUser && 'flex-row-reverse')}>
      {!isUser && <div className="mt-0.5 shrink-0"><OttoMark size={22} /></div>}
      <div className={cx('max-w-[76%] rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed',
        isUser
          ? 'rounded-br-md border border-[color-mix(in_oklab,var(--color-signal)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-signal)_15%,var(--color-panel))] text-[var(--color-fg)]'
          : 'rounded-bl-md border border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-panel)_60%,transparent)] text-[var(--color-fg-dim)]')}>
        <Markdown text={msg.text ?? ''} />
      </div>
    </motion.div>
  );
}

/** inline markdown: **bold**, `code` */
function inline(s: string) {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i} className="font-semibold text-[var(--color-fg)]">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={i} className="mono rounded bg-[var(--color-ink)] px-1.5 py-0.5 text-[12px] text-[var(--color-signal)]">{part.slice(1, -1)}</code>;
    return part;
  });
}

const rowCells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');

/** block markdown: tables, bullets, paragraphs (+ inline bold/code) */
function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // fenced code block ```lang … ``` (was rendering line-by-line before)
    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, '').trim();
      let j = i + 1;
      const code: string[] = [];
      while (j < lines.length && !/^\s*```/.test(lines[j]!)) { code.push(lines[j]!); j++; }
      blocks.push(
        <div key={i} className="my-1.5 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-ink)]">
          {lang && <div className="mono border-b border-[var(--color-line)] px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">{lang}</div>}
          <pre className="mono overflow-x-auto px-3 py-2.5 text-[12px] leading-relaxed text-[var(--color-fg-dim)]"><code>{code.join('\n')}</code></pre>
        </div>,
      );
      i = j + 1; // past the closing fence
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1]!)) {
      let j = i;
      const rows: string[] = [];
      while (j < lines.length && isRow(lines[j]!)) { rows.push(lines[j]!); j++; }
      const header = rowCells(rows[0]!);
      const body = rows.slice(2).map(rowCells);
      const align: ('right' | 'left')[] = rowCells(rows[1]!).map((c) => (c.endsWith(':') ? 'right' : 'left'));
      blocks.push(
        <div key={i} className="my-1 overflow-x-auto rounded-lg border border-[var(--color-line)]">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--color-line)] bg-[var(--color-ink-2)]">
                {header.map((h, k) => <th key={k} className="mono px-3 py-2 text-[10.5px] uppercase tracking-wider text-[var(--color-fg-faint)]" style={{ textAlign: align[k] ?? 'left' }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-b border-[var(--color-line)] last:border-0">
                  {r.map((c, ci) => <td key={ci} className="px-3 py-2 text-[var(--color-fg-dim)] tnum" style={{ textAlign: align[ci] ?? 'left' }}>{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j;
      continue;
    }
    if (line.trim()) {
      const t = line.trim();
      const bullet = /^[-*•]\s/.test(t);
      const heading = /^#{1,3}\s/.test(t);
      blocks.push(
        heading
          ? <div key={i} className="mt-1 font-display text-[15px] font-bold text-[var(--color-fg)]">{inline(t.replace(/^#{1,3}\s/, ''))}</div>
          : <div key={i} className={bullet ? 'flex gap-2 pl-1' : ''}>{bullet && <span className="text-[var(--color-signal)]">·</span>}<span>{inline(bullet ? t.replace(/^[-*•]\s/, '') : line)}</span></div>,
      );
    }
    i++;
  }
  return <div className="flex flex-col gap-1.5">{blocks}</div>;
}
