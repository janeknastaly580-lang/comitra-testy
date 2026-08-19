/**
 * In-app chat, and the goals two accounts share.
 *
 * This is what replaced the judge invite link and the judge secret code. A judge
 * is a friend with an account, so "be my judge", "please decide this" and "please
 * cancel this" are messages delivered to that account and acted on in the app —
 * nothing is emailed, nothing is texted, and no capability token is pasted into
 * a chat app where anyone forwarded it could use it.
 *
 * THE TRUST BOUNDARY. Every function here takes the acting account from the
 * session token (`requireAccount`), never from the request body. Friends know
 * each other's user ids — that is how one of them messages the other — so an id
 * is an address and can never be a credential. The SQL functions below are
 * granted to the service role only and are unreachable with the publishable key.
 *
 * PRIVACY: a message body is what a person typed; a payload carries ids and a
 * goal NUMBER. Neither ever carries a goal's title or description.
 */
import { ApiError } from './errors.ts';
import { rpc } from './state.ts';

/** The product limits. Enforced again inside the SQL, which is the real gate. */
export const CHAT_MAX_CHARS = 300;
export const CHAT_MAX_TEXTS_PER_DAY = 20;

/** What a message can be. Anything else is refused rather than coerced. */
const KINDS = new Set(['text', 'request', 'system']);

/** The only requests the app can make of a judge. */
const REQUESTS = new Set(['judge_invite', 'decision', 'edit']);

function str(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

/**
 * Strip a payload down to the fields the app actually uses.
 *
 * An allow-list, not a filter: a client that invents a field gets it dropped
 * rather than stored, which is what keeps a goal's title out of the database
 * even if some future caller is careless enough to send one.
 */
function cleanPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const request = str(src.request, 32);
  if (request) {
    if (!REQUESTS.has(request)) {
      throw new ApiError('bad-request', "That message couldn't be sent.", 400, `unknown request ${request}`);
    }
    out.request = request;
  }
  const goalId = str(src.goalId, 128);
  if (goalId) out.goalId = goalId;

  const goalNumber = Number(src.goalNumber);
  if (Number.isFinite(goalNumber) && goalNumber > 0) out.goalNumber = Math.trunc(goalNumber);

  const event = str(src.event, 32);
  if (event) out.event = event;

  return out;
}

export interface ChatRow {
  id: string;
  thread_id: string;
  from_user_id: string;
  to_user_id: string;
  kind: string;
  body: string;
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
}

/**
 * Send one message.
 *
 * Returns `{ sent: false, reason: 'rate-limited' }` rather than throwing when
 * the sender has used their day's free-text messages in this thread: hitting a
 * limit is a normal outcome the composer explains, not an error.
 */
export async function chatSend(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const id = str(body.id, 128);
  const toUserId = str(body.toUserId, 128);
  const kind = str(body.kind, 16) || 'text';
  if (!id || !toUserId) {
    throw new ApiError('bad-request', "That message couldn't be sent.", 400, 'id or toUserId missing');
  }
  if (!KINDS.has(kind)) {
    throw new ApiError('bad-request', "That message couldn't be sent.", 400, `unknown kind ${kind}`);
  }
  if (toUserId === accountId) {
    throw new ApiError('bad-request', "You can't message yourself.", 400, 'self-addressed');
  }

  // Trim to the limit rather than refusing: the composer stops at 300 too, so a
  // longer body means a caller that is not the app, and there is nothing to
  // gain by explaining that to it.
  const text = str(body.text, CHAT_MAX_CHARS);
  if (kind === 'text' && !text) {
    throw new ApiError('bad-request', 'Write something first.', 400, 'empty text message');
  }

  const rows = await rpc<{ status: string; remaining: number }[]>('comitra_chat_send', {
    p_id: id,
    p_from: accountId,
    p_to: toUserId,
    p_kind: kind,
    p_body: text,
    p_payload: cleanPayload(body.payload),
    p_max_texts: CHAT_MAX_TEXTS_PER_DAY,
  });
  const result = Array.isArray(rows) ? rows[0] : undefined;
  if (result?.status === 'rate-limited') {
    return { sent: false, reason: 'rate-limited', remaining: 0, limit: CHAT_MAX_TEXTS_PER_DAY };
  }
  return { sent: true, remaining: result?.remaining ?? 0, limit: CHAT_MAX_TEXTS_PER_DAY };
}

