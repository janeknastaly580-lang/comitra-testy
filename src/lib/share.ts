/**
 * Link generation for judge invites and recipient invite / manage pages.
 *
 * We keep the HashRouter `#` so the same deep link works on localhost, through a
 * tunnel, and inside a WebView (file://).
 */
import type { Goal } from './types';

/**
 * The address the app is served from. NOT whatever page the user happens to be
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
  // `import.meta.env.BASE_URL` is './' here (vite.config `base: './'`, so assets load
  // by relative path inside the Capacitor WebView). That's correct for assets but
  // INVALID inside an absolute share URL: `${origin}./` becomes
  // `https://host./#/…`: a trailing-dot host the recipient's browser can't reach
  // ("this site can't be reached"). Share links live at the web root, so use
  // `${origin}/`, honouring only a genuine absolute sub-path base if one is ever set.
  const b = import.meta.env.BASE_URL || '/';
  const path = b.startsWith('/') ? b : '/';
  return `${origin}${path}`;
}

/**
 * Absolute judge link: `…/#/verify/<goalId>/<token>`.
 *
 * `ask` is what the owner wants from their judge, and it is the whole request:
 * Comitra never messages a judge on its own, so the link the owner hands over is
 * what opens the matching panel — `decision` to mark the goal completed or not
 * completed, `edit` to ask for a change or a cancellation. Plain (no `ask`) is
 * the invite link, which only offers the judge role.
 */
export function judgeLink(
  goal: Pick<Goal, 'id'> & { judge?: { acceptToken?: string }; shareToken?: string },
  ask?: 'decision' | 'edit',
): string {
  const token = goal.judge?.acceptToken ?? goal.shareToken ?? '';
  return `${base()}#/verify/${goal.id}/${token}${ask ? `?ask=${ask}` : ''}`;
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
