/**
 * The half of "push" that was missing: waking a phone that has Pactista closed.
 *
 * WHAT CAME BEFORE. A message was written to `comitra_push_inbox` and waited
 * there until its recipient next opened the app, which the app then turned into
 * a system notification itself (see `src/lib/localNotify.ts`). Correct, honest,
 * and useless for the one case that matters — the friend who is not looking at
 * Pactista, which is every friend, almost always. This hands the same message to
 * Firebase Cloud Messaging so it arrives while the app is shut.
 *
 * THE INBOX IS STILL THE RECORD. Everything here is best-effort and nothing here
 * may throw into a request: a push can be dropped by the network, refused at the
 * OS notification permission, or aimed at a handset that has been wiped, and in
 * every one of those cases the message must still be sitting in the inbox when
 * the person next opens the app. `notifyUser` therefore returns a count and
 * swallows its own failures into the log.
 *
 * ── Why this is hand-rolled ───────────────────────────────────────────────
 * The FCM v1 API wants an OAuth access token minted from a service account,
 * which means an RS256 JWT — about forty lines with WebCrypto, versus pulling
 * `firebase-admin` (and its transitive world) into a function whose cold start
 * is on the path of every sign-up. Same reasoning as `state.ts` not taking
 * supabase-js, and `aws.ts` signing SigV4 by hand.
 *
 * PRIVACY. A notification body is read off a lock screen by whoever is holding
 * the phone, so it carries less than the in-app message, never more: a name, a
 * goal NUMBER, and a sentence the server composed. Never a goal's title or
 * description, and never the text somebody typed into a chat.
 */

import { fcmConfig } from './config.ts';
import { rpc } from './state.ts';

/** Google is a third party on the request path; it must never hang a send. */
const TIMEOUT_MS = 6000;

/** How stale a device may be before its token is not worth trying. */
const TOKEN_MAX_AGE_DAYS = 60;

/** The notification channel MainActivity creates at startup. */
const ANDROID_CHANNEL = 'comitra_goals';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface PushNotification {
  title: string;
  body: string;
  /**
   * Collapses re-sends of the same logical event into one banner instead of a
   * stack of identical ones — the inbox id, or the chat thread id.
   */
  tag?: string;
  /** Handed to the app when it is opened from the notification. Ids only. */
  data?: Record<string, string>;
}

/* ────────────────────────────────────────────────────────────── wording ── */

/**
 * Somebody's public display name, for the sentence a notification shows.
 *
 * Taken from the directory rather than from the request: a sender who could
 * name themselves could put "Your bank" on a friend's lock screen. Only ever
 * used to word a message for a person who is already this sender's friend and
 * already sees that name in the app, and it never touches an address.
 *
 * A failure is not an error — "A friend" is a perfectly good notification, and
 * it is better than no notification at all.
 */
export async function senderName(userId: string): Promise<string> {
  try {
    const rows = await rpc<{ user_id: string; name: string }[]>('comitra_directory_get', { p_ids: [userId] });
    const raw = Array.isArray(rows) ? rows[0]?.name : '';
    // One line, bounded: a newline or a 300-character name in a notification is
    // somebody trying to draw a second line of UI on a lock screen.
    const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return name || 'A friend';
  } catch {
    return 'A friend';
  }
}

/* ─────────────────────────────────────────────────────────── access token ── */

interface CachedToken {
  value: string;
  /** Epoch ms. Deliberately short of the real expiry — see `accessToken`. */
  expiresAt: number;
}

/**
 * Cached per isolate, which is the right scope: an access token is not shared
 * state two isolates must agree on (unlike an OTP — see state.ts), it is a
 * bearer credential either of them can mint for itself. The worst case under a
 * cold start is one extra round trip to Google.
 */
