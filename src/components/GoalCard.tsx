import { useNavigate } from 'react-router-dom';
import type { Goal } from '../lib/types';
import { countdown, timeOfDay, shortDate } from '../lib/format';
import { useNow } from '../lib/hooks';
import { statusMeta } from '../lib/status';
import { deadlineElapsedRatio } from '../lib/goal';
import { Avatar } from './Avatar';
import { Badge, Card } from './ui';

export default function GoalCard({ goal }: { goal: Goal }) {
  const navigate = useNavigate();
  const isActive = goal.status === 'active';
  // Live only while the goal is running, a finished card has nothing to tick.
  const now = useNow(isActive ? 1000 : 60_000);
  const cd = countdown(goal.deadlineAt, now);
  const meta = statusMeta(goal.status);
  const pct = deadlineElapsedRatio(goal, now);

  return (
    <Card onClick={() => navigate(`/goal/${goal.id}`)} className="p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar avatar={goal.creatorAvatar} name={goal.creatorName} size={36} />
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink">{goal.title}</p>
          </div>
        </div>
        <Badge tone={meta.tone}>{meta.short}</Badge>
      </div>

      <div className="border-t border-line pt-3">
        <div className="mb-1 flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">
            {isActive ? 'Deadline elapsed' : 'Result'}
          </p>
          <p className={`font-mono text-sm ${isActive && cd.overdue ? 'text-danger' : 'text-ink'}`}>
            {isActive ? cd.label : meta.label}
          </p>
        </div>
        {isActive && (
          <>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div className={`h-full rounded-full ${cd.overdue ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 font-mono text-[10px] text-muted">
              Due {shortDate(goal.deadlineAt)} · {timeOfDay(goal.deadlineAt)}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
