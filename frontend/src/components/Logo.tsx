export function OttoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      {/* observatory reticle */}
      <circle cx="16" cy="16" r="13" stroke="var(--color-line-2)" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="7.5" stroke="color-mix(in oklab, var(--color-signal) 60%, transparent)" strokeWidth="1.5" />
      <path d="M16 1v6M16 25v6M1 16h6M25 16h6" stroke="var(--color-fg-faint)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="16" r="3" fill="var(--color-signal)" />
      <circle cx="24.5" cy="7.5" r="2" fill="var(--color-phosphor)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <OttoMark />
      <div className="leading-none">
        <div className="font-display text-[19px] font-extrabold tracking-tight text-[var(--color-fg)]">otto</div>
        <div className="mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--color-fg-faint)]">signoz copilot</div>
      </div>
    </div>
  );
}
