import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import type { Goal } from '../lib/types';
import { APP_BLOCK_TARGETS, BLOCK_DURATIONS } from '../lib/constants';
import { PRE_ACTIVE, TERMINAL } from '../lib/status';
import { toLocalInputValue } from '../lib/format';
import GoalCard from '../components/GoalCard';
import PageHeader from '../components/PageHeader';
import { Badge, Button, Card, Input, Label, Select, Textarea } from '../components/ui';

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
        includeGoalTitleInFailureMessage: false,
        includeGoalDescriptionInFailureMessage: false,
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
          <Badge tone="accent">🔥 {streak.goals} goal streak</Badge>
        </div>
      )}

      {/* Two ways to start a goal */}
      <div className="mb-5 space-y-3">
        {/* With a judge */}
        <Card className="border-accent/40 bg-accent/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">With a judge</p>
          <p className="mt-1 text-base font-semibold text-ink">A goal someone verifies</p>
          <p className="mt-1 text-[12px] text-muted">
            A judge you choose confirms whether you did it. You can also add people who’ll be told if you don’t.
          </p>
          <Button className="mt-3 w-full" onClick={() => navigate('/create')}>Set a goal with a judge</Button>
        </Card>

        {/* Without a judge */}
        <Card className="border-accent/40 bg-accent/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-accent">Without a judge</p>
          <p className="mt-1 text-base font-semibold text-ink">A goal just for you</p>
          <p className="mt-1 text-[12px] text-muted">
            No judge, no one else. If you miss it, a chosen app gets blocked on your phone for a while.
          </p>
          {!soloOpen ? (
            <Button variant="outline" className="mt-3 w-full" onClick={() => { setSoloErr(''); setSoloOpen(true); }}>
              Set a goal without a judge
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
              <Input type="datetime-local" value={soloDeadline} onChange={(e) => setSoloDeadline(e.target.value)} className="mb-3" />

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
              <p className="mb-3 text-[11px] text-muted">The block runs on your phone (Android). It starts if the deadline passes before you mark the goal done.</p>

              {soloErr && <p className="mb-2 font-mono text-xs text-danger">{soloErr}</p>}
              <Button className="w-full" disabled={soloBusy} onClick={createSolo}>
                {soloBusy ? 'Creating…' : 'Create solo goal'}
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/* Active goals — compact */}
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
        <p className="py-2 text-center text-[12px] text-muted">No active goals yet — start one above.</p>
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
