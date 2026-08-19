import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { countdown, dateTime } from '../lib/format';
import { goalRef, goalRefTitle } from '../lib/goal';
import { useNow } from '../lib/hooks';
import type { Goal, JudgeDecision } from '../lib/types';
import ConfirmDialog from '../components/ConfirmDialog';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card, Label, Textarea } from '../components/ui';
import { MessageSquare } from 'lucide-react';

/**
 * Judging one goal, from inside the app.
 *
 * This is what the old `/verify/:goalId/:token` page became. The differences are
 * not cosmetic: there is no link to hold and no secret code to type, because the
 * judge is signed in and the server answers for goals whose judge is THEM. What
 * they may do is decided there too, against the stored goal — this screen only
 * offers the buttons.
 *
 * PRIVACY, unchanged: the judge is shown the goal's NUMBER and never its title
 * or details. The person who set it tells their judge what it is.
 */
export default function JudgeGoal() {
  const { id } = useParams();
  const { user } = useApp();
  const navigate = useNavigate();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState<'accept' | 'decline' | JudgeDecision | 'cancel' | null>(null);
  const now = useNow(1000);

  async function load() {
    if (!id || !user) return;
    const mine = await api.listJudgingGoals(user.id);
    setGoal(mine.find((g) => g.id === id) ?? null);
    setLoaded(true);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user]);

  if (!user) return null;

  if (!loaded) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Judge" back />
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Judge" back />
        <Card className="p-6 text-center">
          <p className="text-sm text-muted">This goal isn't yours to judge, or it no longer exists.</p>
        </Card>
      </div>
    );
  }

  const cd = countdown(goal.deadlineAt, now);
  const pastDeadline = now > +new Date(goal.deadlineAt);
  const decided = !!goal.judge.decision || goal.status === 'cancelled';
  const pending = goal.judge.status === 'pending';
  const canDecide =
    goal.judge.status === 'accepted' && !decided && (pastDeadline || !!goal.earlyDecisionRequested);

  async function act(what: NonNullable<typeof confirm>) {
    setBusy(true);
    setError('');
    try {
      if (what === 'accept') await api.acceptJudgeRole(goal!.id, user!.id);
      else if (what === 'decline') await api.declineJudgeRole(goal!.id, user!.id);
      else if (what === 'cancel') await api.judgeCancel(goal!.id, user!.id);
      else await api.judgeDecide(goal!.id, user!.id, what, comment.trim() || undefined);
      setConfirm(null);
      setComment('');
      await load();
    } catch (err) {
      setError((err as Error).message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-5">
      <PageHeader
        title={`Judging ${goalRefTitle(goal)}`}
        back
        action={
          <button
            onClick={() => navigate(`/chat/${goal.userId}`)}
            aria-label={`Message ${goal.creatorName}`}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition hover:border-accent hover:text-accent"
          >
            <MessageSquare className="h-4 w-4" aria-hidden />
          </button>
        }
      />

      <Card className="mb-4 p-4">
        <p className="text-sm text-ink">
          Did {goal.creatorName} complete {goalRef(goal)}?
        </p>
        <p className="mt-1 text-[11px] text-muted">
          Comitra doesn't show you what the goal is — {goal.creatorName} tells you that.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Deadline</p>
            <p className={`font-mono text-sm ${cd.overdue ? 'text-danger' : 'text-ink'}`}>{cd.label}</p>
            <p className="text-[11px] text-muted">{dateTime(goal.deadlineAt)}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Status</p>
            <p className="font-mono text-sm text-ink">{goal.judge.status}</p>
          </div>
        </div>
      </Card>

      {error && <p className="mb-3 font-mono text-xs text-danger">{error}</p>}

      {/* Decided or cancelled: nothing left to do. */}
      {decided ? (
        <Card className="p-6 text-center">
          <Badge tone={goal.judge.decision === 'completed' ? 'accent' : 'danger'}>
            {goal.status === 'cancelled'
              ? 'Cancelled'
              : goal.judge.decision === 'completed'
                ? 'Marked completed'
                : 'Marked not completed'}
          </Badge>
          <p className="mt-3 text-sm text-muted">Your decision is recorded.</p>
        </Card>
      ) : goal.judge.status === 'declined' ? (
        <Card className="p-6 text-center">
          <Badge tone="danger">Declined</Badge>
          <p className="mt-3 text-sm text-muted">You turned this role down.</p>
        </Card>
      ) : pending ? (
        <Card className="p-4">
          <Label>Judge role</Label>
          <p className="mb-3 text-sm text-ink">
            Decide honestly, from what {goal.creatorName} told you the goal is.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" disabled={busy} onClick={() => setConfirm('decline')}>
              Decline
            </Button>
            <Button disabled={busy} onClick={() => setConfirm('accept')}>
              Accept role
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {canDecide ? (
            <Card className="p-4">
              <Label>Your decision</Label>
              {!pastDeadline && goal.earlyDecisionRequested && (
                <p className="mb-2 rounded-lg bg-accent/10 px-3 py-2 text-[12px] text-ink">
                  {goal.creatorName} asked you to decide now, before the deadline.
                </p>
              )}
              <Textarea
                rows={2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Optional comment"
                className="mb-3"
              />
              <div className="space-y-2">
                <Button className="w-full" disabled={busy} onClick={() => setConfirm('completed')}>
                  {goalRefTitle(goal)} completed
                </Button>
                <Button variant="danger" className="w-full" disabled={busy} onClick={() => setConfirm('not_completed')}>
                  {goalRefTitle(goal)} not completed
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="p-4 text-center">
              <p className="text-sm text-ink">
                You've accepted. Come back after the deadline — or sooner, if {goal.creatorName} asks you to.
              </p>
              <p className="mt-1 text-[11px] text-muted">Deadline: {dateTime(goal.deadlineAt)}</p>
            </Card>
          )}

          <Card className="mt-4 p-4">
            <Label>Cancel at their request</Label>
            {goal.cancelRequested ? (
              <>
                <p className="mb-2 text-[11px] text-muted">
                  {goal.creatorName} asked you to cancel {goalRef(goal)}. If they only need more time, they
                  can move the deadline themselves.
                </p>
                <Button variant="outline" className="w-full" disabled={busy} onClick={() => setConfirm('cancel')}>
                  Cancel this goal
                </Button>
              </>
            ) : (
              <p className="text-[11px] text-muted">
                Only if {goal.creatorName} asks you to. A button appears here if they do.
              </p>
            )}
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === 'accept'
            ? `Judge ${goalRef(goal)}?`
            : confirm === 'decline'
              ? `Turn down ${goalRef(goal)}?`
              : confirm === 'cancel'
                ? `Cancel ${goalRef(goal)}?`
                : confirm === 'completed'
                  ? `Mark ${goalRef(goal)} completed?`
                  : `Mark ${goalRef(goal)} not completed?`
        }
        message={
          confirm === 'accept' ? (
            <>You'll be the one who says whether {goal.creatorName} did it.</>
          ) : confirm === 'decline' ? (
            <>The goal does not start. {goal.creatorName} is told.</>
          ) : confirm === 'cancel' ? (
            <>Ends {goal.creatorName}'s goal with no decision. Nobody is told, nothing is blocked.</>
          ) : confirm === 'completed' ? (
            <>You confirm {goal.creatorName} did what they told you {goalRef(goal)} was. This is final.</>
          ) : (
            <>
              <span className="text-active">Recipients who accepted get the message.</span>{' '}
              <span className="font-medium text-active">Any app block they set starts now.</span> This is
              final.
            </>
          )
        }
        confirmLabel="I confirm"
        cancelLabel="Go back"
        danger={confirm === 'not_completed' || confirm === 'decline'}
        busy={busy}
        onConfirm={() => confirm && act(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
