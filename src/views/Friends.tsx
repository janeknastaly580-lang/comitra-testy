import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type { FriendStat } from '../lib/api';
import { Avatar } from '../components/Avatar';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card } from '../components/ui';

type Window = '30' | '90';

const WINDOWS: { id: Window; label: string }[] = [
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 3 months' },
];

export default function Friends() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [stats, setStats] = useState<FriendStat[] | null>(null);
  const [win, setWin] = useState<Window>('30');

  useEffect(() => {
    if (user) api.getFriendsStats(user.id).then(setStats);
  }, [user]);

  if (!user) return null;

  const value = (s: FriendStat) => (win === '30' ? s.completed30 : s.completed90);
  // Rank by completions in the window, then by success rate.
  const ranked = stats
    ? [...stats].sort((a, b) => value(b) - value(a) || (b.successRate ?? -1) - (a.successRate ?? -1))
    : [];
  const friends = ranked.filter((s) => !s.isMe);
  const top = value(ranked[0] ?? ({} as FriendStat)) || 1;

  return (
    <div className="px-4 py-5">
      <PageHeader title="Friends" subtitle="How you and your friends are doing" />

      {/* Window toggle */}
      <div className="mb-4 flex gap-1.5">
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => setWin(w.id)}
            className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
              win === w.id ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {stats === null ? (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      ) : friends.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">No friends yet</p>
          <p className="mt-2 text-sm text-ink">Friends are people you follow who also follow you back.</p>
          <p className="mt-1 text-[12px] text-muted">Follow people in the Social tab — once it's mutual, they show up here.</p>
          <Button className="mt-4 w-full" onClick={() => navigate('/social')}>Find people</Button>
        </Card>
      ) : (
        <>
          <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
            Goal ranking · {win === '30' ? '30 days' : '3 months'}
          </h2>
          <div className="space-y-2">
            {ranked.map((s, i) => (
              <Card
                key={s.id}
                onClick={() => (s.isMe ? navigate('/profile') : navigate(`/u/${s.id}`))}
                className={`p-3 ${s.isMe ? 'border-accent/40 bg-accent/5' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <span className="w-5 shrink-0 text-center font-mono text-sm font-bold text-muted">{i + 1}</span>
                  <Avatar avatar={s.avatar} name={s.name} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-ink">{s.name}</p>
                      {s.isMe && <Badge tone="accent">You</Badge>}
                    </div>
                    {/* completions bar */}
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((value(s) / top) * 100)}%` }} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-base font-bold text-ink">{value(s)}</p>
                    <p className="font-mono text-[9px] uppercase tracking-widest text-muted">done</p>
                  </div>
                  <div className="w-14 shrink-0 text-right">
                    <p className="font-mono text-base font-bold text-accent">
                      {s.successRate == null ? '—' : `${s.successRate}%`}
                    </p>
                    <p className="font-mono text-[9px] uppercase tracking-widest text-muted">success</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <p className="mt-3 text-center text-[11px] text-muted">
            “Done” = completed goals in this window. “Success” = completed vs. missed, all-time.
          </p>
        </>
      )}
    </div>
  );
}
