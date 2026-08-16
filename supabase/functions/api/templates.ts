/**
 * Every message this function is allowed to send.
 *
 * The trust boundary from server/src/email/templates.js is preserved: no route
 * accepts a subject or a body. The content is owned here. Without that, the
 * endpoint would be an open relay sending mail signed by our SPF/DKIM.
 *
 * PRIVACY RULE (mirrors src/lib/messages.ts): a message may name the person and
 * the goal NUMBER. It must never contain a goal's title or description.
 */

/** Mirrors EMAIL_CODE_TTL_MS in otp.ts. Only used by the inline fallback copy. */
const EMAIL_TTL_MINUTES = 7;

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

/* ─────────────────────────────────────────────────────────────── email ──── */

/**
 * The inline verification email, used only when no SES-hosted template is
 * configured. Written to survive a spam filter and a plain-text client: the code
 * is in the subject as well as the body, and there is no link — nothing to click
 * means nothing to phish.
 */
export function verificationCodeEmail(code: string): { subject: string; text: string; html: string } {
  const safe = esc(code);
  return {
    subject: `${code} is your Comitra verification code`,
    text: [
      `${code} is your Comitra verification code.`,
      '',
      `Type it into the app to finish creating your account. It expires in ${EMAIL_TTL_MINUTES} minutes.`,
      '',
      'Never share this code with anyone. Comitra will never ask you for it.',
      "If you didn't try to create a Comitra account, you can ignore this email — nothing was created.",
    ].join('\n'),
    html: [
      '<div style="margin:0;padding:24px;background:#0b0f14;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6edf3">',
      '<div style="max-width:420px;margin:0 auto;background:#111820;border:1px solid #1e2a36;border-radius:16px;padding:28px">',
      '<p style="margin:0 0 20px;font-size:13px;letter-spacing:.25em;font-weight:700;color:#16a34a">COMITRA</p>',
      '<h1 style="margin:0 0 8px;font-size:19px;line-height:1.35;color:#e6edf3">Confirm your email</h1>',
      `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#8b98a5">Type this code into the app to confirm this address. It expires in ${EMAIL_TTL_MINUTES} minutes.</p>`,
      `<p style="margin:0 0 20px;padding:16px;text-align:center;font-size:30px;letter-spacing:.35em;font-weight:700;background:#0b0f14;border:1px solid #1e2a36;border-radius:12px;color:#e6edf3">${safe}</p>`,
      '<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#8b98a5">Never share this code with anyone. Comitra will never ask you for it.</p>',
      "<p style=\"margin:0;font-size:12px;line-height:1.6;color:#8b98a5\">If you weren't expecting this, you can ignore this email — nothing was created.</p>",
      '</div></div>',
    ].join(''),
  };
}

/**
 * The inline password-reset email, used until a SES-hosted template named in
 * SES_RESET_TEMPLATE_NAME exists.
 *
 * Unlike the code email this one HAS to carry a link, so it is written to make
 * the link inspectable: the URL is shown in full in the text part rather than
 * hidden behind a word, and the message says plainly that it can be ignored.
 */
export function passwordResetEmail(link: string): { subject: string; text: string; html: string } {
  const safe = esc(link);
  return {
    subject: 'Reset your Comitra password',
    text: [
      'You asked to reset your Comitra password.',
      '',
      'Open this link to choose a new one. It works once and expires in 30 minutes:',
      link,
      '',
      'It works on any device, and setting a new password logs you in there.',
      '',
      "If you didn't ask for this, you can ignore this email. Your password has not changed.",
    ].join('\n'),
    html: [
      '<div style="margin:0;padding:24px;background:#0b0f14;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6edf3">',
      '<div style="max-width:460px;margin:0 auto;background:#111820;border:1px solid #1e2a36;border-radius:16px;padding:28px">',
      '<p style="margin:0 0 20px;font-size:13px;letter-spacing:.25em;font-weight:700;color:#16a34a">COMITRA</p>',
      '<h1 style="margin:0 0 8px;font-size:19px;line-height:1.35;color:#e6edf3">Reset your password</h1>',
      '<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#8b98a5">Choose a new password with the link below. It works once and expires in 30 minutes.</p>',
      `<p style="margin:0 0 20px"><a href="${safe}" style="display:block;padding:14px;text-align:center;font-size:15px;font-weight:700;background:#16a34a;border-radius:12px;color:#0b0f14;text-decoration:none">Choose a new password</a></p>`,
      `<p style="margin:0 0 20px;font-size:11px;line-height:1.6;color:#8b98a5;word-break:break-all">Or paste this into your browser:<br>${safe}</p>`,
      '<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#8b98a5">It works on any device, and setting a new password logs you in there.</p>',
      "<p style=\"margin:0;font-size:12px;line-height:1.6;color:#8b98a5\">If you didn't ask for this, you can ignore this email. Your password has not changed.</p>",
      '</div></div>',
    ].join(''),
  };
}
