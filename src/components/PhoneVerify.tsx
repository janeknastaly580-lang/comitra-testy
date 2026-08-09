import { useEffect, useState } from 'react';
import { Button, Input, Label } from './ui';

/**
 * The "enter the code we texted you" step, shared by every place that confirms
 * a phone number: sign-up (Register, AuthModal) and the judge invite.
 *
 * It owns the two things that are identical everywhere — the six-digit input and
 * the resend cooldown — so those are not re-implemented per screen. Everything
 * that differs (what happens on success, how errors are worded) stays with the
 * caller.
 *
 * The code itself is never held anywhere but this component's state: it goes
 * straight to `onVerify` and is not stored, logged or passed to a parent's form
 * state.
 */

/** Seconds before another code may be requested. Matches the server's cooldown. */
const RESEND_COOLDOWN = 60;

export default function PhoneVerify({
  phone,
  busy,
  error,
  errorIsSetup = false,
  submitLabel,
  onVerify,
  onResend,
  onBack,
  backLabel = 'Change number',
}: {
  /** The number a code was just texted to, shown so a typo is obvious. */
  phone: string;
  busy: boolean;
  /** Message to show under the input; the caller owns the wording. */
  error: string;
  /** Renders the error as a server-setup problem rather than a user mistake. */
  errorIsSetup?: boolean;
  submitLabel: string;
  onVerify: (code: string) => void | Promise<void>;
  /** Resolve `true` when a fresh code really went out; only then does the cooldown restart. */
  onResend: () => Promise<boolean>;
  onBack: () => void;
  backLabel?: string;
}) {
  const [otp, setOtp] = useState('');
  // Starts running: reaching this step means a code has just been sent.
  const [resendIn, setResendIn] = useState(RESEND_COOLDOWN);

  // The dependency is the boolean, not `resendIn` itself: depending on the
  // number would tear down and recreate the interval on every tick, so the
  // remaining second would restart each time and the countdown would crawl.
  const cooldownRunning = resendIn > 0;
  useEffect(() => {
    if (!cooldownRunning) return;
    const id = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldownRunning]);

  async function resend() {
    if (resendIn > 0 || busy) return;
    if (await onResend()) setResendIn(RESEND_COOLDOWN);
  }

  const ready = otp.length === 6;

  return (
    <div>
      <Label>Verification code</Label>
      <Input
        value={otp}
        onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="123456"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        className="text-center text-lg tracking-[0.4em]"
      />
      <p className="mt-1.5 text-[11px] text-muted">
        We texted a 6-digit code to <span className="font-semibold text-ink">{phone}</span>. It expires in 5
        minutes.
      </p>

      {error && (
        <div className="mt-3 rounded-xl border border-danger/40 bg-danger/5 p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-danger">
            {errorIsSetup ? "Server isn't ready" : "Couldn't verify"}
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink">{error}</p>
        </div>
      )}

      <Button className="mt-3 w-full" disabled={busy || !ready} onClick={() => onVerify(otp)}>
        {busy ? 'Checking…' : submitLabel}
      </Button>

      <div className="mt-3 flex items-center justify-between text-[12px]">
        <button
          type="button"
          className="text-accent hover:underline disabled:text-muted disabled:no-underline"
          disabled={busy || resendIn > 0}
          onClick={resend}
        >
          {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
        </button>
        <button type="button" className="text-muted hover:text-ink hover:underline" disabled={busy} onClick={onBack}>
          {backLabel}
        </button>
      </div>
    </div>
  );
}
