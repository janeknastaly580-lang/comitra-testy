/**
 * Comitra's backend, as one Edge Function.
 *
 * NAMED `api` ON PURPOSE. Supabase routes `/functions/v1/<name>/…` and passes
 * the whole path through, so a function called `api` sees exactly the paths the
 * Express server served — `/api/email/verify/start` and friends. That means
 * src/lib/email.ts and src/lib/sms.ts need no code change at all: only
 * VITE_API_BASE moves, from the old host to `<project>.supabase.co/functions/v1`.
 *
 * WHAT LIVES HERE NOW: the email/SMS routes it started with, plus the account
 * system — sign-up, log-in, sessions, and the per-account state document (see
 * `accounts.ts`). That last part is what makes an account portable: the app's
 * data is stored against the ACCOUNT here rather than in one browser's storage,
 * so logging in on a second device reaches the same goals.
 *
 * The `/api/email/*` and `/api/sms/*` routes are deliberately cookie-less and
 * unauthenticated: someone creating an account or accepting a judge invite has
 * no session yet, so there is nothing to require. `/api/auth/*` is the same
 * except where it obviously cannot be, and `/api/state/*` always requires a
 * session token. What protects the unauthenticated ones:
 *   • CORS, so only the app's own origins may call them from a browser;
 *   • a per-IP rate limit on each route (below);
 *   • a per-DESTINATION cooldown and quota in Postgres, which is what actually
 *     stops one address or number being bombed from many IPs;
 *   • server-owned content — no route accepts a subject or a body.
 * CSRF protection is not applicable: no cookie is read, so a forged cross-site
 * request gains an attacker nothing they could not do with curl.
 */

import { maskEmail, maskPhone, normalizeE164, normalizeEmail } from './address.ts';
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
  twilioConfig,
} from './config.ts';
import { issueResetLink, redeemResetToken } from './reset.ts';
import { ApiError, failureBody } from './errors.ts';
import {
  abandonCode,
  EMAIL_CODE_TTL_MS,
  hashKey,
  issueCode,
  looksLikeCode,
  SMS_CODE_TTL_MS,
  verifyCode,
} from './otp.ts';
import { sendEmail } from './ses.ts';
import { sendSmsBody } from './twilio.ts';
import {
  passwordResetEmail,
  renderTemplate,
  TEMPLATE_IDS,
  verificationCodeEmail,
  verificationCodeMessage,
} from './templates.ts';
import { claimSend, rememberSend, releaseSend, sweep, takeSlot } from './state.ts';

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

/** The per-destination limits, unchanged from server/src/twilio/throttle.js. */
const LIMITS = {
  otpResendCooldownMs: 60_000,
  otpSendsPerHour: 5,
  smsPerHourPerNumber: 10,
};

/* ─────────────────────────────────────────────────────────────── plumbing ── */

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = ALLOWED_ORIGINS.length === 0
    // No CLIENT_ORIGIN configured: these routes carry no cookie, so a wildcard
    // grants a browser nothing curl could not already do. Still logged, because
    // it means the deployment is not finished.
    ? '*'
    : (origin && ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, '')) ? origin : '');

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

async function emailVerifyStart(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-email-verify', 20, 10 * 60_000);
  const body = await readJson(req);

  const to = normalizeEmail(body.email);
  if (!to) {
    throw new ApiError('bad-email', "That email address doesn't look right. Check it and try again.", 400, 'address failed validation before any SES call');
  }

  // Local gate first: a rejected resend must not cost an SES request.
  const slot = await takeSlot('email-otp-send', await hashKey('email', to), {
    max: LIMITS.otpSendsPerHour,
    windowMs: 3600_000,
    cooldownMs: LIMITS.otpResendCooldownMs,
  });
  if (!slot.allowed) throw throttleError(slot, 'address');

  const { code, key } = await issueCode('email', to, EMAIL_CODE_TTL_MS);

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
    await abandonCode('email', key);
    throw err;
  }

  console.info('[email:verify-start] code requested for', maskEmail(to));
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

  await verifyCode('email', to, String(body.code).trim());

  // The ticket is the RECEIPT for this check, and `register` demands one for the
  // same address. Without it the server would be taking the browser's word that
  // a code was ever typed, which would let anyone create a permanent account on
  // an address they don't own — harmless while accounts were local to a phone,
  // not harmless now that they are real and shared.
  const ticket = await issueSignupTicket(to);
  console.info('[email:verify-check] approved for', maskEmail(to));
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
 * NOTE the trust boundary: the browser is telling us which address Google
 * returned, and this route believes it. That is the same trust the app placed in
 * it before, but it is now enough to open a real account, so this should verify
 * Google's ID token server-side before the app is used by anyone who is not the
 * author. Left as-is deliberately rather than half-done — see google.ts.
 */
