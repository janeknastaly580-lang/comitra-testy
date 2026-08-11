import { emailConfig } from './config.js';
import { getSesClient, mapSesError } from './client.js';
import { maskEmail } from './address.js';

/**
 * Putting one email on the wire through Amazon SES.
 *
 * The lowest level: no throttling and no de-duplication — the caller owns
 * those (see verify.js) — and the subject/body are taken as given, because
 * every caller must have composed them from a server-owned template first.
 * This function is what a caller would have to reach to send arbitrary mail.
 *
 * The `From` header is built here from the configured identity, so no caller
 * can choose a sender, and `Destination` always holds exactly one address, so
 * no caller can turn a code email into a broadcast.
 */

/** `Name <addr@example.com>`, or the bare address when there is no name. */
function fromHeader() {
  return emailConfig.fromName ? `${emailConfig.fromName} <${emailConfig.fromEmail}>` : emailConfig.fromEmail;
}

/**
 * The `Content` block for one message.
 *
 * Two shapes, and the caller picks by what it passes:
 *   • `templateName` → SES renders a template it already holds, and the only
 *     thing that leaves this process is `templateData` (for us: the six
 *     digits). The subject and both bodies live in AWS, so editing the email
 *     needs no deploy.
 *   • otherwise → the subject and bodies built by templates.js are sent inline.
 *
 * `TemplateData` has to be a JSON *string*, not an object — a common way to get
 * a template that renders with an empty placeholder.
 */
function contentFor({ subject, text, html, templateName, templateData }) {
  if (templateName) {
    return {
      Template: {
        TemplateName: templateName,
        TemplateData: JSON.stringify(templateData ?? {}),
      },
    };
  }
  return {
    Simple: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: text, Charset: 'UTF-8' },
        ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
      },
    },
  };
}

/**
 * Send one email.
 *
 * @param {{to: string, subject?: string, text?: string, html?: string,
 *   templateName?: string|null, templateData?: Record<string, string>}} input
 *   `to` must already be normalised (see address.js). Pass either
 *   `subject`+`text` (inline) or `templateName`+`templateData` (SES template).
 * @returns {Promise<{messageId: string|null, to: string}>}
 */
export async function sendEmail({ to, subject, text, html, templateName, templateData }) {
  const { client, SendEmailCommand } = await getSesClient();
  try {
    const out = await client.send(
      new SendEmailCommand({
        FromEmailAddress: fromHeader(),
        Destination: { ToAddresses: [to] },
        ...(emailConfig.replyTo ? { ReplyToAddresses: [emailConfig.replyTo] } : {}),
        ...(emailConfig.configurationSet ? { ConfigurationSetName: emailConfig.configurationSet } : {}),
        Content: contentFor({ subject, text, html, templateName, templateData }),
      }),
    );
    return { messageId: out?.MessageId ?? null, to };
  } catch (err) {
    throw mapSesError(err, 'send-email');
  }
}

/** Log line for a send, with the address masked. Never includes the body. */
export function describeEmailSend({ to, kind, messageId }) {
  return { to: maskEmail(to), kind, messageId: messageId ?? null };
}
