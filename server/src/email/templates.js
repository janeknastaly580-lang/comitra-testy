/**
 * Every email this server is allowed to send.
 *
 * Same trust boundary as twilio/templates.js: the content is owned by the
 * server. No route accepts a subject or a body, so no one who finds the URL can
 * send arbitrary mail from a verified Comitra domain — which would be a
 * ready-made phishing relay with our SPF/DKIM on it.
 *
 * PRIVACY RULE (same as src/lib/messages.ts): a message may name the person and
 * the goal NUMBER. It must never contain a goal's title or description.
 */

/** How long a code stays valid, in minutes. Mirrors verify.js's CODE_TTL_MS. */
const TTL_MINUTES = 5;

/** HTML-escape everything interpolated into the HTML part. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/**
 * The sign-up verification code.
 *
 * Written to survive a spam filter and a plain-text client: the code is in the
 * subject line as well as the body, there is exactly one call to action, no
 * link (nothing to click means nothing to phish), and the text part is a real
 * alternative rather than a "view in browser" stub.
 */
export function verificationCodeEmail(code) {
  const safe = esc(code);
  return {
    subject: `${code} is your Comitra verification code`,
    text: [
      `${code} is your Comitra verification code.`,
      '',
      `Type it into the app to finish creating your account. It expires in ${TTL_MINUTES} minutes.`,
      '',
      'Never share this code with anyone. Comitra will never ask you for it.',
      "If you didn't try to create a Comitra account, you can ignore this email — nothing was created.",
    ].join('\n'),
    html: [
      '<div style="margin:0;padding:24px;background:#0b0f14;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6edf3">',
      '<div style="max-width:420px;margin:0 auto;background:#111820;border:1px solid #1e2a36;border-radius:16px;padding:28px">',
      '<p style="margin:0 0 20px;font-size:13px;letter-spacing:.25em;font-weight:700;color:#16a34a">COMITRA</p>',
      '<h1 style="margin:0 0 8px;font-size:19px;line-height:1.35;color:#e6edf3">Confirm your email</h1>',
      `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#8b98a5">Type this code into the app to finish creating your account. It expires in ${TTL_MINUTES} minutes.</p>`,
      `<p style="margin:0 0 20px;padding:16px;text-align:center;font-size:30px;letter-spacing:.35em;font-weight:700;background:#0b0f14;border:1px solid #1e2a36;border-radius:12px;color:#e6edf3">${safe}</p>`,
      '<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#8b98a5">Never share this code with anyone. Comitra will never ask you for it.</p>',
      "<p style=\"margin:0;font-size:12px;line-height:1.6;color:#8b98a5\">If you didn't try to create a Comitra account, you can ignore this email — nothing was created.</p>",
      '</div></div>',
    ].join(''),
  };
}
