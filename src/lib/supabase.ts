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

const TABLE = 'comitra_invited_judges';

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
  if (!base || !ANON_KEY) throw new Error('Sync is not configured.');
  const res = await timedFetch(
    `${base}/${TABLE}?on_conflict=owner_user_id,phone`,
    {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(row),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // The one setup error worth calling out loudly: the shared table doesn't
    // exist yet. Run supabase/comitra_invited_judges.sql once in the SQL editor.
    if (res.status === 404 || text.includes('PGRST205') || text.includes('Could not find the table')) {
      console.error(
        '[supabase] The "comitra_invited_judges" table is missing. Run ' +
          'supabase/comitra_invited_judges.sql once in your Supabase SQL editor.',
      );
      throw new Error('The judge-sync table is not set up on the server yet.');
    }
    throw new Error(`Sync failed (${res.status}). ${text}`.trim());
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
