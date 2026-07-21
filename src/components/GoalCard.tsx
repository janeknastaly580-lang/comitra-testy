import { useNavigate } from 'react-router-dom';
import type { Goal } from '../lib/types';
import { countdown } from '../lib/format';
import { statusMeta } from '../lib/status';
import { deadlineElapsedPct } from '../lib/goal';
import { Avatar } from './Avatar';
import { Badge, Card } from './ui';

export default function GoalCard({ goal }: { goal: Goal }) {
  const navigate = useNavigate();
  const cd = countdown(goal.deadlineAt);
  const meta = statusMeta(goal.status);
  const isActive = goal.status === 'active';
  const pct = deadlineElapsedPct(goal);
  const photo = goal.evidence.find((e) => e.type === 'photo')?.content;

  return (
    <Card onClick={() => navigate(`/goal/${goal.id}`)} className="p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {photo ? (
            <img src={photo} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
          ) : (
            <Avatar avatar={goal.creatorAvatar} name={goal.creatorName} size={36} />
          )}
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
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div className={`h-full rounded-full ${cd.overdue ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        {goal.evidence.length > 0 && (
          <p className="mt-1 font-mono text-[10px] text-muted">{goal.evidence.length} proof(s) added</p>
        )}
      </div>
    </Card>
  );
}
