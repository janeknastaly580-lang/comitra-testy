import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Button, Input, Label, PasswordInput } from '../components/ui';
import BrandMark from '../components/BrandMark';
import SocialAuthButtons from '../components/SocialAuthButtons';

export default function Login() {
  const { login, user } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex h-full flex-col justify-center px-6 pt-10">
      {/* Guests reach this screen voluntarily — let them go back to the app. */}
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

      <div className="mb-8">
        <div className="mb-3 flex items-center gap-2">
          <BrandMark className="h-9 w-9" />
          <span className="font-mono text-lg font-bold tracking-[0.25em]">Comitra</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Following through is the hard part.</h1>
        <p className="mt-1 text-sm text-muted">
          Setting a goal is easy — following through is the hard part. Comitra helps you stay
          accountable and build the habit.
        </p>
        <ul className="mt-4 space-y-1.5">
          {[
            'Set a simple, realistic goal — like a few steps this week.',
            'Pick someone to confirm whether you did it.',
            'Invite people who’ll hear about it if you don’t — only if they agree first.',
          ].map((b) => (
            <li key={b} className="flex items-start gap-2 text-[13px] text-muted">
              <span className="mt-0.5 text-accent">✓</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
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
        <div>
          <Label>Password</Label>
          <PasswordInput
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        {error && <p className="font-mono text-xs text-danger">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Authenticating…' : 'Log in'}
        </Button>
      </form>

      <SocialAuthButtons />

      <p className="mt-6 text-center text-sm text-muted">
        No account?{' '}
        <Link to="/register" className="text-accent hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}
