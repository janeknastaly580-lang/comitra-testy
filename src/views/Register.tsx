import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Button, Input, Label, PasswordInput } from '../components/ui';

export default function Register() {
  const { register, user } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit = acceptPrivacy && acceptTerms;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (!acceptPrivacy || !acceptTerms) {
      setError('You must accept the Privacy Policy and the Terms of Use to continue.');
      return;
    }
    setBusy(true);
    try {
      await register(name, email, password);
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
        <h1 className="text-2xl font-bold tracking-tight">Create account</h1>
        <p className="mt-1 text-sm text-muted">Your data lives locally on this device.</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label>Display name</Label>
          <Input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex Operator"
          />
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
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Already registered?{' '}
        <Link to="/login" className="text-accent hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
