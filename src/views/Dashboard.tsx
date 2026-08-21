import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type { Goal } from '../lib/types';
import { APP_BLOCK_TARGETS, BLOCK_DURATIONS } from '../lib/constants';
import { PRE_ACTIVE, TERMINAL } from '../lib/status';
import { clearDraft, loadDraft, useDraft } from '../lib/draft';
import { toLocalInputValue } from '../lib/format';
import { goalRef } from '../lib/goal';
import { Avatar } from '../components/Avatar';
import GoalCard from '../components/GoalCard';
import Inbox from '../components/Inbox';
import DateTimeField from '../components/DateTimeField';
import PageHeader from '../components/PageHeader';
import ReflectionForm, { usePendingReflections } from '../components/ReflectionGate';
import { Badge, Button, Card, Input, Label, Select, Textarea } from '../components/ui';
import { Flame } from 'lucide-react';

const deadlineInDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toLocalInputValue(d);
};

/** The inline solo form, kept across navigation. See src/lib/draft.ts. */
interface SoloDraft {
  open: boolean;
  title: string;
  desc: string;
  deadline: string;
  app: string;
  duration: number;
}

/** A deadline that expired while the draft was sitting there is not worth restoring. */
const restoreDeadline = (saved: string | undefined): string =>
  saved && new Date(saved).getTime() > Date.now() ? saved : deadlineInDays(7);

