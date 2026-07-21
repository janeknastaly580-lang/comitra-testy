/**
 * Real Google Sign-In via Google Identity Services (GIS).
 *
 * Setup: put a public OAuth 2.0 *Web* client id in `.env` as
 * `VITE_GOOGLE_CLIENT_ID` and add your origin(s) to the client's "Authorized
 * JavaScript origins" in Google Cloud Console. Nothing else is required.
 *
 * Flow: on a button click we open Google's account chooser (token client),
 * receive an access token, and read the verified profile from Google's userinfo
 * endpoint. The caller then finds-or-creates a local account keyed by that email.
 */

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
const GSI_SRC = 'https://accounts.google.com/gsi/client';
const UNSET_PLACEHOLDER = 'PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE';

/** True once a real client id has been provided in the environment. */
export function isGoogleConfigured(): boolean {
  return CLIENT_ID.length > 0 && CLIENT_ID !== UNSET_PLACEHOLDER;
}

export interface GoogleIdentity {
  email: string;
  name: string;
  picture?: string;
  googleId: string;
}

// GIS attaches itself to window.google; keep the typing loose.
type AnyWindow = typeof window & { google?: any };

let gsiPromise: Promise<void> | null = null;

/** Load the GIS client script exactly once (idempotent, cached). */
export function loadGoogleScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const w = window as AnyWindow;
  if (w.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiPromise) return gsiPromise;

  gsiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () =>
        reject(new Error('Could not load Google sign-in. Check your connection.')),
      );
      return;
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gsiPromise = null; // allow a retry on the next attempt
      reject(new Error('Could not load Google sign-in. Check your connection.'));
    };
    document.head.appendChild(script);
  });
  return gsiPromise;
}

/**
 * Open the Google account chooser and resolve with the chosen account's verified
 * profile. Rejects with a friendly message if not configured, cancelled, or on a
 * network error.
 */
export async function requestGoogleIdentity(): Promise<GoogleIdentity> {
  if (!isGoogleConfigured()) {
    throw new Error(
      'Google sign-in isn’t configured yet. Add VITE_GOOGLE_CLIENT_ID to your .env and restart.',
    );
  }
  await loadGoogleScript();
  const w = window as AnyWindow;
  const oauth2 = w.google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Google sign-in failed to initialise. Please try again.');

  const accessToken = await new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: 'openid email profile',
      // Always let the user pick which Google account to use.
      prompt: 'select_account',
      callback: (resp: { access_token?: string; error?: string; error_description?: string }) => {
        if (resp?.access_token) resolve(resp.access_token);
        else reject(new Error(resp?.error_description || 'Google sign-in was cancelled.'));
      },
      error_callback: (err: { type?: string; message?: string }) => {
        reject(new Error(err?.message || 'Google sign-in was cancelled.'));
      },
    });
    client.requestAccessToken();
  });

  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Could not read your Google profile. Please try again.');
  const info = (await res.json()) as {
    email?: string;
    email_verified?: boolean | string;
    name?: string;
    given_name?: string;
    picture?: string;
    sub?: string;
  };

  if (!info.email) throw new Error('Your Google account didn’t share an email address.');
  return {
    email: info.email,
    name: info.name || info.given_name || info.email.split('@')[0],
    picture: info.picture,
    googleId: info.sub ?? '',
  };
}
