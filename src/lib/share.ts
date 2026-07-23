/**
 * Link generation for judge invites and recipient invite / manage pages.
 *
 * We keep the HashRouter `#` so the same deep link works on localhost, through a
 * tunnel, and inside a WebView (file://).
 */
import type { Goal } from './types';

/**
 * The address the app is served from — NOT whatever page the user happens to be
 * on. Because routing is hash-based the path can be anything (`/register`, a
 * bookmarked deep path, a host redirect), and baking that into a shared link
 * produces a URL the recipient's browser 404s on before the app ever loads.
 *
 * The file:// case (Capacitor WebView) keeps its real path, since there the
 * document filename is the only way back into the app.
 */
function base(): string {
  const { origin, pathname, protocol } = window.location;
  if (protocol === 'file:' || pathname.endsWith('.html')) return `${origin}${pathname}`;
  return `${origin}${import.meta.env.BASE_URL || '/'}`;
}

/** Absolute judge link: `…/#/verify/<goalId>/<token>`. */
export function judgeLink(goal: Pick<Goal, 'id'> & { judge?: { acceptToken?: string }; shareToken?: string }): string {
  const token = goal.judge?.acceptToken ?? goal.shareToken ?? '';
  return `${base()}#/verify/${goal.id}/${token}`;
}

/** Absolute recipient invite / manage link: `…/#/recipient/<inviteToken>`. */
export function recipientLink(inviteToken: string): string {
  return `${base()}#/recipient/${inviteToken}`;
}

/** Absolute trainer-invite link: `…/#/coach-invite/<inviteToken>`. */
export function coachInviteLink(inviteToken: string): string {
  return `${base()}#/coach-invite/${inviteToken}`;
}

/** Absolute "invite a friend as a judge" link: `…/#/invite/<token>`. */
export function judgeInviteLink(token: string): string {
  return `${base()}#/invite/${token}`;
}
