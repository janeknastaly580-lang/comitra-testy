import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type { RecipientInput } from '../lib/api';
import {
  APP_BLOCK_TARGETS,
  BLOCK_DURATIONS,
  GOAL_TEMPLATES,
  MAX_RECIPIENTS_PER_GOAL,
  PERIOD_CHOICES,
  TONE_OPTIONS,
  type GoalTemplate,
} from '../lib/constants';
import { clearDraft, loadDraft, useDraft } from '../lib/draft';
import { buildFailureMessage, checkGoalContent, SENSITIVE_CONTENT_MESSAGE } from '../lib/messages';
import { toLocalInputValue } from '../lib/format';
import { isReachable, REACHABLE_DAYS } from '../lib/push';
import type { MessageTone } from '../lib/types';
import { Avatar } from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import DateTimeField from '../components/DateTimeField';
import PageHeader from '../components/PageHeader';
import ReflectionForm, { usePendingReflections } from '../components/ReflectionGate';
import { Button, Card, Input, Label, Select, Textarea } from '../components/ui';

const deadlineInDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toLocalInputValue(d);
};

/** Everything on this screen that is worth not having to type twice. */
interface GoalDraft {
  title: string;
  description: string;
  deadline: string;
  judgeId: string;
  recipientIds: string[];
  tone: MessageTone;
  ackNotify: boolean;
  blockOn: boolean;
  blockApp: string;
  blockDuration: number;
}

/**
 * A deadline stored days ago may have gone by while the draft sat there. Falling
 * back to the default is kinder than restoring a form that cannot be submitted.
 */
const restoreDeadline = (saved: string | undefined): string =>
  saved && new Date(saved).getTime() > Date.now() ? saved : deadlineInDays(7);

