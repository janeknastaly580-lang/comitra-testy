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
import { DEFAULT_COUNTRY_ISO, fullPhone } from '../lib/countries';
import { buildFailureMessage, checkGoalContent, SENSITIVE_CONTENT_MESSAGE } from '../lib/messages';
import { toLocalInputValue } from '../lib/format';
import type { Channel, InvitedJudge, MessageTone } from '../lib/types';
import ConfirmDialog from '../components/ConfirmDialog';
import DateTimeField from '../components/DateTimeField';
import PageHeader from '../components/PageHeader';
import PhoneField from '../components/PhoneField';
import ReflectionForm, { usePendingReflections } from '../components/ReflectionGate';
import { Button, Card, Input, Label, Select, Textarea } from '../components/ui';

interface RecipientRow {
  name: string;
  channel: Channel;
  /** Holds the email, or the national phone number when channel is 'phone'. */
  contact: string;
  /** Selected country ISO for the phone dial code. */
  phoneIso: string;
}
const emptyRecipient = (): RecipientRow => ({ name: '', channel: 'phone', contact: '', phoneIso: DEFAULT_COUNTRY_ISO });
const deadlineInDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toLocalInputValue(d);
};

export default function CreateGoal() {
  const { user } = useApp();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState(() => deadlineInDays(7));

  // The judge must be chosen from friends the user invited (Profile &gt; Invite friends).
  const [invitedJudges, setInvitedJudges] = useState<InvitedJudge[]>([]);
  const [judgeId, setJudgeId] = useState('');
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  // The number the judge and any recipients will see, the goal's only identifier
  // outside this screen.
  const [goalNumber, setGoalNumber] = useState<number | null>(null);

  // A missed goal must be reflected on before a new one can be set.
  const { pending, reload: reloadPending } = usePendingReflections(user?.id);

  useEffect(() => {
    if (user) {
      api.listInvitedJudges(user.id).then(setInvitedJudges);
      api.getNextGoalNumber(user.id).then(setGoalNumber);
    }
  }, [user]);

  const [tone, setTone] = useState<MessageTone>('neutral');
  const [ackNotify, setAckNotify] = useState(false);

  // Optional penalty: block an app when the judge marks the goal not completed.
  const [blockOn, setBlockOn] = useState(false);
  const [blockApp, setBlockApp] = useState(APP_BLOCK_TARGETS[0].packageName);
  const [blockDuration, setBlockDuration] = useState(BLOCK_DURATIONS[1].minutes);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  function setRecipient(i: number, patch: Partial<RecipientRow>) {
    setRecipients((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRecipient() {
    setRecipients((rs) => (rs.length >= MAX_RECIPIENTS_PER_GOAL ? rs : [...rs, emptyRecipient()]));
  }
  function removeRecipient(i: number) {
    setRecipients((rs) => rs.filter((_, idx) => idx !== i));
  }

  const contactValid = (channel: Channel, contact: string) =>
    channel === 'phone' ? contact.replace(/\D/g, '').length >= 7 : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim());

  const selectedJudge = invitedJudges.find((j) => j.id === judgeId) ?? null;
  const judgeValid = !!selectedJudge;
  const filledRecipients = recipients.filter((r) => r.name.trim() || r.contact.trim());
  const hasRecipients = filledRecipients.length > 0;
  const titleValid = title.trim().length >= 3;
  const recipientsValid =
    filledRecipients.length <= MAX_RECIPIENTS_PER_GOAL &&
    filledRecipients.every((r) => r.name.trim().length >= 2 && contactValid(r.channel, r.contact));

  const canSubmit =
    titleValid && judgeValid && recipientsValid && (!hasRecipients || ackNotify) && contentCheck.ok;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!contentCheck.ok) return setError(SENSITIVE_CONTENT_MESSAGE);
    if (!titleValid) return setError('Give your goal a title.');
    if (new Date(deadline).getTime() <= Date.now()) return setError('The goal’s end date must be in the future.');
    if (!judgeValid) return setError('Choose a judge from your invited friends.');
    if (!recipientsValid) return setError('Each recipient needs a name and a valid contact (up to 3).');
    if (hasRecipients && !ackNotify) return setError('Please acknowledge the notification consent.');
    setConfirmOpen(true);
  }

  async function createConfirmed() {
    setBusy(true);
    try {
      const recips: RecipientInput[] = filledRecipients.map((r) => ({
        name: r.name,
        channel: r.channel,
        contact: r.channel === 'phone' ? fullPhone(r.phoneIso, r.contact) : r.contact,
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
        judge: {
          name: selectedJudge!.name,
          channel: 'phone',
          contact: selectedJudge!.phone,
        },
        recipients: recips,
        appBlock: blockOn
          ? { packageName: app.packageName, appLabel: app.label, durationMinutes: blockDuration }
          : undefined,
      });
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
      <PageHeader title="Set a goal" subtitle="Pick a template or build your own. Then pick a judge." back />

      {/* The one place the privacy rule is stated up front. */}
      <Card className="mb-5 border-accent/30 bg-accent/5 p-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Your goal stays private</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink">
          The notification sent to your judge does not contain your goal’s content. They are only asked
          whether you completed {goalNumber ? `goal #${goalNumber}` : 'your goal'}. Telling them what
          the goal is, is up to you.
        </p>
      </Card>

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
            Only you can read this. Everyone else sees{' '}
            <span className="font-semibold text-ink">{goalNumber ? `goal #${goalNumber}` : 'the goal number'}</span>.
            Once the goal is finished you can choose to show it on your profile.
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
            Pick a friend who confirms whether you completed the goal. You can only choose people who
            accepted your invite (they set their own judge password). You cannot judge your own goal.
          </p>
          <p className="mb-3 rounded-lg border border-line bg-elevated p-3 text-[12px] leading-relaxed text-ink">
            The notification sent to your judge does not contain your goal’s content. They are asked
            only: “Did {user.name.split(' ')[0]} complete {goalNumber ? `goal #${goalNumber}` : 'this goal'}?”
          </p>

          {invitedJudges.length === 0 ? (
            <div className="rounded-xl border border-warn/40 bg-warn/5 p-3">
              <p className="text-[12px] text-ink">You haven't invited anyone yet.</p>
              <p className="mt-1 text-[11px] text-muted">
                Invite a friend in{' '}
                <Link to="/invite-friends" className="text-accent underline">Profile &gt; Invite friends</Link>
                {' '}and once they join, they'll appear here.
              </p>
            </div>
          ) : (
            <Select value={judgeId} onChange={(e) => setJudgeId(e.target.value)}>
              <option value="" disabled>Choose a judge…</option>
              {invitedJudges.map((j) => (
                <option key={j.id} value={j.id}>{j.name} · {j.phone}</option>
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
          <p className="mb-3 text-[11px] text-muted">
            Block an app on your phone when your judge marks this goal as not completed.
          </p>
          <ToggleRow label="Block an app if I miss this goal" checked={blockOn} onChange={setBlockOn} />
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
              <p className="mt-2 text-[11px] text-muted">
                The block runs on your phone (Android). It starts the moment your judge marks the goal
                as not completed.
              </p>
            </div>
          )}
        </Card>

        {/* Recipients */}
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-ink">
              Recipients <span className="text-muted">({filledRecipients.length}/{MAX_RECIPIENTS_PER_GOAL})</span>
            </span>
          </div>
          <p className="mb-3 text-[11px] text-muted">Optional. If the judge marks the goal not completed, these people (once they accept) receive a message. Up to 3. Leave empty to keep the goal between you and your judge only.</p>
          <p className="mb-3 rounded-lg border border-line bg-elevated p-3 text-[12px] leading-relaxed text-ink">
            Recipients never see your goal’s content either. The message says only that{' '}
            {goalNumber ? `goal #${goalNumber}` : 'the goal'} was not completed.
          </p>
          <div className="space-y-3">
            {recipients.map((r, i) => (
              <div key={i} className="rounded-xl border border-line bg-elevated p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Recipient {i + 1}</span>
                  <button type="button" onClick={() => removeRecipient(i)} className="text-[11px] text-danger hover:underline">Remove</button>
                </div>
                <Input value={r.name} onChange={(e) => setRecipient(i, { name: e.target.value })} placeholder="Name" />
                <div className="mt-2 space-y-2">
                  <Select value={r.channel} onChange={(e) => setRecipient(i, { channel: e.target.value as Channel })}>
                    <option value="phone">Phone</option>
                    <option value="email">Email</option>
                  </Select>
                  {r.channel === 'phone' ? (
                    <PhoneField
                      iso={r.phoneIso}
                      number={r.contact}
                      onIso={(iso) => setRecipient(i, { phoneIso: iso })}
                      onNumber={(number) => setRecipient(i, { contact: number })}
                    />
                  ) : (
                    <Input value={r.contact} onChange={(e) => setRecipient(i, { contact: e.target.value })} placeholder="name@email.com" />
                  )}
                </div>
              </div>
            ))}
          </div>
          {recipients.length < MAX_RECIPIENTS_PER_GOAL && (
            <Button type="button" variant="outline" className="mt-3 w-full" onClick={addRecipient}>+ Add recipient</Button>
          )}
        </Card>

        {hasRecipients && (
        <>
        {/* Message tone */}
        <Card className="p-4">
          <Label>Message tone</Label>
          <p className="mb-3 text-[11px] text-muted">Choose how the message reads. All tones stay respectful.</p>
          <div className="space-y-2">
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
          <p className="mb-2 text-[11px] text-muted">
            Sent only if the judge marks the goal as not completed. This is the whole message, and there is
            no option to add your goal’s content to it.
          </p>
          <div className="whitespace-pre-line rounded-xl border border-line bg-elevated p-3 text-sm text-ink">{preview}</div>
        </Card>

        {/* Notify consent */}
        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-line p-3">
          <input type="checkbox" checked={ackNotify} onChange={(e) => setAckNotify(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[color:rgb(var(--c-accent))]" />
          <span className="text-[12px] leading-relaxed text-ink">
            I understand that if the goal is marked as not completed, the people I chose and who accepted may receive a message.{' '}
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
              <span className="text-ink">{selectedJudge?.name ?? 'Your judge'}</span> is set as your judge. Your{' '}
              <span className="text-ink">{filledRecipients.length}</span> recipient(s) must accept before it starts. If it is later
              marked not completed, accepted recipients get a <span className="text-ink">{tone}</span> message about{' '}
              <span className="text-ink">goal #{goalNumber ?? 1}</span>, never its content.
            </>
          ) : (
            <>
              <span className="text-ink">{selectedJudge?.name ?? 'Your judge'}</span> is set as your judge and the goal starts right
              away. They will be asked only whether you completed <span className="text-ink">goal #{goalNumber ?? 1}</span>; no one
              sees what the goal is.
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
