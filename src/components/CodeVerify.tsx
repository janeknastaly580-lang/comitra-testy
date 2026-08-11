import { useEffect, useState } from 'react';
import { Button, Input, Label } from './ui';

/**
 * The "enter the code we sent you" step, shared by every place that confirms a
 * contact: sign-up (Register, AuthModal), which sends the code by EMAIL, and
 * the judge invite, which still sends it by TEXT.
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

/**
 * `expiresInMinutes` mirrors the server's own TTL per channel — email is
 * `CODE_TTL_MS` in server/src/email/verify.js, SMS the one in
 * server/src/twilio/verify.js. They are not the same number, so the wording
 * cannot be shared: promising five minutes on a code that lives seven (or the
 * reverse) is worse than saying nothing.
 */
const CHANNEL = {
  email: { sent: 'We emailed a 6-digit code to', back: 'Change email', expiresInMinutes: 7 },
  sms: { sent: 'We texted a 6-digit code to', back: 'Change number', expiresInMinutes: 5 },
} as const;

export default function CodeVerify({
  destination,
  channel = 'email',
  busy,
  error,
  errorIsSetup = false,
  submitLabel,
  onVerify,
  onResend,
  onBack,
  backLabel,
}: {
  /** Where the code was just sent, shown so a typo is obvious. */
  destination: string;
  /** How it was sent — only changes the wording. */
  channel?: keyof typeof CHANNEL;
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

  const copy = CHANNEL[channel];
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
        {copy.sent} <span className="font-semibold text-ink">{destination}</span>. It expires in{' '}
        {copy.expiresInMinutes} minutes.
      </p>
      {channel === 'email' && (
        <p className="mt-1 text-[11px] text-muted">Not there? Check your spam folder.</p>
      )}

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
          {backLabel ?? copy.back}
        </button>
      </div>
    </div>
  );
}
