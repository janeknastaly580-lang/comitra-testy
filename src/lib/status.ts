import type { GoalStatus } from './types';

type Tone = 'neutral' | 'accent' | 'active' | 'danger' | 'warn';

interface StatusMeta {
  /** Full label used on the goal detail badge. */
  label: string;
  /** Short label used on the compact goal card. */
  short: string;
  tone: Tone;
}

export const STATUS_META: Record<GoalStatus, StatusMeta> = {
  draft: { label: 'Draft', short: 'Draft', tone: 'neutral' },
  waiting_for_judge_acceptance: { label: 'Waiting for judge', short: 'Judge?', tone: 'warn' },
  waiting_for_recipients_acceptance: { label: 'Waiting for recipients', short: 'Recipients?', tone: 'warn' },
  active: { label: 'Active', short: 'Active', tone: 'active' },
  proof_pending: { label: 'Proof pending', short: 'Proof', tone: 'warn' },
  judge_review: { label: 'Judge review', short: 'Review', tone: 'warn' },
  completed: { label: 'Completed', short: 'Done', tone: 'accent' },
  failed_pending_notification: { label: 'Not completed', short: 'Missed', tone: 'danger' },
  failed_notified: { label: 'Not completed · notified', short: 'Missed', tone: 'danger' },
  cancelled: { label: 'Cancelled', short: 'Cancelled', tone: 'neutral' },
  expired_without_judge_decision: { label: 'Expired (no decision)', short: 'Expired', tone: 'neutral' },
  disputed: { label: 'Disputed', short: 'Disputed', tone: 'warn' },
};

export const statusMeta = (s: GoalStatus): StatusMeta =>
  STATUS_META[s] ?? { label: s, short: s, tone: 'neutral' };

/** Statuses where the goal has not yet started (awaiting acceptances). */
export const PRE_ACTIVE: GoalStatus[] = [
  'draft',
  'waiting_for_judge_acceptance',
  'waiting_for_recipients_acceptance',
];

/** Statuses where the goal is finished. */
export const TERMINAL: GoalStatus[] = [
  'completed',
  'failed_notified',
  'cancelled',
  'expired_without_judge_decision',
];
