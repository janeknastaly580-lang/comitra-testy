/**
 * The social graph, shared between devices.
 *
 * WHY THIS EXISTS. "Friends" used to be local: the app listed this phone's own
 * storage plus some seeded demo profiles, and `following` lived inside the
 * owner's private state document. Two real accounts could therefore never find
 * each other, and neither side could observe a mutual follow. That was survivable
 * while a judge was invited by email — the invited-judge table was the shared
 * thing that made a real judge reachable — but a judge is now picked FROM YOUR
 * FRIENDS, so the friends have to be real people the server can confirm.
 *
 * Same trust boundary as the rest of this function: the acting account comes
 * from the session token, never from the body. You can publish only your own
 * profile row and create only your own follows.
 *
 * PRIVACY: search is by display NAME. An address is never searchable and never
 * returned — it is how somebody is reached, not a handle, and a directory that
 * answered "who owns this address" would be exactly the lookup nobody should
 * have.
 */
import { ApiError } from './errors.ts';
import { rpc } from './state.ts';

function str(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

/** Publish (or refresh) the caller's own public profile row. */
export async function directoryPublish(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  await rpc<null>('comitra_directory_publish', {
    p_user: accountId,
    p_name: str(body.name, 80),
    // Large enough for the downscaled avatar the profile screen produces.
    p_avatar: typeof body.avatar === 'string' ? body.avatar.slice(0, 300_000) : '',
    p_bio: str(body.bio, 300),
  });
  return { ok: true };
}

export async function directorySearch(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const query = str(body.query, 80);
  // Two characters minimum, enforced in SQL as well: a one-letter query is a
  // request to enumerate the directory rather than to find somebody.
  if (query.length < 2) return { people: [] };
  const limit = Number(body.limit);
  const rows = await rpc<unknown[]>('comitra_directory_search', {
    p_user: accountId,
    p_query: query,
    p_limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 20,
  });
  return { people: Array.isArray(rows) ? rows : [] };
}

/** Names and avatars for ids the caller already holds. */
export async function directoryGet(_accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= 128)
    .slice(0, 200);
  if (ids.length === 0) return { people: [] };
  const rows = await rpc<unknown[]>('comitra_directory_get', { p_ids: ids });
  return { people: Array.isArray(rows) ? rows : [] };
}

export async function followSet(accountId: string, body: Record<string, unknown>): Promise<unknown> {
  const userId = str(body.userId, 128);
  if (!userId) throw new ApiError('bad-request', 'Could not do that.', 400, 'userId missing');
  if (userId === accountId) {
    throw new ApiError('bad-request', "You can't follow yourself.", 400, 'self-follow');
  }
  try {
    await rpc<null>('comitra_follow_set', {
      p_follower: accountId,
      p_followee: userId,
      p_on: body.follow !== false,
    });
  } catch (err) {
    const detail = (err as Error)?.message ?? '';
    if (detail.includes('following too many people')) {
      throw new ApiError('rate-limited', "You're following too many people.", 400, detail);
    }
    throw err;
  }
  return { ok: true };
}

/** Everyone this account follows or is followed by, with counts, in one call. */
export async function socialGraph(accountId: string): Promise<unknown> {
  const rows = await rpc<unknown[]>('comitra_social_graph', { p_user: accountId });
  return { people: Array.isArray(rows) ? rows : [] };
}
