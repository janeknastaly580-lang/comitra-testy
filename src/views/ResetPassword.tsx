import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import { useApp } from '../context/AppContext';
import { MIN_PASSWORD_LENGTH } from '../lib/constants';
import { Button, Label, PasswordInput } from '../components/ui';
import BrandMark from '../components/BrandMark';

/**
 * "Forgot password?" — step two: the screen the emailed link opens.
 *
 * This used to be the sharpest edge of the device-local design: the link proved
 * the person could open the mailbox, but the password it changed lived in ONE
 * browser's storage, so opening the mail on a phone when the account was made on
 * a laptop could not work. The account is on the server now, so the link works
 * from anywhere, and succeeding signs this device straight in.
 *
 * The token is spent by the SAME request that sets the password. Checking it
 * first and saving second would burn the single-use link before anything had
 * been typed, and leave anyone who fumbled the form holding a dead link.
 */
type Stage = 'form' | 'done';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useApp();
  const token = params.get('token') ?? '';

  const [stage, setStage] = useState<Stage>('form');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Those two passwords are different.');
      return;
    }
    setBusy(true);
    try {
      await api.applyPasswordReset(token, password);
      // The account and its data are loaded now; pick them up for the UI.
      await refresh();
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

  if (!token) {
    return (
      <div className="flex h-full flex-col justify-center px-6 pt-10">
        {header}
        <h1 className="text-2xl font-bold tracking-tight">This link doesn't work</h1>
        <p className="mt-2 text-sm text-muted">
          It's missing its token, so we can't tell which account it's for. Ask for a new reset link.
        </p>
        <Button className="mt-6 w-full" onClick={() => navigate('/forgot-password')}>
          Get a new link
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
          You're logged in on this device, and your goals are here. Anywhere else you were logged in
          has been signed out.
        </p>
        <Button className="mt-6 w-full" onClick={() => navigate('/goals')}>
          Go to my goals
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col justify-center px-6 pt-10">
      {header}
      <h1 className="text-2xl font-bold tracking-tight">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted">
        Setting it signs you in here and signs out every other device.
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
