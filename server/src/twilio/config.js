import '../env.js';

/**
 * Twilio configuration: read from the environment, validated once, never
 * hardcoded and never logged.
 *
 * Credential model (Twilio's current recommendation):
 *   • API Key SID + API Key Secret authenticate every REST call. They can be
 *     revoked on their own, so the Account's master credentials are not spread
 *     across servers. The Account SID identifies which account the key acts on.
 *   • A Messaging Service is the sender for everything this app texts —
 *     verification codes and transactional notices alike. No Verify Service is
 *     involved: the one-time codes are issued and checked by `verify.js`.
 *   • The Auth Token is OPTIONAL and used for one thing only: recomputing the
 *     `X-Twilio-Signature` HMAC on incoming webhooks. It never authenticates an
 *     outgoing request, so an account that does not use delivery receipts does
 *     not need it at all.
 *
 * All-or-nothing on the four required names:
 *   • nothing set  → SMS is switched OFF. The API answers 503 on the SMS routes
 *     and the app falls back to its no-SMS behaviour. The server still boots.
 *   • partially set → the process refuses to boot, naming exactly what is
 *     missing or malformed. A half-configured SMS stack fails at the worst
 *     possible moment (someone waiting for a login code), so it is caught here.
 */

/** Sid prefixes Twilio guarantees, used to catch a value pasted into the wrong slot. */
const SID_PATTERNS = {
  TWILIO_ACCOUNT_SID: /^AC[0-9a-fA-F]{32}$/,
  TWILIO_API_KEY_SID: /^SK[0-9a-fA-F]{32}$/,
  TWILIO_MESSAGING_SERVICE_SID: /^MG[0-9a-fA-F]{32}$/,
};

/** Every name that must be present together for Twilio to be considered configured. */
export const TWILIO_ENV_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_MESSAGING_SERVICE_SID',
];

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
 * A status callback must be a URL Twilio can reach from the public internet.
 * `http://localhost…` is allowed so the flow can be exercised with a tunnel or
 * a local Twilio test; anything else must be https.
 */
function validateCallbackUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'TWILIO_STATUS_CALLBACK_URL is not a valid absolute URL.';
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    return 'TWILIO_STATUS_CALLBACK_URL must use https (http is only allowed for localhost).';
  }
  return null;
}

/**
 * Pure parser: turns a plain env object into the resolved Twilio config.
 * Exported (and kept side-effect free) so it can be unit tested without
 * touching `process.env`.
 *
 * @returns {{configured: boolean, problems: string[], accountSid?: string,
 *   apiKeySid?: string, apiKeySecret?: string, authToken: string|null,
 *   messagingServiceSid?: string, statusCallbackUrl: string|null}}
 */
export function parseTwilioEnv(env = {}) {
  const present = TWILIO_ENV_KEYS.filter((key) => !isBlank(env[key]));

  // Nothing filled in: SMS is simply off. Not an error.
  if (present.length === 0) {
    return { configured: false, problems: [], authToken: null, statusCallbackUrl: null };
  }

  const problems = [];
  for (const key of TWILIO_ENV_KEYS) {
    if (isBlank(env[key])) {
      problems.push(`${key} is empty — fill it in (see TWILIO_SETUP.md).`);
      continue;
    }
    const pattern = SID_PATTERNS[key];
    if (pattern && !pattern.test(env[key].trim())) {
      // The value itself is never echoed: a wrong paste is often a real secret.
      problems.push(
        `${key} does not look like a Twilio ${key.includes('ACCOUNT') ? 'Account SID (AC…)' : ''}` +
          `${key.includes('API_KEY') ? 'API Key SID (SK…)' : ''}` +
          `${key.includes('MESSAGING') ? 'Messaging Service SID (MG…)' : ''}` +
          ' — check you copied the right value.',
      );
    }
  }

  // The API Key Secret is the one credential with no recognisable shape; the
  // only useful check is that it is not obviously a SID pasted by mistake.
  const secret = (env.TWILIO_API_KEY_SECRET ?? '').trim();
  if (secret && /^(AC|SK|VA|MG)[0-9a-fA-F]{32}$/.test(secret)) {
    problems.push('TWILIO_API_KEY_SECRET looks like a SID, not the API Key Secret.');
  }

  const rawToken = (env.TWILIO_AUTH_TOKEN ?? '').trim();
  const authToken = isBlank(rawToken) ? null : rawToken;

  const rawCallback = (env.TWILIO_STATUS_CALLBACK_URL ?? '').trim();
  const statusCallbackUrl = isBlank(rawCallback) ? null : rawCallback;
  if (statusCallbackUrl) {
    const err = validateCallbackUrl(statusCallbackUrl);
    if (err) problems.push(err);
    // Delivery receipts arrive on a public endpoint that can only be trusted by
    // recomputing Twilio's signature, and that needs the Auth Token. Asking for
    // receipts without it would mean answering 403 to every one of them.
    if (!authToken) {
      problems.push(
        'TWILIO_STATUS_CALLBACK_URL is set but TWILIO_AUTH_TOKEN is empty — the ' +
          'delivery-status webhook cannot verify Twilio\'s signature without it. ' +
          'Add the Auth Token, or clear the callback URL to skip delivery receipts.',
      );
    }
  }

  if (problems.length > 0) {
    return { configured: false, problems, authToken, statusCallbackUrl };
  }

  return {
    configured: true,
    problems: [],
    accountSid: env.TWILIO_ACCOUNT_SID.trim(),
    apiKeySid: env.TWILIO_API_KEY_SID.trim(),
    apiKeySecret: secret,
    authToken,
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID.trim(),
    statusCallbackUrl,
  };
}

const parsed = parseTwilioEnv(process.env);

if (parsed.problems.length > 0) {
  throw new Error(
    'Twilio is half-configured, so SMS would fail at run time. Fix these in .env ' +
      `(see TWILIO_SETUP.md):\n  - ${parsed.problems.join('\n  - ')}\n` +
      'Or clear every TWILIO_* value to run with SMS switched off.',
  );
}

/** Whether real texts can be sent at all is `twilioConfig.configured`; the rest
 * of the server asks `client.js#isConfigured()` rather than reading it directly. */
export const twilioConfig = parsed;
