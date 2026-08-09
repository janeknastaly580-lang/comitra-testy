/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Google OAuth 2.0 Web client id (enables "Continue with Google"). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_PAYPAL_CLIENT_ID?: string;
  /**
   * Base URL of this app's backend (`server/`), e.g. `https://api.comitra.app`.
   * Required for SMS: every Twilio call goes through it, so no Twilio key is
   * ever shipped in the browser bundle or the Android APK.
   */
  readonly VITE_API_BASE?: string;
  /** Supabase project URL (e.g. https://xxxx.supabase.co), enables cross-device judge sync. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase public anon key (safe to ship in the client bundle). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /**
   * Whether to require an SMS code at sign-up and when someone accepts a judge
   * invite. `auto` (default) turns it on only when the backend reports working
   * Twilio credentials; `off` disables the step. There is no value that forces
   * it on — that could only strand people at a code no backend can send.
   */
  readonly VITE_SMS_VERIFY?: 'auto' | 'off';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
