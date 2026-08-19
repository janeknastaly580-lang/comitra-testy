import { NavLink } from 'react-router-dom';
import { useApp } from '../context/AppContext';

const linkBase = 'flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium transition';

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.6">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const GOALS = { to: '/goals', label: 'Goals', d: 'M4 6h16M4 12h16M4 18h10' };
// Everyone else, in one place: Discover, Friends and the Leaderboard are tabs
// inside it. Friends had a slot of its own down here and no longer needs one —
// it was a third view of the same people.
const SOCIAL = { to: '/social', label: 'Social', d: 'M16 11a3 3 0 100-6 3 3 0 000 6zM8 13a3 3 0 100-6 3 3 0 000 6zM2 20a6 6 0 0112 0M14 14a6 6 0 018 6' };
// Where every judge request lands, and where the two of you can just talk.
const MESSAGES = { to: '/messages', label: 'Chats', d: 'M21 12a8 8 0 01-11.6 7.1L3 21l1.9-6.4A8 8 0 1121 12z' };
const PROFILE = { to: '/profile', label: 'Profile', d: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 20a7 7 0 0114 0' };
// Guests get a "Log in" entry in the profile slot instead (door + arrow icon).
const LOGIN = { to: '/login', label: 'Log in', d: 'M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3' };

export default function BottomNav() {
  const { user, chatThreads } = useApp();
  const unread = chatThreads.reduce((sum, t) => sum + t.unread, 0);
  const items = [GOALS, SOCIAL, MESSAGES, user?.isGuest ? LOGIN : PROFILE];
  return (
    <nav className="relative flex shrink-0 items-stretch border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          className={({ isActive }) =>
            `${linkBase} ${isActive ? 'text-accent' : 'text-muted hover:text-ink'}`
          }
        >
          <span className="relative">
            <Icon d={it.d} />
            {it.to === MESSAGES.to && unread > 0 && (
              <span className="absolute -right-1.5 -top-1 min-w-[15px] rounded-full bg-accent px-1 text-center font-mono text-[9px] leading-[15px] text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </span>
          {it.label}
        </NavLink>
      ))}
    </nav>
  );
}
