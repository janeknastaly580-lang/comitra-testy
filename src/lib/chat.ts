/**
 * In-app chat between two accounts — and the channel every judge request now
 * travels on.
 *
 * WHAT THIS REPLACED. A judge used to be an email address you invited, who set a
 * secret code and was then sent links: one to accept the role, one to be asked
 * for a decision, one to be asked for a change. Every one of those was a
 * capability in a URL, pasted through WhatsApp, working for whoever ended up
 * holding it. A judge is a friend with an account now, so all four things are
 * messages addressed to that account: "be my judge", "please decide this",
 * "please cancel this", and whatever the two of them type to each other.
 *
 * WHAT THIS IS NOT. It is not a general messenger. There are no attachments of
 * any kind (a message is text and nothing else), a message is capped at
 * {@link CHAT_MAX_CHARS} characters, and each person may send
 * {@link CHAT_MAX_TEXTS_PER_DAY} typed messages a day in any one conversation.
 * Both caps are enforced in SQL, inside the insert, under a lock on the thread —
 * the numbers here are for wording the message someone sees, not the gate.
 *
 * Neither cap is announced up front: nothing on the composer counts down at you
 * until you have actually run out, and then it says so plainly.
 */
import { apiPost, backendEnabled } from './backend';
import { sessionTokenOrNull } from './supabase';
import { uuid } from './storage';

/** The most characters one message can carry. */
export const CHAT_MAX_CHARS = 300;

/** How many typed messages one person may send per conversation per day. */
export const CHAT_MAX_TEXTS_PER_DAY = 20;

/**
 * What a message is.
 *
 *  • `text`    — something a person typed.
 *  • `request` — the app asking the judge for one specific thing. It renders as
 *    a card with the button that does it, so a request is never just a sentence
 *    the judge has to act on somewhere else.
 *  • `system`  — the app recording that something happened (a role accepted, a
 *    goal decided), so the conversation is the whole history of the goal.
 */
export type ChatKind = 'text' | 'request' | 'system';

/** The three things one account can ask another for. */
export type ChatRequest = 'judge_invite' | 'decision' | 'edit';

export interface ChatPayload {
  request?: ChatRequest;
  /** Which goal the request or event is about. */
  goalId?: string;
  /** The goal's per-owner number — the only thing about it anyone else sees. */
  goalNumber?: number;
  /** For a `system` message: what happened. */
  event?: 'accepted' | 'declined' | 'completed' | 'not_completed' | 'cancelled';
}

export interface ChatMessage {
  id: string;
  fromUserId: string;
  toUserId: string;
  kind: ChatKind;
  body: string;
  payload: ChatPayload;
  createdAt: string;
  readAt?: string;
}

/** One conversation, as the list of conversations shows it. */
export interface ChatThread {
  userId: string;
  lastBody: string;
  lastKind: ChatKind;
  lastAt: string;
  lastFromUserId: string;
  unread: number;
}

/** What a send did. `rate-limited` is a normal answer, not a failure. */
export type SendResult =
  | { sent: true; remaining: number }
  | { sent: false; reason: 'rate-limited' }
  | { sent: false; reason: 'offline' };

interface RawRow {
  id: string;
  from_user_id: string;
  to_user_id: string;
  kind: string;
  body: string;
  payload: ChatPayload | null;
  created_at: string;
  read_at: string | null;
}

function toMessage(row: RawRow): ChatMessage {
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    kind: (row.kind as ChatKind) ?? 'text',
    body: row.body ?? '',
    payload: row.payload ?? {},
    createdAt: row.created_at,
    readAt: row.read_at ?? undefined,
  };
}

/** Whether chat can work at all here (no backend = no shared store to talk in). */
export function chatEnabled(): boolean {
  return backendEnabled() && !!sessionTokenOrNull();
}

