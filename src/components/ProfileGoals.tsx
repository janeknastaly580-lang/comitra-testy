import { useState } from 'react';
import type { GoalTabStats, ProfileGoalsView } from '../lib/api';
import { goalPublicLabel } from '../lib/goal';
import { shortDate } from '../lib/format';
import { statusMeta } from '../lib/status';
import type { Goal } from '../lib/types';
import { Badge, Card } from './ui';
import { Lock } from 'lucide-react';

type Tab = 'solo' | 'judged';

const TABS: { id: Tab; label: string }[] = [
  { id: 'solo', label: 'Without a judge' },
  { id: 'judged', label: 'With a judge' },
];

/**
 * The "Profile" tab of an account: finished goals split into the ones the user
 * tracked alone and the ones a judge ruled on, each with its success rate.
 *
 * Whether the viewer may see any of this is decided by `api.getProfileGoals`;
 * this component only renders what it was handed. Goal content follows the
 * per-goal rule: someone else sees "Goal #N" unless the owner published it.
 */
export default function ProfileGoals({
  view,
  isOwner,
  ownerName,
}: {
  view: ProfileGoalsView | null;
  isOwner: boolean;
  ownerName: string;
}) {
  const [tab, setTab] = useState<Tab>('solo');

  if (!view) return <p className="py-8 text-center text-sm text-muted">Loading…</p>;

  if (!view.allowed) {
    return (
      <Card className="p-6 text-center">
        <Lock className="mx-auto h-7 w-7 text-muted" aria-hidden />
        <p className="mt-2 text-sm font-semibold text-ink">
          {view.blockedBy === 'friends-only' ? 'Friends only' : 'This profile is private'}
        </p>
        <p className="mt-1 text-[12px] text-muted">
          {view.blockedBy === 'friends-only'
            ? `${ownerName} shows these to friends only.`
            : `${ownerName} keeps their goals to themselves.`}
        </p>
      </Card>
    );
  }

  const stats = tab === 'solo' ? view.solo : view.judged;

  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${
              tab === t.id ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <SuccessRate stats={stats} />

      {stats.goals.length === 0 ? (
        <Card className="p-5 text-center">
          <p className="text-sm text-muted">
            {tab === 'solo'
              ? 'No finished goals without a judge yet.'
              : 'No finished goals with a judge yet.'}
          </p>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {stats.goals.map((g) => (
            <GoalRow key={g.id} goal={g} isOwner={isOwner} />
          ))}
        </div>
      )}
    </>
  );
}

function SuccessRate({ stats }: { stats: GoalTabStats }) {
  const decided = stats.completed + stats.missed;
  return (
    <Card className="mb-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Success rate</p>
          <p className="mt-0.5 text-[11px] text-muted">
            {decided === 0
              ? 'No finished goals yet'
              : `${stats.completed} completed · ${stats.missed} missed`}
          </p>
        </div>
        <p className="font-mono text-2xl font-bold text-ink">
          {stats.successRate === null ? 'n/a' : `${stats.successRate}%`}
        </p>
      </div>
      {decided > 0 && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-accent" style={{ width: `${stats.successRate ?? 0}%` }} />
        </div>
      )}
    </Card>
  );
}

/** The owner always reads their own goal; everyone else follows `isPublic`. */
function GoalRow({ goal, isOwner }: { goal: Goal; isOwner: boolean }) {
  const meta = statusMeta(goal.status);
  const hidden = !isOwner && !goal.isPublic;
  const label = isOwner ? goal.title : goalPublicLabel(goal);
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={`flex items-center gap-1.5 truncate text-xs font-medium ${hidden ? 'text-muted' : 'text-ink'}`}>
          {hidden && <Lock className="h-3 w-3 shrink-0" aria-hidden />}
          {label}
        </p>
        <p className="font-mono text-[10px] text-muted">
          {shortDate(goal.failedAt ?? goal.completedAt ?? goal.createdAt)}
        </p>
      </div>
      <Badge tone={meta.tone}>{meta.short}</Badge>
    </div>
  );
}
