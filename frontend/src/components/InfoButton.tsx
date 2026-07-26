import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SURFACES } from '../surfaces/registry.ts';
import { SectionLabel } from './ui.tsx';

/** an "ⓘ" button that opens a modal describing the current surface (in-context help). */
export function InfoButton({ surfaceId }: { surfaceId: string }) {
  const [open, setOpen] = useState(false);
  const meta = SURFACES.find((s) => s.id === surfaceId);
  if (!meta) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="What is this?"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--color-line-2)] text-[13px] text-[var(--color-fg-faint)] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]">ⓘ</button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.6)] p-6 backdrop-blur-sm">
            <motion.div initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="panel w-full max-w-lg p-7" style={{ boxShadow: 'var(--shadow-glow)' }}>
              <div className="flex items-center gap-2.5">
                {meta.emoji && <span className="text-[20px]">{meta.emoji}</span>}
                <span className="font-display text-[20px] font-bold text-[var(--color-fg)]">{meta.label}</span>
                <span className="mono ml-auto text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">{meta.hint}</span>
              </div>
              <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--color-fg-dim)]">{meta.what}</p>
              <div className="mt-5">
                <SectionLabel>use it to</SectionLabel>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {meta.useCases.map((u, k) => (
                    <li key={k} className="flex gap-2 text-[13px] text-[var(--color-fg-dim)]"><span className="text-[var(--color-signal)]">›</span><span>{u}</span></li>
                  ))}
                </ul>
              </div>
              <button onClick={() => setOpen(false)} className="mono mt-6 h-9 rounded-lg border border-[var(--color-line-2)] px-4 text-[13px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-fg)]">Got it</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
