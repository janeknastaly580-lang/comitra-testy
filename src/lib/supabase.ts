/**
 * Minimal Supabase REST client (raw fetch, no SDK, so nothing extra to bundle
 * or build for the Android WebView).
 *
 * This is the ONE shared store the app has: it exists so a friend who registers
 * as a judge on their own phone becomes pickable on the inviter's device. Every
 * other bit of state still lives in per-device LocalStorage, so all calls here
 * are best-effort: callers must keep working (local-only) when Supabase is not
 * configured or is unreachable.
 *
 * Requires a one-time table + policies in the Supabase project, see
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
  // Never touch the network from the test suite, keep vitest hermetic and
  // deterministic even though .env is loaded during tests.
  if (import.meta.env.MODE === 'test') return false;
  return !!restBase() && !!ANON_KEY;
}

/**
 * One shared row per (owner, judge email), the minimum the inviter needs to see
 * and pick a judge on another device.
 *
 * SECURITY: the judge's password (even its hash) is intentionally NOT here. It
 * never leaves the judge's own device; the shared store only carries the name +
 * address so the owner can display and select the judge. Reads are gated behind
 * an RPC that requires knowing the owner id (see supabase/comitra_invited_judges.sql),
 * so the table can't be enumerated.
 */
export interface RemoteInvitedJudge {
  id: string;
  owner_user_id: string;
  name: string;
  email: string;
  /** @deprecated rows written before judges moved to email. Never read. */
  phone?: string | null;
  judge_account_user_id: string | null;
  consented_at: string | null;
  created_at: string;
}

/**
 * What went wrong with a shared-store write, in terms the UI can act on.
 *
 * `setup` is the important one: the request reached Supabase and Supabase said
 * no, because the one-time SQL install (table / policies) hasn't been run, or
 * was only half-run. Nobody on the phone can fix that; the project owner has to
 * run `supabase/comitra_invited_judges.sql`.
 */
export type SyncErrorKind =
  | 'not-configured'
  | 'setup'
  | 'offline'
  | 'unknown'
  /** The emailed code the person typed was wrong or has expired. */
  | 'invalid-code'
  /** Too many code requests/attempts too fast (server rate limit). */
  | 'rate-limited'
  /** The email address itself isn't one we could send to. */
  | 'bad-email';

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  /** Raw server text, kept for logs: never shown verbatim to a user. */
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
        'This is nothing you did wrong. Tell the person who sent you this link, and try again after they fix it.',
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
    // that would leak every address). The function performs the upsert
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
          p_email: row.email,
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
    // on a phone screen: the person reading the invite page can't act on it.
    console.error('[supabase] judge sync failed:', err.detail ?? text);
    throw err;
  }
}

/**
 * Health of the shared store, as far as it can be told without writing data.
 *
 * `unreachable` and `no-server` are both "the request never got an answer", told
 * apart by whether the device itself is online: a phone in a tunnel is a
 * different problem from a `VITE_SUPABASE_URL` that no longer resolves (a
 * deleted or renamed Supabase project), and only the second one is the owner's
 * to fix.
 */
export type SyncHealth = 'off' | 'ok' | 'setup' | 'unreachable' | 'no-server';

/**
 * Ask the server whether a friend would actually be able to register, before the
 * inviter sends anyone a link.
 *
 * A missing write policy is invisible to a read, it only surfaces when someone
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
    // fetch rejects the same way for "no network" and "that host doesn't exist",
    // so the browser's own connectivity flag is what separates them. Online +
    // no answer = the configured project address is dead, which no amount of
    // retrying from this phone will fix.
    return navigator.onLine ? 'no-server' : 'unreachable';
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

/* ─────────────────────────────────────────────── Goals (judge access) ── */

/**
 * A goal as it exists outside its owner's device.
 *
 * `data` is the ALLOW-LISTED projection built by `src/lib/goalShare.ts` — the
 * goal's title and details are not in it and never reach this file. What is
 * here is what a judge must see to do their job: which numbered goal, whose,
 * by when, the proofs, and the judge's own state.
 *
 * Access is capability-based, never by owner: reads need `(id, token)`, and the
 * token only exists in the link the owner chose to send. There is deliberately
 * no "list an owner's goals" call — that would turn a leaked user id into a
 * dump of everything that person is working on.
 */
export interface RemoteGoalRow {
  data: unknown;
  updated_at: string;
}

