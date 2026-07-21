/**
 * Pure helpers for goal progress, the next planned action, and the goal report.
 * No storage, no async — safe to use directly in components.
 */
import type { Goal, PlannedAction } from './types';

/** Total steps/actions required to complete the goal. */
export function goalRequired(g: Goal): number {
  return Math.max(1, g.requiredActionsCount ?? g.plannedActions.length ?? 1);
}

/** How many are done — counted from proofs added (each proof = one action done). */
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

/** Percent of the goal period (start → deadline) that has already elapsed. */
export function deadlineElapsedPct(g: Goal): number {
  const start = +new Date(goalStart(g));
  const end = +new Date(g.deadlineAt);
  if (!(end > start)) return Date.now() >= end ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round(((Date.now() - start) / (end - start)) * 100)));
}

/** A "solo" goal has no judge — the user tracks and completes it themselves. */
export function isSoloGoal(g: Goal): boolean {
  return !!g.noJudge;
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
    message = 'All proof added — waiting for the goal deadline and the judge.';
  }

  return { plannedCount, completedCount, evidenceCount, completionPercentage, judgeStatus, message };
}
