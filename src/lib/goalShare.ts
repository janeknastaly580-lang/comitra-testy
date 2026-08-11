/**
 * What a goal looks like OUTSIDE its owner's device, and how the two sides are
 * merged back together.
 *
 * A goal lives in the owner's LocalStorage. Their judge is on a different phone,
 * so for the judge link to open anything at all, part of the goal has to be
 * readable from the shared store (see `src/lib/supabase.ts`, table
 * `comitra_goals`). Which part is not a detail: the app's core rule is that a
 * judge only ever learns "goal #N", never what the goal is.
 *
 * So this module is an ALLOW-LIST, not a redaction. A field is shared only by
 * being named in `SHARED_FIELDS`; anything added to `Goal` later stays on the
 * owner's device by default. `title`, `description` and `plannedActions` are
 * deliberately absent, so the goal's content is never uploaded anywhere — not to
 * the judge's phone, not to the database row, not to a backup of it.
 */
import type { Goal, GoalEvidence } from './types';

/**
 * The only fields that leave the owner's device.
 *
 * `recipients` carries consent IDs and delivery flags, never names or phone
 * numbers — those live in `RecipientConsent`, which is never shared. The judge's
 * device needs the array to know a message is owed, and the owner's device is
 * the only one that can actually send it.
 */
const SHARED_FIELDS = [
  'id',
  'userId',
  'goalNumber',
  'status',
  'requiredActionsCount',
  'startsAt',
  'deadlineAt',
  'messageTone',
  'evidence',
  'judge',
  'recipients',
  'ackNotifyConsent',
  'noJudge',
  'appBlock',
  'appBlockUntil',
  'commitmentBlock',
  'earlyDecisionRequested',
  'cancelRequested',
  'shareToken',
  'creatorDeviceId',
  'creatorName',
  'creatorAvatar',
  'createdAt',
  'activatedAt',
  'completedAt',
  'failedAt',
  'cancelledAt',
  'updatedAt',
] as const;

export type SharedGoal = Pick<Goal, (typeof SHARED_FIELDS)[number]>;

/** Roughly the biggest row we're willing to push (Base64 photos add up fast). */
const MAX_SHARED_BYTES = 1_500_000;

export function toSharedGoal(goal: Goal): SharedGoal {
  const out: Partial<Record<(typeof SHARED_FIELDS)[number], unknown>> = {};
  for (const key of SHARED_FIELDS) {
    if (goal[key] !== undefined) out[key] = goal[key];
  }
  return capPhotos(out as SharedGoal);
}

/**
 * Drop photo payloads when the row would be too big to push. The judge keeps the
 * note, the date and any link; the photo simply stays on the owner's phone
 * rather than the whole sync failing and the judge seeing no goal at all.
 */
function capPhotos(shared: SharedGoal): SharedGoal {
  if (JSON.stringify(shared).length <= MAX_SHARED_BYTES) return shared;
  const evidence = (shared.evidence ?? []).map((ev): GoalEvidence => {
    const isPhotoData = ev.photoUrl?.startsWith('data:') || ev.content?.startsWith('data:');
    if (!isPhotoData) return ev;
    return {
      ...ev,
      photoUrl: undefined,
      content: ev.note ?? '',
      note: ev.note ?? 'Photo too large to share; ask them to show you.',
    };
  });
  return { ...shared, evidence };
}

/**
 * Identity of the shared part, used to tell "this goal actually changed" from
 * "the array was rewritten". `updatedAt` is excluded on purpose: including the
 * stamp would make every goal look changed every time one of them was.
 */
export function sharedFingerprint(goal: Goal): string {
  const { updatedAt: _ignored, ...rest } = toSharedGoal(goal);
  return JSON.stringify(rest);
}

/** Whether the incoming shared copy is newer than what this device holds. */
export function isNewerThan(shared: SharedGoal, local: Goal | null | undefined): boolean {
  if (!local) return true;
  const remote = shared.updatedAt ? +new Date(shared.updatedAt) : 0;
  const mine = local.updatedAt ? +new Date(local.updatedAt) : 0;
  return remote > mine;
}

/**
 * Fold a shared copy into what this device already has.
 *
 * On the OWNER's device `local` exists, so their title and details survive: only
 * the shared fields (the judge's acceptance, decision, requests) are taken.
 *
 * On the JUDGE's device there is no local copy, so the goal is materialised with
 * empty content. That is not a placeholder to be filled in later — the content
 * was never sent, and the judge view asks about "goal #N" precisely because it
 * has nothing else to show.
 */
export function mergeSharedGoal(local: Goal | null | undefined, shared: SharedGoal): Goal {
  const base: Goal = local ?? {
    ...(shared as Goal),
    title: '',
    description: '',
    plannedActions: [],
  };
  return { ...base, ...shared };
}
