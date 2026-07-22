import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { JudgeAccess } from '../lib/api';
import { countdown, dateTime } from '../lib/format';
import { goalRequired } from '../lib/goal';
import type { JudgeDecision } from '../lib/types';
import { JUDGE_CODE_MIN } from '../lib/api';
import { Badge, Button, Card, Input, Label, Textarea } from '../components/ui';
import BrandMark from '../components/BrandMark';

export default function Verifier() {
  const routeParams = useParams();
  const [params] = useSearchParams();
  const goalId = routeParams.challengeId ?? params.get('challengeId') ?? '';
  const token = routeParams.token ?? params.get('token') ?? '';

  const [access, setAccess] = useState<JudgeAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackRole, setAckRole] = useState(false);
  const [code, setCode] = useState('');
  const [decideCode, setDecideCode] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  const [reported, setReported] = useState(false);

  async function refresh() {
    if (!goalId || !token) {
      setAccess({ state: 'invalid-token' });
      return;
    }
    setAccess(await api.getJudgeAccess(goalId, token));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId, token]);

  const Shell = ({ children }: { children: ReactNode }) => (
    <div className="phone-scroll flex h-full flex-col overflow-y-auto px-5 pb-8 pt-10">
      <div className="mb-6 flex items-center gap-2">
        <BrandMark className="h-7 w-7" />
        <span className="font-mono text-sm font-bold tracking-[0.2em]">Comitra</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted">Judge view</span>
      </div>
      {children}
    </div>
  );

  if (!access) {
    return (
      <Shell>
        <p className="text-sm text-muted">Loading goal…</p>
      </Shell>
    );
  }

  if (access.state === 'not-found' || access.state === 'invalid-token') {
    return (
      <Shell>
        <Card className="p-6 text-center">
          <p className="text-sm text-danger">
            {access.state === 'not-found'
              ? "This goal couldn't be found on this device."
              : 'This judge link is malformed.'}
          </p>
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

  async function decide(decision: JudgeDecision) {
    setError('');
    setBusy(true);
    try {
      await api.judgeDecision(goalId, token, decision, comment, decideCode);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelByJudge() {
    setError('');
    setBusy(true);
    try {
      await api.judgeCancelGoal(goalId, token);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
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

  const cd = countdown(goal.deadlineAt);
  const pastDeadline = Date.now() > +new Date(goal.deadlineAt);

  return (
    <Shell>
      <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
        {goal.creatorName} asked you to judge
      </p>
      <h1 className="mb-1 text-xl font-bold text-ink">{goal.title}</h1>
      {goal.description && <p className="mb-4 text-sm text-muted">{goal.description}</p>}

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Steps</p>
            <p className="font-mono text-sm text-ink">{goal.evidence.length} / {goalRequired(goal)}</p>
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
              <p className="mt-3 text-sm text-muted">Thanks — your decision has been recorded.</p>
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
              You've been chosen to decide whether {goal.creatorName} completed this goal.
              You should decide honestly based on the available proof.
            </p>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 p-3">
              <input
                type="checkbox"
                checked={ackRole}
                onChange={(e) => setAckRole(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[color:rgb(var(--c-accent))]"
              />
              <span className="text-[12px] leading-relaxed text-ink">
                I understand that my decision may cause a message to be sent to the people the user
                chose.
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

      {/* Accepted — decision panel */}
      {access.state === 'awaiting-decision' && (
        <>
          <div className="mb-3">
            <Badge tone="accent">You are the judge · {goal.judge.name}</Badge>
          </div>

          <Card className="mb-4 p-4">
            <p className="text-sm text-ink">
              {`${goal.creatorName} planned to complete this goal in this period (${goal.evidence.length} of ${goalRequired(goal)} steps have proof). Check the proof and mark the result.`}
            </p>
          </Card>

          <Card className="mb-4 p-4">
            <Label>Proof from {goal.creatorName}</Label>
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
              <div className="space-y-2">
                <Button className="w-full" disabled={busy || !decideCode.trim()} onClick={() => decide('completed')}>
                  Goal completed
                </Button>
                <Button variant="danger" className="w-full" disabled={busy || !decideCode.trim()} onClick={() => decide('not_completed')}>
                  Goal not completed
                </Button>
                <Button variant="outline" className="w-full" disabled={busy || !decideCode.trim()} onClick={() => decide('needs_proof')}>
                  Need proof / can't decide
                </Button>
              </div>
              <p className="mt-3 text-[11px] text-muted">
                “Not completed” sends the pre-set message to the recipients who accepted.
              </p>
            </Card>
          )}

          {/* Cancel only when the creator has asked for it (they can't cancel a judged goal themselves). */}
          <Card className="mt-4 p-4">
            <Label>Cancel at the user's request</Label>
            {goal.cancelRequested ? (
              <>
                <p className="mb-2 text-[11px] text-muted">
                  {goal.creatorName} asked you to cancel this goal. No code is needed — cancelling never sends a message.
                </p>
                <Button variant="outline" className="w-full" disabled={busy} onClick={cancelByJudge}>
                  Cancel this goal
                </Button>
              </>
            ) : (
              <p className="text-[11px] text-muted">
                You can only cancel this goal if {goal.creatorName} asks you to. If they do, a cancel button appears here.
              </p>
            )}
          </Card>
        </>
      )}

      {/* Report abuse */}
      <div className="mt-6 border-t border-line pt-4">
        {reported ? (
          <p className="text-center text-[12px] text-muted">Thanks — your report was recorded.</p>
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
