/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Google OAuth 2.0 Web client id (enables "Continue with Google"). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_PAYPAL_CLIENT_ID?: string;
  /**
   * Base URL of this app's backend, e.g.
   * `https://<project>.supabase.co/functions/v1`. Required for accounts and for
   * verification codes: every Amazon SES call goes through it, so no AWS key is
   * ever shipped in the browser bundle or the Android APK.
   */
  readonly VITE_API_BASE?: string;
  /** Supabase project URL (e.g. https://xxxx.supabase.co), enables cross-device judge sync. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase public anon key (safe to ship in the client bundle). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /**
   * Whether sign-up and the judge invite ask for the 6-digit code emailed by
   * Amazon SES. `auto` (default) turns it on only when the backend reports
   * working SES settings; `off` disables the step. There is no value that forces
   * it on — that could only strand people at a code no backend can send.
   */
  readonly VITE_EMAIL_VERIFY?: 'auto' | 'off';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
