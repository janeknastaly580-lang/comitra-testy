/**
 * Putting one email on the wire through Amazon SES v2.
 *
 * The `From` header is built here from the configured identity and `Destination`
 * always holds exactly one address, so no caller can choose a sender or turn a
 * code email into a broadcast. Subject and bodies are never accepted from a
 * request — see templates.ts.
 */

import { signJsonPost } from './aws.ts';
import { sesConfig } from './config.ts';
import { ApiError } from './errors.ts';

/** `Name <addr@example.com>`, or the bare address when there is no name. */
function fromHeader(): string {
  return sesConfig.fromName ? `${sesConfig.fromName} <${sesConfig.fromEmail}>` : sesConfig.fromEmail!;
}

/**
 * Two content shapes, picked by whether a SES-hosted template is configured:
 *
 *   • template → the subject and both bodies live in AWS and the only thing
 *     that leaves this function is the six digits. Editing the email needs no
 *     redeploy. `TemplateData` must be a JSON *string*, not an object — passing
 *     an object is a common way to get a template that renders with an empty
 *     placeholder and still reports success.
 *   • simple   → the copy from templates.ts, sent inline.
 */
function contentFor(input: {
  subject?: string;
  text?: string;
  html?: string;
  templateData?: Record<string, string>;
}): Record<string, unknown> {
  if (sesConfig.templateName) {
    return {
      Template: {
        TemplateName: sesConfig.templateName,
        TemplateData: JSON.stringify(input.templateData ?? {}),
      },
    };
  }
  return {
    Simple: {
      Subject: { Data: input.subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: input.text, Charset: 'UTF-8' },
        ...(input.html ? { Html: { Data: input.html, Charset: 'UTF-8' } } : {}),
      },
    },
  };
}

/**
 * Map a SES failure onto something safe to hand a browser.
 *
 * AWS's own text names the account, the identity and sometimes the recipient, so
 * it goes to `detail` (server logs only) and never to `message`.
 */
function mapSesError(errorType: string, status: number, awsMessage: string): ApiError {
  const detail = `ses send-email failed (${errorType || 'unknown'}, status ${status}): ${awsMessage}`;

  const setup = () =>
    new ApiError(
      'setup',
      "We couldn't send the code because email isn't finished being set up on our side. Please try again later.",
      503,
      detail,
    );

  switch (errorType) {
    // All of these are our setup problem, not the person's.
    case 'MessageRejected':
    case 'MailFromDomainNotVerifiedException':
    case 'SendingPausedException':
    case 'AccountSuspendedException':
    case 'NotFoundException': // unknown template or configuration set
    case 'BadRequestException':
      return setup();

    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'ThrottlingException':
      return new ApiError('rate-limited', 'Too many attempts. Wait about a minute, then try again.', 429, detail);

    case 'InvalidParameterValue':
    case 'InvalidParameterException':
      return new ApiError('bad-email', "That email address doesn't look right. Check it and try again.", 400, detail);
  }

  if (status === 429) {
    return new ApiError('rate-limited', 'Too many attempts. Wait about a minute, then try again.', 429, detail);
  }
  if (status === 401 || status === 403) return setup();
  if (status >= 400 && status < 500) {
    return new ApiError('bad-email', "We couldn't send to that address. Check it and try again.", 400, detail);
  }
  return new ApiError('unavailable', "The email couldn't be sent right now. Please try again in a moment.", 502, detail);
}

/**
 * Send one email.
 *
 * @param to must already be normalised (see address.ts).
 */
export async function sendEmail(input: {
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  templateData?: Record<string, string>;
}): Promise<{ messageId: string | null }> {
  if (!sesConfig.configured) {
    throw new ApiError('email_not_configured', 'Email sending is not configured on this server.', 503);
  }

  const body = JSON.stringify({
    FromEmailAddress: fromHeader(),
    Destination: { ToAddresses: [input.to] },
    ...(sesConfig.replyTo ? { ReplyToAddresses: [sesConfig.replyTo] } : {}),
    ...(sesConfig.configurationSet ? { ConfigurationSetName: sesConfig.configurationSet } : {}),
    Content: contentFor(input),
  });

  const signed = await signJsonPost({
    service: 'ses',
    region: sesConfig.region!,
    host: `email.${sesConfig.region}.amazonaws.com`,
    path: '/v2/email/outbound-emails',
    body,
    accessKeyId: sesConfig.accessKeyId!,
    secretAccessKey: sesConfig.secretAccessKey!,
  });

  let res: Response;
  try {
    res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
  } catch (err) {
    throw new ApiError(
      'unavailable',
      "The email couldn't be sent right now. Please try again in a moment.",
      502,
      `ses fetch failed: ${(err as Error).message}`,
    );
  }

  const raw = await res.text();
  if (!res.ok) {
    // SES reports the exception name in a header, and repeats it in `__type`
    // when it does not. Strip the `com.amazonaws...#` prefix AWS sometimes adds.
    let parsed: { message?: string; Message?: string; __type?: string } = {};
    try {
      parsed = JSON.parse(raw);
    } catch { /* a non-JSON body is itself the detail */ }
    const errorType = (res.headers.get('x-amzn-errortype') ?? parsed.__type ?? '').split('#').pop()!.split(':')[0];
    throw mapSesError(errorType, res.status, parsed.message ?? parsed.Message ?? raw.slice(0, 200));
  }

  const ok = raw ? (JSON.parse(raw) as { MessageId?: string }) : {};
  return { messageId: ok.MessageId ?? null };
}
