import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { DEFAULT_COUNTRY_ISO, fullPhone } from '../lib/countries';
import { SyncError } from '../lib/supabase';
import PhoneField from '../components/PhoneField';
import PhoneVerify from '../components/PhoneVerify';
import { Button, Input, Label, PasswordInput } from '../components/ui';

export default function Register() {
  const { register, user } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phoneIso, setPhoneIso] = useState(DEFAULT_COUNTRY_ISO);
  const [phone, setPhone] = useState('');
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState('');
  // A server-setup failure is not the new user's to fix, so it is worded as
  // "the server isn't ready" rather than "you got the code wrong".
  const [errorIsSetup, setErrorIsSetup] = useState(false);
  const [busy, setBusy] = useState(false);

  const fullNumber = fullPhone(phoneIso, phone);
  const phoneValid = phone.replace(/\D/g, '').length >= 7;
  const canSubmit = acceptPrivacy && acceptTerms && phoneValid;

  function showError(err: unknown) {
    setError((err as Error).message);
    setErrorIsSetup(err instanceof SyncError && err.kind === 'setup');
  }

  /** Create the account, recording whether the number was proved by SMS. */
  async function createAccount(phoneVerified: boolean) {
    await register(name, email, password, 'standard', fullNumber, phoneVerified);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setErrorIsSetup(false);
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (!phoneValid) {
      setError('Enter your phone number, including the country code.');
      return;
    }
    if (!acceptPrivacy || !acceptTerms) {
      setError('You must accept the Privacy Policy and the Terms of Use to continue.');
      return;
    }
    setBusy(true);
    try {
      // On a deployment with no Twilio credentials there is no code to send, so
      // the number is recorded unverified rather than blocking sign-up on a text
      // that can never arrive.
      if (await api.phoneVerificationAvailable()) {
        await api.startPhoneVerification(fullNumber);
        setStep('verify');
      } else {
        await createAccount(false);
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
      await api.verifyPhoneCode(fullNumber, code);
      await createAccount(true);
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
      await api.startPhoneVerification(fullNumber);
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
            <h1 className="text-2xl font-bold tracking-tight">Confirm your number</h1>
            <p className="mt-1 text-sm text-muted">One last step, then your account is created.</p>
          </div>
          <PhoneVerify
            phone={fullNumber}
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
            <p className="mt-1 text-sm text-muted">Your data lives locally on this device.</p>
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@domain.com"
              />
            </div>
            <div>
              <Label>Phone number</Label>
              <PhoneField iso={phoneIso} number={phone} onIso={setPhoneIso} onNumber={setPhone} />
              <p className="mt-1.5 text-[11px] text-muted">
                We'll text you a 6-digit code to confirm this number is yours.
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
