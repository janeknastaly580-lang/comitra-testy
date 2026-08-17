/**
 * Comitra's backend, as one Edge Function.
 *
 * NAMED `api` ON PURPOSE. Supabase routes `/functions/v1/<name>/…` and passes
 * the whole path through, so a function called `api` sees exactly the paths the
 * Express server served — `/api/email/verify/start` and friends. That means
 * src/lib/email.ts needs no code change at all: only VITE_API_BASE moves, from
 * the old host to `<project>.supabase.co/functions/v1`.
 *
 * WHAT LIVES HERE NOW: the email routes it started with, plus the account
 * system — sign-up, log-in, sessions, and the per-account state document (see
 * `accounts.ts`). That last part is what makes an account portable: the app's
 * data is stored against the ACCOUNT here rather than in one browser's storage,
 * so logging in on a second device reaches the same goals.
 *
 * The `/api/email/*` routes are deliberately cookie-less and unauthenticated:
 * someone creating an account or accepting a judge invite has no session yet, so
 * there is nothing to require. `/api/auth/*` is the same
 * except where it obviously cannot be, and `/api/state/*` always requires a
 * session token. What protects the unauthenticated ones:
 *   • CORS, so only the app's own origins may call them from a browser;
 *   • a per-IP rate limit on each route (below);
 *   • a per-DESTINATION cooldown and quota in Postgres, which is what actually
 *     stops one address being bombed from many IPs;
 *   • server-owned content — no route accepts a subject or a body.
 * CSRF protection is not applicable: no cookie is read, so a forged cross-site
 * request gains an attacker nothing they could not do with curl.
 */

import { maskEmail, normalizeEmail } from './address.ts';
import {
  accountByEmail,
  accountForToken,
  createAccount,
  createSession,
  deleteAccount,
  dropSession,
  emailAvailable,
  getState,
  hashPassword,
  issueSignupTicket,
  putState,
  renameAccount,
  requireAccount,
  requireEmail,
  requirePassword,
  sessionTokenFrom,
  setAccountPassword,
  spendSignupTicket,
  upsertSocialAccount,
  verifyPassword,
  type Account,
} from './accounts.ts';
import {
  ALLOWED_ORIGINS,
  RESET_TEMPLATE_NAME,
  RESET_TEMPLATE_VAR,
  sesConfig,
} from './config.ts';
import { issueResetLink, redeemResetToken } from './reset.ts';
import { ApiError, failureBody } from './errors.ts';
import { verifyGoogleAccessToken } from './google.ts';
import {
  abandonCode,
  type CodePurpose,
  EMAIL_CODE_TTL_MS,
  hashKey,
  issueCode,
  looksLikeCode,
  verifyCode,
} from './otp.ts';
import { sendEmail } from './ses.ts';
import { passwordResetEmail, verificationCodeEmail } from './templates.ts';
import { rpc, sweep, takeSlot } from './state.ts';

/**
 * A real, throwaway PBKDF2 verifier that no password matches.
 *
 * Checked when a login names an address with no account, so that path costs the
 * same ~250k iterations as a wrong password on a real one. Without it, "no such
 * account" would answer noticeably faster than "wrong password" and the login
 * form would become a way to test who is registered.
 */
const DUMMY_HASH =
  'pbkdf2$250000$AAAAAAAAAAAAAAAAAAAAAA==$Y29taXRyYS1kdW1teS12ZXJpZmllci0wMDAwMDAwMDA=';

/** The per-destination limits. */
const LIMITS = {
  /** How soon a fresh code may be asked for. The app's button counts this down. */
  otpResendCooldownMs: 30_000,
  otpSendsPerHour: 5,
};

/* ─────────────────────────────────────────────────────────────── plumbing ── */

/**
 * The origins the native shell loads from.
 *
 * A Capacitor WebView is not a page on the app's domain: Android serves the
 * bundle from `https://localhost`, iOS from `capacitor://localhost`, and a
 * `file://` page sends the literal string `null`. Nobody deploying this could
 * put those in CLIENT_ORIGIN — they are not the app's address, they are the
 * WebView's — so leaving them out is exactly what makes a freshly built APK fail
 * every single request with a CORS error and look like a dead backend.
 *
 * Allowing them costs nothing: no route here reads a cookie, so a browser being
 * permitted to make the call grants an attacker nothing `curl` could not already
 * do. What actually protects the sensitive routes is the session token.
 */
const NATIVE_ORIGINS = [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
  'null',
];