export async function chatList(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const withUserId = str(body.withUserId, 128);
  if (!withUserId) {
    throw new ApiError('bad-request', 'Could not open that conversation.', 400, 'withUserId missing');
  }
  const limit = Number(body.limit);
  const rows = await rpc<ChatRow[]>('comitra_chat_list', {
    p_user: accountId,
    p_other: withUserId,
    p_limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 100,
  });
  return { messages: Array.isArray(rows) ? rows : [] };
}

export async function chatThreads(accountId: string): Promise<unknown> {
  const rows = await rpc<unknown[]>('comitra_chat_threads', { p_user: accountId });
  return { threads: Array.isArray(rows) ? rows : [] };
}

export async function chatRead(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const withUserId = str(body.withUserId, 128);
  if (!withUserId) {
    throw new ApiError('bad-request', 'Could not mark that as read.', 400, 'withUserId missing');
  }
  await rpc<null>('comitra_chat_mark_read', { p_user: accountId, p_other: withUserId });
  return { ok: true };
}

/* ──────────────────────────────────────────────── goals, by identity ────── */

/**
 * Publish a goal's shared projection. Only its owner can, and the SQL checks
 * that against the stored row rather than trusting this layer.
 */
export async function goalPut(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const id = str(body.id, 128);
  if (!id) throw new ApiError('bad-request', 'Could not save that goal.', 400, 'id missing');
  if (!body.data || typeof body.data !== 'object') {
    throw new ApiError('bad-request', 'Could not save that goal.', 400, 'data was not an object');
  }
  await rpc<null>('comitra_goal_put', {
    p_id: id,
    p_owner_user_id: accountId,
    p_judge_user_id: str(body.judgeUserId, 128) || null,
    p_data: body.data,
  });
  return { ok: true };
}

/** One goal, for its owner or for the judge named on it. Nobody else. */
export async function goalGet(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const id = str(body.id, 128);
  if (!id) throw new ApiError('bad-request', 'Could not open that goal.', 400, 'id missing');
  const rows = await rpc<{ data: unknown; updated_at: string }[]>('comitra_goal_get', {
    p_id: id,
    p_user: accountId,
  });
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return { goal: row ?? null };
}

/** Every goal this account is the judge of. */
export async function goalsJudging(accountId: string): Promise<unknown> {
  const rows = await rpc<unknown[]>('comitra_goal_list_judging', { p_user: accountId });
  return { goals: Array.isArray(rows) ? rows : [] };
}

/** The five things a judge may do. Anything else is not a judge's to do. */
const JUDGE_ACTIONS = new Set(['accept', 'decline', 'completed', 'not_completed', 'cancel']);

/**
 * Record a judge's action on a goal.
 *
 * Nothing about the goal is taken from the request except which one and which
 * action: the patch itself is built in SQL from the stored row, so a judge can
 * write their verdict and cannot touch a deadline, a recipient or a penalty.
 * Every precondition (are they the judge, has it been decided, is it too early)
 * is checked there too, in the same statement that writes.
 */
export async function goalJudgeAct(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const id = str(body.id, 128);
  const action = str(body.action, 32);
  if (!id || !JUDGE_ACTIONS.has(action)) {
    throw new ApiError('bad-request', 'Could not record that.', 400, `id or action invalid (${action})`);
  }
  try {
    const rows = await rpc<{ data: unknown; updated_at: string }[]>('comitra_goal_judge_act', {
      p_id: id,
      p_judge: accountId,
      p_action: action,
      p_comment: str(body.comment, CHAT_MAX_CHARS) || null,
    });
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return { goal: row ?? null };
  } catch (err) {
    // The SQL raises with a sentence already fit to show someone; anything else
    // is a real fault and must not leak.
    const detail = (err as Error)?.message ?? '';
    const match = /comitra: ([^"]+)/.exec(detail);
    if (match) {
      const reason = match[1].trim();
      throw new ApiError('bad-request', reason.charAt(0).toUpperCase() + reason.slice(1) + '.', 400, detail);
    }
    throw err;
  }
}
