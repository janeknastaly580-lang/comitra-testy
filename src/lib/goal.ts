/**
 * Pure helpers for goal progress, the next planned action, and the goal report.
 * No storage, no async: safe to use directly in components.
 */
import type { Goal, PlannedAction } from './types';
import { TERMINAL } from './status';

/** Total steps/actions required to complete the goal. */
export function goalRequired(g: Goal): number {
  return Math.max(1, g.requiredActionsCount ?? g.plannedActions.length ?? 1);
}

/** How many are done: counted from proofs added (each proof = one action done). */
export function goalDone(g: Goal): number {
  return Math.min(goalRequired(g), g.evidence.length);
}

export function goalProgressPct(g: Goal): number {
  const req = goalRequired(g);
  return req > 0 ? Math.round((goalDone(g) / req) * 100) : 0;
}

/** The word for one unit of progress. */
export const unitWord = (_g: Goal, n: number) => (n === 1 ? 'step' : 'steps');

/** Whole days remaining until the deadline (0 if past). */
export function daysLeft(g: Goal): number {
  const ms = +new Date(g.deadlineAt) - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** ISO time the goal period started (explicit start, else creation time). */
export function goalStart(g: Goal): string {
  return g.startsAt ?? g.createdAt;
}

/**
 * The instant the goal stopped running, or null while it is still going. Once a
 * goal is over its clock is frozen here, so the progress bar stays where the
 * goal ended instead of creeping on toward a deadline that no longer matters.
 */
export function goalEndedAt(g: Goal): number | null {
  const stamped = g.completedAt ?? g.failedAt ?? g.cancelledAt;
  if (stamped) {
    const t = +new Date(stamped);
    if (Number.isFinite(t)) return t;
  }
  // Finished with no stamp (expired goals, older records): stop at the deadline.
  return TERMINAL.includes(g.status) ? +new Date(g.deadlineAt) : null;
}

/**
 * Percent of the goal period (start → deadline) that has already elapsed, NOT
 * rounded. Used for the width of the progress bar so it creeps forward smoothly
 * every second instead of jumping a whole percent at a time — and stops dead
 * once the goal is finished.
 */
export function deadlineElapsedRatio(g: Goal, now = Date.now()): number {
  const start = +new Date(goalStart(g));
  const end = +new Date(g.deadlineAt);
  const ended = goalEndedAt(g);
  const at = ended === null ? now : Math.min(now, ended);
  if (!(end > start)) return at >= end ? 100 : 0;
  return Math.min(100, Math.max(0, ((at - start) / (end - start)) * 100));
}

/** Percent of the goal period that has elapsed, rounded for display. */
export function deadlineElapsedPct(g: Goal, now = Date.now()): number {
  return Math.round(deadlineElapsedRatio(g, now));
}

/** A "solo" goal has no judge: the user tracks and completes it themselves. */
export function isSoloGoal(g: Goal): boolean {
  return !!g.noJudge;
}

/**
 * The goal's per-owner number. Everyone other than the owner (judge, recipients)
 * only ever sees this number: never the title or the details.
 */
export function goalNumberOf(g: Pick<Goal, 'goalNumber'>): number {
  return g.goalNumber && g.goalNumber > 0 ? g.goalNumber : 1;
}

/** How a goal is referred to outside the owner's own screens, e.g. "goal #3". */
export function goalRef(g: Pick<Goal, 'goalNumber'>): string {
  return `goal #${goalNumberOf(g)}`;
}

/** Title-case variant of `goalRef`, e.g. "Goal #3". */
export function goalRefTitle(g: Pick<Goal, 'goalNumber'>): string {
  return `Goal #${goalNumberOf(g)}`;
}

/**
 * The owner published THIS finished goal, so its title may appear on their
 * profile. It never unlocks anything else, messages and the judge view stay
 * content-free, and running goals are not shown to other people at all.
 */
export function isPublicGoal(g: Pick<Goal, 'isPublic'>): boolean {
  return g.isPublic === true;
}

/**
 * What to call a goal on someone else's screen: the real title when the owner
 * published it, otherwise "Goal #N".
 */
export function goalPublicLabel(g: Pick<Goal, 'goalNumber' | 'isPublic' | 'title'>): string {
  return isPublicGoal(g) && g.title.trim() ? g.title.trim() : goalRefTitle(g);
}

/** The next open (planned) step, earliest scheduled first. */
export function nextPlannedAction(g: Goal): PlannedAction | null {
  const open = g.plannedActions.filter(
    (p) => p.status === 'planned' || p.status === 'rescheduled',
  );
  if (open.length === 0) return null;
  return [...open].sort((a, b) => {
    const ta = a.plannedDate ? +new Date(a.plannedDate) : Infinity;
    const tb = b.plannedDate ? +new Date(b.plannedDate) : Infinity;
    return ta - tb;
  })[0];
}

export interface GoalReport {
  plannedCount: number;
  completedCount: number;
  evidenceCount: number;
  completionPercentage: number;
  judgeStatus: string;
  message: string;
}

/** Generate the goal report dynamically from the goal + its evidence. */
export function buildGoalReport(g: Goal): GoalReport {
  const plannedCount = goalRequired(g);
  const evidenceCount = g.evidence.length;
  const completedCount = Math.min(plannedCount, evidenceCount);
  const completionPercentage = plannedCount ? Math.round((completedCount / plannedCount) * 100) : 0;
  const judgeStatus = g.judge?.decision ?? g.judge?.status ?? 'pending';
  const short = Math.max(0, plannedCount - completedCount);
  const unit = unitWord(g, short);

  let message: string;
  if (g.status === 'completed') {
    message = 'Goal completed.';
  } else if (g.status === 'failed_notified' || g.status === 'failed_pending_notification') {
    message = short > 0 ? `You were ${short} ${unit} short of the goal.` : 'Goal not completed.';
  } else if (g.status === 'judge_review' || g.status === 'proof_pending') {
    message = 'Goal is waiting for the judge to confirm the result.';
  } else if (completedCount < plannedCount) {
    message = 'Add proof of completion so the judge can assess the result.';
  } else {
    message = 'All proof added. Waiting for the goal deadline and the judge.';
  }

  return { plannedCount, completedCount, evidenceCount, completionPercentage, judgeStatus, message };
}
