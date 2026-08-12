/**
 * Comitra's backend, as one Edge Function.
 *
 * NAMED `api` ON PURPOSE. Supabase routes `/functions/v1/<name>/…` and passes
 * the whole path through, so a function called `api` sees exactly the paths the
 * Express server served — `/api/email/verify/start` and friends. That means
 * src/lib/email.ts and src/lib/sms.ts need no code change at all: only
 * VITE_API_BASE moves, from the old host to `<project>.supabase.co/functions/v1`.
 *
 * These endpoints are deliberately cookie-less and unauthenticated: someone
 * creating an account or accepting a judge invite has no session yet, so there
 * is nothing to require. What protects them instead:
 *   • CORS, so only the app's own origins may call them from a browser;
 *   • a per-IP rate limit on each route (below);
 *   • a per-DESTINATION cooldown and quota in Postgres, which is what actually
 *     stops one address or number being bombed from many IPs;
 *   • server-owned content — no route accepts a subject or a body.
 * CSRF protection is not applicable: no cookie is read, so a forged cross-site
 * request gains an attacker nothing they could not do with curl.
 */

import { maskEmail, maskPhone, normalizeE164, normalizeEmail } from './address.ts';
import { ALLOWED_ORIGINS, sesConfig, twilioConfig } from './config.ts';
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
import { renderTemplate, TEMPLATE_IDS, verificationCodeEmail, verificationCodeMessage } from './templates.ts';
import { claimSend, rememberSend, releaseSend, sweep, takeSlot } from './state.ts';

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
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
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
      await sendEmail({ to, templateData: { [sesConfig.templateVar]: code } });
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
  console.info('[email:verify-check] approved for', maskEmail(to));
  return { approved: true };
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
  'POST /api/sms/verify/start': { method: 'POST', route: 'sms:verify-start', handler: smsVerifyStart },
  'POST /api/sms/verify/check': { method: 'POST', route: 'sms:verify-check', handler: smsVerifyCheck },
  'POST /api/sms/send': { method: 'POST', route: 'sms:send', handler: smsSend },
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
