import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import { Button, Label, PasswordInput } from '../components/ui';
import BrandMark from '../components/BrandMark';

/**
 * "Forgot password?" — step two: the screen the emailed link opens.
 *
 * THE ONE THING TO UNDERSTAND HERE: accounts live in this browser's storage,
 * not on a server. The link proves the person can open that mailbox, but the
 * password it changes is the one on THIS device. Opening the link on a phone
 * when the account was made on a laptop cannot work, and the honest thing is to
 * say so plainly rather than appear to succeed and change nothing.
 */
type Stage = 'checking' | 'ready' | 'no-account' | 'bad-token' | 'done';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [stage, setStage] = useState<Stage>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * Spending the token destroys it server-side, so it must happen exactly once.
   * React 18 mounts effects twice in development, which without this guard
   * would burn the link before the person ever saw the form.
   */
  const spent = useRef(false);

  useEffect(() => {
    if (spent.current) return;
    spent.current = true;

    (async () => {
      if (!token) {
        setError('This link is missing its token. Ask for a new reset link.');
        setStage('bad-token');
        return;
      }
      try {
        const address = await api.consumePasswordResetToken(token);
        setEmail(address);
        setStage((await api.accountExistsForEmail(address)) ? 'ready' : 'no-account');
      } catch (err) {
        setError((err as Error).message);
        setStage('bad-token');
      }
    })();
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Those two passwords are different.');
      return;
    }
    setBusy(true);
    try {
      await api.setPasswordForEmail(email, password);
      setStage('done');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div className="mb-6 flex items-center gap-2">
      <BrandMark className="h-9 w-9" />
      <span className="font-mono text-lg font-bold tracking-[0.25em]">Comitra</span>
    </div>
  );

  if (stage === 'checking') {
    return (
      <div className="flex h-full flex-col justify-center px-6 pt-10">
        {header}
        <p className="text-sm text-muted">Checking your link…</p>
      </div>
    );
  }

  if (stage === 'bad-token') {
    return (
      <div className="flex h-full flex-col justify-center px-6 pt-10">
        {header}
        <h1 className="text-2xl font-bold tracking-tight">This link doesn't work</h1>
        <p className="mt-2 text-sm text-muted">{error}</p>
        <Button className="mt-6 w-full" onClick={() => navigate('/forgot-password')}>
          Get a new link
        </Button>
      </div>
    );
  }

  if (stage === 'no-account') {
    return (
      <div className="flex h-full flex-col justify-center px-6 pt-10">
        {header}
        <h1 className="text-2xl font-bold tracking-tight">Open this on your own device</h1>
        <p className="mt-2 text-sm text-muted">
          The link is valid, but there's no Comitra account for{' '}
          <span className="font-semibold text-ink">{email}</span> on this device.
        </p>
        <p className="mt-3 text-[13px] text-muted">
          Comitra keeps your account on the device you created it on, so a password can only be
          changed there. Open the same email on that phone or computer and use the link again.
        </p>
        <p className="mt-3 text-[13px] text-muted">
          The link you just opened has now been used up — ask for a fresh one on the device you use
          Comitra on.
        </p>
        <Button className="mt-6 w-full" onClick={() => navigate('/login')}>
          Back to log in
        </Button>
      </div>
    );
  }

  if (stage === 'done') {
    return (
      <div className="flex h-full flex-col justify-center px-6 pt-10">
        {header}
        <h1 className="text-2xl font-bold tracking-tight">Password changed</h1>
        <p className="mt-2 text-sm text-muted">
          You can log in as <span className="font-semibold text-ink">{email}</span> with your new
          password.
        </p>
        <Button className="mt-6 w-full" onClick={() => navigate('/login')}>
          Log in
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col justify-center px-6 pt-10">
      {header}
      <h1 className="text-2xl font-bold tracking-tight">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted">
        For <span className="font-semibold text-ink">{email}</span>.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <Label>New password</Label>
          <PasswordInput
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <div>
          <Label>Repeat new password</Label>
          <PasswordInput
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        {error && <p className="font-mono text-xs text-danger">{error}</p>}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Saving…' : 'Save new password'}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        <Link to="/login" className="text-accent hover:underline">
          Back to log in
        </Link>
      </p>
    </div>
  );
}
