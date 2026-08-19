import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { SyncError } from '../lib/supabase';
import { Button, Input, Label } from '../components/ui';
import BrandMark from '../components/BrandMark';

/**
 * "Forgot password?" — step one: ask for the address, email a link.
 *
 * The confirmation deliberately does NOT say whether an account exists. That is
 * not a white lie for security theatre: the backend genuinely cannot tell,
 * because accounts live in the browser's own storage. Saying "no such account"
 * would require inventing knowledge the server does not have, and would turn
 * this screen into a way of testing who is registered.
 */
export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [errorIsSetup, setErrorIsSetup] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setErrorIsSetup(false);
    if (!api.emailLooksValid(email)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      await api.startPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
      setErrorIsSetup(err instanceof SyncError && err.kind === 'setup');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="flex h-full flex-col justify-center px-6 pt-10">
        <div className="mb-6 flex items-center gap-2">
          <BrandMark className="h-9 w-9" />
          <span className="font-mono text-lg font-bold tracking-[0.25em]">Comitra</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm text-muted">
          If there's a Comitra account for{' '}
          <span className="font-semibold text-ink">{api.normalizeEmail(email)}</span>, a reset link
          is on its way. It works once and expires in 30 minutes.
        </p>
        <p className="mt-2 text-[13px] text-muted">
          It works on any device. Nothing arrived? Check your spam folder.
        </p>

        <Button className="mt-6 w-full" onClick={() => navigate('/login')}>
          Back to log in
        </Button>
        <button
          type="button"
          onClick={() => setSent(false)}
          className="mt-3 text-center text-[13px] text-accent hover:underline"
        >
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col justify-center px-6 pt-10">
      <div className="mb-6 flex items-center gap-2">
        <BrandMark className="h-9 w-9" />
        <span className="font-mono text-lg font-bold tracking-[0.25em]">Comitra</span>
      </div>
      <h1 className="text-2xl font-bold tracking-tight">Forgot password?</h1>
      <p className="mt-1 text-sm text-muted">
        Type the address you signed up with and we'll email you a link to choose a new password.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
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
        </div>

        {error && (
          <div className="rounded-xl border border-danger/40 bg-danger/5 p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-danger">
              {errorIsSetup ? "Server isn't ready" : "Couldn't send the link"}
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink">{error}</p>
          </div>
        )}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Sending…' : 'Email me a reset link'}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Remembered it?{' '}
        <Link to="/login" className="text-accent hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