async function authSocial(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-auth-social', 20, 10 * 60_000);
  const body = await readJson(req);
  const email = requireEmail(body.email);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';

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

async function smsVerifyStart(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-sms-verify', 20, 10 * 60_000);
  const body = await readJson(req);

  const to = normalizeE164(body.phone);
  if (!to) {
    throw new ApiError('bad-phone', "That phone number doesn't look right. Include the country code, then try again.", 400, 'phone failed E.164 validation before any Twilio call');
  }

  const slot = await takeSlot('otp-send', await hashKey('sms', to), {
    max: LIMITS.otpSendsPerHour,
    windowMs: 3600_000,
    cooldownMs: LIMITS.otpResendCooldownMs,
  });
  if (!slot.allowed) throw throttleError(slot, 'number');

  const { code, key } = await issueCode('sms', to, SMS_CODE_TTL_MS);

  try {
    await sendSmsBody({ to, body: verificationCodeMessage(code) });
  } catch (err) {
    await abandonCode('sms', key);
    throw err;
  }

  console.info('[sms:verify-start] code requested for', maskPhone(to));
  return { status: 'pending', to: maskPhone(to) };
}

async function smsVerifyCheck(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-sms-verify', 20, 10 * 60_000);
  const body = await readJson(req);

  const to = normalizeE164(body.phone);
  if (!to) throw new ApiError('bad-phone', "That phone number doesn't look right.", 400, 'phone failed E.164 validation');
  if (!looksLikeCode(body.code)) {
    throw new ApiError('invalid-code', "That code isn't right. It's the 6 digits from the text message.", 400, 'code failed shape check');
  }

  await verifyCode('sms', to, String(body.code).trim());
  console.info('[sms:verify-check] approved for', maskPhone(to));
  return { approved: true };
}

/**
 * Send a transactional text. The caller names a TEMPLATE and supplies
 * parameters; the body is composed here. `idempotencyKey` must be stable for one
 * logical message (the outbox entry id), which is what makes a retry safe.
 */
async function smsSend(req: Request): Promise<unknown> {
  await limitByIp(req, 'ip-sms-send', 20, 60_000);
  const body = await readJson(req);

  const to = normalizeE164(body.to);
  if (!to) throw new ApiError('bad-phone', "That phone number doesn't look right.", 400, 'recipient failed E.164 validation');

  const template = typeof body.template === 'string' ? body.template.trim() : '';
  if (!TEMPLATE_IDS.includes(template)) {
    throw new ApiError('bad-request', "We couldn't build that message.", 400, `unknown template "${template}"`);
  }

  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (key.length < 8 || key.length > 128) {
    throw new ApiError('bad-request', 'Missing message id.', 400, 'idempotencyKey missing or wrong length');
  }

  const rendered = renderTemplate(template, (body.params as Record<string, unknown>) ?? {});
  if (!rendered) {
    throw new ApiError('bad-request', "We couldn't build that message.", 400, `template "${template}" produced no usable body`);
  }

  // Claim before the network call so two simultaneous requests cannot both send.
  const claim = await claimSend(key);
  if (!claim.claimed) {
    const prior = (claim.prior ?? {}) as { status?: string };
    return { status: prior.status ?? 'duplicate', duplicate: true };
  }

  const slot = await takeSlot('sms-send', await hashKey('sms', to), {
    max: LIMITS.smsPerHourPerNumber,
    windowMs: 3600_000,
  });
  if (!slot.allowed) {
    await releaseSend(key);
    throw new ApiError('rate-limited', 'Too many messages to that number. Try again later.', 429, 'per-destination sms-send quota');
  }

  try {
    const result = await sendSmsBody({ to, body: rendered });
    await rememberSend(key, result);
    console.info('[sms:send]', { to: maskPhone(to), template, sid: result.sid, status: result.status });
    return { status: result.status, duplicate: false };
  } catch (err) {
    // A failed attempt must not burn the key — the caller is allowed to retry.
    await releaseSend(key);
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────────── router ── */

type Handler = (req: Request) => Promise<unknown>;

const ROUTES: Record<string, { method: string; handler: Handler; route: string }> = {
  'GET /api/health': { method: 'GET', route: 'health', handler: () => Promise.resolve({ ok: true }) },

  // Public and free of anything sensitive: one boolean, no region, no identity.
  // The app uses these to decide whether to show the code step at all.
  'GET /api/email/status': { method: 'GET', route: 'email-status', handler: () => Promise.resolve({ configured: sesConfig.configured }) },
  'GET /api/sms/status': { method: 'GET', route: 'sms-status', handler: () => Promise.resolve({ configured: twilioConfig.configured }) },

  'POST /api/email/verify/start': { method: 'POST', route: 'email:verify-start', handler: emailVerifyStart },
  'POST /api/email/verify/check': { method: 'POST', route: 'email:verify-check', handler: emailVerifyCheck },
  'POST /api/email/reset/start': { method: 'POST', route: 'email:reset-start', handler: emailResetStart },
  'POST /api/email/reset/apply': { method: 'POST', route: 'email:reset-apply', handler: emailResetApply },
  'POST /api/sms/verify/start': { method: 'POST', route: 'sms:verify-start', handler: smsVerifyStart },
  'POST /api/sms/verify/check': { method: 'POST', route: 'sms:verify-check', handler: smsVerifyCheck },
  'POST /api/sms/send': { method: 'POST', route: 'sms:send', handler: smsSend },

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
};

/** Refuse early, and in a way the frontend can tell apart from a failure. */
function requireConfigured(path: string): void {
  if (path.startsWith('/api/email/') && path !== '/api/email/status' && !sesConfig.configured) {
    throw new ApiError('email_not_configured', 'Email verification is not set up on this server yet.', 503);
  }
  if (path.startsWith('/api/sms/') && path !== '/api/sms/status' && !twilioConfig.configured) {
    throw new ApiError('sms_not_configured', 'Text messaging is not set up on this server yet.', 503);
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
    // Unexpected: log the message only. An AWS or Twilio exception can carry the
    // recipient, and a stack trace helps nobody in a browser.
    console.error(`[${match.route}] unexpected:`, (err as Error)?.message ?? err);
    return json({ error: 'Something went wrong. Please try again.', code: 'unknown' }, 500, origin);
  }
});
