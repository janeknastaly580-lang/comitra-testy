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
 * Send one email.
 *
 * @param {{to: string, subject: string, text: string, html?: string}} input
 *   `to` must already be normalised (see address.js).
 * @returns {Promise<{messageId: string|null, to: string}>}
 */
export async function sendEmail({ to, subject, text, html }) {
  const { client, SendEmailCommand } = await getSesClient();
  try {
    const out = await client.send(
      new SendEmailCommand({
        FromEmailAddress: fromHeader(),
        Destination: { ToAddresses: [to] },
        ...(emailConfig.replyTo ? { ReplyToAddresses: [emailConfig.replyTo] } : {}),
        ...(emailConfig.configurationSet ? { ConfigurationSetName: emailConfig.configurationSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
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