async function post<T>(path: string, payload: unknown): Promise<T | null> {
  const session = sessionTokenOrNull();
  // `backendEnabled` is false in the test suite as well as with no backend
  // configured, which is what keeps vitest hermetic.
  if (!backendEnabled() || !session) return null;
  try {
    return await apiPost<T>(path, payload, `chat ${path}`, { session });
  } catch (err) {
    console.warn('[chat]', path, (err as Error).message);
    return null;
  }
}

/**
 * Send a message. `kind` defaults to `text`, which is the only kind that counts
 * against the daily allowance — someone who has used their typed messages must
 * still be able to ask their judge to decide a goal.
 */
export async function sendMessage(input: {
  toUserId: string;
  text?: string;
  kind?: ChatKind;
  payload?: ChatPayload;
}): Promise<SendResult> {
  const body = (input.text ?? '').slice(0, CHAT_MAX_CHARS);
  const result = await post<{ sent?: boolean; reason?: string; remaining?: number }>('/api/chat/send', {
    // Client-side id, so a retry after a dropped response cannot post twice.
    id: uuid(),
    toUserId: input.toUserId,
    kind: input.kind ?? 'text',
    text: body,
    payload: input.payload ?? {},
  });
  if (!result) return { sent: false, reason: 'offline' };
  if (result.sent === false) {
    return { sent: false, reason: result.reason === 'rate-limited' ? 'rate-limited' : 'offline' };
  }
  return { sent: true, remaining: result.remaining ?? 0 };
}

/** One conversation, oldest message first (which is how it is read). */
export async function listMessages(withUserId: string, limit = 100): Promise<ChatMessage[]> {
  const data = await post<{ messages?: RawRow[] }>('/api/chat/list', { withUserId, limit });
  const rows = data?.messages ?? [];
  return rows.map(toMessage).sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
}

interface RawThread {
  other_user_id?: string;
  last_body?: string;
  last_kind?: string;
  last_at?: string;
  last_from?: string;
  unread?: number;
}

/** Every conversation this account is in, newest first. */
export async function listThreads(): Promise<ChatThread[]> {
  const data = await post<{ threads?: RawThread[] }>('/api/chat/threads', {});
  const rows = data?.threads ?? [];
  return rows
    .map((r) => ({
      userId: r.other_user_id ?? '',
      lastBody: r.last_body ?? '',
      lastKind: (r.last_kind as ChatKind) ?? 'text',
      lastAt: r.last_at ?? '',
      lastFromUserId: r.last_from ?? '',
      unread: Number(r.unread ?? 0) || 0,
    }))
    .filter((t) => t.userId);
}

/** Mark everything the other person sent in this conversation as read. */
export async function markThreadRead(withUserId: string): Promise<void> {
  await post('/api/chat/read', { withUserId });
}

/** Total unread across every conversation, for the badge. */
export async function unreadTotal(): Promise<number> {
  const threads = await listThreads();
  return threads.reduce((sum, t) => sum + t.unread, 0);
}

/**
 * The sentence a message shows in a list (thread previews, notifications).
 * A request and an event are rendered as cards in the conversation itself, but
 * anywhere they have to be one line, this is that line.
 */
export function chatPreview(message: Pick<ChatMessage, 'kind' | 'body' | 'payload'>): string {
  if (message.body) return message.body;
  const goal = message.payload.goalNumber ? `goal #${message.payload.goalNumber}` : 'a goal';
  switch (message.payload.request) {
    case 'judge_invite':
      return `Asked you to judge ${goal}`;
    case 'decision':
      return `Asked you to decide ${goal}`;
    case 'edit':
      return `Asked you to change ${goal}`;
    default:
      break;
  }
  switch (message.payload.event) {
    case 'accepted':
      return `Accepted judging ${goal}`;
    case 'declined':
      return `Declined judging ${goal}`;
    case 'completed':
      return `Marked ${goal} completed`;
    case 'not_completed':
      return `Marked ${goal} not completed`;
    case 'cancelled':
      return `Cancelled ${goal}`;
    default:
      return 'New message';
  }
}
