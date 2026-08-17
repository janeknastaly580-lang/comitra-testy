import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import * as api from '../lib/api';
import { EVERYDAY, scheduleLabel } from '../lib/renewing';
import type { Weekday } from '../lib/types';
import DayPicker from '../components/DayPicker';
import PageHeader from '../components/PageHeader';
import { Button, Card, Input, Label, Textarea } from '../components/ui';

export default function CreateRenewingGoal() {
  const { user } = useApp();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  // Every day is the honest default: it is what most people mean by a habit, and
  // narrowing it down is easier than remembering to widen it.
  const [days, setDays] = useState<Weekday[]>([...EVERYDAY]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!user) return null;

  const ready = title.trim().length > 0 && days.length > 0;

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const goal = await api.createRenewingGoal({ userId: user!.id, title, note, days });
      navigate(`/renewing/${goal.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-5">
      <PageHeader title="New renewing goal" subtitle="It comes back on the days you choose" back />

      <div className="space-y-4">
        <Card className="p-4">
          <Label>What is it</Label>
          <Input
            value={title}
            maxLength={120}
            placeholder="Run 5 km"
            onChange={(e) => setTitle(e.target.value)}
          />
          <p className="mt-1.5 text-[11px] text-muted">
            Only you ever see this. A renewing goal has no judge — nobody is told either way.
          </p>

          <div className="mt-4">
            <Label>Notes (optional)</Label>
            <Textarea
              rows={3}
              value={note}
              maxLength={500}
              placeholder="Before work, not after."
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </Card>

        <Card className="p-4">
          <DayPicker value={days} onChange={setDays} disabled={busy} />
          <p className="mt-3 text-[12px] text-muted">
            {days.length === 0 ? (
              <span className="text-warn">Pick at least one day.</span>
            ) : (
              <>
                Due <span className="font-semibold text-ink">{scheduleLabel(days).toLowerCase()}</span>. Each of
                those days you mark it done or not — and days you never mark count as missed, so the streak
                stays honest.
              </>
            )}
          </p>
        </Card>

        {error && (
          <Card className="border-danger/40 bg-danger/5 p-3">
            <p className="text-[13px] text-danger">{error}</p>
          </Card>
        )}

        <Button className="w-full" disabled={!ready || busy} onClick={submit}>
          {busy ? 'Setting it up…' : 'Start this goal'}
        </Button>
      </div>
    </div>
  );
}