export default function CreateGoal() {
  const { user } = useApp();
  const navigate = useNavigate();

  // Switching tab unmounts this screen, so what has been typed is restored from
  // the draft rather than thrown away. See src/lib/draft.ts.
  const draftKey = `goal:${user?.id ?? 'guest'}`;
  const [saved] = useState(() => loadDraft<GoalDraft>(draftKey));

  const [title, setTitle] = useState(saved.title ?? '');
  const [description, setDescription] = useState(saved.description ?? '');
  const [deadline, setDeadline] = useState(() => restoreDeadline(saved.deadline));

  // The judge is a FRIEND — someone you follow who follows you back. There is
  // nobody to invite and no address to type: the same list the recipient comes
  // from, minus whoever is already the recipient.
  const [judgeId, setJudgeId] = useState(saved.judgeId ?? '');
  /**
   * The recipient is picked from FRIENDS — people the user follows who follow
   * back. There is no contact field any more: the message goes to their app.
   */
  const [friends, setFriends] = useState<api.SocialProfile[]>([]);
  const [recipientIds, setRecipientIds] = useState<string[]>(saved.recipientIds ?? []);
  /**
   * Whether the chosen friend has opened Pactista recently. `false` is not an
   * error — the message is still queued and delivered if they come back — but
   * the owner should know before they build a commitment on it.
   */
  const [recipientReachable, setRecipientReachable] = useState<boolean | null>(null);
  // The number the judge and any recipients will see, the goal's only identifier
  // outside this screen.
  const [goalNumber, setGoalNumber] = useState<number | null>(null);

  // A missed goal must be reflected on before a new one can be set.
  const { pending, reload: reloadPending } = usePendingReflections(user?.id);

  useEffect(() => {
    if (user) {
      api.getNextGoalNumber(user.id).then(setGoalNumber);
      api.listFriends(user.id).then(setFriends);
    }
  }, [user]);

  // Ask the shared store whether the chosen friend still has the app. Runs on
  // every change of choice; a failure answers "reachable", because not being
  // able to check is not evidence that somebody uninstalled Pactista.
  const chosenRecipientId = recipientIds[0] ?? '';
  useEffect(() => {
    if (!chosenRecipientId) {
      setRecipientReachable(null);
      return;
    }
    let cancelled = false;
    setRecipientReachable(null);
    isReachable(chosenRecipientId)
      .then((ok) => !cancelled && setRecipientReachable(ok))
      .catch(() => !cancelled && setRecipientReachable(true));
    return () => {
      cancelled = true;
    };
  }, [chosenRecipientId]);

  const [tone, setTone] = useState<MessageTone>(saved.tone ?? 'neutral');
  const [ackNotify, setAckNotify] = useState(saved.ackNotify ?? false);

  // Optional penalty: block an app when the judge marks the goal not completed.
  const [blockOn, setBlockOn] = useState(saved.blockOn ?? false);
  const [blockApp, setBlockApp] = useState(saved.blockApp ?? APP_BLOCK_TARGETS[0].packageName);
  const [blockDuration, setBlockDuration] = useState(saved.blockDuration ?? BLOCK_DURATIONS[1].minutes);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Stops the draft being written again by the last render after a successful
  // create, which would resurrect the form the user just submitted.
  const [submitted, setSubmitted] = useState(false);

  useDraft<GoalDraft>(
    draftKey,
    { title, description, deadline, judgeId, recipientIds, tone, ackNotify, blockOn, blockApp, blockDuration },
    !submitted,
  );

  const contentCheck = useMemo(() => checkGoalContent(title, description), [title, description]);

  const preview = useMemo(
    () => buildFailureMessage({ ownerName: user?.name ?? 'You', tone, goalNumber: goalNumber ?? 1 }),
    [user?.name, tone, goalNumber],
  );

  if (!user) return null;

  if (!api.hasEntitlement(user)) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Set a goal" back />
        <Card className="border-warn/40 p-6 text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-warn">Subscription needed</p>
          <p className="mt-2 text-sm text-muted">
            Create goals, track your steps, and use social commitment for $4.99 a month.
          </p>
          <Button className="mt-4 w-full" onClick={() => navigate('/subscription')}>
            See subscription
          </Button>
        </Card>
      </div>
    );
  }

  // Blocked until the questions about the last missed goal are answered.
  if (pending.length > 0) {
    return (
      <div className="px-4 py-5">
        <PageHeader title="Set a goal" back />
        <ReflectionForm goal={pending[0]} onDone={reloadPending} />
      </div>
    );
  }

  function applyTemplate(t: GoalTemplate) {
    setTitle(t.title);
    setDeadline(deadlineInDays(t.periodDays));
  }

  function pickRecipient(id: string) {
    // One recipient per goal today, so choosing simply replaces.
    setRecipientIds(id ? [id] : []);
    if (id && id === judgeId) setJudgeId('');
  }
  function removeRecipient(id: string) {
    setRecipientIds((ids) => ids.filter((x) => x !== id));
  }

  const selectedJudge = friends.find((f) => f.id === judgeId) ?? null;
  const judgeValid = !!selectedJudge;
  // Nobody can be both: the judge decides the goal, the recipient hears how it
  // went, and one person doing both makes the second meaningless.
  const judgeChoices = friends.filter((f) => !recipientIds.includes(f.id));
  const chosenRecipients = recipientIds
    .map((id) => friends.find((f) => f.id === id))
    .filter((f): f is api.SocialProfile => !!f);
  const hasRecipients = chosenRecipients.length > 0;
  const titleValid = title.trim().length >= 3;
  // Every id must still resolve to a friend: unfollowing someone between opening
  // this screen and submitting it must not smuggle a stranger through.
  const recipientsValid =
    chosenRecipients.length === recipientIds.length && chosenRecipients.length <= MAX_RECIPIENTS_PER_GOAL;

  // Re-read the clock rather than trusting the value the field started with: a
  // form left open long enough would otherwise let a past deadline through.
  const deadlineValid = !!deadline && new Date(deadline).getTime() > Date.now();

  const canSubmit =
    titleValid &&
    deadlineValid &&
    judgeValid &&
    recipientsValid &&
    (!hasRecipients || ackNotify) &&
    contentCheck.ok;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!contentCheck.ok) return setError(SENSITIVE_CONTENT_MESSAGE);
    if (!titleValid) return setError('Give your goal a title.');
    if (!deadline) return setError('Set the goal’s end date and time.');
    if (new Date(deadline).getTime() <= Date.now()) return setError('The goal’s end date must be in the future.');
    if (!judgeValid) return setError('Choose a judge from your invited friends.');
    if (!recipientsValid) return setError('Choose the recipient from your friends. A goal can have only one.');
    if (hasRecipients && !ackNotify) return setError('Please acknowledge the notification consent.');
    setConfirmOpen(true);
  }

  async function createConfirmed() {
    setBusy(true);
    try {
      const recips: RecipientInput[] = chosenRecipients.map((f) => ({
        recipientUserId: f.id,
        name: f.name,
      }));
      const app = APP_BLOCK_TARGETS.find((a) => a.packageName === blockApp) ?? APP_BLOCK_TARGETS[0];
      const goal = await api.createGoal({
        userId: user!.id,
        creatorName: user!.name,
        creatorAvatar: user!.avatar,
        title,
        description,
        requiredActionsCount: 1,
        startsAt: new Date().toISOString(),
        deadlineAt: new Date(deadline).toISOString(),
        messageTone: tone,
        ackNotifyConsent: hasRecipients ? ackNotify : false,
        judge: { judgeUserId: selectedJudge!.id, name: selectedJudge!.name },
        recipients: recips,
        appBlock: blockOn
          ? { packageName: app.packageName, appLabel: app.label, durationMinutes: blockDuration }
          : undefined,
      });
      setSubmitted(true);
      clearDraft(draftKey);
      setConfirmOpen(false);
      navigate(`/goal/${goal.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-5">
      <PageHeader title="Set a goal" back />

      <div className="mb-5">
        <Label>Starter goals</Label>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {GOAL_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t)}
              className="shrink-0 rounded-full border border-accent/40 bg-accent/5 px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/10"
            >
              {t.title}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <Label>Goal</Label>
          <Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Finish the project by Friday" />
          <p className="mt-2 text-[11px] text-muted">
            Only you see this. Everyone else sees{' '}
            <span className="font-semibold text-ink">{goalNumber ? `goal #${goalNumber}` : 'the goal number'}</span>.
          </p>
        </div>

        <div>
          <Label>Details (optional)</Label>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What exactly counts as done?" />
        </div>

        {!contentCheck.ok && (
          <Card className="border-danger/50 bg-danger/5 p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-danger">Change the goal</p>
            <p className="mt-1 text-sm text-ink">{SENSITIVE_CONTENT_MESSAGE}</p>
            <p className="mt-2 text-[11px] text-muted">Detected: {contentCheck.topics.join(', ')}.</p>
          </Card>
        )}

        <div>
          <Label>Goal end (term)</Label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PERIOD_CHOICES.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setDeadline(deadlineInDays(p.days))}
                className="rounded-full border border-line px-3 py-1 text-[11px] text-muted transition hover:border-accent hover:text-accent"
              >
                {p.label}
              </button>
            ))}
          </div>
          <DateTimeField value={deadline} onChange={setDeadline} />
        </div>

        {/* Judge */}
        <Card className="border-accent/30 p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-semibold text-ink">Judge</span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-danger">Required</span>
          </div>
          <p className="mb-3 text-[11px] text-muted">
            A friend, asked in the app. They confirm whether you did it.
          </p>

          {judgeChoices.length === 0 ? (
            <div className="rounded-xl border border-warn/40 bg-warn/5 p-3 text-[12px] text-ink">
              No friends yet — find people in{' '}
              <Link to="/social" className="text-accent underline">Social</Link>. A friend follows you back.
            </div>
          ) : (
            <Select value={judgeId} onChange={(e) => setJudgeId(e.target.value)}>
              <option value="" disabled>Choose a judge…</option>
              {judgeChoices.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </Select>
          )}

        </Card>

        {/* Penalty: block an app if the judge marks the goal not completed */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-semibold text-ink">If you don’t do it</span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Optional</span>
          </div>
          <ToggleRow label="Block an app if my judge marks this not completed" checked={blockOn} onChange={setBlockOn} />
          {blockOn && (
            <div className="mt-3">
              <Label>Block this app…</Label>
              <Select value={blockApp} onChange={(e) => setBlockApp(e.target.value)} className="mb-2">
                {APP_BLOCK_TARGETS.map((a) => (
                  <option key={a.packageName} value={a.packageName}>{a.label}</option>
                ))}
              </Select>
              <Label>…for</Label>
              <Select value={String(blockDuration)} onChange={(e) => setBlockDuration(Number(e.target.value))}>
                {BLOCK_DURATIONS.map((d) => (
                  <option key={d.minutes} value={d.minutes}>{d.label}</option>
                ))}
              </Select>
              <p className="mt-2 text-[11px] text-muted">Android only.</p>
            </div>
          )}
        </Card>

        {/* Recipients */}
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">
              Recipient <span className="text-muted">({chosenRecipients.length}/{MAX_RECIPIENTS_PER_GOAL})</span>
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Optional</span>
          </div>
          <p className="mb-3 text-[11px] text-active">
            Told in the app, once they accept, if this goal is marked not completed.
          </p>

          {friends.length === 0 ? (
            <div className="rounded-xl border border-warn/40 bg-warn/5 p-3 text-[12px] text-ink">
              No friends yet — find people in{' '}
              <Link to="/social" className="text-accent underline">Social</Link>. A friend follows you back.
            </div>
          ) : chosenRecipients.length === 0 ? (
            <Select value="" onChange={(e) => pickRecipient(e.target.value)}>
              <option value="" disabled>Choose a friend…</option>
              {friends.filter((f) => f.id !== judgeId).map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </Select>
          ) : (
            <div className="space-y-2">
              {chosenRecipients.map((f) => (
                <div key={f.id} className="flex items-center gap-3 rounded-xl border border-line bg-elevated p-3">
                  <Avatar avatar={f.avatar} name={f.name} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{f.name}</p>
                    <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Friend</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRecipient(f.id)}
                    className="text-[11px] text-danger hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {recipientReachable === false && (
                <p className="text-[11px] text-warn">
                  Not seen in Pactista for {REACHABLE_DAYS} days. A message would wait for them.
                </p>
              )}
            </div>
          )}
        </Card>

        {hasRecipients && (
        <>
        {/* Message tone */}
        <Card className="p-4">
          <Label>Message tone</Label>
          <div className="mt-2 space-y-2">
            {TONE_OPTIONS.map((t) => (
              <label key={t.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${tone === t.id ? 'border-accent bg-accent/5' : 'border-line'}`}>
                <input type="radio" name="tone" checked={tone === t.id} onChange={() => setTone(t.id)} className="mt-1 h-4 w-4 accent-[color:rgb(var(--c-accent))]" />
                <div>
                  <p className="text-sm font-semibold text-ink">{t.label}</p>
                  <p className="text-[11px] text-muted">{t.blurb}</p>
                </div>
              </label>
            ))}
          </div>
        </Card>

        {/* Preview */}
        <Card className="p-4">
          <Label>Message preview</Label>
          <div className="whitespace-pre-line rounded-xl border border-line bg-elevated p-3 text-sm text-ink">{preview}</div>
        </Card>

        {/* Notify consent */}
        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-line p-3">
          <input type="checkbox" checked={ackNotify} onChange={(e) => setAckNotify(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[color:rgb(var(--c-accent))]" />
          <span className="text-[12px] leading-relaxed text-active">
            I understand a message may be sent if the goal is marked not completed.{' '}
            <Link to="/terms" className="text-accent underline">Terms</Link>
          </span>
        </label>
        </>
        )}

        {error && <p className="font-mono text-xs text-danger">{error}</p>}

        <Button type="submit" disabled={busy || !canSubmit} className="w-full">Set goal</Button>
      </form>

      <ConfirmDialog
        open={confirmOpen}
        title="Set this goal?"
        message={
          hasRecipients ? (
            <>
              <span className="text-ink">{selectedJudge?.name ?? 'Your judge'}</span> judges{' '}
              <span className="text-ink">goal #{goalNumber ?? 1}</span>.{' '}
              <span className="text-ink">{chosenRecipients[0]?.name ?? '—'}</span> must accept before it starts, and
              gets a <span className="text-ink">{tone}</span> message if it is marked not completed.
            </>
          ) : (
            <>
              <span className="text-ink">{selectedJudge?.name ?? 'Your judge'}</span> judges{' '}
              <span className="text-ink">goal #{goalNumber ?? 1}</span>. It starts right away.
            </>
          )
        }
        confirmLabel="Set goal"
        busy={busy}
        onConfirm={createConfirmed}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between border-t border-line py-2.5 first:border-t-0">
      <span className="text-sm text-ink">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[color:rgb(var(--c-accent))]" />
    </label>
  );
}
