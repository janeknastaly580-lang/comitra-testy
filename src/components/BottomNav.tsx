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
const SOCIAL = { to: '/social', label: 'Social', d: 'M16 11a3 3 0 100-6 3 3 0 000 6zM8 13a3 3 0 100-6 3 3 0 000 6zM2 20a6 6 0 0112 0M14 14a6 6 0 018 6' };
// Friends = mutual follows; shows rankings of your friends' goals.
const FRIENDS = { to: '/friends', label: 'Friends', d: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20a6 6 0 0112 0M17 11l2 2 4-4' };
const PLAN = { to: '/subscription', label: 'Plan', d: 'M4 6h16v12H4zM4 10h16' };
const PROFILE = { to: '/profile', label: 'Profile', d: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 20a7 7 0 0114 0' };
// Guests get a "Log in" entry in the profile slot instead (door + arrow icon).
const LOGIN = { to: '/login', label: 'Log in', d: 'M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3' };

export default function BottomNav() {
  const { user } = useApp();
  const items = [GOALS, SOCIAL, FRIENDS, PLAN, user?.isGuest ? LOGIN : PROFILE];
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
          <Icon d={it.d} />
          {it.label}
        </NavLink>
      ))}
    </nav>
  );
}
