import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { JudgeAccess, JudgeLinkRequest } from '../lib/api';
import { countdown, dateTime } from '../lib/format';
import { goalRef, goalRefTitle } from '../lib/goal';
import { useNow } from '../lib/hooks';
import type { JudgeDecision } from '../lib/types';
import { JUDGE_CODE_MIN } from '../lib/api';
import { Badge, Button, Card, Input, Label, Textarea } from '../components/ui';
import BrandMark from '../components/BrandMark';
import ConfirmDialog from '../components/ConfirmDialog';

// Module-scope so it keeps a stable identity across renders, see InviteAccept:
// an in-component Shell remounts every keystroke and inputs (the judge password /
// comment fields) lose focus.
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="phone-scroll flex h-full flex-col overflow-y-auto px-5 pb-8 pt-10">
      <div className="mb-6 flex items-center gap-2">
        <BrandMark className="h-7 w-7" />
        <span className="font-mono text-sm font-bold tracking-[0.2em]">Comitra</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted">Judge view</span>
      </div>
      {children}
    </div>
  );
}

export default function Verifier() {
  const routeParams = useParams();
  const [params] = useSearchParams();
  const goalId = routeParams.challengeId ?? params.get('challengeId') ?? '';
  const token = routeParams.token ?? params.get('token') ?? '';
  // What the owner is asking for. The link they sent IS the request: Comitra
  // never messages a judge by itself. See `api.applyJudgeLinkRequest`.
  const askParam = params.get('ask');
  const ask: JudgeLinkRequest | null =
    askParam === 'decision' || askParam === 'edit' ? askParam : null;

  const [access, setAccess] = useState<JudgeAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackRole, setAckRole] = useState(false);
  const [code, setCode] = useState('');
  const [decideCode, setDecideCode] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [confirmDecision, setConfirmDecision] = useState<JudgeDecision | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  const [reported, setReported] = useState(false);
  // Keeps the deadline countdown moving while the judge has the page open.
  const now = useNow(1000);

  async function refresh() {
    if (!goalId || !token) {
      setAccess({ state: 'invalid-token' });
      return;
    }
    setAccess(await api.getJudgeAccess(goalId, token));
  }

  useEffect(() => {
    void (async () => {
      if (ask && goalId && token) await api.applyJudgeLinkRequest(goalId, token, ask);
      await refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId, token, ask]);

  if (!access) {
    return (
      <Shell>
        <p className="text-sm text-muted">Loading goal…</p>
      </Shell>
    );
  }

  if (
    access.state === 'not-found' ||
    access.state === 'invalid-token' ||
    access.state === 'sync-off' ||
    access.state === 'sync-unavailable'
  ) {
    // Four very different problems, and only one of them is the judge's to act
    // on. Saying "not found on this device" for all of them sent people looking
    // for a fault on their own phone when the server was the problem.
    const message =
      access.state === 'invalid-token'
        ? 'This judge link is incomplete. Ask for it again — links break when a chat cuts them in half.'
        : access.state === 'sync-off'
          ? "This copy of Comitra has no server set up, so a goal set on someone else's phone can't be opened here."
          : access.state === 'sync-unavailable'
            ? access.reason === 'setup'
              ? "Comitra's server isn't finished setting up, so this goal can't be loaded yet. Tell the person who sent you the link."
              : "We couldn't reach Comitra's server. Check your connection and open the link again."
            : "This goal no longer exists, or the link was replaced by a newer one.";
    return (
      <Shell>
        <Card className="p-6 text-center">
          <p className="text-sm text-danger">{message}</p>
          <Link to="/login" className="mt-3 inline-block text-sm text-accent hover:underline">
            Go to Comitra
          </Link>
        </Card>
      </Shell>
    );
  }

  if (access.state === 'creator-blocked') {
    return (
      <Shell>
        <div className="rounded-lg border-2 border-danger bg-danger/10 p-6 text-center">
          <p className="text-lg font-bold text-danger">Access Denied</p>
          <p className="mt-2 text-sm text-danger">You cannot judge your own goal. Send this link to your chosen judge.</p>
        </div>
      </Shell>
    );
  }

  const goal = access.goal;

  async function accept() {
    setError('');
    setBusy(true);
    try {
      await api.acceptJudge(goalId, token, code);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await api.declineJudge(goalId, token);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /** Runs only after the judge confirms in the dialog: this is the real decision. */
  async function decide(decision: JudgeDecision) {
    setError('');
    setBusy(true);
    try {
      await api.judgeDecision(goalId, token, decision, comment, decideCode);
      setConfirmDecision(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setConfirmDecision(null);
    } finally {
      setBusy(false);
    }
  }

  async function cancelByJudge() {
    setError('');
    setBusy(true);
    try {
      await api.judgeCancelGoal(goalId, token);
      setConfirmCancel(false);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setConfirmCancel(false);
    } finally {
      setBusy(false);
    }
  }

  async function submitReport() {
    setBusy(true);
    try {
      await api.reportAbuse({
        reporterRole: 'judge',
        ownerUserId: goal.userId,
        goalId: goal.id,
        reason: reportText,
      });
      setReported(true);
      setReportOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const cd = countdown(goal.deadlineAt, now);
  const pastDeadline = now > +new Date(goal.deadlineAt);

  return (
    <Shell>
      {/* PRIVACY: the judge is shown the goal's NUMBER only, never its title or
          details. The person who set the goal tells their judge what it is.
          Making a goal public later never changes this, see `setGoalVisibility`. */}
      <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
        {goal.creatorName} asked you to judge
      </p>
      <h1 className="mb-1 text-xl font-bold text-ink">
        Did {goal.creatorName} complete {goalRef(goal)}?
      </h1>
      <p className="mb-4 text-[12px] text-muted">
        Comitra doesn’t show you what the goal is. {goal.creatorName} tells you that themselves. You
        only decide whether they did it.
      </p>

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Goal</p>
            <p className="font-mono text-sm text-ink">{goalRefTitle(goal)}</p>
            <p className="text-[11px] text-muted">{goal.evidence.length} proof(s) added</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Deadline</p>
            <p className={`font-mono text-sm ${cd.overdue ? 'text-danger' : 'text-ink'}`}>{cd.label}</p>
            <p className="text-[11px] text-muted">{dateTime(goal.deadlineAt)}</p>
          </div>
        </div>
      </Card>

      {/* Decided (or cancelled) */}
      {access.state === 'decided' && (
        <Card className="p-6 text-center">
          {goal.status === 'cancelled' ? (
            <>
              <Badge tone="neutral">Cancelled</Badge>
              <p className="mt-3 text-sm text-muted">This goal was cancelled at the user's request.</p>
            </>
          ) : (
            <>
              <Badge tone={goal.judge.decision === 'completed' ? 'accent' : 'danger'}>
                {goal.judge.decision === 'completed' ? 'Marked completed' : 'Marked not completed'}
              </Badge>
              <p className="mt-3 text-sm text-muted">Thanks, your decision has been recorded.</p>
            </>
          )}
        </Card>
      )}

      {access.state === 'declined' && (
        <Card className="p-6 text-center">
          <Badge tone="danger">Declined</Badge>
          <p className="mt-3 text-sm text-muted">You declined this role. The goal will not start.</p>
        </Card>
      )}

      {/* Pending acceptance */}
      {access.state === 'pending-acceptance' && (
        <>
          <Card className="p-4">
            <Label>Judge role</Label>
            <p className="mb-3 text-sm text-ink">
              You've been chosen to decide whether {goal.creatorName} completed {goalRef(goal)}.
              You should decide honestly, based on what they told you the goal is and on any proof
              they add here.
            </p>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 p-3">
              <input
                type="checkbox"
                checked={ackRole}
                onChange={(e) => setAckRole(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[color:rgb(var(--c-accent))]"
              />
              <span className="text-[12px] leading-relaxed text-active">
                I understand my decision may cause a message to be sent.
              </span>
            </label>

            <div className="mt-3">
              <Label>Set your secret code</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={`At least ${JUDGE_CODE_MIN} characters`}
                autoComplete="off"
              />
              <p className="mt-1.5 text-[11px] text-muted">
                Keep this code secret. You'll enter it every time you verify a goal, and it proves
                the decision is really from you. Accepting also means {goal.creatorName} can pick you
                as their judge again without asking each time.
              </p>
            </div>

            {error && <p className="mt-3 font-mono text-xs text-danger">{error}</p>}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Button variant="outline" disabled={busy} onClick={decline}>
                Decline
              </Button>
              <Button disabled={busy || !ackRole || code.trim().length < JUDGE_CODE_MIN} onClick={accept}>
                Accept role
              </Button>
            </div>
          </Card>
        </>
      )}

      {/* Accepted: decision panel */}
      {access.state === 'awaiting-decision' && (
        <>
          <div className="mb-3">
            <Badge tone="accent">You are the judge · {goal.judge.name}</Badge>
          </div>

          <Card className="mb-4 p-4">
            <p className="text-sm text-ink">
              {`${goal.creatorName} committed to complete ${goalRef(goal)} within this period. Decide whether they did it, because you know what the goal is because they told you.`}
            </p>
          </Card>

          <Card className="mb-4 p-4">
            <Label>Proof {goal.creatorName} chose to share</Label>
            {goal.evidence.length === 0 ? (
              <p className="text-[12px] text-muted">No proof has been added yet.</p>
            ) : (
              <div className="space-y-2">
                {goal.evidence.map((ev) => (
                  <div key={ev.id} className="rounded-lg border border-line bg-elevated p-3">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
                      {ev.type} · {dateTime(ev.actionDate ?? ev.addedAt)}
                    </p>
                    {ev.photoUrl && <img src={ev.photoUrl} alt="proof" className="mt-2 max-h-48 rounded-lg" />}
                    {ev.linkUrl && (
                      <a href={ev.linkUrl} target="_blank" rel="noopener noreferrer" className="mt-1 block break-all text-sm text-accent underline">
                        {ev.linkUrl}
                      </a>
                    )}
                    {ev.note && <p className="mt-1 whitespace-pre-line text-sm text-ink">{ev.note}</p>}
                    {!ev.photoUrl && !ev.linkUrl && !ev.note && ev.type === 'text' && (
                      <p className="mt-1 whitespace-pre-line text-sm text-ink">{ev.content}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {!pastDeadline && !goal.earlyDecisionRequested ? (
            <Card className="p-4 text-center">
              <p className="text-sm text-ink">You've accepted. Come back after the deadline to decide.</p>
              <p className="mt-1 text-[11px] text-muted">Deadline: {dateTime(goal.deadlineAt)}</p>
              <p className="mt-1 text-[11px] text-muted">You can only decide early if {goal.creatorName} asks you to.</p>
            </Card>
          ) : (
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
              <Label>Your secret code</Label>
              <Input
                value={decideCode}
                onChange={(e) => setDecideCode(e.target.value)}
                placeholder="Enter the code you set when you accepted"
                autoComplete="off"
                className="mb-3"
              />
              {error && <p className="mb-3 font-mono text-xs text-danger">{error}</p>}
              {/* Every button here only OPENS the confirmation: nothing is
                  recorded until the judge confirms in the dialog. */}
              <div className="space-y-2">
                <Button className="w-full" disabled={busy || !decideCode.trim()} onClick={() => setConfirmDecision('completed')}>
                  {goalRefTitle(goal)} completed
                </Button>
                <Button variant="danger" className="w-full" disabled={busy || !decideCode.trim()} onClick={() => setConfirmDecision('not_completed')}>
                  {goalRefTitle(goal)} not completed
                </Button>
                <Button variant="outline" className="w-full" disabled={busy || !decideCode.trim()} onClick={() => setConfirmDecision('needs_proof')}>
                  Need proof / can't decide
                </Button>
              </div>
              <p className="mt-3 text-[11px] text-active">
                “Not completed” messages the recipients who accepted.
              </p>
              <p className="mt-1 text-[11px] font-medium text-active">
                It also starts any app block {goal.creatorName} set for themselves.
              </p>
            </Card>
          )}

          {/* Change / cancel: only when the creator asked for it, by sending the
              "ask for a change" link (they can't cancel a judged goal themselves). */}
          <Card className="mt-4 p-4">
            <Label>Change or cancel at the user's request</Label>
            {goal.cancelRequested ? (
              <>
                <p className="mb-2 text-[11px] text-muted">
                  {goal.creatorName} is asking you to change or cancel {goalRef(goal)}. Cancelling ends
                  the goal with no decision and no message to anyone, so no code is needed. If they only
                  need more time, they can move the deadline themselves — you don't have to do anything.
                </p>
                <Button variant="outline" className="w-full" disabled={busy} onClick={() => setConfirmCancel(true)}>
                  Cancel this goal
                </Button>
              </>
            ) : (
              <p className="text-[11px] text-muted">
                You can only cancel this goal if {goal.creatorName} asks you to, by sending you their
                “ask for a change” link. If they do, a cancel button appears here.
              </p>
            )}
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirmDecision !== null}
        title={
          confirmDecision === 'completed'
            ? `Mark ${goalRef(goal)} completed?`
            : confirmDecision === 'not_completed'
              ? `Mark ${goalRef(goal)} not completed?`
              : 'Ask for more proof?'
        }
        message={
          confirmDecision === 'completed' ? (
            <>
              You confirm {goal.creatorName} did what they told you {goalRef(goal)} was. This is final
              and cannot be changed afterwards.
            </>
          ) : confirmDecision === 'not_completed' ? (
            <>
              <span className="text-active">
                Recipients who accepted get the message about {goalRef(goal)}.
              </span>{' '}
              <span className="font-medium text-active">
                Any app block they set for themselves starts now.
              </span>{' '}
              This is final and cannot be changed afterwards.
            </>
          ) : (
            <>
              You tell {goal.creatorName} you can't decide yet and need more proof. Nothing is sent to
              anyone, and you can decide later.
            </>
          )
        }
        confirmLabel="I confirm"
        cancelLabel="Go back"
        danger={confirmDecision === 'not_completed'}
        busy={busy}
        onConfirm={() => confirmDecision && decide(confirmDecision)}
        onCancel={() => setConfirmDecision(null)}
      />

      <ConfirmDialog
        open={confirmCancel}
        title={`Cancel ${goalRef(goal)}?`}
        message={`This ends ${goal.creatorName}'s goal with no decision. No message is sent to anyone, and no app is blocked.`}
        confirmLabel="I confirm"
        cancelLabel="Go back"
        danger
        busy={busy}
        onConfirm={cancelByJudge}
        onCancel={() => setConfirmCancel(false)}
      />

      {/* Report abuse */}
      <div className="mt-6 border-t border-line pt-4">
        {reported ? (
          <p className="text-center text-[12px] text-muted">Thanks, your report was recorded.</p>
        ) : reportOpen ? (
          <Card className="p-4">
            <Label>Report abuse</Label>
            <Textarea rows={3} value={reportText} onChange={(e) => setReportText(e.target.value)} placeholder="What's wrong with this goal?" />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setReportOpen(false)}>Cancel</Button>
              <Button disabled={busy || reportText.trim().length < 5} onClick={submitReport}>Send report</Button>
            </div>
          </Card>
        ) : (
          <button onClick={() => setReportOpen(true)} className="w-full text-center text-[11px] text-muted hover:text-danger">
            Report abuse
          </button>
        )}
      </div>
    </Shell>
  );
}
