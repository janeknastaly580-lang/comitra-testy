import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { scheduleLabel, streak, todayStatus } from '../lib/renewing';
import type { RenewingGoal } from '../lib/types';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card } from '../components/ui';

export default function RenewingGoals() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState<RenewingGoal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (user) setItems(await api.listRenewingGoals(user.id));
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user) return null;

  const live = (items ?? []).filter((g) => !g.archivedAt);
  const dueToday = live.filter((g) => todayStatus(g) === 'pending');
  const rest = live.filter((g) => todayStatus(g) !== 'pending');
  const archived = (items ?? []).filter((g) => g.archivedAt);

  async function mark(goal: RenewingGoal, status: 'completed' | 'failed') {
    setBusy(goal.id);
    try {
      await api.markRenewingDay(goal.id, user!.id, status);
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-4 py-5">
      <PageHeader
        title="Renewing goals"
        subtitle="The same goal, back on the days you pick"
        back
        action={<Button onClick={() => navigate('/renewing/new')}>+ New</Button>}
      />

      {items === null ? (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <Card className="border-accent/40 bg-accent/5 p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Renewing goal</p>
          <p className="mt-1 text-base font-semibold text-ink">A goal that comes back</p>
          <p className="mt-1 text-[12px] text-muted">
            The days you pick, every week. Comitra keeps the streak and the record.
          </p>
          <Button className="mt-3 w-full" onClick={() => navigate('/renewing/new')}>
            Set a renewing goal
          </Button>
        </Card>
      ) : (
        <div className="space-y-6">
          {dueToday.length > 0 && (
            <Section title={`Due today · ${dueToday.length}`} accent>
              {dueToday.map((goal) => (
                <Card key={goal.id} className="border-accent/40 bg-accent/5 p-4">
                  <button
                    type="button"
                    className="block w-full text-left"
                    onClick={() => navigate(`/renewing/${goal.id}`)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink">{goal.title}</p>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted">
                          {scheduleLabel(goal.days)}
                        </p>
                      </div>
                      <StreakBadge goal={goal} />
                    </div>
                  </button>
                  <div className="mt-3 flex gap-2">
                    <Button
                      className="flex-1"
                      disabled={busy === goal.id}
                      onClick={() => mark(goal, 'completed')}
                    >
                      Did it
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      disabled={busy === goal.id}
                      onClick={() => mark(goal, 'failed')}
                    >
                      Didn’t
                    </Button>
                  </div>
                </Card>
              ))}
            </Section>
          )}

          {rest.length > 0 && (
            <Section title={dueToday.length > 0 ? 'Everything else' : 'Your goals'}>
              {rest.map((goal) => (
                <GoalRow key={goal.id} goal={goal} onOpen={() => navigate(`/renewing/${goal.id}`)} />
              ))}
            </Section>
          )}

          {archived.length > 0 && (
            <Section title="Retired">
              {archived.map((goal) => (
                <GoalRow key={goal.id} goal={goal} onOpen={() => navigate(`/renewing/${goal.id}`)} />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children, accent }: { title: string; children: ReactNode; accent?: boolean }) {
  return (
    <section>
      <h2
        className={`mb-2 font-mono text-xs uppercase tracking-widest ${accent ? 'text-accent' : 'text-muted'}`}
      >
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function StreakBadge({ goal }: { goal: RenewingGoal }) {
  const n = streak(goal);
  if (n === 0) return <Badge tone="neutral">No streak</Badge>;
  return <Badge tone="accent">{n} in a row</Badge>;
}

function GoalRow({ goal, onOpen }: { goal: RenewingGoal; onOpen: () => void }) {
  const status = todayStatus(goal);
  const state =
    goal.archivedAt
      ? { tone: 'neutral' as const, text: 'Retired' }
      : status === 'completed'
        ? { tone: 'active' as const, text: 'Done today' }
        : status === 'failed'
          ? { tone: 'danger' as const, text: 'Missed today' }
          : { tone: 'neutral' as const, text: 'Not due today' };

  return (
    <Card onClick={onOpen} className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`truncate font-semibold ${goal.archivedAt ? 'text-muted' : 'text-ink'}`}>{goal.title}</p>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-muted">
            {scheduleLabel(goal.days)}
          </p>
        </div>
        <Badge tone={state.tone}>{state.text}</Badge>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <StreakBadge goal={goal} />
        <p className="font-mono text-[11px] text-muted">Open →</p>
      </div>
    </Card>
  );
}