function corsHeaders(origin: string | null): Record<string, string> {
  const from = (origin ?? '').replace(/\/+$/, '');
  const allow = NATIVE_ORIGINS.includes(from)
    ? from
    : ALLOWED_ORIGINS.length === 0
    // No CLIENT_ORIGIN configured: these routes carry no cookie, so a wildcard
    // grants a browser nothing curl could not already do. Still logged, because
    // it means the deployment is not finished.
    ? '*'
    : (from && ALLOWED_ORIGINS.includes(from) ? from : '');

  return {
    ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
    // `x-comitra-session` carries the app's own session token. It cannot ride in
    // `Authorization`, which Supabase's platform gate already owns.
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-comitra-session',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/** The caller's address, for per-IP limiting only. Never stored in the clear. */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  return fwd.split(',')[0].trim() || 'unknown';
}

/**
 * Per-IP gate. Kept a little loose: a university or a mobile carrier puts many
 * real users behind one address, so the per-destination cooldown is the limit
 * that matters and this one only blunts a flood from a single source.
 */
async function limitByIp(req: Request, bucket: string, max: number, windowMs: number): Promise<void> {
  const slot = await takeSlot(bucket, await hashKey('ip', clientIp(req)), { max, windowMs });
  if (!slot.allowed) {
    throw new ApiError(
      'rate-limited',
      'Too many attempts. Please wait a few minutes and try again.',
      429,
      `per-ip ${bucket} ${slot.reason}`,
    );
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object') throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new ApiError('bad-request', 'Invalid input.', 400, 'body was not JSON');
  }
}

/** Translate a per-destination throttle refusal into the wording people see. */
function throttleError(slot: { reason: string | null; retryAfterSec: number }, what: string): ApiError {
  return new ApiError(
    'rate-limited',
    slot.reason === 'cooldown'
      ? `A code was just sent. Wait ${slot.retryAfterSec}s before asking for another.`
      : `Too many codes requested for this ${what}. Try again later.`,
    429,
    `per-destination ${slot.reason}`,
  );
}

/* ──────────────────────────────────────────────────────────────── handlers ── */

/**
 * Which flow is asking for a code.
 *
 * Sign-up and the judge invite send the SAME email from the SAME template — the
 * six digits are all it contains — but they are separate codes: separate rows,
 * separate quotas, and a receipt only where one is needed. An unknown or missing
 * value means sign-up, which is what every older client sends.
 */
function purposeOf(raw: unknown): CodePurpose {
  return raw === 'judge' ? 'judge' : 'signup';
}

async function emailVerifyStart(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-email-verify', 20, 10 * 60_000);
  const body = await readJson(req);

  const to = normalizeEmail(body.email);
  if (!to) {
    throw new ApiError('bad-email', "That email address doesn't look right. Check it and try again.", 400, 'address failed validation before any SES call');
  }
  const purpose = purposeOf(body.purpose);

  // Local gate first: a rejected resend must not cost an SES request. The bucket
  // is per purpose, so accepting a judge invite is not blocked by a sign-up code
  // sent to the same address a moment earlier.
  const slot = await takeSlot(`email-otp-send:${purpose}`, await hashKey('email', to), {
    max: LIMITS.otpSendsPerHour,
    windowMs: 3600_000,
    cooldownMs: LIMITS.otpResendCooldownMs,
  });
  if (!slot.allowed) throw throttleError(slot, 'address');

  const { code, key } = await issueCode(purpose, to, EMAIL_CODE_TTL_MS);

  try {
    if (sesConfig.templateName) {
      // The email lives in SES. The ONLY thing handed to the template is the six
      // digits — no name, no address, nothing about a goal.
      await sendEmail({
        to,
        templateName: sesConfig.templateName,
        templateData: { [sesConfig.templateVar]: code },
      });
    } else {
      const { subject, text, html } = verificationCodeEmail(code);
      await sendEmail({ to, subject, text, html });
    }
  } catch (err) {
    // The email never went out, so a live code would strand the person on a code
    // they were never shown.
    await abandonCode(key);
    throw err;
  }

  console.info(`[email:verify-start] ${purpose} code requested for`, maskEmail(to));
  return { status: 'pending', to: maskEmail(to) };
}

async function emailVerifyCheck(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-email-verify', 20, 10 * 60_000);
  const body = await readJson(req);

  const to = normalizeEmail(body.email);
  if (!to) throw new ApiError('bad-email', "That email address doesn't look right.", 400, 'address failed validation');
  if (!looksLikeCode(body.code)) {
    throw new ApiError('invalid-code', "That code isn't right. It's the 6 digits from the email.", 400, 'code failed shape check');
  }
  const purpose = purposeOf(body.purpose);

  await verifyCode(purpose, to, String(body.code).trim());

  // The ticket is the RECEIPT for this check, and `register` demands one for the
  // same address. Without it the server would be taking the browser's word that
  // a code was ever typed, which would let anyone create a permanent account on
  // an address they don't own — harmless while accounts were local to a phone,
  // not harmless now that they are real and shared.
  //
  // A judge invite gets no ticket: it creates no account, and its registration
  // goes to the shared judge store, which has no ticket to spend.
  const ticket = purpose === 'signup' ? await issueSignupTicket(to) : undefined;
  console.info(`[email:verify-check] ${purpose} approved for`, maskEmail(to));
  return { approved: true, ticket };
}

/**
 * Email a password-reset link.
 *
 * Answers the same way whether or not an account exists. The server now KNOWS
 * (accounts live here), which is exactly why the sameness has to be deliberate:
 * a different answer for an unknown address would turn this form into a way of
 * discovering who is registered. The link is issued either way and simply finds
 * nothing to reset.
 *
 * Tighter limits than the sign-up code: 3 links an hour per address. A reset
 * mail is more alarming to receive unexpectedly, so it should be harder to use
 * as a way of pestering someone.
 */
async function emailResetStart(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-email-reset', 10, 10 * 60_000);
  const body = await readJson(req);

  const to = normalizeEmail(body.email);
  if (!to) {
    throw new ApiError('bad-email', "That email address doesn't look right. Check it and try again.", 400, 'address failed validation');
  }

  const slot = await takeSlot('email-reset-send', await hashKey('email', to), {
    max: 3,
    windowMs: 3600_000,
    cooldownMs: LIMITS.otpResendCooldownMs,
  });
  if (!slot.allowed) throw throttleError(slot, 'address');

  const { link } = await issueResetLink(to);

  if (RESET_TEMPLATE_NAME) {
    await sendEmail({ to, templateName: RESET_TEMPLATE_NAME, templateData: { [RESET_TEMPLATE_VAR]: link } });
  } else {
    const { subject, text, html } = passwordResetEmail(link);
    await sendEmail({ to, subject, text, html });
  }

  console.info('[email:reset-start] link sent to', maskEmail(to));
  return { status: 'sent', to: maskEmail(to) };
}

/**
 * Spend a reset token AND set the new password, in one call.
 *
 * One call rather than two on purpose: the token is single-use, so a "check the
 * link" step followed by a "save the password" step burns the link before the
 * person has typed anything, and any hiccup in between leaves them holding a
 * dead link and an unchanged password.
 *
 * Succeeding also signs the device in — the person has just proved they can
 * open the mailbox and chosen a password; making them immediately type it into
 * a login form proves nothing further.
 */
async function emailResetApply(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-email-reset', 10, 10 * 60_000);
  const body = await readJson(req);
  const password = requirePassword(body.password);

  const email = await redeemResetToken(body.token);
  const userId = await setAccountPassword(email, await hashPassword(password));
  if (!userId) {
    // The link was genuine but there is no account on that address — someone
    // asked for a reset before ever signing up. Say so: the alternative is a
    // "password changed" screen that changed nothing.
    throw new ApiError(
      'no-account',
      "There's no Comitra account for that address yet. Create one — it only takes a moment.",
      404,
      'reset token redeemed for an address with no account',
    );
  }

  // Every other session was just dropped by `setAccountPassword`, so this device
  // needs a fresh one.
  const token = await createSession(userId);
  const account = await accountByEmail(email);
  const state = await getState(userId);
  console.info('[email:reset-apply] password set for', maskEmail(email));
  return {
    token,
    user: account
      ? publicAccount(account)
      : { id: userId, email, name: '', accountType: 'standard', emailVerifiedAt: null },
    state,
  };
}

/* ────────────────────────────────────────────────────────────────── accounts ── */

/** The account fields the app needs; never the password verifier. */
function publicAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    accountType: account.accountType,
    emailVerifiedAt: account.emailVerifiedAt,
  };
}

