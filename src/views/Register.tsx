import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { SyncError } from '../lib/supabase';
import CodeVerify from '../components/CodeVerify';
import { Button, Input, Label, PasswordInput } from '../components/ui';

export default function Register() {
  const { register, user } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState('');
  // A server-setup failure is not the new user's to fix, so it is worded as
  // "the server isn't ready" rather than "you got the code wrong".
  const [errorIsSetup, setErrorIsSetup] = useState(false);
  const [busy, setBusy] = useState(false);

  const emailValid = api.emailLooksValid(email);
  const canSubmit = acceptPrivacy && acceptTerms && emailValid;

  function showError(err: unknown) {
    setError((err as Error).message);
    setErrorIsSetup(err instanceof SyncError && err.kind === 'setup');
  }

  /**
   * Create the account. `ticket` is the backend's receipt for the emailed code;
   * the server refuses a sign-up without one wherever verification is on, so an
   * address cannot be claimed by someone who never opened its inbox.
   */
  async function createAccount(ticket?: string) {
    await register(name, email, password, 'standard', ticket);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setErrorIsSetup(false);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!emailValid) {
      setError('Enter a valid email address.');
      return;
    }
    if (!acceptPrivacy || !acceptTerms) {
      setError('You must accept the Privacy Policy and the Terms of Use to continue.');
      return;
    }
    setBusy(true);
    try {
      // Refuse a duplicate HERE, not after the code round-trip: `register` also
      // checks, but it runs only once the six digits are typed back, so the
      // person would wait for an email just to be told the address was taken —
      // and the send would be wasted.
      if (!(await api.emailAvailable(email))) {
        setError('An account with this email already exists. Log in instead, or use a different address.');
        return;
      }
      const mode = await api.emailVerificationMode();
      if (mode === 'required') {
        // The account is NOT created here. It is created in onVerify, once the
        // code that was emailed to this address has been accepted.
        await api.startEmailVerification(email);
        setStep('verify');
      } else if (mode === 'disabled') {
        // Verification deliberately switched off for this build.
        await createAccount();
      } else {
        // Backend unreachable or SES not configured. Refuse rather than create
        // an account on an address nobody has proved they can open.
        setError(
          "We can't email you a confirmation code right now, so your account wasn't created. " +
            'This is nothing you did wrong — please try again in a few minutes.',
        );
        setErrorIsSetup(true);
      }
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
      await createAccount(await api.verifyEmailCode(email, code));
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
    <div className="phone-scroll relative flex h-full flex-col justify-center overflow-y-auto px-6 pt-10">
      {/* Guests reach this screen voluntarily, let them go back to the app. */}
      {user?.isGuest && (
        <button
          type="button"
          onClick={() => navigate('/goals')}
          aria-label="Back to app"
          className="absolute left-4 top-[calc(1rem+env(safe-area-inset-top))] flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition hover:border-accent hover:text-accent"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {step === 'verify' ? (
        <>
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">Confirm your email</h1>
            <p className="mt-1 text-sm text-muted">One last step, then your account is created.</p>
          </div>
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
        </>
      ) : (
        <>
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">Create account</h1>
            <p className="mt-1 text-sm text-muted">
              Your goals are saved to your account, so you can log in from any device.
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label>Display name</Label>
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Operator" />
            </div>
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
              <p className="mt-1.5 text-[11px] text-muted">
                We'll email you a 6-digit code to confirm this address is yours.
              </p>
            </div>
            <div>
              <Label>Password</Label>
              <PasswordInput
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <div className="space-y-2 pt-1">
              <label className="flex cursor-pointer items-start gap-2.5 text-xs text-muted">
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
              <label className="flex cursor-pointer items-start gap-2.5 text-xs text-muted">
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

            {error && <p className="font-mono text-xs text-danger">{error}</p>}
            <Button type="submit" disabled={busy || !canSubmit} className="w-full">
              {busy ? 'Sending code…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">
            Already registered?{' '}
            <Link to="/login" className="text-accent hover:underline">
              Log in
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
