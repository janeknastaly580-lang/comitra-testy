/**
 * Configuration, read from Edge Function secrets.
 *
 * The all-or-nothing rule from server/src/email/config.js is kept, with ONE
 * deliberate difference: an
 * Express process could refuse to boot on a half-filled block, and a serverless
 * function has no boot to refuse. So a half-filled block reports `configured:
 * false` plus `problems`, the feature answers 503, and the reason is logged —
 * loud, but never taking the whole endpoint down with it.
 */

/** Blank, or one of the placeholder styles this repo uses in its .env files. */
function isBlank(value: string | undefined): boolean {
  if (typeof value !== 'string') return true;
  const v = value.trim();
  return v === '' || v.startsWith('PASTE_') || v.startsWith('replace_with') || /^(your|xxx+|<.*>)$/i.test(v);
}

function env(name: string): string | undefined {
  return Deno.env.get(name) ?? undefined;
}

function clean(name: string): string | null {
  const v = env(name);
  return isBlank(v) ? null : v!.trim();
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
const TEMPLATE_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ────────────────────────────────────────────────────────── Amazon SES ──── */

export interface SesConfig {
  configured: boolean;
  problems: string[];
  region: string | null;
  fromEmail: string | null;
  fromName: string;
  replyTo: string | null;
  configurationSet: string | null;
  templateName: string | null;
  templateVar: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
}

function readSes(): SesConfig {
  const region = clean('SES_REGION');
  const fromEmail = clean('SES_FROM_EMAIL');
  const problems: string[] = [];

  const off: SesConfig = {
    configured: false, problems: [], region: null, fromEmail: null, fromName: 'Comitra',
    replyTo: null, configurationSet: null, templateName: null, templateVar: 'code',
    accessKeyId: null, secretAccessKey: null,
  };

  // Neither set: email verification is simply off. Not an error.
  if (!region && !fromEmail) return off;

  if (!region) problems.push('SES_REGION is empty.');
  if (!fromEmail) problems.push('SES_FROM_EMAIL is empty.');
  if (region && !REGION.test(region)) problems.push(`SES_REGION "${region}" is not an AWS region id.`);
  if (fromEmail && !EMAIL.test(fromEmail)) {
    problems.push(`SES_FROM_EMAIL "${fromEmail}" is not a bare address — put the display name in SES_FROM_NAME.`);
  }

  const accessKeyId = clean('AWS_ACCESS_KEY_ID');
  const secretAccessKey = clean('AWS_SECRET_ACCESS_KEY');
  // Unlike the Express version there is no instance role to fall back to, so
  // both keys are required here rather than optional.
  if (!accessKeyId || !secretAccessKey) {
    problems.push('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must both be set for an Edge Function.');
  }

  const templateVar = clean('SES_TEMPLATE_VAR') ?? 'code';
  if (!TEMPLATE_VAR.test(templateVar)) {
    // Caught here because SES does NOT fail on an unknown variable: it renders
    // an empty box where the code should be and reports success.
    problems.push(`SES_TEMPLATE_VAR "${templateVar}" is not a valid placeholder name.`);
  }

  const rawName = clean('SES_FROM_NAME') ?? '';
  // A quote or angle bracket could break out of the `Name <addr>` header.
  const fromName = !rawName || /["<>\r\n]/.test(rawName) ? 'Comitra' : rawName.slice(0, 60);

  if (problems.length > 0) return { ...off, problems };

  return {
    configured: true, problems: [], region, fromEmail, fromName,
    replyTo: clean('SES_REPLY_TO'),
    configurationSet: clean('SES_CONFIGURATION_SET'),
    templateName: clean('SES_TEMPLATE_NAME'),
    templateVar,
    accessKeyId, secretAccessKey,
  };
}

/* ───────────────────────────────────────────────────────────────── misc ──── */

/**
 * The pepper for OTP digests. It MUST come from a secret rather than being
 * generated per process: Edge Functions run as many isolates, and a per-isolate
 * pepper would mean a code issued by one isolate can never be verified by
 * another — failing for a random subset of people, intermittently.
 */
export const OTP_PEPPER = clean('COMITRA_OTP_PEPPER');

/**
 * Origins allowed to call this API from a browser. Comma-separated so a Vercel
 * preview deployment and a custom domain can both be listed — the Express
 * version allowed exactly one, which broke every preview build.
 */
export const ALLOWED_ORIGINS = (clean('CLIENT_ORIGIN') ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/**
 * Where password-reset links point.
 *
 * Deliberately NOT taken from the request's Origin header: that is attacker
 * controlled, and a reset link is the one email where sending someone to the
 * wrong host hands over their account. Falls back to the first configured
 * CLIENT_ORIGIN, and when neither is set the reset routes report themselves as
 * not configured rather than mailing a broken link.
 */
export const APP_URL = (clean('APP_URL') ?? ALLOWED_ORIGINS[0] ?? '').replace(/\/+$/, '') || null;

/**
 * The SES-hosted template for the reset email. Left blank by default so the
 * feature works before the template exists — set it to `comitra-password-reset`
 * once that template is created in SES, and the inline copy stops being used.
 */
export const RESET_TEMPLATE_NAME = clean('SES_RESET_TEMPLATE_NAME');
/** The `{{placeholder}}` the reset template uses for the link. */
export const RESET_TEMPLATE_VAR = clean('SES_RESET_TEMPLATE_VAR') ?? 'RESET_LINK';

export const sesConfig = readSes();

// Logged once per isolate. Problems are configuration mistakes, never secrets.
if (sesConfig.problems.length > 0) console.error('[config] SES half-configured:', sesConfig.problems.join(' | '));
if (!OTP_PEPPER) console.error('[config] COMITRA_OTP_PEPPER is not set — verification cannot run.');
