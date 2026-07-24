/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Google OAuth 2.0 Web client id (enables "Continue with Google"). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_PAYPAL_CLIENT_ID?: string;
  readonly VITE_API_BASE?: string;
  /** Supabase project URL (e.g. https://xxxx.supabase.co) — enables cross-device judge sync. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase public anon key (safe to ship in the client bundle). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /**
   * Whether to require an SMS code when someone accepts a judge invite.
   * `auto` (default) turns it on only when Supabase phone auth is detected as
   * enabled; `on` forces it; `off` disables it (register without an SMS step).
   */
  readonly VITE_SMS_VERIFY?: 'auto' | 'on' | 'off';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
