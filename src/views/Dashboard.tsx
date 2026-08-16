import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type { Goal } from '../lib/types';
import { APP_BLOCK_TARGETS, BLOCK_DURATIONS } from '../lib/constants';
import { PRE_ACTIVE, TERMINAL } from '../lib/status';
import { toLocalInputValue } from '../lib/format';
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

export default function Dashboard() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [streak, setStreak] = useState({ goals: 0 });
  const [loaded, setLoaded] = useState(false);

  // A missed goal must be reflected on before any new goal can be started.
  const { pending: owedReflections, blocked, reload: reloadPending } = usePendingReflections(user?.id);

  // Quick "goal without a judge" (solo) creator, kept here so it doesn't clutter
  // the full goal-creation screen.
  const [soloOpen, setSoloOpen] = useState(false);
  const [soloTitle, setSoloTitle] = useState('');
  const [soloDesc, setSoloDesc] = useState('');
  const [soloDeadline, setSoloDeadline] = useState(() => deadlineInDays(7));
  const [soloApp, setSoloApp] = useState(APP_BLOCK_TARGETS[0].packageName);
  const [soloDuration, setSoloDuration] = useState(BLOCK_DURATIONS[1].minutes);
  const [soloBusy, setSoloBusy] = useState(false);
  const [soloErr, setSoloErr] = useState('');

  async function reload() {
    if (!user) return;
    setGoals(await api.listGoals(user.id));
    setStreak(await api.getStreak(user.id));
    setLoaded(true);
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
        // No judge → a solo, self-tracked goal. Penalty: block an app if missed.
        appBlock: { packageName: app.packageName, appLabel: app.label, durationMinutes: soloDuration },
      });
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
            <span className="font-medium text-active">
              If you miss it, a chosen app gets blocked on your phone for a while.
            </span>
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

              <Label>If I miss it, block this app…</Label>
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
              <p className="mb-3 text-[11px] font-medium text-active">The block runs on your phone (Android). It starts if the deadline passes before you mark the goal done, or if you mark it not completed yourself.</p>

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
            A judge you choose confirms whether you did it. They only ever see your goal’s number, so you tell
            them what it is yourself.{' '}
            <span className="text-active">You can also add someone who’ll be told if you don’t do it.</span>
          </p>
          <Button variant="info" className="mt-3 w-full" disabled={blocked} onClick={() => navigate('/create')}>
            {blocked ? 'Answer the questions above first' : 'Set a goal with a judge'}
          </Button>
        </Card>

        {/* Against friends */}
        <Card className="border-accent/40 bg-accent/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Team challenge</p>
          <p className="mt-1 text-base font-semibold text-ink">A goal you race your friends on</p>
          <p className="mt-1 text-[12px] text-muted">
            Two equal teams, 1v1 up to 8v8, each with its own judge. Relay race or tug of war.
          </p>
          <Button variant="outline" className="mt-3 w-full" onClick={() => navigate('/challenges')}>
            Team challenges
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
