import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { SyncError } from '../lib/supabase';
import { Button, Input, Label, PasswordInput } from './ui';
import BrandMark from './BrandMark';
import CodeVerify from './CodeVerify';
import SocialAuthButtons from './SocialAuthButtons';
import { X } from 'lucide-react';

/**
 * In-app auth panel shown over the running app (the app stays visible behind it).
 * Fully self-contained: log-in and create-account modes plus Google sign-in,
 * so when it is `forced` the user can convert without ever leaving the screen.
 * A forced modal has no close affordance and ignores backdrop clicks.
 */
export default function AuthModal({
  open,
  forced = false,
  onClose,
  title,
  subtitle,
}: {
  open: boolean;
  forced?: boolean;
  onClose?: () => void;
  title?: string;
  subtitle?: string;
}) {
  const { login, register } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  // Sign-up becomes two steps once a code has been emailed.
  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState('');
  const [errorIsSetup, setErrorIsSetup] = useState(false);
  const [busy, setBusy] = useState(false);

  const emailValid = api.emailLooksValid(email);

  if (!open) return null;

  function showError(err: unknown) {
    setError((err as Error).message);
    setErrorIsSetup(err instanceof SyncError && err.kind === 'setup');
  }

  function switchMode(next: 'login' | 'register') {
    setMode(next);
    setStep('form');
    setError('');
    setErrorIsSetup(false);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setErrorIsSetup(false);
    if (mode === 'register') {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (!emailValid) {
        setError('Enter a valid email address.');
        return;
      }
      if (!acceptPrivacy || !acceptTerms) {
        setError('Accept the Privacy Policy and Terms of Use to continue.');
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        // Refuse a duplicate before spending an email on it — `register` checks
        // too, but only after the code has been typed back.
        if (!(await api.emailAvailable(email))) {
          setError('An account with this email already exists. Log in instead, or use a different address.');
          return;
        }
        const verify = await api.emailVerificationMode();
        if (verify === 'required') {
          // A code is on its way; the account is created on the verify step.
          await api.startEmailVerification(email);
          setStep('verify');
          return;
        }
        if (verify === 'unavailable') {
          // Refuse rather than create an account on an unproven address.
          setError(
            "We can't email you a confirmation code right now, so your account wasn't created. " +
              'This is nothing you did wrong — please try again in a few minutes.',
          );
          setErrorIsSetup(true);
          return;
        }
        // Verification deliberately switched off for this build.
        await register(name, email, password, 'standard');
      }
      onClose?.();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(code: string) {
    setError('');
    setErrorIsSetup(false);
    setBusy(true);
    try {
      const ticket = await api.verifyEmailCode(email, code);
      await register(name, email, password, 'standard', ticket);
      onClose?.();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onResend(): Promise<boolean> {
    setError('');
    setErrorIsSetup(false);
    setBusy(true);
    try {
      await api.startEmailVerification(email);
      return true;
    } catch (err) {
      showError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4">
      {/* Backdrop: app remains visible behind the blur. Inert when forced;
          otherwise a click dismisses. Kept as a plain div so a forced gate
          exposes no "close" affordance to assistive tech. */}
      <div
        aria-hidden="true"
        onClick={() => !forced && onClose?.()}
        className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] ${forced ? 'cursor-default' : 'cursor-pointer'}`}
      />

      <div className="relative z-10 max-h-full w-full max-w-[340px] overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-[0_20px_60px_-12px_rgba(0,0,0,0.6)]">
        {!forced && onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 p-1 text-muted transition hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}

        <div className="mb-3 flex items-center gap-2">
          <BrandMark className="h-8 w-8" />
          <span className="font-mono text-lg font-bold tracking-[0.15em]">Comitra</span>
        </div>
        <h2 className="text-lg font-bold tracking-tight text-ink">
          {step === 'verify'
            ? 'Confirm your email'
            : (title ?? (mode === 'login' ? 'Log in to keep your goals' : 'Create your account'))}
        </h2>
        <p className="mb-4 mt-0.5 text-xs text-muted">
          {step === 'verify'
            ? 'One last step, then your account is created.'
            : (subtitle ?? 'Sign in or sign up to save your goals for good.')}
        </p>

        {step === 'verify' ? (
          <CodeVerify
            destination={api.normalizeEmail(email)}
            channel="email"
            busy={busy}
            error={error}
            errorIsSetup={errorIsSetup}
            submitLabel="Verify & create account"
            onVerify={onVerify}
            onResend={onResend}
            onBack={() => {
              setStep('form');
              setError('');
              setErrorIsSetup(false);
            }}
          />
        ) : (
          <>
        <form onSubmit={onSubmit} className="space-y-3">
          {mode === 'register' && (
            <div>
              <Label>Display name</Label>
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex Operator"
              />
            </div>
          )}
          <div>
            <Label>Email</Label>
            <Input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@domain.com"
            />
            {mode === 'register' && (
              <p className="mt-1.5 text-[11px] text-muted">
                We'll email you a 6-digit code to confirm it's yours.
              </p>
            )}
          </div>
          <div>
            <Label>Password</Label>
            <PasswordInput
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {mode === 'register' && (
            <div className="space-y-1.5 pt-0.5">
              <label className="flex cursor-pointer items-start gap-2 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={acceptPrivacy}
                  onChange={(e) => setAcceptPrivacy(e.target.checked)}
                  className="mt-0.5 accent-[color:rgb(var(--c-accent))]"
                />
                <span>
                  I accept the{' '}
                  <Link to="/privacy" className="text-accent hover:underline">
                    Privacy Policy
                  </Link>
                  .
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(e.target.checked)}
                  className="mt-0.5 accent-[color:rgb(var(--c-accent))]"
                />
                <span>
                  I accept the{' '}
                  <Link to="/terms" className="text-accent hover:underline">
                    Terms of Use
                  </Link>
                  .
                </span>
              </label>
            </div>
          )}

          {error && <p className="font-mono text-xs text-danger">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </Button>
        </form>

        <SocialAuthButtons onDone={() => onClose?.()} />

        <p className="mt-4 text-center text-xs text-muted">
          {mode === 'login' ? (
            <>
              No account?{' '}
              <button type="button" onClick={() => switchMode('register')} className="text-accent hover:underline">
                Create one
              </button>
            </>
          ) : (
            <>
              Already registered?{' '}
              <button type="button" onClick={() => switchMode('login')} className="text-accent hover:underline">
                Log in
              </button>
            </>
          )}
        </p>
          </>
        )}
      </div>
    </div>
  );
}
