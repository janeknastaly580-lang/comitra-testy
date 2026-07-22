import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { BLOCK_DURATIONS } from '../lib/constants';
import { countdown, dateTime, shortDate } from '../lib/format';
import { deadlineElapsedPct, goalStart, isSoloGoal } from '../lib/goal';
import { failureMessageForGoal } from '../lib/messages';
import { judgeLink, recipientLink } from '../lib/share';
import { statusMeta, PRE_ACTIVE, TERMINAL } from '../lib/status';
import type { Goal, NotificationLog, OutboxMessage, RecipientConsent } from '../lib/types';
import ConfirmDialog from '../components/ConfirmDialog';
import PageHeader from '../components/PageHeader';
import ShareLink from '../components/ShareLink';
import { Badge, Button, Card, Input, Label, Textarea } from '../components/ui';

const TONE_LABEL = { neutral: 'Neutral', supportive: 'Supportive', firm: 'Firm' } as const;
const CONSENT_TONE = { pending: 'warn', accepted: 'accent', revoked: 'danger' } as const;
const JUDGE_TONE = { pending: 'warn', accepted: 'accent', declined: 'danger' } as const;

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function GoalDetail() {
  const { id } = useParams();
  const { user } = useApp();
  const navigate = useNavigate();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [consents, setConsents] = useState<RecipientConsent[]>([]);
  const [notes, setNotes] = useState<NotificationLog[]>([]);
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const [notice, setNotice] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [rateVal, setRateVal] = useState('');
  const [rateBusy, setRateBusy] = useState(false);

  // Evidence form
  const [evOpen, setEvOpen] = useState(false);
  const [evTarget, setEvTarget] = useState<string | undefined>(undefined);
  const [evDate, setEvDate] = useState(todayISO());
  const [evNote, setEvNote] = useState('');
  const [evLink, setEvLink] = useState('');
  const [evPhoto, setEvPhoto] = useState('');

  async function load() {
    if (!id || !user) return;
    const g = await api.getGoal(id);
    setGoal(g);
    setConsents(await api.listOwnerConsents(user.id));
    setOutbox(await api.listOutbox(id));
    if (g && g.status === 'failed_notified') setNotes(await api.listGoalNotifications(g.id));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user]);

  if (!user) return null;
  if (!goal) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Goal" back />
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  const cd = countdown(goal.deadlineAt);
  const meta = statusMeta(goal.status);
  const elapsedPct = deadlineElapsedPct(goal);
  const consentFor = (cid: string) => consents.find((c) => c.id === cid);
  const isPreActive = PRE_ACTIVE.includes(goal.status);
  const isTerminal = TERMINAL.includes(goal.status);
  const canAddEvidence = ['active', 'proof_pending', 'judge_review'].includes(goal.status);

  function openEvidence(target?: string) {
    setEvTarget(target);
    setEvDate(todayISO());
    setEvNote('');
    setEvLink('');
    setEvPhoto('');
    setEvOpen(true);
  }

  function onPhoto(file?: File) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setEvPhoto(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function removeEvidence(evId: string) {
    await api.deleteEvidence(goal!.id, evId);
    await load();
    setNotice('Proof removed.');
  }

  async function submitEvidence() {
    const hasContent = evPhoto || evLink.trim() || evNote.trim();
    if (!hasContent) return;
    const type = evPhoto ? 'photo' : evLink.trim() ? 'link' : 'text';
    await api.addEvidence(goal!.id, {
      type,
      content: evPhoto || evLink.trim() || evNote.trim(),
      note: evNote.trim() || undefined,
      actionDate: new Date(evDate).toISOString(),
      plannedActionId: evTarget,
      photoUrl: evPhoto || undefined,
      linkUrl: evLink.trim() || undefined,
    });
    setEvOpen(false);
    await load();
    setNotice('Proof added — the judge can see it.');
  }

  async function submitRating() {
    const v = Number(rateVal);
    if (!Number.isFinite(v) || v < 0 || v > 5) {
      setNotice('Enter a rating between 0 and 5.');
      return;
    }
    // At most two decimal places.
    if (!/^\d(\.\d{1,2})?$|^5(\.0{1,2})?$/.test(rateVal.trim())) {
      setNotice('Use 0–5 with at most two decimals (e.g. 3.75).');
      return;
    }
    setRateBusy(true);
    try {
      await api.rateJudge(goal!.id, user!.id, v);
      setRateVal('');
      await load();
      setNotice('Thanks — your rating of the judge was saved.');
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setRateBusy(false);
    }
  }

  async function cancel() {
    try {
      await api.cancelGoal(goal!.id);
      await load();
    } catch (err) {
      setNotice((err as Error).message);
    }
    setConfirmCancel(false);
  }

  async function completeSolo() {
    try {
      await api.completeSoloGoal(goal!.id, user!.id);
      await load();
      setNotice('Nice — goal marked as completed.');
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  async function askJudgeNow() {
    try {
      await api.requestEarlyDecision(goal!.id, user!.id);
      await load();
      setNotice('Your judge has been asked to decide now.');
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  async function askCancel() {
    try {
      await api.requestCancel(goal!.id, user!.id);
      await load();
      setNotice('Your judge has been asked to cancel this goal.');
    } catch (err) {
      setNotice((err as Error).message);
    }
  }
  async function remove() {
    try {
      await api.deleteGoal(goal!.id);
      navigate('/goals', { replace: true });
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  return (
    <div className="px-4 py-5">
      <PageHeader title={goal.title} back action={<Badge tone={meta.tone}>{meta.label}</Badge>} />

      {goal.description && <p className="mb-4 text-sm text-muted">{goal.description}</p>}

      {/* Deadline progress — how much of the goal period has elapsed */}
      <Card className="mb-4 p-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-mono text-sm text-ink">Deadline elapsed</span>
          <span className="font-mono text-xs text-muted">{elapsedPct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-line">
          <div
            className={`h-full rounded-full transition-all ${cd.overdue ? 'bg-danger' : 'bg-accent'}`}
            style={{ width: `${elapsedPct}%` }}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3">
          <Mini label="Start" value={shortDate(goalStart(goal))} />
          <Mini label="Deadline" value={shortDate(goal.deadlineAt)} />
        </div>
      </Card>

      {/* Solo penalty: app block */}
      {isSoloGoal(goal) && goal.appBlock && (
        <Card className="mb-4 border-danger/30 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">If you miss this goal</p>
          <p className="mt-1 text-sm text-ink">
            <span className="font-semibold">{goal.appBlock.appLabel}</span> gets blocked on your phone for{' '}
            <span className="font-semibold">{blockDurationLabel(goal.appBlock.durationMinutes)}</span>.
          </p>
          {goal.appBlockUntil && new Date(goal.appBlockUntil).getTime() > Date.now() ? (
            <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] font-semibold text-danger">
              🔒 {goal.appBlock.appLabel} is blocked until {dateTime(goal.appBlockUntil)}.
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-muted">The block runs on Android; it starts if the deadline passes before you mark the goal done.</p>
          )}
        </Card>
      )}

      {/* Add proof button (global) */}
      {canAddEvidence && !evOpen && (
        <Button className="mb-4 w-full" onClick={() => openEvidence(undefined)}>
          Add proof of completion
        </Button>
      )}

      {/* Evidence form */}
      {evOpen && (
        <Card className="mb-4 border-accent/30 p-4">
          <div className="mb-2 flex items-center justify-between">
            <Label>Proof of completion</Label>
            <button onClick={() => setEvOpen(false)} className="text-[11px] text-muted hover:text-ink">Close</button>
          </div>

          <div className="mb-2">
            <Label>Date</Label>
            <Input type="date" value={evDate} onChange={(e) => setEvDate(e.target.value)} />
          </div>

          <Label>Description</Label>
          <Textarea rows={2} value={evNote} onChange={(e) => setEvNote(e.target.value)} placeholder="What did you do?" className="mb-2" />

          <Label>Link (optional)</Label>
          <Input value={evLink} onChange={(e) => setEvLink(e.target.value)} placeholder="https://… (e.g. a screenshot from another app)" className="mb-2" />

          <Label>Photo (optional)</Label>
          <input type="file" accept="image/*" onChange={(e) => onPhoto(e.target.files?.[0])} className="mb-2 block w-full text-sm text-muted" />
          {evPhoto && <img src={evPhoto} alt="preview" className="mb-2 max-h-40 rounded-lg" />}

          <Button className="w-full" onClick={submitEvidence} disabled={!evPhoto && !evLink.trim() && !evNote.trim()}>
            Add proof
          </Button>
        </Card>
      )}

      {/* Your proofs */}
      {goal.evidence.length > 0 && (
        <Card className="mb-4 p-4">
          <Label>Your proofs</Label>
          <div className="mt-1 space-y-2">
            {goal.evidence.map((ev) => (
              <div key={ev.id} className="rounded-lg border border-line bg-elevated p-3">
                <div className="flex items-center justify-between">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
                    {shortDate(ev.actionDate ?? ev.addedAt)}
                  </p>
                  {canAddEvidence && (
                    <button onClick={() => removeEvidence(ev.id)} className="text-[11px] text-muted hover:text-danger">Delete</button>
                  )}
                </div>
                {ev.photoUrl && <img src={ev.photoUrl} alt="proof" className="mt-2 max-h-40 rounded-lg" />}
                {ev.note && <p className="mt-1 text-sm text-ink">{ev.note}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Judge */}
      {isSoloGoal(goal) ? (
        <Card className="mb-4 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Judge</p>
          <p className="mt-1 text-sm text-ink">No judge — you set this goal for yourself and track it on your own.</p>
        </Card>
      ) : (
        <Card className="mb-4 p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Judge</p>
              <p className="truncate text-base font-bold text-ink">{goal.judge.name}</p>
              {goal.judge.judgeContact && <p className="truncate font-mono text-[12px] text-muted">{goal.judge.judgeContact}</p>}
            </div>
            <Badge tone={JUDGE_TONE[goal.judge.status]}>{goal.judge.status}</Badge>
          </div>
          {goal.judge.decision && (
            <p className="mt-2 border-t border-line pt-2 text-[12px] text-muted">
              Decision: <span className="text-ink">{goal.judge.decision.replace('_', ' ')}</span>
              {goal.judge.decisionComment && <> — “{goal.judge.decisionComment}”</>}
            </p>
          )}
        </Card>
      )}

      {/* Rate the judge — only judges with an account can be rated. */}
      {goal.judge.decision && goal.judge.judgeAccountUserId && (
        <Card className="mb-4 p-4">
          <Label>Rate your judge</Label>
          {goal.judge.judgeRating != null ? (
            <p className="mt-1 text-sm text-ink">
              You rated {goal.judge.name}{' '}
              <span className="font-mono font-bold text-accent">{goal.judge.judgeRating.toFixed(2)}</span> / 5.
              <button onClick={() => setRateVal(String(goal.judge.judgeRating))} className="ml-2 text-[11px] text-muted hover:text-accent">
                Change
              </button>
            </p>
          ) : (
            <p className="mb-2 text-[11px] text-muted">Give a score from 0 to 5 (up to two decimals, e.g. 3.75).</p>
          )}
          {(goal.judge.judgeRating == null || rateVal) && (
            <div className="mt-2 flex items-center gap-2">
              <Input
                inputMode="decimal"
                value={rateVal}
                onChange={(e) => setRateVal(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder="0–5"
                className="flex-1"
              />
              <Button className="px-4 py-2" disabled={rateBusy || !rateVal.trim()} onClick={submitRating}>
                {rateBusy ? 'Saving…' : 'Rate'}
              </Button>
            </div>
          )}
        </Card>
      )}

      {goal.judge.status === 'pending' && isPreActive && (
        <div className="mb-4">
          <ShareLink
            title="Invite your judge"
            hint="Send this so the judge can accept the role and later decide the outcome."
            link={judgeLink(goal)}
            phone={goal.judge.channel === 'phone' ? goal.judge.judgeContact : undefined}
          />
        </div>
      )}

      {/* Recipients */}
      {goal.recipients.length > 0 && (
      <Card className="mb-4 p-4">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Recipients ({goal.recipients.length})</p>
        <p className="mb-3 text-[11px] text-muted">Only recipients who accept can ever receive a message. They can opt out anytime.</p>
        <div className="space-y-3">
          {goal.recipients.map((r) => {
            const c = consentFor(r.consentId);
            if (!c) return null;
            return (
              <div key={r.consentId} className="rounded-xl border border-line bg-elevated p-3">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{c.name}</p>
                    {c.recipientContact && <p className="truncate font-mono text-[11px] text-muted">{c.recipientContact}</p>}
                  </div>
                  <Badge tone={CONSENT_TONE[c.consentStatus]}>{c.consentStatus}</Badge>
                </div>
                {c.consentStatus === 'pending' && (
                  <div className="mt-3">
                    <ShareLink
                      title="Invite this recipient"
                      hint="They must accept before they can ever be messaged."
                      link={recipientLink(c.inviteToken)}
                      phone={c.channel === 'phone' ? c.recipientContact : undefined}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      )}

      {/* Tone + preview */}
      {goal.recipients.length > 0 && (
      <Card className="mb-4 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Failure message</p>
          <Badge tone="neutral">{TONE_LABEL[goal.messageTone]}</Badge>
        </div>
        <div className="whitespace-pre-line rounded-xl border border-line bg-elevated p-3 text-sm text-ink">{failureMessageForGoal(goal)}</div>
      </Card>
      )}

      {/* Ask the judge to decide before the deadline */}
      {!isSoloGoal(goal) && goal.status === 'active' && Date.now() < +new Date(goal.deadlineAt) && (
        goal.earlyDecisionRequested ? (
          <Card className="mb-4 p-4">
            <p className="text-sm text-ink">You asked {goal.judge.name} to decide now.</p>
            <p className="mt-0.5 text-[11px] text-muted">They've been notified and can decide before the deadline.</p>
          </Card>
        ) : (
          <Button variant="outline" className="mb-4 w-full" onClick={askJudgeNow}>
            Ask your judge to decide now
          </Button>
        )
      )}

      {/* Notifications the system will send for this goal */}
      {outbox.length > 0 && (
        <Card className="mb-4 p-4">
          <Label>Notifications</Label>
          <p className="mb-2 text-[11px] text-muted">
            Messages Comitra sends for this goal. Recipients are only ever messaged after they accept.
          </p>
          <div className="space-y-2">
            {outbox.map((m) => (
              <div key={m.id} className="rounded-lg border border-line bg-elevated p-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-mono text-[9px] uppercase tracking-widest text-muted">{outboxLabel(m.kind)}</span>
                  <span className="font-mono text-[9px] text-muted">{shortDate(m.createdAt)}</span>
                </div>
                <p className="text-[12px] text-ink">{m.body}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Notifications after failure */}
      {goal.status === 'failed_notified' && goal.recipients.length > 0 && (
        <Card className="mb-4 border-danger/30 p-4">
          <Label>Notifications</Label>
          {notes.length === 0 ? (
            <p className="text-[12px] text-muted">No recipients were messaged.</p>
          ) : (
            <div className="space-y-2">
              {notes.map((n) => {
                const c = consentFor(n.recipientConsentId);
                return <Row key={n.id} label={c?.name ?? 'Recipient'} value={n.status === 'sent' ? 'Message sent' : `Not sent · ${n.reason}`} muted={n.status !== 'sent'} />;
              })}
            </div>
          )}
        </Card>
      )}

      {notice && <p className="mb-3 font-mono text-xs text-active">{notice}</p>}

      {(goal.status === 'proof_pending' || goal.status === 'judge_review') && (
        <div className="mb-4 rounded-2xl border border-accent/25 bg-accent/5 p-4">
          <p className="text-sm font-bold text-ink">Awaiting the judge's decision</p>
          <p className="mt-0.5 text-[12px] text-muted">Only {goal.judge.name} can mark this completed or not completed. Add proof above to help them decide.</p>
        </div>
      )}

      {/* Solo goals: the creator finishes them themselves (no judge to decide). */}
      {isSoloGoal(goal) && goal.status === 'active' && (
        <Button className="mb-2 mt-2 w-full" onClick={completeSolo}>
          Mark goal as completed
        </Button>
      )}

      {isTerminal ? (
        <button onClick={remove} className="mt-3 w-full py-2 text-center font-mono text-[11px] uppercase tracking-widest text-muted hover:text-danger">
          Delete from history
        </button>
      ) : isSoloGoal(goal) ? (
        // Solo (judge-less) goal: the creator can cancel it themselves.
        <button onClick={() => setConfirmCancel(true)} className="mt-3 w-full py-2 text-center font-mono text-[11px] uppercase tracking-widest text-muted hover:text-danger">
          Cancel goal
        </button>
      ) : (
        // Any goal with a judge: the creator can't cancel — they ask the judge to.
        goal.cancelRequested ? (
          <p className="mt-3 text-center text-[11px] text-muted">
            You asked {goal.judge.name} to cancel this goal — they've been notified.
          </p>
        ) : (
          <button onClick={askCancel} className="mt-3 w-full py-2 text-center font-mono text-[11px] uppercase tracking-widest text-muted hover:text-danger">
            Ask your judge to cancel this goal
          </button>
        )
      )}

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this goal?"
        message="This ends the goal. No message will be sent to anyone."
        confirmLabel="Cancel goal"
        cancelLabel="Keep it"
        danger
        onConfirm={cancel}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-t border-line py-2 first:border-t-0">
      <span className="text-xs text-muted">{label}</span>
      <span className={`font-mono text-sm ${muted ? 'text-muted' : 'text-ink'}`}>{value}</span>
    </div>
  );
}

function blockDurationLabel(minutes: number): string {
  return BLOCK_DURATIONS.find((d) => d.minutes === minutes)?.label ?? `${Math.round(minutes / 60)}h`;
}

const OUTBOX_LABEL: Record<OutboxMessage['kind'], string> = {
  recipient_consent_request: 'To recipient · consent',
  judge_invite: 'To judge · invite',
  judge_review_request: 'To judge · please review',
  recipient_message: 'To recipient · result',
};
function outboxLabel(kind: OutboxMessage['kind']): string {
  return OUTBOX_LABEL[kind] ?? kind;
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="font-mono text-sm font-bold text-ink">{value}</p>
      <p className="font-mono text-[9px] uppercase tracking-widest text-muted">{label}</p>
    </div>
  );
}