/**
 * Is this address free? Asked BEFORE a verification code is sent, so someone
 * does not fill in the form, wait for an email and type six digits only to be
 * told the address was taken — and so the send is not wasted while SES is
 * capped at 200 messages a day.
 *
 * This answers for one address at a time behind a per-IP limit. It does reveal
 * whether an address is registered, which is unavoidable for a sign-up form:
 * `register` would reveal the same thing one step later.
 */
async function authAvailable(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-auth-available', 60, 10 * 60_000);
  const email = requireEmail((await readJson(req)).email);
  return { available: await emailAvailable(email) };
}

async function authRegister(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-auth-register', 10, 10 * 60_000);
  const body = await readJson(req);
  const email = requireEmail(body.email);
  const password = requirePassword(body.password);

  // A deployment with no SES settings has no code step at all, so there is no
  // ticket to demand. Where verification IS configured it is mandatory.
  if (sesConfig.configured) {
    await spendSignupTicket(body.ticket, email);
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const accountType = body.accountType === 'trainer' ? 'trainer' : 'standard';

  const id = await createAccount({
    email,
    name: name || 'Friend',
    passwordHash: await hashPassword(password),
    accountType,
    provider: 'password',
    emailVerified: sesConfig.configured,
  });

  const token = await createSession(id);
  console.info('[auth:register] account created for', maskEmail(email));
  return {
    token,
    user: {
      id,
      email,
      name: name || 'Friend',
      accountType,
      emailVerifiedAt: sesConfig.configured ? new Date().toISOString() : null,
    },
    state: { data: {}, revision: 0 },
  };
}

async function authLogin(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-auth-login', 30, 10 * 60_000);
  const body = await readJson(req);
  const email = requireEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  // Per-address as well as per-IP: an attacker with a botnet gets a fresh IP
  // budget for free, but only one budget per account they are trying to open.
  const slot = await takeSlot('auth-login', await hashKey('login', email), {
    max: 10,
    windowMs: 15 * 60_000,
  });
  if (!slot.allowed) {
    throw new ApiError('rate-limited', 'Too many attempts for this account. Wait a few minutes and try again.', 429, 'per-address login quota');
  }

  const account = await accountByEmail(email);
  // One wording for "no such account" and "wrong password", so this cannot be
  // used to enumerate who is registered — and the password is still verified
  // against a dummy hash when the account is missing, so the two paths take
  // comparably long.
  const ok = account
    ? await verifyPassword(password, account.passwordHash)
    : await verifyPassword(password, DUMMY_HASH);

  if (!account || !ok) {
    throw new ApiError('bad-credentials', 'Invalid email or password.', 401, account ? 'wrong password' : 'no account for address');
  }

  const token = await createSession(account.id);
  const state = await getState(account.id);
  console.info('[auth:login] signed in', maskEmail(email));
  return { token, user: publicAccount(account), state };
}

/**
 * Sign in with a provider that has already vouched for the address.
 *
 * THE TRUST BOUNDARY, which this route used to get wrong: it took the address
 * out of the request body and believed it, so posting somebody else's address
 * returned a session for their account — a complete takeover of any account, no
 * password, no code, using nothing but the publishable key that ships in the
 * APK. The address now comes from Google's own answer about the token the app
 * holds, and `body.email` is not read at all. See google.ts.
 */
async function authSocial(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-auth-social', 20, 10 * 60_000);
  const body = await readJson(req);

  // Google is asked who this token belongs to; the answer is the only identity
  // this route will accept.
  const identity = await verifyGoogleAccessToken(body.accessToken);
  const email = requireEmail(identity.email);
  // The display name is cosmetic and lives in the person's own profile, so the
  // client's version is fine — but Google's is the fallback, not the other way
  // round, and it is length-capped either way.
  const name = (typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '') || identity.name;

  const { id, created } = await upsertSocialAccount({ email, name, provider: 'google' });
  const token = await createSession(id);
  const state = await getState(id);
  console.info('[auth:social]', created ? 'account created for' : 'signed in', maskEmail(email));
  return { token, user: { id, email, name, accountType: 'standard', emailVerifiedAt: new Date().toISOString() }, created, state };
}

/** Who is this device signed in as, and what is their data? The boot call. */
async function authSession(req: Request): Promise<unknown> {
  const token = sessionTokenFrom(req);
  const account = token ? await accountForToken(token) : null;
  // Not an error: "nobody" is a perfectly good answer to "who is this?", and a
  // 401 here would make every cold start look like a failure.
  if (!account) return { user: null };
  return { user: publicAccount(account), state: await getState(account.id) };
}

async function authLogout(req: Request): Promise<unknown> {
  const token = sessionTokenFrom(req);
  if (token) await dropSession(token);
  return { ok: true };
}

async function authDelete(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  await deleteAccount(account.id);
  console.info('[auth:delete] account removed for', maskEmail(account.email));
  return { ok: true };
}

/**
 * Keep the account row's display name in step with the profile screen.
 *
 * The name the app shows comes from the state document; this copy exists so the
 * account row is not stale for anything that reads it without loading the whole
 * document — today that is the empty-state fallback on a fresh device.
 */
async function authRename(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (name) await renameAccount(account.id, name);
  return { ok: true };
}

/* ─────────────────────────────────────────────────────── state document ──── */

async function statePull(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  return await getState(account.id);
}

async function statePush(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  const body = await readJson(req);
  const revision = Number(body.revision);
  if (!Number.isFinite(revision)) {
    throw new ApiError('bad-request', 'Could not save your data.', 400, 'revision missing or not a number');
  }
  if (!body.data || typeof body.data !== 'object') {
    throw new ApiError('bad-request', 'Could not save your data.', 400, 'data missing or not an object');
  }
  return await putState(account.id, body.data, revision);
}

/* ──────────────────────────────────────── the shared store, behind a session ── */

/**
 * The judge list and the in-app inbox, moved here from the phone.
 *
 * WHY THEY MOVED. Both used to be RPCs the app called directly with the
 * publishable key, authorised by nothing but a user id passed as an argument.
 * That is fine against a stranger — ids are uuids — but friends know each
 * other's ids by design: that is how one of them sends the other a message. So
 * any friend could pull somebody else's whole inbox, or list the name and EMAIL
 * ADDRESS of every judge they had invited. An id is an address, not a password,
 * and it was being used as one.
 *
 * Here the id is not taken from the caller at all. It comes from the session
 * token, which is the one thing a person cannot get for somebody else, and the
 * SQL functions are no longer reachable with the publishable key.
 *
 * The one place an id still travels in a request is `reachable`, where the
 * question genuinely is about another person ("will this get through, or have
 * they deleted the app?"). It answers a single boolean about somebody the caller
 * is already messaging, and it needs a session of its own to ask.
 */

/** Rows come back from PostgREST as an array; a void RPC comes back as null. */
async function judgesList(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  const judges = await rpc<unknown[]>('comitra_list_invited_judges', { p_owner: account.id });
  return { judges: Array.isArray(judges) ? judges : [] };
}

function str(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

async function pushTouch(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  const body = await readJson(req);
  const deviceId = str(body.deviceId, 128);
  if (!deviceId) throw new ApiError('bad-request', 'Could not register this device.', 400, 'deviceId missing');
  await rpc<null>('comitra_push_touch_device', {
    p_user_id: account.id,
    p_device_id: deviceId,
    p_platform: str(body.platform, 16) || 'web',
  });
  return { ok: true };
}

async function pushReachable(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  const body = await readJson(req);
  const userId = str(body.userId, 128);
  if (!userId) throw new ApiError('bad-request', 'Could not check that.', 400, 'userId missing');
  const days = Number(body.days);
  const reachable = await rpc<boolean>('comitra_push_reachable', {
    p_user_id: userId,
    p_days: Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 365) : 30,
  });
  console.info('[push:reachable] asked by', account.id.slice(0, 8));
  return { reachable: reachable === true };
}

/**
 * Send one message.
 *
 * `from` is the session's account, never the body's: letting the sender name
 * themselves would make every message forgeable, and "your friend nudged you"
 * is exactly the sentence somebody would want to forge.
 */
async function pushSend(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  await limitByIp(req, 'ip-push-send', 120, 10 * 60_000);
  const body = await readJson(req);

  const id = str(body.id, 128);
  const toUserId = str(body.toUserId, 128);
  const kind = str(body.kind, 64);
  if (!id || !toUserId || !kind) {
    throw new ApiError('bad-request', "That message couldn't be sent.", 400, 'id, toUserId or kind missing');
  }
  if (!body.payload || typeof body.payload !== 'object') {
    throw new ApiError('bad-request', "That message couldn't be sent.", 400, 'payload was not an object');
  }

  await rpc<null>('comitra_push_send', {
    p_id: id,
    p_to_user_id: toUserId,
    p_from_user_id: account.id,
    p_kind: kind,
    p_payload: body.payload,
  });
  return { ok: true };
}

async function pushPull(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  const rows = await rpc<unknown[]>('comitra_push_pull', { p_user_id: account.id });
  return { messages: Array.isArray(rows) ? rows : [] };
}

async function pushRead(req: Request): Promise<unknown> {
  const account = await requireAccount(req);
  const body = await readJson(req);
  const id = str(body.id, 128);
  if (!id) throw new ApiError('bad-request', 'Could not mark that as read.', 400, 'id missing');
  await rpc<null>('comitra_push_mark_read', { p_id: id, p_user_id: account.id });
  return { ok: true };
}

/* ────────────────────────────────────────────────────────────────── router ── */

type Handler = (req: Request) => Promise<unknown>;

const ROUTES: Record<string, { method: string; handler: Handler; route: string }> = {
  'GET /api/health': { method: 'GET', route: 'health', handler: () => Promise.resolve({ ok: true }) },

  // Public and free of anything sensitive: one boolean, no region, no identity.
  // The app uses these to decide whether to show the code step at all.
  'GET /api/email/status': { method: 'GET', route: 'email-status', handler: () => Promise.resolve({ configured: sesConfig.configured }) },

  'POST /api/email/verify/start': { method: 'POST', route: 'email:verify-start', handler: emailVerifyStart },
  'POST /api/email/verify/check': { method: 'POST', route: 'email:verify-check', handler: emailVerifyCheck },
  'POST /api/email/reset/start': { method: 'POST', route: 'email:reset-start', handler: emailResetStart },
  'POST /api/email/reset/apply': { method: 'POST', route: 'email:reset-apply', handler: emailResetApply },

  // Accounts. `session` is the one the app calls on every cold start.
  'POST /api/auth/available': { method: 'POST', route: 'auth:available', handler: authAvailable },
  'POST /api/auth/register': { method: 'POST', route: 'auth:register', handler: authRegister },
  'POST /api/auth/login': { method: 'POST', route: 'auth:login', handler: authLogin },
  'POST /api/auth/social': { method: 'POST', route: 'auth:social', handler: authSocial },
  'GET /api/auth/session': { method: 'GET', route: 'auth:session', handler: authSession },
  'POST /api/auth/logout': { method: 'POST', route: 'auth:logout', handler: authLogout },
  'POST /api/auth/delete': { method: 'POST', route: 'auth:delete', handler: authDelete },
  'POST /api/auth/rename': { method: 'POST', route: 'auth:rename', handler: authRename },

  // The account's data. Both need a session token; neither takes a user id, so
  // there is no way to ask for somebody else's document.
  'POST /api/state/pull': { method: 'POST', route: 'state:pull', handler: statePull },
  'POST /api/state/push': { method: 'POST', route: 'state:push', handler: statePush },

  // The shared store. Same rule as /api/state/*: the account comes from the
  // session, so none of these can be pointed at somebody else. `reachable` is
  // the sole exception and returns one boolean about a person being messaged.
  'POST /api/judges/list': { method: 'POST', route: 'judges:list', handler: judgesList },
  'POST /api/push/touch': { method: 'POST', route: 'push:touch', handler: pushTouch },
  'POST /api/push/reachable': { method: 'POST', route: 'push:reachable', handler: pushReachable },
  'POST /api/push/send': { method: 'POST', route: 'push:send', handler: pushSend },
  'POST /api/push/pull': { method: 'POST', route: 'push:pull', handler: pushPull },
  'POST /api/push/read': { method: 'POST', route: 'push:read', handler: pushRead },
};

/** Refuse early, and in a way the frontend can tell apart from a failure. */
function requireConfigured(path: string): void {
  if (path.startsWith('/api/email/') && path !== '/api/email/status' && !sesConfig.configured) {
    throw new ApiError('email_not_configured', 'Email verification is not set up on this server yet.', 503);
  }
}

/** Prune expired rows now and then; there is no cron on the free plan. */
let lastSweep = 0;
function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  // Fire and forget: housekeeping must never delay someone's sign-up.
  sweep().catch((err) => console.warn('[sweep]', err.message));
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

  const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/api/health';
  const match = ROUTES[`${req.method} ${path}`];

  if (!match) return json({ error: 'Not found.', code: 'not-found' }, 404, origin);

  try {
    maybeSweep();
    requireConfigured(path);
    return json(await match.handler(req), 200, origin);
  } catch (err) {
    if (err instanceof ApiError) {
      return json(failureBody(err, match.route), err.httpStatus, origin);
    }
    // Unexpected: log the message only. An AWS exception can carry the
    // recipient, and a stack trace helps nobody in a browser.
    console.error(`[${match.route}] unexpected:`, (err as Error)?.message ?? err);
    return json({ error: 'Something went wrong. Please try again.', code: 'unknown' }, 500, origin);
  }
});
