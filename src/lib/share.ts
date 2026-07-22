/**
 * Link generation for judge invites and recipient invite / manage pages.
 *
 * We keep the HashRouter `#` so the same deep link works on localhost, through a
 * tunnel, and inside a WebView (file://).
 */
import type { Goal } from './types';

function base(): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}`;
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