export default function Dashboard() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [goals, setGoals] = useState<Goal[]>([]);
  // Goals somebody else set and asked THIS person to judge. They live on the
  // server, not on this phone, so they arrive with the dashboard rather than
  // through a link somebody had to remember to send.
  const [judging, setJudging] = useState<Goal[]>([]);
  const [streak, setStreak] = useState({ goals: 0 });
  const [loaded, setLoaded] = useState(false);

  // A missed goal must be reflected on before any new goal can be started.
  const { pending: owedReflections, blocked, reload: reloadPending } = usePendingReflections(user?.id);

  // Quick "goal without a judge" (solo) creator, kept here so it doesn't clutter
  // the full goal-creation screen.
  const draftKey = `solo:${user?.id ?? 'guest'}`;
  const [saved] = useState(() => loadDraft<SoloDraft>(draftKey));
  const [soloOpen, setSoloOpen] = useState(saved.open ?? false);
  const [soloTitle, setSoloTitle] = useState(saved.title ?? '');
  const [soloDesc, setSoloDesc] = useState(saved.desc ?? '');
  const [soloDeadline, setSoloDeadline] = useState(() => restoreDeadline(saved.deadline));
  const [soloApp, setSoloApp] = useState(saved.app ?? APP_BLOCK_TARGETS[0].packageName);
  const [soloDuration, setSoloDuration] = useState(saved.duration ?? BLOCK_DURATIONS[1].minutes);
  const [soloBusy, setSoloBusy] = useState(false);
  const [soloErr, setSoloErr] = useState('');
  // False from the moment the goal is created, so the last render cannot write
  // the form back after it has been cleared.
  const [soloDone, setSoloDone] = useState(false);

  useDraft<SoloDraft>(
    draftKey,
    { open: soloOpen, title: soloTitle, desc: soloDesc, deadline: soloDeadline, app: soloApp, duration: soloDuration },
    !soloDone,
  );

  async function reload() {
    if (!user) return;
    setGoals(await api.listGoals(user.id));
    setStreak(await api.getStreak(user.id));
    setLoaded(true);
    setJudging(await api.listJudgingGoals(user.id));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!user) return null;

  async function createSolo() {
    setSoloErr('');
    if (soloTitle.trim().length < 3) return setSoloErr('Give your goal a title.');
    if (!soloDeadline) return setSoloErr('Set the end date and time.');
    if (new Date(soloDeadline).getTime() <= Date.now()) return setSoloErr('The end date must be in the future.');
    setSoloBusy(true);
    try {
      const app = APP_BLOCK_TARGETS.find((a) => a.packageName === soloApp) ?? APP_BLOCK_TARGETS[0];
      const goal = await api.createGoal({
        userId: user!.id,
        creatorName: user!.name,
        creatorAvatar: user!.avatar,
        title: soloTitle,
        description: soloDesc,
        requiredActionsCount: 1,
        startsAt: new Date().toISOString(),
        deadlineAt: new Date(soloDeadline).toISOString(),
        messageTone: 'neutral',
        ackNotifyConsent: false,
        recipients: [],
        // No judge → a solo, self-tracked goal. Penalty: block an app if the
        // owner later marks it not completed (nothing else ever starts it).
        appBlock: { packageName: app.packageName, appLabel: app.label, durationMinutes: soloDuration },
      });
      setSoloDone(true);
      clearDraft(draftKey);
      setSoloOpen(false);
      setSoloTitle('');
      setSoloDesc('');
      setSoloDeadline(deadlineInDays(7));
      navigate(`/goal/${goal.id}`);
    } catch (err) {
      setSoloErr((err as Error).message);
    } finally {
      setSoloBusy(false);
    }
  }

  const waitingOnMe = api.judgeActionNeeded(judging);
  const running = goals.filter((g) => g.status === 'active' || g.status === 'proof_pending' || g.status === 'judge_review');
  const pending = goals.filter((g) => PRE_ACTIVE.includes(g.status));
  const history = goals.filter((g) => TERMINAL.includes(g.status));

  return (
    <div className="px-4 py-5">
      <PageHeader title={`Hi, ${user.name.split(' ')[0]}`} subtitle="Your goal accountability" />

      {streak.goals > 0 && (
        <div className="mb-4 flex gap-2">
          <Badge tone="accent">
            <Flame className="mr-1 inline h-3 w-3" aria-hidden />
            {streak.goals} goal streak
          </Badge>
        </div>
      )}

      {/* What friends' goals have told this person. Above everything else: it is
          the only part of this screen that is somebody else waiting on them. */}
      <Inbox />

      {/* What other people are waiting on this person for. Above their own
          goals: somebody else's commitment is stuck until they answer. */}
      {waitingOnMe.length > 0 && (
        <div className="mb-5">
          <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
            Waiting on you <Badge tone="accent">{waitingOnMe.length}</Badge>
          </h2>
          <div className="space-y-2">
            {waitingOnMe.map((g) => (
              <Card
                key={g.id}
                onClick={() => navigate(`/judge/${g.id}`)}
                className="flex items-center gap-3 border-accent/40 bg-accent/5 p-3.5"
              >
                <Avatar avatar={g.creatorAvatar} name={g.creatorName} size={38} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{g.creatorName}</p>
                  <p className="truncate text-[12px] text-muted">
                    {g.judge.status === 'pending'
                      ? `Asks you to judge ${goalRef(g)}`
                      : g.cancelRequested
                        ? `Asks you to cancel ${goalRef(g)}`
                        : `Asks you to decide ${goalRef(g)}`}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-accent">Open →</span>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* A missed goal has to be reflected on before a new one can be set. */}
      {owedReflections.length > 0 && (
        <div className="mb-5 space-y-3">
          <ReflectionForm
            goal={owedReflections[0]}
            onDone={() => {
              reloadPending();
              reload();
            }}
          />
          {owedReflections.length > 1 && (
            <p className="text-center text-[11px] text-muted">
              {owedReflections.length - 1} more missed goal{owedReflections.length - 1 === 1 ? '' : 's'} to answer for.
            </p>
          )}
        </div>
      )}

      {/* Two ways to start a goal. Solo comes first: it is the one that needs
          nobody else, so it is the easiest place to start. */}
      <div className="mb-5 space-y-3">
        {/* Without a judge */}
        <Card className="border-accent/40 bg-accent/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Without a judge</p>
          <p className="mt-1 text-base font-semibold text-ink">A goal just for you</p>
          <p className="mt-1 text-[12px] text-muted">
            No judge, no one else.{' '}
            <span className="font-medium text-active">Mark it not completed and a chosen app gets blocked.</span>
          </p>
          {!soloOpen ? (
            <Button
              className="mt-3 w-full"
              disabled={blocked}
              onClick={() => { setSoloErr(''); setSoloOpen(true); }}
            >
              {blocked ? 'Answer the questions above first' : 'Set a goal without a judge'}
            </Button>
          ) : (
            <div className="mt-3 rounded-xl border border-line bg-surface p-3">
              <div className="mb-2 flex items-center justify-between">
                <Label>New solo goal</Label>
                <button onClick={() => setSoloOpen(false)} className="text-[11px] text-muted hover:text-ink">Close</button>
              </div>
              <Input value={soloTitle} onChange={(e) => setSoloTitle(e.target.value)} placeholder="What do you want to do?" className="mb-2" />
              <Textarea rows={2} value={soloDesc} onChange={(e) => setSoloDesc(e.target.value)} placeholder="Details (optional)" className="mb-2" />
              <Label>Goal end</Label>
              <DateTimeField value={soloDeadline} onChange={setSoloDeadline} className="mb-3" />

              <Label>If I mark it not completed, block this app…</Label>
              <Select value={soloApp} onChange={(e) => setSoloApp(e.target.value)} className="mb-2">
                {APP_BLOCK_TARGETS.map((a) => (
                  <option key={a.packageName} value={a.packageName}>{a.label}</option>
                ))}
              </Select>
              <Label>…for</Label>
              <Select value={String(soloDuration)} onChange={(e) => setSoloDuration(Number(e.target.value))} className="mb-2">
                {BLOCK_DURATIONS.map((d) => (
                  <option key={d.minutes} value={d.minutes}>{d.label}</option>
                ))}
              </Select>
              <p className="mb-3 text-[11px] text-muted">Android only.</p>

              {soloErr && <p className="mb-2 font-mono text-xs text-danger">{soloErr}</p>}
              <Button className="w-full" disabled={soloBusy} onClick={createSolo}>
                {soloBusy ? 'Creating…' : 'Create solo goal'}
              </Button>
            </div>
          )}
        </Card>

        {/* With a judge */}
        <Card className="border-accent/40 bg-accent/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">With a judge</p>
          <p className="mt-1 text-base font-semibold text-ink">A goal someone verifies</p>
          <p className="mt-1 text-[12px] text-muted">
            A friend confirms whether you did it.{' '}
            <span className="text-active">Someone else can be told if you don’t.</span>
          </p>
          <Button variant="info" className="mt-3 w-full" disabled={blocked} onClick={() => navigate('/create')}>
            {blocked ? 'Answer the questions above first' : 'Set a goal with a judge'}
          </Button>
        </Card>

        {/* On repeat */}
        <Card className="border-accent/40 bg-accent/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Renewing goal</p>
          <p className="mt-1 text-base font-semibold text-ink">A goal that comes back</p>
          <p className="mt-1 text-[12px] text-muted">
            The days you pick, every week. Pactista keeps the streak.
          </p>
          <Button variant="purple" className="mt-3 w-full" onClick={() => navigate('/renewing')}>
            Renewing goals
          </Button>
        </Card>
      </div>

      {/* Active goals: compact */}
      {!loaded ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : running.length > 0 ? (
        <>
          <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-muted">Active goals</h2>
          <div className="space-y-3">
            {running.map((g) => (
              <GoalCard key={g.id} goal={g} />
            ))}
          </div>
        </>
      ) : (
        <p className="py-2 text-center text-[12px] text-muted">No active goals yet. Start one above.</p>
      )}

      {pending.length > 0 && (
        <>
          <h2 className="mb-3 mt-6 font-mono text-xs uppercase tracking-widest text-muted">Awaiting acceptance</h2>
          <div className="space-y-3">
            {pending.map((g) => (
              <GoalCard key={g.id} goal={g} />
            ))}
          </div>
        </>
      )}

      {history.length > 0 && (
        <>
          <h2 className="mb-3 mt-6 font-mono text-xs uppercase tracking-widest text-muted">Goal history</h2>
          <div className="space-y-3">
            {history.map((g) => (
              <GoalCard key={g.id} goal={g} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
