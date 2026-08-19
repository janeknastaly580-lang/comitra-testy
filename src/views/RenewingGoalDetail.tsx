import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import {
  bestStreak,
  byMonth,
  formatDay,
  history,
  scheduleLabel,
  streak,
  todayStatus,
  totals,
  type DayStatus,
} from '../lib/renewing';
import type { RenewingGoal, Weekday } from '../lib/types';
import DayPicker from '../components/DayPicker';
import PageHeader from '../components/PageHeader';
import { Button, Card } from '../components/ui';

/** One look-up for every place a day's state has to be shown. */
const STATUS_STYLE: Record<DayStatus, { label: string; dot: string; text: string }> = {
  completed: { label: 'Done', dot: 'bg-active', text: 'text-active' },
  failed: { label: 'Not done', dot: 'bg-danger', text: 'text-danger' },
  missed: { label: 'Missed', dot: 'bg-warn', text: 'text-warn' },
  pending: { label: 'Today', dot: 'bg-accent', text: 'text-accent' },
};

export default function RenewingGoalDetail() {
  const { id = '' } = useParams();
  const { user } = useApp();
  const navigate = useNavigate();

  const [goal, setGoal] = useState<RenewingGoal | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingDays, setEditingDays] = useState(false);
  const [draftDays, setDraftDays] = useState<Weekday[]>([]);
  /** Which past row has its fix-it controls open. */
  const [openRow, setOpenRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    setGoal(await api.getRenewingGoal(id));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;

  if (goal === undefined) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Renewing goal" back />
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      </div>
    );
  }

  if (!goal || goal.userId !== user.id) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Renewing goal" back />
        <Card className="p-6 text-center">
          <p className="text-sm text-muted">This goal no longer exists.</p>
          <Button className="mt-4 w-full" onClick={() => navigate('/renewing')}>
            Back to renewing goals
          </Button>
        </Card>
      </div>
    );
  }

  const rows = history(goal);
  const now = streak(goal);
  const best = bestStreak(goal);
  const stats = totals(goal);
  const today = todayStatus(goal);
  const archived = !!goal.archivedAt;
  // Oldest first for the strip, so it reads left-to-right like a calendar.
  const strip = rows.slice(0, 21).reverse();

  return (
    <div className="px-4 py-5">
      <PageHeader title={goal.title} subtitle={scheduleLabel(goal.days)} back />

      {/* Streak */}
      <Card className="border-accent/40 bg-accent/5 p-5">
        <div className="flex items-end gap-3">
          <p className="font-mono text-5xl font-bold leading-none text-accent">{now}</p>
          <p className="pb-1 text-sm text-muted">
            {now === 1 ? 'day in a row' : 'days in a row'}
            {archived && ' · retired'}
          </p>
        </div>

        {strip.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1">
            {strip.map((row) => (
              <span
                key={row.date}
                title={`${formatDay(row.date)} · ${STATUS_STYLE[row.status].label}`}
                className={`h-3 w-3 rounded-[4px] ${
                  row.status === 'pending' ? 'bg-accent/30 ring-1 ring-accent' : STATUS_STYLE[row.status].dot
                }`}
              />
            ))}
          </div>
        )}

        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-accent/20 pt-3">
          <Stat label="Best run" value={String(best)} />
          <Stat label="Kept" value={String(stats.completed)} />
          <Stat label="Hit rate" value={stats.rate === null ? '—' : `${stats.rate}%`} />
        </div>
      </Card>

      {goal.note && <p className="mt-3 text-[13px] text-muted">{goal.note}</p>}

      {/* Today */}
      {!archived && today && (
        <Card className="mt-4 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Today</p>
          {today === 'pending' ? (
            <>
              <p className="mt-1 text-[13px] text-ink">Did you do it?</p>
              <div className="mt-3 flex gap-2">
                <Button
                  className="flex-1"
                  disabled={busy}
                  onClick={() => run(() => api.markRenewingDay(goal.id, user.id, 'completed'))}
                >
                  Did it
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => run(() => api.markRenewingDay(goal.id, user.id, 'failed'))}
                >
                  Didn’t
                </Button>
              </div>
            </>
          ) : (
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className={`text-[13px] font-semibold ${STATUS_STYLE[today].text}`}>
                {today === 'completed' ? 'Marked done.' : 'Marked not done.'}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run(() => api.clearRenewingDay(goal.id, user.id, rows[0].date))}
              >
                Undo
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Schedule */}
      <Card className="mt-4 p-4">
        {editingDays ? (
          <>
            <DayPicker value={draftDays} onChange={setDraftDays} disabled={busy} />
            <div className="mt-3 flex gap-2">
              <Button
                className="flex-1"
                disabled={busy || draftDays.length === 0}
                onClick={() =>
                  run(async () => {
                    await api.updateRenewingGoal(goal.id, user.id, { days: draftDays });
                    setEditingDays(false);
                  })
                }
              >
                Save days
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => setEditingDays(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Due</p>
              <p className="mt-0.5 truncate text-[13px] font-semibold text-ink">{scheduleLabel(goal.days)}</p>
            </div>
            {!archived && (
              <Button
                variant="outline"
                onClick={() => {
                  setDraftDays([...goal.days]);
                  setEditingDays(true);
                }}
              >
                Change
              </Button>
            )}
          </div>
        )}
      </Card>

      {error && (
        <Card className="mt-3 border-danger/40 bg-danger/5 p-3">
          <p className="text-[13px] text-danger">{error}</p>
        </Card>
      )}

      {/* History */}
      <section className="mt-6">
        <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">History</h2>
        {rows.length === 0 ? (
          <Card className="p-5 text-center">
            <p className="text-[13px] text-muted">
              Nothing yet. The first day it is due will show up here.
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {byMonth(rows).map((block) => (
              <div key={block.month}>
                <p className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-widest text-muted">
                  {block.month}
                </p>
                <div className="overflow-hidden rounded-2xl border border-line">
                  {block.rows.map((row, i) => {
                    const style = STATUS_STYLE[row.status];
                    const open = openRow === row.date;
                    return (
                      <div
                        key={row.date}
                        className={`${i % 2 === 1 ? 'bg-elevated/40' : ''} ${
                          i > 0 ? 'border-t border-line/60' : ''
                        }`}
                      >
                        <button
                          type="button"
                          disabled={archived}
                          onClick={() => setOpenRow(open ? null : row.date)}
                          className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
                        >
                          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
                          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                            {formatDay(row.date)}
                          </span>
                          <span className={`shrink-0 text-[12px] font-semibold ${style.text}`}>
                            {style.label}
                          </span>
                        </button>

                        {open && !archived && (
                          <div className="flex gap-2 px-4 pb-3">
                            <Button
                              className="flex-1"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  await api.markRenewingDay(goal.id, user.id, 'completed', row.date);
                                  setOpenRow(null);
                                })
                              }
                            >
                              Done
                            </Button>
                            <Button
                              variant="outline"
                              className="flex-1"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  await api.markRenewingDay(goal.id, user.id, 'failed', row.date);
                                  setOpenRow(null);
                                })
                              }
                            >
                              Not done
                            </Button>
                            {row.status !== 'missed' && row.status !== 'pending' && (
                              <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  run(async () => {
                                    await api.clearRenewingDay(goal.id, user.id, row.date);
                                    setOpenRow(null);
                                  })
                                }
                              >
                                Clear
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Retire / delete */}
      <section className="mt-6">
        <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">This goal</h2>
        <Card className="p-4">
          {archived ? (
            <>
              <p className="text-[12px] text-muted">
                Retired, record kept. Starting it again counts from today.
              </p>
              <Button
                className="mt-3 w-full"
                disabled={busy}
                onClick={() => run(() => api.resumeRenewingGoal(goal.id, user.id))}
              >
                Start it again
              </Button>
            </>
          ) : (
            <>
              <p className="text-[12px] text-muted">
                Retiring stops it asking for anything, and keeps the history.
              </p>
              <Button
                variant="outline"
                className="mt-3 w-full"
                disabled={busy}
                onClick={() => run(() => api.archiveRenewingGoal(goal.id, user.id))}
              >
                Retire this goal
              </Button>
            </>
          )}
          <Button
            variant="danger"
            className="mt-2 w-full"
            disabled={busy}
            onClick={() => {
              if (!confirm('Delete this goal and its whole history? This cannot be undone.')) return;
              void run(async () => {
                await api.deleteRenewingGoal(goal.id, user.id);
                navigate('/renewing', { replace: true });
              });
            }}
          >
            Delete for good
          </Button>
        </Card>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted">{label}</p>
      <p className="mt-0.5 font-mono text-lg font-bold text-ink">{value}</p>
    </div>
  );
}
