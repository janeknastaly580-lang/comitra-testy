/**
 * Minimal Supabase REST client (raw fetch — no SDK, so nothing extra to bundle
 * or build for the Android WebView).
 *
 * This is the ONE shared store the app has: it exists so a friend who registers
 * as a judge on their own phone becomes pickable on the inviter's device. Every
 * other bit of state still lives in per-device LocalStorage, so all calls here
 * are best-effort — callers must keep working (local-only) when Supabase is not
 * configured or is unreachable.
 *
 * Requires a one-time table + policies in the Supabase project — see
 * `supabase/comitra_invited_judges.sql`. Without it, `supabaseEnabled()` is still
 * true but calls fail and the app silently falls back to LocalStorage.
 */

const RAW_URL = import.meta.env.VITE_SUPABASE_URL?.trim();
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** Normalise `https://x.supabase.co[/rest/v1[/]]` → `https://x.supabase.co/rest/v1`. */
function restBase(): string | null {
  if (!RAW_URL) return null;
  const trimmed = RAW_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  return `${trimmed}/rest/v1`;
}

/** Whether a Supabase URL + anon key are configured at all. */
export function supabaseEnabled(): boolean {
  // Never touch the network from the test suite — keep vitest hermetic and
  // deterministic even though .env is loaded during tests.
  if (import.meta.env.MODE === 'test') return false;
  return !!restBase() && !!ANON_KEY;
}

/**
 * One shared row per (owner, judge phone) — the minimum the inviter needs to see
 * and pick a judge on another device.
 *
 * SECURITY: the judge's password (even its hash) is intentionally NOT here. It
 * never leaves the judge's own device; the shared store only carries the name +
 * phone so the owner can display and select the judge. Reads are gated behind an
 * RPC that requires knowing the owner id (see supabase/comitra_invited_judges.sql),
 * so the table can't be enumerated.
 */
export interface RemoteInvitedJudge {
  id: string;
  owner_user_id: string;
  name: string;
  phone: string;
  judge_account_user_id: string | null;
  consented_at: string | null;
  created_at: string;
}

/**
 * What went wrong with a shared-store write, in terms the UI can act on.
 *
 * `setup` is the important one: the request reached Supabase and Supabase said
 * no, because the one-time SQL install (table / policies) hasn't been run — or
 * was only half-run. Nobody on the phone can fix that; the project owner has to
 * run `supabase/comitra_invited_judges.sql`.
 */
