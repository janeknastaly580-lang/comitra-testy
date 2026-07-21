import { useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'outline';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent font-semibold hover:brightness-110 active:brightness-95',
  danger: 'bg-danger text-on-accent font-semibold hover:brightness-110',
  outline: 'border border-line text-ink hover:border-accent hover:text-accent bg-transparent',
  ghost: 'text-muted hover:text-ink bg-transparent',
};

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: { variant?: Variant } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-sm tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className = '',
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl border border-line/60 bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_28px_-16px_rgba(16,24,40,0.14)] ${
        onClick ? 'cursor-pointer transition hover:shadow-[0_2px_6px_rgba(16,24,40,0.06),0_16px_34px_-16px_rgba(16,24,40,0.20)]' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-widest text-muted">
      {children}
    </label>
  );
}

const fieldBase =
  'w-full rounded-xl border border-line bg-elevated px-3.5 py-3 text-sm text-ink placeholder:text-muted/60 outline-none transition focus:border-accent';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldBase} ${props.className ?? ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${fieldBase} resize-none ${props.className ?? ''}`} />;
}

/** Password field with an eye toggle that reveals/hides the typed value. */
export function PasswordInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>,
) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={show ? 'text' : 'password'}
        className={`${fieldBase} pr-11 ${props.className ?? ''}`}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        tabIndex={-1}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted transition hover:text-ink"
      >
        {show ? (
          // Eye-off
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path
              d="M3 3l18 18M10.6 10.7a2 2 0 002.8 2.8M9.9 5.1A9.5 9.5 0 0112 5c5 0 9 4 10 7a12.4 12.4 0 01-3.2 4.2M6.1 6.1A12.6 12.6 0 002 12c1 3 5 7 10 7 1.4 0 2.7-.3 3.9-.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          // Eye-open
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${fieldBase} appearance-none ${props.className ?? ''}`}>
      {props.children}
    </select>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'active' | 'danger' | 'warn';
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-elevated text-muted',
    accent: 'bg-accent/10 text-accent',
    active: 'bg-active/10 text-active',
    danger: 'bg-danger/10 text-danger',
    warn: 'bg-warn/10 text-warn',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function PremiumTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-active/50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-active">
      ◆ Pro
    </span>
  );
}
