import { describe, expect, it } from 'vitest';
import { isNewerThan, mergeSharedGoal, sharedFingerprint, toSharedGoal } from '../goalShare';
import type { Goal } from '../types';

/** A judged goal with content the judge must never receive. */
function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    userId: 'owner1',
    goalNumber: 4,
    title: 'Finish the tax return',
    description: 'All receipts scanned and filed',
    requiredActionsCount: 1,
    plannedActions: [{ id: 'p1', actionType: 'step', status: 'planned', createdAt: '2026-08-01T10:00:00.000Z' }],
    deadlineAt: '2026-09-01T10:00:00.000Z',
    status: 'active',
    messageTone: 'neutral',
    evidence: [],
    judge: { name: 'Kasia', channel: 'phone', judgeContact: '+48500100200', status: 'accepted', acceptToken: 'tok-1' },
    recipients: [{ consentId: 'c1' }],
    ackNotifyConsent: true,
    shareToken: 'share-1',
    creatorDeviceId: 'owner-device',
    creatorName: 'Owner',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...over,
  } as Goal;
}

describe('what a goal looks like off its owner’s device', () => {
  it('never carries the goal’s content', () => {
    const shared = toSharedGoal(goal()) as Record<string, unknown>;
    // The whole product rests on this: a judge is asked about "goal #4".
    expect(shared.title).toBeUndefined();
    expect(shared.description).toBeUndefined();
    expect(shared.plannedActions).toBeUndefined();
    expect(JSON.stringify(shared)).not.toContain('tax return');
    expect(JSON.stringify(shared)).not.toContain('receipts');
    // …but everything the judge needs to do the job is there.
    expect(shared.goalNumber).toBe(4);
    expect(shared.deadlineAt).toBe('2026-09-01T10:00:00.000Z');
    expect(shared.creatorName).toBe('Owner');
    expect((shared.judge as { acceptToken: string }).acceptToken).toBe('tok-1');
  });

  it('shares only consent ids for recipients, never who they are', () => {
    const shared = toSharedGoal(goal()) as Record<string, unknown>;
    expect(shared.recipients).toEqual([{ consentId: 'c1' }]);
  });

  it('a field added to Goal later is not shared unless it is opted in', () => {
    const withSecret = goal({ someFutureNote: 'private' } as unknown as Partial<Goal>);
    expect(JSON.stringify(toSharedGoal(withSecret))).not.toContain('private');
  });

  it('drops photo payloads rather than failing on an oversized goal', () => {
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(1_600_000);
    const shared = toSharedGoal(
      goal({ evidence: [{ id: 'e1', type: 'photo', content: huge, photoUrl: huge, addedAt: '2026-08-02T10:00:00.000Z', note: 'Week one' }] }),
    );
    expect(JSON.stringify(shared).length).toBeLessThan(200_000);
    expect(shared.evidence[0].photoUrl).toBeUndefined();
    expect(shared.evidence[0].note).toBe('Week one');
  });

  it('the fingerprint ignores the timestamp, so a re-save is not a change', () => {
    const a = goal({ updatedAt: '2026-08-01T10:00:00.000Z' });
    const b = goal({ updatedAt: '2026-08-09T10:00:00.000Z' });
    expect(sharedFingerprint(a)).toBe(sharedFingerprint(b));
    expect(sharedFingerprint(goal({ status: 'completed' }))).not.toBe(sharedFingerprint(a));
  });
});

describe('merging the two sides back together', () => {
  it('the owner keeps their content when they pull the judge’s decision', () => {
    const mine = goal({ updatedAt: '2026-08-01T10:00:00.000Z' });
    const fromJudge = toSharedGoal(
      goal({
        updatedAt: '2026-08-02T10:00:00.000Z',
        status: 'completed',
        judge: { ...goal().judge, decision: 'completed', decisionAt: '2026-08-02T10:00:00.000Z' },
      }),
    );
    const merged = mergeSharedGoal(mine, fromJudge);
    expect(merged.status).toBe('completed');
    expect(merged.judge.decision).toBe('completed');
    expect(merged.title).toBe('Finish the tax return'); // never uploaded, never lost
    expect(merged.description).toBe('All receipts scanned and filed');
  });

  it('the judge’s device materialises a goal with no content at all', () => {
    const merged = mergeSharedGoal(null, toSharedGoal(goal()));
    expect(merged.title).toBe('');
    expect(merged.description).toBe('');
    expect(merged.plannedActions).toEqual([]);
    expect(merged.goalNumber).toBe(4);
  });

  it('an older copy never overwrites a newer one', () => {
    const local = goal({ updatedAt: '2026-08-05T10:00:00.000Z' });
    expect(isNewerThan(toSharedGoal(goal({ updatedAt: '2026-08-04T10:00:00.000Z' })), local)).toBe(false);
    expect(isNewerThan(toSharedGoal(goal({ updatedAt: '2026-08-06T10:00:00.000Z' })), local)).toBe(true);
    // Nothing local: anything from the store is new (this is the judge's phone).
    expect(isNewerThan(toSharedGoal(goal()), null)).toBe(true);
  });
});
