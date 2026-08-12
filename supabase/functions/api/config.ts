/**
 * Configuration, read from Edge Function secrets.
 *
 * The all-or-nothing rule from server/src/email/config.js and
 * server/src/twilio/config.js is kept, with ONE deliberate difference: an
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

const SID_PATTERNS: Record<string, RegExp> = {
  TWILIO_ACCOUNT_SID: /^AC[0-9a-fA-F]{32}$/,
  TWILIO_API_KEY_SID: /^SK[0-9a-fA-F]{32}$/,
  TWILIO_MESSAGING_SERVICE_SID: /^MG[0-9a-fA-F]{32}$/,
};

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

/* ─────────────────────────────────────────────────────────────── Twilio ──── */

export interface TwilioConfig {
  configured: boolean;
  problems: string[];
  accountSid: string | null;
  apiKeySid: string | null;
  apiKeySecret: string | null;
  messagingServiceSid: string | null;
  statusCallbackUrl: string | null;
}

const TWILIO_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_MESSAGING_SERVICE_SID',
];

function readTwilio(): TwilioConfig {
  const off: TwilioConfig = {
    configured: false, problems: [], accountSid: null, apiKeySid: null,
    apiKeySecret: null, messagingServiceSid: null, statusCallbackUrl: null,
  };

  const present = TWILIO_KEYS.filter((k) => !isBlank(env(k)));
  if (present.length === 0) return off;

  const problems: string[] = [];
  for (const key of TWILIO_KEYS) {
    const value = clean(key);
    if (!value) {
      problems.push(`${key} is empty.`);
      continue;
    }
    const pattern = SID_PATTERNS[key];
    // The value itself is never echoed: a wrong paste is often a real secret.
    if (pattern && !pattern.test(value)) problems.push(`${key} does not look like the right Twilio id.`);
  }

  const secret = clean('TWILIO_API_KEY_SECRET');
  if (secret && /^(AC|SK|VA|MG)[0-9a-fA-F]{32}$/.test(secret)) {
    problems.push('TWILIO_API_KEY_SECRET looks like a SID, not the API Key Secret.');
  }

  if (problems.length > 0) return { ...off, problems };

  return {
    configured: true, problems: [],
    accountSid: clean('TWILIO_ACCOUNT_SID'),
    apiKeySid: clean('TWILIO_API_KEY_SID'),
    apiKeySecret: secret,
    messagingServiceSid: clean('TWILIO_MESSAGING_SERVICE_SID'),
    statusCallbackUrl: clean('TWILIO_STATUS_CALLBACK_URL'),
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

export const sesConfig = readSes();
export const twilioConfig = readTwilio();

// Logged once per isolate. Problems are configuration mistakes, never secrets.
if (sesConfig.problems.length > 0) console.error('[config] SES half-configured:', sesConfig.problems.join(' | '));
if (twilioConfig.problems.length > 0) console.error('[config] Twilio half-configured:', twilioConfig.problems.join(' | '));
if (!OTP_PEPPER) console.error('[config] COMITRA_OTP_PEPPER is not set — verification cannot run.');
