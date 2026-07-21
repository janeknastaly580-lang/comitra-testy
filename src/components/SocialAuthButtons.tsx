import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { isGoogleConfigured, loadGoogleScript } from '../lib/google';

/** Multicolor Google "G". */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

/**
 * "Continue with Google" — real Google Sign-In. Preloads the GIS script on mount
 * so the click that opens Google's popup stays inside the user gesture (avoids
 * popup blockers). `onDone` fires on success so a host modal can close itself.
 */
export default function SocialAuthButtons({ onDone }: { onDone?: () => void }) {
  const { loginWithGoogle } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isGoogleConfigured()) loadGoogleScript().catch(() => {});
  }, []);

  async function go() {
    setError('');
    setBusy(true);
    try {
      await loginWithGoogle();
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="my-3 flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-muted">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2.5 rounded border border-line bg-surface px-4 py-3 text-sm font-medium text-ink transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <GoogleIcon />
        {busy ? 'Connecting…' : 'Continue with Google'}
      </button>
      {error && <p className="font-mono text-xs text-danger">{error}</p>}
    </div>
  );
}
