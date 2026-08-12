/**
 * Every message this function is allowed to send.
 *
 * The trust boundary from server/src/{email,twilio}/templates.js is preserved:
 * no route accepts a subject or a body. A caller names a template and supplies
 * parameters; the content is owned here. Without that, the endpoint would be an
 * open relay sending mail signed by our SPF/DKIM and texts from our sender.
 *
 * PRIVACY RULE (mirrors src/lib/messages.ts): a message may name the person and
 * the goal NUMBER. It must never contain a goal's title or description.
 */

/** Mirrors EMAIL_CODE_TTL_MS in otp.ts. Only used by the inline fallback copy. */
const EMAIL_TTL_MINUTES = 7;
/** Mirrors SMS_CODE_TTL_MS. */
const SMS_TTL_MINUTES = 5;

/** Longest a rendered SMS body may be. Two segments; longer is a template bug. */
const MAX_BODY_CHARS = 300;

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
      `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#8b98a5">Type this code into the app to finish creating your account. It expires in ${EMAIL_TTL_MINUTES} minutes.</p>`,
      `<p style="margin:0 0 20px;padding:16px;text-align:center;font-size:30px;letter-spacing:.35em;font-weight:700;background:#0b0f14;border:1px solid #1e2a36;border-radius:12px;color:#e6edf3">${safe}</p>`,
      '<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#8b98a5">Never share this code with anyone. Comitra will never ask you for it.</p>',
      "<p style=\"margin:0;font-size:12px;line-height:1.6;color:#8b98a5\">If you didn't try to create a Comitra account, you can ignore this email — nothing was created.</p>",
      '</div></div>',
    ].join(''),
  };
}

/* ───────────────────────────────────────────────────────────────── sms ──── */

function cleanName(raw: unknown, fallback = 'Someone'): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return name || fallback;
}

function goalRef(raw: unknown): string {
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? `goal #${n}` : 'goal';
}

/**
 * A link this function is willing to put in a text. Only https, and only a URL —
 * this is what stops a caller smuggling arbitrary text in through `link`.
 */
function cleanLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The tone the goal's owner chose. It changes the framing of the failure notice
 * and nothing else: no insults, no moral judgement, never any goal content.
 */
const TONE_SUFFIX: Record<string, string> = {
  neutral: '',
  supportive: ' You can send them a few words of encouragement to help them get back on track.',
  firm: ' They asked to have you told if they did not keep their commitment.',
};

function toneSuffix(raw: unknown): string {
  return TONE_SUFFIX[String(raw ?? '').trim()] ?? TONE_SUFFIX.neutral;
}

/**
 * The body of a verification-code text.
 *
 * Deliberately NOT one of the TEMPLATES below: those can be named by any caller
 * of POST /api/sms/send, and a client-selectable code template would let anyone
 * text "Comitra: your code is 123456" to any number.
 */
export function verificationCodeMessage(code: string): string {
  return `Comitra: ${code} is your verification code. It expires in ${SMS_TTL_MINUTES} minutes. Never share it with anyone.`;
}

type Params = Record<string, unknown>;

export const TEMPLATES: Record<string, (p: Params) => string | null> = {
  /** The judge is asked to decide a goal. Says who and which numbered goal. */
  judge_review_request: ({ ownerName, goalNumber, link }) => {
    const url = cleanLink(link);
    return (
      `Comitra: ${cleanName(ownerName)} needs you to decide their ${goalRef(goalNumber)}. ` +
      (url
        ? `Open ${url} and mark it completed or not completed.`
        : 'Open your judge link to mark it completed or not completed.')
    );
  },

  /** Someone did not complete a goal, sent to a recipient who has consented. */
  goal_not_completed: ({ ownerName, goalNumber, tone }) =>
    `Comitra: ${cleanName(ownerName)} failed their ${goalRef(goalNumber)}.${toneSuffix(tone)}`,

  judge_invite: ({ ownerName, link }) => {
    const url = cleanLink(link);
    if (!url) return null;
    return `Comitra: ${cleanName(ownerName, 'A Comitra user')} asks you to be the judge of their goals. Accept here: ${url}`;
  },

  recipient_invite: ({ ownerName, link }) => {
    const url = cleanLink(link);
    if (!url) return null;
    return (
      `Comitra: ${cleanName(ownerName, 'A Comitra user')} wants to be able to tell you the result of a goal. ` +
      `Agree here: ${url}`
    );
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

/** Render to a body, or `null` when the id is unknown or the params are unusable. */
export function renderTemplate(templateId: string, params: Params = {}): string | null {
  const template = TEMPLATES[templateId];
  if (!template) return null;
  const body = template(params ?? {});
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_BODY_CHARS) return null;
  return trimmed;
}
