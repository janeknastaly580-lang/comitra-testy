/**
 * The half of the social graph that lives on the server.
 *
 * WHAT WAS WRONG BEFORE. Friends were local. `listProfiles` read this device's
 * own storage plus a set of seeded demo profiles, and `following` sat inside the
 * signed-in account's private state document — which no other account can read.
 * So two real people on two phones could never find each other, and neither
 * could ever observe a mutual follow. The demo profiles hid it: the screen was
 * full of friends, none of whom existed.
 *
 * That was survivable while a judge was invited by email. It stopped being
 * survivable the moment a judge became someone you pick FROM YOUR FRIENDS.
 *
 * HOW IT FITS. The server is the truth for two facts — who exists (a directory
 * row each account publishes about itself) and who follows whom. Everything
 * else still works off the local user list, so this module's job is to fold the
 * server's answer back into that list: `syncGraph` upserts the real people it
 * finds and rewrites this account's `following` from the server. The demo
 * profiles stay for a device with no backend, and are simply outnumbered once
 * real friends exist.
 */
import { apiPost, backendEnabled } from './backend';
import { sessionTokenOrNull } from './supabase';

/** One person as the directory knows them. Never an email address. */
export interface DirectoryPerson {
  id: string;
  name: string;
  avatar: string;
  bio: string;
}

/** A directory person plus this account's relationship to them. */
export interface GraphPerson extends DirectoryPerson {
  iFollow: boolean;
  followsMe: boolean;
  followers: number;
  following: number;
}

interface RawPerson {
  user_id?: string;
  name?: string;
  avatar?: string;
  bio?: string;
  i_follow?: boolean;
  follows_me?: boolean;
  followers?: number;
  following?: number;
}

function toPerson(row: RawPerson): GraphPerson {
  return {
    id: String(row.user_id ?? ''),
    name: String(row.name ?? ''),
    avatar: String(row.avatar ?? ''),
    bio: String(row.bio ?? ''),
    iFollow: row.i_follow === true,
    followsMe: row.follows_me === true,
    followers: Number(row.followers ?? 0) || 0,
    following: Number(row.following ?? 0) || 0,
  };
}

/** Whether the shared graph can be reached at all (false with no backend). */
export function socialSyncEnabled(): boolean {
  return backendEnabled() && !!sessionTokenOrNull();
}

async function post<T>(path: string, payload: unknown): Promise<T | null> {
  const session = sessionTokenOrNull();
  if (!backendEnabled() || !session) return null;
  try {
    return await apiPost<T>(path, payload, `social ${path}`, { session });
  } catch (err) {
    console.warn('[social]', path, (err as Error).message);
    return null;
  }
}

/**
 * Publish this account's public profile.
 *
 * Called after sign-in and after a profile edit. Without it an account is
 * invisible: nobody can search for it, and a friend who has already followed it
 * sees a nameless row.
 */
export async function publishProfile(input: { name: string; avatar: string; bio: string }): Promise<void> {
  await post('/api/users/publish', input);
}

/** Search the directory by display name. Two characters minimum. */
export async function searchPeople(query: string): Promise<DirectoryPerson[]> {
  const data = await post<{ people?: RawPerson[] }>('/api/users/search', { query });
  const rows = data?.people ?? [];
  return rows.map(toPerson).filter((p) => p.id);
}

/** Names and avatars for ids this device already holds. */
export async function fetchPeople(ids: string[]): Promise<DirectoryPerson[]> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return [];
  const data = await post<{ people?: RawPerson[] }>('/api/users/get', { ids: wanted });
  const rows = data?.people ?? [];
  return rows.map(toPerson).filter((p) => p.id);
}

/** Everyone this account follows or is followed by. */
export async function fetchGraph(): Promise<GraphPerson[]> {
  const data = await post<{ people?: RawPerson[] }>('/api/social/graph', {});
  const rows = data?.people ?? [];
  return rows.map(toPerson).filter((p) => p.id);
}

/** Follow or unfollow. Returns false when the server could not be told. */
export async function setFollow(userId: string, follow: boolean): Promise<boolean> {
  const data = await post<{ ok?: boolean }>('/api/social/follow', { userId, follow });
  return data?.ok === true;
}