/** Push (insert or update) one goal's shared projection. Throws on failure. */
export async function remotePutGoal(input: {
  id: string;
  ownerUserId: string;
  judgeToken: string;
  shareToken: string;
  data: unknown;
}): Promise<void> {
  const base = restBase();
  if (!base || !ANON_KEY) throw new SyncError('not-configured', 'Sync is not configured.');
  let res: Response;
  try {
    res = await timedFetch(`${base}/rpc/comitra_put_goal`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        p_id: input.id,
        p_owner_user_id: input.ownerUserId,
        p_judge_token: input.judgeToken,
        p_share_token: input.shareToken,
        p_data: input.data,
      }),
    });
  } catch {
    throw new SyncError('offline', "We couldn't reach the server, so your judge may not see this yet.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = classify(res.status, text);
    console.error('[supabase] goal sync failed:', err.detail ?? text);
    throw err;
  }
}

/**
 * Fetch one goal by its id and a token from the link. Returns null when the row
 * isn't there or the token doesn't match, and throws only when the server could
 * not be asked at all — the judge view needs to tell those two apart.
 */
export async function remoteGetGoal(id: string, token: string): Promise<RemoteGoalRow | null> {
  const base = restBase();
  if (!base || !ANON_KEY) throw new SyncError('not-configured', 'Sync is not configured.');
  let res: Response;
  try {
    res = await timedFetch(`${base}/rpc/comitra_get_goal`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ p_id: id, p_token: token }),
    });
  } catch {
    throw new SyncError('offline', "We couldn't reach the server.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = classify(res.status, text);
    console.error('[supabase] goal fetch failed:', err.detail ?? text);
    throw err;
  }
  // PostgREST returns a table-returning function as an array of rows.
  const rows = (await res.json()) as RemoteGoalRow[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row?.data ? row : null;
}

/* ─────────────────────────────────────────────────────── In-app push ──── */

/**
 * A message addressed to an ACCOUNT rather than to a phone number.
 *
 * This is what replaced the Twilio path: recipients are now people the user
 * follows and who follow back, so Comitra can reach them through their own app
 * instead of through a mobile network. `payload` is the same content the text
 * carried — who, which numbered goal, which tone — and never a goal's title.
 */
export interface RemotePushRow {
  id: string;
  to_user_id: string;
  from_user_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

/**
 * POST an RPC that may fail harmlessly.
 *
 * `ok` and `data` are separate because a void RPC succeeds with an empty body:
 * collapsing the two would make "it worked, there was nothing to return" and "it
 * failed" the same answer, and the push path has to tell those apart.
 */
async function rpcQuiet<T>(fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: T | null }> {
  const base = restBase();
  if (!base || !ANON_KEY) return { ok: false, data: null };
  try {
    const res = await timedFetch(`${base}/rpc/${fn}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      console.warn(`[supabase] ${fn} -> HTTP ${res.status}`, await res.text().catch(() => ''));
      return { ok: false, data: null };
    }
    const text = await res.text();
    return { ok: true, data: (text ? JSON.parse(text) : null) as T };
  } catch {
    return { ok: false, data: null };
  }
}

/**
 * Record that this account has the app open on this device, right now.
 *
 * The timestamp is the whole point: it is what later answers "is this person
 * still reachable, or did they uninstall the app?" — see `remotePushReachable`.
 */
export async function remoteTouchPushDevice(userId: string, deviceId: string, platform: string): Promise<void> {
  await rpcQuiet('comitra_push_touch_device', { p_user_id: userId, p_device_id: deviceId, p_platform: platform });
}

/**
 * Has this person opened the app on any device within `days`?
 *
 * `null` means the question could not be asked (offline, or the SQL is not
 * installed) — which callers must NOT read as "no". Losing the network is not
 * evidence that somebody uninstalled the app.
 */
export async function remotePushReachable(userId: string, days: number): Promise<boolean | null> {
  const { ok, data } = await rpcQuiet<boolean>('comitra_push_reachable', { p_user_id: userId, p_days: days });
  return ok && typeof data === 'boolean' ? data : null;
}

/** Queue one message for an account. Idempotent on `id`. */
export async function remotePushSend(row: {
  id: string;
  toUserId: string;
  fromUserId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  const { ok } = await rpcQuiet<null>('comitra_push_send', {
    p_id: row.id,
    p_to_user_id: row.toUserId,
    p_from_user_id: row.fromUserId,
    p_kind: row.kind,
    p_payload: row.payload,
  });
  return ok;
}

/** Everything unread for this account. Marks each row delivered on the way out. */
export async function remotePushPull(userId: string): Promise<RemotePushRow[]> {
  const { data } = await rpcQuiet<RemotePushRow[]>('comitra_push_pull', { p_user_id: userId });
  return Array.isArray(data) ? data : [];
}

export async function remotePushMarkRead(id: string, userId: string): Promise<void> {
  await rpcQuiet('comitra_push_mark_read', { p_id: id, p_user_id: userId });
}
