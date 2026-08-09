/**
 * Every transactional text this server is allowed to send.
 *
 * The trust boundary matches the one the payment routes already use: a client
 * sends an id and a few parameters, the server owns the content. If the body
 * came from the request, the endpoint would be an open SMS relay — anyone who
 * found the URL could send any text from Comitra's sender.
 *
 * PRIVACY RULE (same as src/lib/messages.ts): a message may name the person and
 * the goal NUMBER. It must never contain the goal's title or description, and
 * no template may add one.
 */

/** Longest a rendered body may be. Two SMS segments; longer is a template bug. */
const MAX_BODY_CHARS = 300;

function cleanName(raw, fallback = 'Someone') {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return name || fallback;
}

function goalRef(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? `goal #${n}` : 'goal';
}

/**
 * A link this server is willing to put in a text. Only https, and only a URL —
 * this is what stops a caller smuggling arbitrary text in through `link`.
 */
function cleanLink(raw) {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The tone the goal's owner chose when they created it. It changes the framing
 * of the failure notice and nothing else: no insults, no moral judgement, and
 * never any goal content. Mirrors `src/lib/messages.ts` so the text a recipient
 * receives matches the preview the owner was shown.
 */
const TONE_SUFFIX = {
  neutral: '',
  supportive: ' You can send them a few words of encouragement to help them get back on track.',
  firm: ' They asked to have you told if they did not keep their commitment.',
};

function toneSuffix(raw) {
  return TONE_SUFFIX[String(raw ?? '').trim()] ?? TONE_SUFFIX.neutral;
}

/**
 * The body of a verification-code text.
 *
 * Deliberately NOT one of the `TEMPLATES` below: those can be named by any
 * caller of `POST /api/sms/send`, and a client-selectable code template would
 * let anyone text "Comitra: your code is 123456" to any number. Only
 * `verify.js`, which generated the code, can reach this.
 */
export function verificationCodeMessage(code) {
  return `Comitra: ${code} is your verification code. It expires in 5 minutes. Never share it with anyone.`;
}

export const TEMPLATES = {
  /**
   * The judge is asked to decide a goal. Says who and which numbered goal,
   * never what the goal is — the owner tells their judge that themselves.
   */
  judge_review_request: ({ ownerName, goalNumber, link }) => {
    const who = cleanName(ownerName);
    const url = cleanLink(link);
    return (
      `Comitra: ${who} needs you to decide their ${goalRef(goalNumber)}. ` +
      (url ? `Open ${url} and mark it completed or not completed.` : 'Open your judge link to mark it completed or not completed.')
    );
  },

  /**
   * Someone did not complete a goal, sent to a recipient who has consented.
   * Names the person and the goal NUMBER, then one sentence set by the owner's
   * chosen tone. An unknown or missing tone falls back to neutral.
   */
  goal_not_completed: ({ ownerName, goalNumber, tone }) =>
    `Comitra: ${cleanName(ownerName)} failed their ${goalRef(goalNumber)}.${toneSuffix(tone)}`,

  /** Invite to become a judge. */
  judge_invite: ({ ownerName, link }) => {
    const url = cleanLink(link);
    if (!url) return null;
    return `Comitra: ${cleanName(ownerName, 'A Comitra user')} asks you to be the judge of their goals. Accept here: ${url}`;
  },

  /** Invite to receive result notifications about one person's goals. */
  recipient_invite: ({ ownerName, link }) => {
    const url = cleanLink(link);
    if (!url) return null;
    return (
      `Comitra: ${cleanName(ownerName, 'A Comitra user')} wants to be able to tell you the result of a goal. ` +
      `Agree here: ${url}`
    );
  },
};

/** Template ids a request may name. */
export const TEMPLATE_IDS = Object.keys(TEMPLATES);

/**
 * Render a template to a body, or return `null` when the id is unknown or the
 * parameters do not produce a usable message.
 */
export function renderTemplate(templateId, params = {}) {
  const template = TEMPLATES[templateId];
  if (!template) return null;
  const body = template(params ?? {});
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_BODY_CHARS) return null;
  return trimmed;
}
