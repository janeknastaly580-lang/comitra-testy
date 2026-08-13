/**
 * The state that used to be `new Map()` in the Express backend.
 *
 * WHY IT MOVED: server/src/email/verify.js, twilio/verify.js and
 * twilio/throttle.js each kept their pending codes and rate buckets in process
 * memory. That is correct for one process. Edge Functions run as many
 * short-lived isolates, so a Map written by one is invisible to the next — codes
 * would verify or fail depending on which isolate answered, intermittently and
 * unreproducibly. Postgres is the only thing all isolates share.
 *
 * Reached over PostgREST with the SERVICE ROLE key, which Supabase injects into
 * every function. The tables have RLS on with no policies and no grants, so the
 * anon key in the browser cannot read a code hash or a rate bucket even though
 * it can reach the same database.
 *
 * Deliberately no supabase-js: four RPC calls do not justify the dependency, and
 * a smaller module graph is a faster cold start — which matters here, because a
 * slow first request is what makes sign-up time out.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    // The body can name columns and arguments but never a secret; it is logged
    // by the caller and never returned to the browser.
    throw new Error(`rpc ${fn} -> HTTP ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/* ───────────────────────────────────────────────────── rate limiting ────── */

export interface Slot {
  allowed: boolean;
  reason: 'cooldown' | 'quota' | null;
  retryAfterSec: number;
}

/**
 * Record an attempt against a named bucket for one destination.
 *
 * The decision and the write happen in one statement under an advisory lock, so
 * two isolates racing on the same destination cannot both be let through — the
 * guarantee the in-memory version could only offer within a single process.
 */
export async function takeSlot(
  bucket: string,
  keyHash: string,
  opts: { max: number; windowMs: number; cooldownMs?: number },
): Promise<Slot> {
  const rows = await rpc<Array<{ allowed: boolean; reason: string | null; retry_after_sec: number }>>(
    'comitra_rate_take',
    {
      p_bucket: bucket,
      p_key: keyHash,
      p_max: opts.max,
      p_window_ms: opts.windowMs,
      p_cooldown_ms: opts.cooldownMs ?? 0,
    },
  );
  const row = rows?.[0];
  if (!row) return { allowed: true, reason: null, retryAfterSec: 0 };
  return {
    allowed: row.allowed,
    reason: (row.reason as 'cooldown' | 'quota' | null) ?? null,
    retryAfterSec: row.retry_after_sec ?? 0,
  };
}

/* ────────────────────────────────────────────────────── pending codes ───── */

export type OtpOutcome = 'approved' | 'wrong' | 'burnt' | 'expired' | 'none';

/** Store a code's digest, replacing any earlier one for the same destination. */
export function putOtp(
  kind: 'email' | 'sms',
  keyHash: string,
  codeHashHex: string,
  ttlMs: number,
  attempts: number,
): Promise<null> {
  return rpc<null>('comitra_otp_put', {
    p_kind: kind,
    p_key: keyHash,
    p_hash_hex: codeHashHex,
    p_ttl_ms: ttlMs,
    p_attempts: attempts,
  });
}

/** Delete a code whose message failed to go out. */
export function dropOtp(kind: 'email' | 'sms', keyHash: string): Promise<null> {
  return rpc<null>('comitra_otp_drop', { p_kind: kind, p_key: keyHash });
}

/**
 * Check a code. Expiry, comparison, attempt decrement, single-use consumption
 * and burning an exhausted entry all happen inside one transaction under a row
 * lock, so concurrent guesses cannot each get a full five attempts.
 */
export async function checkOtp(
  kind: 'email' | 'sms',
  keyHash: string,
  codeHashHex: string,
): Promise<{ outcome: OtpOutcome; attemptsLeft: number }> {
  const rows = await rpc<Array<{ outcome: OtpOutcome; attempts_left: number }>>('comitra_otp_check', {
    p_kind: kind,
    p_key: keyHash,
    p_hash_hex: codeHashHex,
  });
  const row = rows?.[0];
  return { outcome: row?.outcome ?? 'none', attemptsLeft: row?.attempts_left ?? 0 };
}

/* ───────────────────────────────────────────────────────── send once ────── */

/** Claim an idempotency key before the network call. */
export async function claimSend(key: string): Promise<{ claimed: boolean; prior: unknown }> {
  const rows = await rpc<Array<{ claimed: boolean; prior: unknown }>>('comitra_send_claim', { p_key: key });
  const row = rows?.[0];
  return { claimed: row?.claimed ?? true, prior: row?.prior ?? null };
}

export function rememberSend(key: string, result: unknown): Promise<null> {
  return rpc<null>('comitra_send_remember', { p_key: key, p_result: result });
}

/** Release a claim whose send failed, so the caller may genuinely retry. */
export function releaseSend(key: string): Promise<null> {
  return rpc<null>('comitra_send_release', { p_key: key });
}

/* ─────────────────────────────────────────────────── password resets ────── */

/** Store a reset token's digest, retiring any earlier one for the address. */
export function putReset(tokenKey: string, email: string, ttlMs: number): Promise<null> {
  return rpc<null>('comitra_reset_put', { p_token_key: tokenKey, p_email: email, p_ttl_ms: ttlMs });
}

/**
 * Spend a reset token: verify, return the address it belongs to, and destroy it
 * in the same transaction so the link cannot be used twice.
 */
export async function consumeReset(
  tokenKey: string,
): Promise<{ outcome: 'ok' | 'none' | 'expired'; email: string | null }> {
  const rows = await rpc<Array<{ outcome: 'ok' | 'none' | 'expired'; email: string | null }>>(
    'comitra_reset_consume',
    { p_token_key: tokenKey },
  );
  const row = rows?.[0];
  return { outcome: row?.outcome ?? 'none', email: row?.email ?? null };
}

/**
 * Drop expired rows. Called opportunistically — there is no cron on the free
 * plan, and none is needed while every write path also prunes.
 */
export function sweep(): Promise<null> {
  return rpc<null>('comitra_state_sweep', {});
}
