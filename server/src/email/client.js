import { emailConfig } from './config.js';

/**
 * The single Amazon SES client for the whole process, plus the mapping from
 * SES's errors onto something safe to hand back to a browser.
 *
 * Two deliberate choices:
 *   • **The SDK is imported dynamically**, inside the lazy getter. The server
 *     must boot and serve payments even on a deployment that never installed
 *     `@aws-sdk/client-sesv2`, and a top-level import would take the whole
 *     process down at start-up instead of answering 503 on one route.
 *   • **Credentials are only passed when they were configured.** Leaving them
 *     out lets the SDK use its default provider chain (IAM role, shared
 *     profile, SSO), which is how this should run in production.
 */

let clientPromise = null;

/** True when the process holds a usable SES configuration. */
export function isEmailConfigured() {
  return emailConfig.configured === true;
}

/** Thrown when an email route is hit before anyone filled in the SES values. */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email sending is not configured on this server.');
    this.name = 'EmailNotConfiguredError';
    this.code = 'email_not_configured';
    this.httpStatus = 503;
  }
}

/**
 * A failure that already carries a message written for the person signing up.
 * `code` is the machine-readable kind the frontend maps onto its own wording;
 * `detail` is server-side only and is logged, never sent.
 */
export class EmailError extends Error {
  constructor(code, message, httpStatus = 502, detail) {
    super(message);
    this.name = 'EmailError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

/**
 * Lazily build the SESv2 client. Returns a promise because the SDK import is
 * dynamic; the promise is cached, so the module is loaded at most once.
 */
export function getSesClient() {
  if (clientPromise) return clientPromise;
  if (!isEmailConfigured()) throw new EmailNotConfiguredError();

  clientPromise = (async () => {
    let sdk;
    try {
      sdk = await import('@aws-sdk/client-sesv2');
    } catch (err) {
      clientPromise = null; // a later request may run after `npm install`
      throw new EmailError(
        'setup',
        'Email sending is not finished being set up on the server.',
        503,
        `@aws-sdk/client-sesv2 is not installed — run "npm install" in server/ (${err?.message ?? err})`,
      );
    }
    const { SESv2Client, SendEmailCommand } = sdk;
    const client = new SESv2Client({
      region: emailConfig.region,
      maxAttempts: 2, // one retry on SES's own throttling / 5xx
      ...(emailConfig.accessKeyId
        ? {
            credentials: {
              accessKeyId: emailConfig.accessKeyId,
              secretAccessKey: emailConfig.secretAccessKey,
            },
          }
        : {}),
    });
    return { client, SendEmailCommand };
  })();

  return clientPromise;
}

/**
 * Swap in a stand-in client. Tests only — it lets the sending and OTP modules
 * be exercised without a network call, a credential or a charge. Pass `null` to
 * restore the real, lazily-built one.
 */
export function setSesClientForTests(fake) {
  clientPromise = fake ? Promise.resolve(fake) : null;
}

/**
 * Translate an SES exception into an `EmailError`.
 *
 * AWS's own text is not forwarded to the client: it names the account, the
 * identity and sometimes the recipient. It goes to `detail`, which only the
 * server-side logger sees.
 *
 * Error names: https://docs.aws.amazon.com/ses/latest/APIReference-V2/CommonErrors.html
 */
export function mapSesError(err, phase) {
  const name = err?.name ?? err?.Code ?? '';
  const status = Number(err?.$metadata?.httpStatusCode) || 0;
  const detail = `ses ${phase} failed (${name || 'unknown'}, status ${status || '?'})`;

  switch (name) {
    // The sender identity is missing, unverified, or the account is still in
    // the sandbox and the recipient was never verified. All of them are our
    // setup problem, not the person's — see SES_SETUP.md.
    case 'MessageRejected':
    case 'MailFromDomainNotVerifiedException':
    case 'SendingPausedException':
    case 'AccountSuspendedException':
      return new EmailError(
        'setup',
        "We couldn't send the code because email isn't finished being set up on our side. Please try again later.",
        503,
        detail,
      );

    case 'NotFoundException': // unknown configuration set / identity
    case 'BadRequestException':
      return new EmailError(
        'setup',
        "We couldn't send the code because email isn't finished being set up on our side. Please try again later.",
        503,
        detail,
      );

    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'ThrottlingException':
      return new EmailError('rate-limited', 'Too many attempts. Wait about a minute, then try again.', 429, detail);

    // The address itself is the problem: SES will not even attempt delivery.
    case 'InvalidParameterValue':
    case 'InvalidParameterException':
      return new EmailError(
        'bad-email',
        "That email address doesn't look right. Check it and try again.",
        400,
        detail,
      );

    default:
      break;
  }

  if (status === 429) {
    return new EmailError('rate-limited', 'Too many attempts. Wait about a minute, then try again.', 429, detail);
  }
  if (status === 401 || status === 403) {
    return new EmailError(
      'setup',
      "We couldn't send the code because email isn't finished being set up on our side. Please try again later.",
      503,
      detail,
    );
  }
  if (status >= 400 && status < 500) {
    return new EmailError('bad-email', "We couldn't send to that address. Check it and try again.", 400, detail);
  }
  return new EmailError('unavailable', "The email couldn't be sent right now. Please try again in a moment.", 502, detail);
}
