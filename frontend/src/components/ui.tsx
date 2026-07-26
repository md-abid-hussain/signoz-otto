import type { ReactNode, ButtonHTMLAttributes } from 'react';

export function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Panel({ children, className, glow }: { children: ReactNode; className?: string; glow?: boolean }) {
  return (
    <div className={cx('panel', className)} style={glow ? { boxShadow: 'var(--shadow-glow)' } : undefined}>
      {children}
    </div>
  );
}

export function Button({
  children, variant = 'ghost', size = 'md', className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline' | 'danger'; size?: 'sm' | 'md' }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed select-none';
  const sizes = { sm: 'text-[13px] px-3 h-8', md: 'text-sm px-4 h-10' };
  const variants = {
    primary: 'text-black bg-[var(--color-signal)] hover:bg-[var(--color-signal-deep)] hover:text-white shadow-[0_6px_20px_-8px_var(--color-signal)]',
    ghost: 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] hover:bg-[var(--color-panel-2)]',
    outline: 'text-[var(--color-fg)] border border-[var(--color-line-2)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]',
    danger: 'text-[var(--color-danger)] border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] hover:bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)]',
  };
  return (
    <button className={cx(base, sizes[size], variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}

export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span className={cx('inline-block h-2 w-2 rounded-full', pulse && 'pulse')} style={{ color, background: color }} />
  );
}

export function Badge({ children, color = 'var(--color-fg-dim)', tone = 'soft' }: { children: ReactNode; color?: string; tone?: 'soft' | 'solid' }) {
  return (
    <span
      className="mono inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] uppercase tracking-wider"
      style={
        tone === 'solid'
          ? { color: '#000', background: color }
          : { color, background: `color-mix(in oklab, ${color} 13%, transparent)`, border: `1px solid color-mix(in oklab, ${color} 30%, transparent)` }
      }
    >
      {children}
    </span>
  );
}

export function Stat({ label, value, unit, accent }: { label: string; value: ReactNode; unit?: string; accent?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-faint)]">{label}</div>
      <div className="mono flex items-baseline gap-1 text-2xl font-semibold tnum" style={{ color: accent ?? 'var(--color-fg)' }}>
        {value}
        {unit && <span className="text-sm text-[var(--color-fg-dim)]">{unit}</span>}
      </div>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-faint)]">{children}</div>;
}

export function Select({ value, onChange, options, placeholder, disabled, label }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string; hint?: string }[];
  placeholder?: string; disabled?: boolean; label?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      {label && <span className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-faint)]">{label}</span>}
      <div className="relative">
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
          className="mono h-10 w-full appearance-none rounded-lg border border-[var(--color-line-2)] bg-[var(--color-ink-2)] pl-3 pr-9 text-[13px] text-[var(--color-fg)] transition-colors focus:border-[var(--color-signal)] disabled:opacity-40">
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}{o.hint ? `  ·  ${o.hint}` : ''}</option>)}
        </select>
        <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-fg-faint)" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
      </div>
    </label>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-[var(--color-fg-dim)]">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-line-2)] border-t-[var(--color-signal)]" />
      {label && <span className="mono text-[13px]">{label}</span>}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="mono rounded-lg border border-dashed border-[var(--color-line-2)] px-4 py-8 text-center text-[13px] text-[var(--color-fg-faint)]">{children}</div>;
}
