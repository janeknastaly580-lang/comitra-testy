import '../env.js';

/**
 * Amazon SES configuration: read from the environment, validated once, never
 * hardcoded and never logged.
 *
 * What SES needs from us:
 *   • a REGION — SES is regional, and an identity verified in eu-central-1 does
 *     not exist in us-east-1, so the wrong region looks exactly like "the domain
 *     isn't verified";
 *   • a FROM address on a domain (or address) verified in that region. This is
 *     the only sender the app ever uses, so no route can choose one;
 *   • credentials, and these are OPTIONAL here on purpose. When the two AWS key
 *     variables are left blank the SDK's default provider chain takes over —
 *     an EC2/ECS/Lambda IAM role, `~/.aws/credentials`, SSO. That is the safer
 *     deployment, so it must not require inventing a long-lived access key.
 *
 * All-or-nothing on the two required names:
 *   • nothing set   → email verification is OFF. `/api/email/*` answers 503 and
 *     sign-up falls back to creating the account without a code. Server boots.
 *   • partially set → the process refuses to boot, naming what is wrong. A
 *     half-configured mailer fails at the worst moment (someone waiting for
 *     their sign-up code), so it is caught at start-up instead.
 */

/** Both must be present for SES to be considered configured. */
export const EMAIL_ENV_KEYS = ['SES_REGION', 'SES_FROM_EMAIL'];

/** AWS region ids: `eu-central-1`, `us-east-2`, `ap-southeast-1`… */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * Deliberately loose: the authority on whether an address is real is SES, which
 * will reject it. This only catches "obviously not an address" before it costs
 * an API call — no `@`, spaces, a display name pasted in with the address.
 */
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

/**
 * The `{{placeholder}}` a SES-hosted template uses for the six digits, when
 * `SES_TEMPLATE_VAR` does not say otherwise. `code` is the obvious name and the
 * one SES_SETUP.md tells people to use.
 */
const DEFAULT_TEMPLATE_VAR = 'code';

/** A Handlebars-safe identifier — what SES accepts between `{{` and `}}`. */
const TEMPLATE_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Blank, or one of the placeholder styles this repo uses in its .env.example files. */
function isBlank(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim();
  return (
    v === '' ||
    v.startsWith('PASTE_') ||
    v.startsWith('replace_with') ||
    /^(your|xxx+|<.*>)$/i.test(v)
  );
}

/**
 * Pure parser: turns a plain env object into the resolved SES config. Exported
 * and side-effect free so it can be unit tested without touching `process.env`.
 *
 * @returns {{configured: boolean, problems: string[], region?: string,
 *   fromEmail?: string, fromName: string, replyTo: string|null,
 *   configurationSet: string|null, accessKeyId: string|null,
 *   secretAccessKey: string|null, templateName: string|null,
 *   templateVar: string}}
 */
export function parseEmailEnv(env = {}) {
  const present = EMAIL_ENV_KEYS.filter((key) => !isBlank(env[key]));

  // Nothing filled in: email verification is simply off. Not an error.
  if (present.length === 0) {
    return {
      configured: false,
      problems: [],
      fromName: 'Pactista',
      replyTo: null,
      configurationSet: null,
      accessKeyId: null,
      secretAccessKey: null,
      templateName: null,
      templateVar: DEFAULT_TEMPLATE_VAR,
    };
  }

  const problems = [];
  for (const key of EMAIL_ENV_KEYS) {
    if (isBlank(env[key])) problems.push(`${key} is empty — fill it in (see SES_SETUP.md).`);
  }

  const region = (env.SES_REGION ?? '').trim();
  if (region && !REGION.test(region)) {
    problems.push(`SES_REGION "${region}" is not an AWS region id (e.g. eu-central-1).`);
  }

  const fromEmail = (env.SES_FROM_EMAIL ?? '').trim();
  if (fromEmail && !EMAIL.test(fromEmail)) {
    // The address is not a secret, so naming it here is the fastest way to spot
    // that a display name ("Pactista <no-reply@…>") was pasted in whole.
    problems.push(
      `SES_FROM_EMAIL "${fromEmail}" is not a bare email address. ` +
        'Put the display name in SES_FROM_NAME instead.',
    );
  }

  const replyToRaw = (env.SES_REPLY_TO ?? '').trim();
  const replyTo = isBlank(replyToRaw) ? null : replyToRaw;
  if (replyTo && !EMAIL.test(replyTo)) {
    problems.push(`SES_REPLY_TO "${replyTo}" is not a bare email address.`);
  }

  // Access keys are optional, but half a key pair is always a mistake: the SDK
  // would silently fall through to the default chain and fail far from here.
  const accessKeyId = isBlank(env.AWS_ACCESS_KEY_ID) ? null : env.AWS_ACCESS_KEY_ID.trim();
  const secretAccessKey = isBlank(env.AWS_SECRET_ACCESS_KEY) ? null : env.AWS_SECRET_ACCESS_KEY.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    problems.push(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together, or both ' +
        'left empty to use the instance role / AWS profile.',
    );
  }

  const rawName = (env.SES_FROM_NAME ?? '').trim();
  // A display name with a quote or an angle bracket could break out of the
  // `Name <addr>` header, so anything unsafe is dropped rather than escaped.
  const fromName = !rawName || /["<>\r\n]/.test(rawName) ? 'Pactista' : rawName.slice(0, 60);

  const configurationSetRaw = (env.SES_CONFIGURATION_SET ?? '').trim();
  const configurationSet = isBlank(configurationSetRaw) ? null : configurationSetRaw;

  // A SES-hosted template. When set, the subject and both bodies come from AWS
  // and this server sends only the six digits — see send.js. Left blank, the
  // built-in copy in templates.js is used instead, so a deployment that never
  // created a template still sends a usable email.
  const templateNameRaw = (env.SES_TEMPLATE_NAME ?? '').trim();
  const templateName = isBlank(templateNameRaw) ? null : templateNameRaw;

  const templateVarRaw = (env.SES_TEMPLATE_VAR ?? '').trim();
  const templateVar = isBlank(templateVarRaw) ? DEFAULT_TEMPLATE_VAR : templateVarRaw;
  if (!TEMPLATE_VAR.test(templateVar)) {
    // Caught here rather than at send time: a bad name means SES substitutes
    // nothing and the person receives an email with an empty box where the
    // code should be — which looks like "the code never arrived".
    problems.push(
      `SES_TEMPLATE_VAR "${templateVar}" is not a valid placeholder name. ` +
        'Use the bare word from between {{ and }} in your template, e.g. code.',
    );
  }

  const base = {
    problems,
    fromName,
    replyTo,
    configurationSet,
    accessKeyId,
    secretAccessKey,
    templateName,
    templateVar,
  };

  if (problems.length > 0) return { configured: false, ...base };

  return { configured: true, region, fromEmail, ...base };
}

const parsed = parseEmailEnv(process.env);

if (parsed.problems.length > 0) {
  throw new Error(
    'Amazon SES is half-configured, so sign-up codes would fail at run time. Fix these ' +
      `in .env (see SES_SETUP.md):\n  - ${parsed.problems.join('\n  - ')}\n` +
      'Or clear every SES_* value to run with email verification switched off.',
  );
}

/** Whether real emails can be sent is `emailConfig.configured`; the rest of the
 * server asks `client.js#isEmailConfigured()` rather than reading it directly. */
export const emailConfig = parsed;