let cached: CachedToken | null = null;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * A PEM private key as WebCrypto wants it.
 *
 * The newline-unescaping is not cosmetic: a PEM is multi-line, and every way of
 * getting one into an environment variable (a dashboard field, a `.env` line,
 * `supabase secrets set`) flattens each break into the two characters backslash
 * and n. A key that keeps them is the single most common reason this whole file
 * appears broken.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    console.error('[fcm] request failed:', (err as Error)?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An OAuth access token for the service account, minted from a self-signed JWT.
 *
 * The cache expires a minute early on purpose. A token Google considers valid
 * for one more second is not worth the request it is about to be spent on, and
 * the failure it causes — a 401 on a notification nobody is waiting for — is
 * invisible, and therefore never debugged.
 */
async function accessToken(): Promise<string | null> {
  if (!fcmConfig.configured) return null;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: fcmConfig.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson(claims)}`;

  let assertion: string;
  try {
    const key = await importPrivateKey(fcmConfig.privateKey as string);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(unsigned),
    );
    assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;
  } catch (err) {
    // Nearly always the key itself — wrong format, or its newlines lost.
    console.error('[fcm] could not sign with FCM_PRIVATE_KEY:', (err as Error)?.message ?? err);
    return null;
  }

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res) return null;
  if (!res.ok) {
    // Names the reason — "invalid_grant" for a revoked key or a clock skew, a
    // 400 for a service account deleted out from under us — and no secret.
    console.error('[fcm] token endpoint refused:', res.status, await res.text().catch(() => ''));
    return null;
  }

  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!json?.access_token) return null;
  cached = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max((json.expires_in ?? 3600) - 60, 30) * 1000,
  };
  return cached.value;
}

/* ────────────────────────────────────────────────────────────────── send ── */

/** Did FCM say this token is dead, rather than that the send went wrong? */
function isDeadToken(status: number, body: string): boolean {
  if (status === 404) return true;
  return status === 400 && /INVALID_ARGUMENT/.test(body) && /token/i.test(body);
}

async function sendToToken(token: string, bearer: string, message: PushNotification): Promise<boolean> {
  const res = await fetchWithTimeout(
    `https://fcm.googleapis.com/v1/projects/${fcmConfig.projectId}/messages:send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          android: {
            // These are a handful a week, each one the reason the app is
            // installed at all — not a feed.
            priority: 'HIGH',
            notification: {
              channel_id: ANDROID_CHANNEL,
              ...(message.tag ? { tag: message.tag } : {}),
            },
          },
          data: message.data ?? {},
        },
      }),
    },
  );
  if (!res) return false;
  if (res.ok) return true;

  const detail = await res.text().catch(() => '');
  if (isDeadToken(res.status, detail)) {
    // An uninstall, a wipe, or a token FCM has rotated. Forgetting it is what
    // stops the same doomed send being retried for months.
    console.info('[fcm] dropping dead token');
    try {
      await rpc<null>('comitra_push_drop_token', { p_token: token });
    } catch { /* the row stays; the next send drops it instead */ }
    return false;
  }
  console.error('[fcm] send failed:', res.status, detail.slice(0, 300));
  return false;
}

/**
 * Push one notification to every device an account still has.
 *
 * Returns how many FCM accepted — which means "handed over", not "seen".
 * Callers use it for the log and nothing else: the sender's screen keeps
 * reporting reachability from `comitra_push_reachable`, because a push Google
 * accepted is still not a promise that a person read anything.
 */
export async function notifyUser(userId: string, message: PushNotification): Promise<number> {
  if (!fcmConfig.configured || !userId) return 0;
  try {
    const bearer = await accessToken();
    if (!bearer) return 0;

    const tokens = await rpc<string[]>('comitra_push_tokens_for', {
      p_user_id: userId,
      p_days: TOKEN_MAX_AGE_DAYS,
    });
    const list = Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string' && t.length > 0) : [];
    if (list.length === 0) return 0;

    const results = await Promise.all(list.map((token) => sendToToken(token, bearer, message)));
    return results.filter(Boolean).length;
  } catch (err) {
    // Reached only by something unforeseen; every expected failure above is
    // already handled. A notification is never worth failing a request over.
    console.error('[fcm] notify failed:', (err as Error)?.message ?? err);
    return 0;
  }
}
