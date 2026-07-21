import { Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import BottomNav from './BottomNav';
import BrandMark from './BrandMark';
import { Badge } from './ui';

/** Authenticated shell: header + scrollable content + bottom nav. */
export default function AppLayout() {
  const { user } = useApp();
  const navigate = useNavigate();
  const entitled = user ? api.hasEntitlement(user) : false;
  const trialing = user?.subscription?.status === 'trialing' && entitled;

  return (
    <>
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-4 pb-3 pt-[calc(1.25rem+env(safe-area-inset-top))] sm:pt-8">
        <button onClick={() => navigate('/goals')} className="flex items-center gap-2">
          <BrandMark className="h-6 w-6" />
          <span className="font-mono text-sm font-bold tracking-[0.2em] text-ink">Comitra</span>
        </button>
        <button onClick={() => navigate('/subscription')}>
          <Badge tone={entitled ? (trialing ? 'accent' : 'active') : 'warn'}>
            {entitled ? (trialing ? 'Trial' : 'Subscribed') : 'Subscribe'}
          </Badge>
        </button>
      </header>

      <main className="phone-scroll flex-1 overflow-y-auto">
        <Outlet />
      </main>

      <BottomNav />
    </>
  );
}
