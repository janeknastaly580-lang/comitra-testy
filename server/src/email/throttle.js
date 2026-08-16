/**
 * Per-destination throttling and send-once bookkeeping.
 *
 * express-rate-limit already caps requests per IP, and `verify.js` caps the
 * guesses against one code. Neither covers the case this guards: the SAME
 * address hammered from many IPs, or the same message sent twice because a
 * request was retried. Every entry is keyed by a HASH of the address, never the
 * address itself, so a heap dump or a crash log holds no addresses.
 *
 * In-memory on purpose: the payments backend is a single process with a local
 * SQLite file, so there is no shared cache to reach for. Running more than one
 * instance would need this moved to Redis/SQLite — the limits below would then
 * be per-instance, which is a weaker guarantee, not a broken one.
 */
import { createHash, randomUUID } from 'node:crypto';

/** Salt so the stored key cannot be reversed by hashing candidate numbers. */
const KEY_SALT = randomUUID();

function keyFor(value) {
  return createHash('sha256').update(`${KEY_SALT}:${value}`).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------- limits ---- */

export const LIMITS = {
  /**
   * Minimum gap between two verification codes to the same address. Matches the
   * Edge Function's own cooldown and the countdown the app shows on its
   * "Resend code" button — three places that have to agree.
   */
  otpResendCooldownMs: 30_000,
  /** Codes emailed to one address per hour. */
  otpSendsPerHour: 5,
  /** How long a completed send is remembered for de-duplication. */
  dedupeTtlMs: 24 * 60 * 60 * 1000,
};

/* -------------------------------------------------------------- store ---- */

/** key -> { hits: number[], until?: number } */
const buckets = new Map();
/** idempotency key -> { at: number, result: unknown } */
const sends = new Map();

/** Drop expired entries so the maps cannot grow without bound. */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < 3600_000);
    if (bucket.hits.length === 0 && (!bucket.until || bucket.until <= now)) buckets.delete(key);
  }
  for (const [key, entry] of sends) {
    if (now - entry.at > LIMITS.dedupeTtlMs) sends.delete(key);
  }
}

let lastSweep = 0;
function maybeSweep(now) {
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    sweep(now);
  }
}

/**
 * Record an attempt against a named bucket for one destination.
 *
 * @returns {{allowed: true} | {allowed: false, reason: 'cooldown'|'quota', retryAfterSec: number}}
 */
export function takeSlot(bucketName, destination, { max, windowMs, cooldownMs = 0 }, now = Date.now()) {
  maybeSweep(now);
  const key = `${bucketName}:${keyFor(destination)}`;
  const bucket = buckets.get(key) ?? { hits: [] };

  const recent = bucket.hits.filter((t) => now - t < windowMs);

  if (cooldownMs > 0 && recent.length > 0) {
    const since = now - recent[recent.length - 1];
    if (since < cooldownMs) {
      return { allowed: false, reason: 'cooldown', retryAfterSec: Math.ceil((cooldownMs - since) / 1000) };
    }
  }
  if (recent.length >= max) {
    const retryMs = windowMs - (now - recent[0]);
    return { allowed: false, reason: 'quota', retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
  }

  recent.push(now);
  bucket.hits = recent;
  buckets.set(key, bucket);
  return { allowed: true };
}

/** Reset every counter. Tests only. */
export function resetThrottleForTests() {
  buckets.clear();
  sends.clear();
  lastSweep = 0;
}

/* ------------------------------------------------------- send-once ------- */

/**
 * Remember a send under an idempotency key so a retried request (double tap,
 * client retry, an at-least-once job) never puts a second text on someone's
 * phone. Returns the previous result when the key has already been used.
 */
export function rememberSend(idempotencyKey, result, now = Date.now()) {
  sends.set(idempotencyKey, { at: now, result });
}

/** The result of an earlier send under this key, or `undefined`. */
export function previousSend(idempotencyKey, now = Date.now()) {
  const entry = sends.get(idempotencyKey);
  if (!entry) return undefined;
  if (now - entry.at > LIMITS.dedupeTtlMs) {
    sends.delete(idempotencyKey);
    return undefined;
  }
  return entry.result;
}

/**
 * Claim an idempotency key before the network call, so two requests that arrive
 * at the same moment cannot both send. Returns false if already claimed.
 */
export function claimSend(idempotencyKey, now = Date.now()) {
  if (sends.has(idempotencyKey)) return false;
  sends.set(idempotencyKey, { at: now, result: { status: 'in_flight' } });
  return true;
}

/** Release a claim whose send failed, so the caller may genuinely retry. */
export function releaseSend(idempotencyKey) {
  const entry = sends.get(idempotencyKey);
  if (entry?.result?.status === 'in_flight') sends.delete(idempotencyKey);
}
