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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
