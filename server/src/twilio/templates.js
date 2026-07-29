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

  /** Someone did not complete a goal, sent to a recipient who has consented. */
  goal_not_completed: ({ ownerName, goalNumber }) =>
    `Comitra: ${cleanName(ownerName)} did not complete their ${goalRef(goalNumber)} by the deadline.`,

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
