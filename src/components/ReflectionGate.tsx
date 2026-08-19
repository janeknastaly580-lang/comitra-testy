import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import { clearDraft, loadDraft, useDraft } from '../lib/draft';
import { goalRefTitle } from '../lib/goal';
import type { Goal } from '../lib/types';
import { Button, Card, Label, Textarea } from './ui';

const MIN = api.REFLECTION_MIN_CHARS;

/**
 * The missed goals this user still owes answers for (oldest first). While the
 * list is non-empty no new goal can be created, `api.createGoal` enforces the
 * same rule, so a screen that forgets to check simply gets an error instead.
 */
export function usePendingReflections(userId: string | undefined) {
  const [pending, setPending] = useState<Goal[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!userId) return;
    setPending(await api.listUnreflectedGoals(userId));
    setLoaded(true);
  }, [userId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { pending, loaded, reload, blocked: pending.length > 0 };
}

/**
 * The two questions a user must answer after a goal is not completed: why it
 * didn't work out, and what they'll do differently. Both answers need at least
 * {@link api.REFLECTION_MIN_CHARS} characters.
 *
 * The answers are private: no judge and no recipient ever sees them.
 */
export default function ReflectionForm({ goal, onDone }: { goal: Goal; onDone: () => void }) {
  // The same form appears on Dashboard, Set-a-goal and the goal itself, keyed by
  // goal, so answers started in one place are there in the others too.
  const draftKey = `reflection:${goal.id}`;
  const [saved] = useState(() => loadDraft<{ why: string; next: string }>(draftKey));
  const [why, setWhy] = useState(saved.why ?? '');
  const [next, setNext] = useState(saved.next ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveDone, setSaveDone] = useState(false);

  useDraft(draftKey, { why, next }, !saveDone);

  const valid = why.trim().length >= MIN && next.trim().length >= MIN;

  async function submit() {
    setError('');
    setBusy(true);
    try {
      await api.submitGoalReflection(goal.id, goal.userId, why, next);
      setSaveDone(true);
      clearDraft(draftKey);
      setWhy('');
      setNext('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-warn/50 bg-warn/5 p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-warn">Before your next goal</p>
      <p className="mt-1 text-base font-semibold text-ink">{goalRefTitle(goal)} was not completed</p>
      <p className="mt-1 text-[12px] text-muted">
        Answer both to set goals again. Only you see them.
      </p>

      <div className="mt-4">
        <Label>Why didn’t it work out?</Label>
        <Textarea
          rows={3}
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          placeholder="Be honest with yourself. What got in the way?"
        />
        <CharCount value={why} />
      </div>

      <div className="mt-3">
        <Label>What can you do to succeed next time?</Label>
        <Textarea
          rows={3}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="One concrete change you’ll make."
        />
        <CharCount value={next} />
      </div>

      {error && <p className="mt-3 font-mono text-xs text-danger">{error}</p>}

      <Button className="mt-4 w-full" disabled={busy || !valid} onClick={submit}>
        {busy ? 'Saving…' : 'Save answers'}
      </Button>
    </Card>
  );
}

function CharCount({ value }: { value: string }) {
  const len = value.trim().length;
  const ok = len >= MIN;
  return (
    <p className={`mt-1 text-right font-mono text-[10px] ${ok ? 'text-muted' : 'text-warn'}`}>
      {ok ? `${len} characters` : `${len}/${MIN} characters minimum`}
    </p>
  );
}