export type SyncErrorKind =
  | 'not-configured'
  | 'setup'
  | 'offline'
  | 'unknown'
  /** The SMS code the person typed was wrong or has expired. */
  | 'invalid-code'
  /** Too many code requests/attempts too fast (server rate limit). */
  | 'rate-limited'
  /** The phone number itself isn't a valid E.164 number. */
  | 'bad-phone';

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  /** Raw server text, kept for logs — never shown verbatim to a user. */
  readonly detail?: string;
  constructor(kind: SyncErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** Map a failed PostgREST response onto a `SyncError` with human wording. */
function classify(status: number, body: string): SyncError {
  // 42501 = insufficient_privilege → RLS refused the write. This is BY FAR the
  // most common setup mistake: the table exists (often created by hand in the
  // Table Editor, which enables RLS and adds no policies) but the insert/update
  // policies are missing, so every registration bounces.
  if (body.includes('42501') || body.includes('row-level security')) {
    return new SyncError(
      'setup',
      "Comitra's server isn't finished setting up, so your registration couldn't be saved. " +
        'This is nothing you did wrong — tell the person who sent you this link, and try again after they fix it.',
      `RLS policy missing (42501). Run supabase/comitra_invited_judges.sql. ${body}`,
    );
  }
  // Missing table (PGRST205) or missing function (PGRST202).
  if (status === 404 || body.includes('PGRST205') || body.includes('PGRST202') || body.includes('Could not find the table')) {
    return new SyncError(
      'setup',
      "Comitra's server isn't set up for judges yet, so your registration couldn't be saved. " +
        'Tell the person who sent you this link, and try again after they fix it.',
      `Table or function missing (${status}). Run supabase/comitra_invited_judges.sql. ${body}`,
    );
  }
  if (status === 401 || status === 403) {
    return new SyncError(
      'setup',
      "Comitra's server refused to save your registration. Tell the person who sent you this link.",
      `Rejected (${status}). ${body}`,
    );
  }
  return new SyncError(
    'unknown',
    "We couldn't save your registration on the server. Check your connection and try again.",
    `HTTP ${status}. ${body}`,
  );
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: ANON_KEY as string,
    Authorization: `Bearer ${ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** fetch with a short timeout so a dead network never hangs a submit/open. */
async function timedFetch(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Publish (insert or update) a judge's registration to the shared store so the
 * inviting owner can see it on another device. Throws on failure so the judge
 * can be told to retry (their registration would otherwise silently not sync).
 */
export async function remoteUpsertInvitedJudge(row: RemoteInvitedJudge): Promise<void> {
  const base = restBase();
  if (!base || !ANON_KEY) {
    throw new SyncError('not-configured', 'Sync is not configured.');
  }
  let res: Response;
  try {
    // Writes go through a SECURITY DEFINER function, NOT a direct table insert.
    // The table is fully locked to the anon key (it can't be read/dumped, and a
    // direct `INSERT ... ON CONFLICT` upsert is impossible without a SELECT policy
    // that would leak every phone number). The function performs the upsert
    // server-side. See supabase/comitra_invited_judges.sql.
    res = await timedFetch(
      `${base}/rpc/comitra_register_invited_judge`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          p_id: row.id,
          p_owner_user_id: row.owner_user_id,
          p_name: row.name,
          p_phone: row.phone,
          p_judge_account_user_id: row.judge_account_user_id,
          p_consented_at: row.consented_at,
          p_created_at: row.created_at,
        }),
      },
    );
  } catch {
    throw new SyncError(
      'offline',
      "We couldn't reach the server. Check your connection and tap “Become a judge” again.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = classify(res.status, text);
    // The detail (raw server text, SQL file to run) belongs in the console, not
    // on a phone screen — the person reading the invite page can't act on it.
    console.error('[supabase] judge sync failed:', err.detail ?? text);
    throw err;
  }
}

/** Health of the shared store, as far as it can be told without writing data. */
export type SyncHealth = 'off' | 'ok' | 'setup' | 'unreachable';

/**
 * Ask the server whether a friend would actually be able to register, before the
 * inviter sends anyone a link.
 *
 * A missing write policy is invisible to a read — it only surfaces when someone
 * tries to save, on THEIR phone, where the inviter never sees it. So the check
 * goes through `comitra_sync_status`, which reports whether the insert/update
 * policies exist. An older install won't have that function at all, which is
 * itself the answer: setup is incomplete.
 */
export async function remoteSyncHealth(): Promise<SyncHealth> {
  const base = restBase();
  if (!supabaseEnabled() || !base || !ANON_KEY) return 'off';
  try {
    const res = await timedFetch(
      `${base}/rpc/comitra_sync_status`,
      { method: 'POST', headers: headers(), body: '{}' },
      6000,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return classify(res.status, text).kind === 'setup' ? 'setup' : 'unreachable';
    }
    // PostgREST returns a table-returning function as an array of rows.
    const rows = (await res.json()) as { has_insert?: boolean; has_update?: boolean }[];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row?.has_insert && row?.has_update ? 'ok' : 'setup';
  } catch {
    return 'unreachable';
  }
}

/**
 * List the judges registered for one owner across all devices. Best-effort:
 * returns [] on any failure so the caller can fall back to LocalStorage.
 */
export async function remoteListInvitedJudges(ownerUserId: string): Promise<RemoteInvitedJudge[]> {
  const base = restBase();
  if (!base || !ANON_KEY) return [];
  try {
    const res = await timedFetch(
      `${base}/rpc/comitra_list_invited_judges`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ p_owner: ownerUserId }),
      },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as RemoteInvitedJudge[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/* ─────────────────────────────── Phone (SMS) verification via Supabase Auth ── */

/**
 * Base URL of the project's GoTrue (Auth) API, e.g. `https://x.supabase.co/auth/v1`.
 * Derived from the same `VITE_SUPABASE_URL` used for the REST base — the auth
 * endpoints live under `/auth/v1` on the same project origin.
 *
 * SMS verification rides on Supabase's built-in phone auth: Supabase generates the
 * random 6-digit code, stores it hashed, expires it, rate-limits it, and hands the
 * text to whichever SMS provider (Twilio / MessageBird / Vonage / …) the project
 * owner configured. No code and no provider secret ever reaches the browser.
 */
function authBase(): string | null {
  if (!RAW_URL) return null;
  const origin = RAW_URL.replace(/\/+$/, '')
    .replace(/\/rest\/v1$/, '')
    .replace(/\/auth\/v1$/, '');
  return `${origin}/auth/v1`;
}

/** Map a failed GoTrue OTP response onto a `SyncError` with human wording. */
function classifyOtp(status: number, body: string, phase: 'send' | 'verify'): SyncError {
  const b = body.toLowerCase();
  // A malformed phone number — the person can fix this by correcting the field.
  if (b.includes('invalid phone') || b.includes('e.164') || b.includes('invalid format')) {
    return new SyncError('bad-phone', "That phone number doesn't look right. Check the country and number, then try again.", `OTP ${phase} bad phone (${status}). ${body}`);
  }
  // Provider not wired up yet: phone auth off, no/invalid SMS provider, or phone
  // signups disabled. Nobody on the phone can fix this — the project owner must
  // finish the Supabase phone-auth setup (see SMS-SETUP.md).
  if (
    b.includes('signups not allowed') ||
    b.includes('phone provider') ||
    b.includes('unsupported phone') ||
    b.includes('sms provider') ||
    b.includes('phone_provider_disabled') ||
    b.includes('otp_disabled') ||
    (status === 422 && (b.includes('provider') || b.includes('disabled') || b.includes('not enabled')))
  ) {
    return new SyncError(
      'setup',
      "Text-message verification isn't finished being set up yet. This is nothing you did wrong — tell the person who sent you this link, and try again once they've turned it on.",
      `OTP ${phase} setup incomplete (${status}). ${body}`,
    );
  }
  if (status === 429 || b.includes('rate limit') || b.includes('too many') || b.includes('for security purposes') || b.includes('over_sms_send_rate_limit')) {
    return new SyncError('rate-limited', 'Too many attempts — wait about a minute, then request a new code.', `OTP ${phase} rate-limited (${status}). ${body}`);
  }
  if (phase === 'verify' && (status === 400 || status === 401 || status === 403 || b.includes('invalid') || b.includes('expired'))) {
    return new SyncError('invalid-code', "That code isn't right, or it has expired. Check the text and try again, or resend a new code.", `OTP verify invalid (${status}). ${body}`);
  }
  // Sending depends on the SMS provider; a 5xx almost always means bad provider
  // credentials on the server, not anything the person can fix.
  if (status >= 500) {
    return new SyncError(
      'setup',
      "The text message couldn't be sent — the SMS provider looks misconfigured. Tell the person who sent you this link.",
      `OTP ${phase} server error (${status}). ${body}`,
    );
  }
  return new SyncError('unknown', 'Something went wrong verifying your phone. Please try again in a moment.', `OTP ${phase} HTTP ${status}. ${body}`);
}

/**
 * Whether Supabase phone (SMS) auth is switched on for this project. Lets the
 * judge-invite flow decide if it should require an SMS code. Best-effort: any
 * failure (not configured, unreachable, unexpected shape) reports `false`, so the
 * app simply falls back to registering a judge without an SMS step — nothing
 * breaks before the owner finishes SMS setup.
 */
export async function remotePhoneAuthEnabled(): Promise<boolean> {
  const base = authBase();
  if (!base || !ANON_KEY) return false;
  try {
    const res = await timedFetch(`${base}/settings`, { method: 'GET', headers: headers() }, 6000);
    if (!res.ok) return false;
    const data = (await res.json()) as { external?: Record<string, boolean> };
    return data?.external?.phone === true;
  } catch {
    return false;
  }
}

/**
 * Ask Supabase to text a random 6-digit code to this phone (E.164). Throws a
 * `SyncError` the invite page can act on: `setup` (owner must finish SMS setup),
 * `rate-limited`, `bad-phone`, `offline`, or `unknown`.
 */
export async function remoteSendPhoneOtp(phone: string): Promise<void> {
  const base = authBase();
  if (!base || !ANON_KEY) throw new SyncError('not-configured', 'Phone verification is not configured.');
  let res: Response;
  try {
    res = await timedFetch(`${base}/otp`, {
      method: 'POST',
      headers: headers(),
      // `create_user` lets a brand-new phone receive a code (the judge has no
      // Supabase account) — it still needs "phone signups" enabled on the project.
      body: JSON.stringify({ phone, channel: 'sms', create_user: true }),
    });
  } catch {
    throw new SyncError('offline', "We couldn't reach the server to text your code. Check your connection and try again.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = classifyOtp(res.status, text, 'send');
    console.error('[supabase] send OTP failed:', err.detail ?? text);
    throw err;
  }
}

/**
 * Verify the 6-digit code the judge received by SMS. Resolves when the code is
 * correct (Supabase confirms it server-side, so a success genuinely proves the
 * person holds the number); throws `SyncError('invalid-code')` when it's wrong or
 * expired. The session Supabase returns on success is intentionally ignored — we
 * only use this to prove phone ownership, not to sign anyone in.
 */
export async function remoteVerifyPhoneOtp(phone: string, code: string): Promise<void> {
  const base = authBase();
  if (!base || !ANON_KEY) throw new SyncError('not-configured', 'Phone verification is not configured.');
  let res: Response;
  try {
    res = await timedFetch(`${base}/verify`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ type: 'sms', phone, token: code }),
    });
  } catch {
    throw new SyncError('offline', "We couldn't reach the server to check your code. Check your connection and try again.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = classifyOtp(res.status, text, 'verify');
    console.error('[supabase] verify OTP failed:', err.detail ?? text);
    throw err;
  }
}
