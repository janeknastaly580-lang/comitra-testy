import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api';
import { KEYS, write } from '../storage';
import type { CreateGoalInput } from '../api';
import type { PushMessage } from '../push';
import { goalRequired } from '../goal';
import { checkGoalContent } from '../messages';

/** Simulate acting from a device different from the goal creator's. */
function setDevice(id: string) {
  write(KEYS.deviceId, id);
}

const future = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

/** The judge's secret code used across the link-based flow in these tests. */
const JUDGE_CODE = 'code1234';

function goalInput(userId: string, over: Partial<CreateGoalInput> = {}): CreateGoalInput {
  return {
    userId,
    creatorName: 'Owner',
    title: 'Study 3 times this week',
    description: 'Three sessions',
    requiredActionsCount: 3,
    deadlineAt: future(),
    messageTone: 'neutral',
    ackNotifyConsent: true,
    judge: { name: 'Judge', channel: 'email', contact: 'judge@example.com' },
    // A goal notifies exactly one recipient (MAX_RECIPIENTS_PER_GOAL === 1), and
    // a recipient is always a friend's account — never a number or an address.
    recipients: [{ name: 'Alice', recipientUserId: 'friend-alice' }],
    ...over,
  };
}

async function freshOwner() {
  const email = `o_${Math.random().toString(36).slice(2)}@e.com`;
  return api.register('Owner', email, 'pw');
}

/** Full happy path up to (but not including) the judge's decision. */
async function activatedGoal(over: Partial<CreateGoalInput> = {}) {
  setDevice('creator-device');
  const owner = await freshOwner();
  const goal = await api.createGoal(goalInput(owner.id, over));
  const consents = await api.listOwnerConsents(owner.id);
  const alice = consents.find((c) => c.name === 'Alice')!;
  await api.acceptRecipientConsent(alice.inviteToken); // the one recipient accepts
  setDevice('judge-device');
  await api.acceptJudge(goal.id, goal.judge.acceptToken, JUDGE_CODE);
  // Deadlines are in the future in these tests, so let the judge decide now by
  // having the owner request an early decision (the only way to decide early).
  await api.requestEarlyDecision(goal.id, owner.id);
  return { owner, goal: (await api.getGoal(goal.id))!, alice, consents };
}

beforeEach(() => {
  localStorage.clear();
});

describe('subscription / trial gating', () => {
  it('allows creating a goal during the trial', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    expect(api.hasEntitlement(owner)).toBe(true);
    const goal = await api.createGoal(goalInput(owner.id));
    expect(goal.id).toBeTruthy();
  });

  it('blocks creating a goal without an active subscription or trial', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    await api.updateUser({
      ...owner,
      subscription: { ...owner.subscription, status: 'expired', trialEndsAt: new Date(Date.now() - 1000).toISOString() },
    });
    const refreshed = (await api.getSessionUser())!;
    expect(api.hasEntitlement(refreshed)).toBe(false);
    await expect(api.createGoal(goalInput(owner.id))).rejects.toThrow(/subscription/i);
  });
});

describe('judge acceptance is required to activate', () => {
  it('does not become active until the judge accepts', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id));
    const consents = await api.listOwnerConsents(owner.id);
    await api.acceptRecipientConsent(consents.find((c) => c.name === 'Alice')!.inviteToken);
    // Recipient accepted, but judge has NOT, must not be active.
    expect((await api.getGoal(goal.id))!.status).toBe('waiting_for_judge_acceptance');
  });

  it('a creator cannot judge their own goal (device isolation)', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id));
    await expect(api.acceptJudge(goal.id, goal.judge.acceptToken, JUDGE_CODE)).rejects.toThrow(/your own goal/i);
  });

  it('activates once judge + one recipient accept', async () => {
    const { goal } = await activatedGoal();
    expect(goal.status).toBe('active');
  });
});

describe('notifications only reach accepted, non-revoked recipients', () => {
  it('does not send to a recipient who never accepted', async () => {
    // The single recipient never accepts, so the goal never starts and the
    // judge cannot decide: no message can ever reach them.
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id));
    setDevice('judge-device');
    await api.acceptJudge(goal.id, goal.judge.acceptToken, JUDGE_CODE);
    expect((await api.getGoal(goal.id))!.status).toBe('waiting_for_recipients_acceptance');
    await expect(
      api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE),
    ).rejects.toThrow(/not ready/i);
    expect(await api.listGoalNotifications(goal.id)).toHaveLength(0);
  });

  it('sends exactly one message, to the one accepted recipient', async () => {
    const { goal, alice } = await activatedGoal();
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const notes = await api.listGoalNotifications(goal.id);
    const sent = notes.filter((n) => n.status === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].recipientConsentId).toBe(alice.id);
  });

  it('does not send after a recipient revokes consent', async () => {
    const { goal, alice } = await activatedGoal();
    await api.revokeRecipientConsent(alice.inviteToken);
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const notes = await api.listGoalNotifications(goal.id);
    const aliceNote = notes.find((n) => n.recipientConsentId === alice.id)!;
    expect(aliceNote.status).toBe('suppressed');
    expect(aliceNote.reason).toBe('consent_revoked');
    expect(notes.filter((n) => n.status === 'sent')).toHaveLength(0);
  });

  it('completing a goal sends no messages and pays no reward', async () => {
    const { goal } = await activatedGoal();
    const done = await api.judgeDecision(goal.id, goal.judge.acceptToken, 'completed', undefined, JUDGE_CODE);
    expect(done.status).toBe('completed');
    expect(await api.listGoalNotifications(goal.id)).toHaveLength(0);
  });
});

describe('message tone', () => {
  it('uses the selected tone in the delivered message', async () => {
    const { goal, alice } = await activatedGoal({ messageTone: 'supportive' });
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const notes = await api.listGoalNotifications(goal.id);
    const aliceNote = notes.find((n) => n.recipientConsentId === alice.id)!;
    expect(aliceNote.tone).toBe('supportive');
    expect(aliceNote.body.toLowerCase()).toContain('encourage');
  });
});

describe('goal content is never shared, only the goal number', () => {
  it('the failure message carries the goal number, never the title or details', async () => {
    const { goal, alice } = await activatedGoal();
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const notes = await api.listGoalNotifications(goal.id);
    const body = notes.find((n) => n.recipientConsentId === alice.id)!.body;
    expect(body).not.toContain('Study 3 times');
    expect(body).not.toContain(goal.title);
    expect(body).not.toContain(goal.description);
    expect(body).toContain(`goal no. ${goal.goalNumber}`);
  });

  it('every tone keeps the goal content out of the message', async () => {
    for (const tone of ['neutral', 'supportive', 'firm'] as const) {
      const { goal, alice } = await activatedGoal({ messageTone: tone });
      await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
      const notes = await api.listGoalNotifications(goal.id);
      const body = notes.find((n) => n.recipientConsentId === alice.id)!.body;
      expect(body).not.toContain(goal.title);
      expect(body).toContain(`goal no. ${goal.goalNumber}`);
    }
  });

  it('the messages queued for the judge never contain the goal content', async () => {
    const { goal } = await activatedGoal();
    const messages = await api.listOutbox(goal.id);
    const toJudge = messages.filter((m) => m.to === 'judge');
    expect(toJudge.length).toBeGreaterThan(0);
    for (const m of toJudge) {
      expect(m.body).not.toContain(goal.title);
      expect(m.body).not.toContain(goal.description);
      expect(m.body).toContain(`goal #${goal.goalNumber}`);
    }
  });

  it('numbers goals per owner, starting at 1', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const first = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    expect(first.goalNumber).toBe(1);
    await api.completeSoloGoal(first.id, owner.id);
    const second = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    expect(second.goalNumber).toBe(2);
    // A different owner starts their own count at 1.
    const other = await freshOwner();
    const theirs = await api.createGoal(goalInput(other.id, { recipients: [], judge: undefined }));
    expect(theirs.goalNumber).toBe(1);
  });
});

describe('publishing one finished goal', () => {
  it('a new goal starts private', async () => {
    const { goal } = await activatedGoal();
    expect(goal.isPublic).toBe(false);
  });

  it('refuses to publish a goal that is still running', async () => {
    const { goal, owner } = await activatedGoal();
    await expect(api.setGoalVisibility(goal.id, owner.id, true)).rejects.toThrow(/finished/i);
    expect((await api.getGoal(goal.id))!.isPublic).toBe(false);
  });

  it('publishes a finished goal, and only that one', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const first = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    await api.completeSoloGoal(first.id, owner.id);
    const second = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    await api.completeSoloGoal(second.id, owner.id);

    await api.setGoalVisibility(first.id, owner.id, true);
    expect((await api.getGoal(first.id))!.isPublic).toBe(true);
    // The owner's other goal is untouched, this is per goal, not a global switch.
    expect((await api.getGoal(second.id))!.isPublic).toBe(false);

    // …and it can be taken back.
    await api.setGoalVisibility(first.id, owner.id, false);
    expect((await api.getGoal(first.id))!.isPublic).toBe(false);
  });

  it('only the owner can publish their goal', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    await api.completeSoloGoal(goal.id, owner.id);
    const stranger = await freshOwner();
    await expect(api.setGoalVisibility(goal.id, stranger.id, true)).rejects.toThrow(/owner/i);
  });

  it('a profile lists finished goals only, never a running one', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const done = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    await api.completeSoloGoal(done.id, owner.id);
    const running = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    expect(running.status).toBe('active');

    const shown = await api.listCompletedGoals(owner.id);
    expect(shown.map((g) => g.id)).toContain(done.id);
    expect(shown.map((g) => g.id)).not.toContain(running.id);
  });

  it('publishing never puts the goal content into a message', async () => {
    const { goal, alice } = await activatedGoal();
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const published = await api.setGoalVisibility(goal.id, goal.userId, true);
    expect(published.isPublic).toBe(true);

    const body = (await api.listGoalNotifications(goal.id)).find((n) => n.recipientConsentId === alice.id)!.body;
    expect(body).not.toContain(goal.title);
    expect(body).toContain(`goal no. ${goal.goalNumber}`);
    for (const m of await api.listOutbox(goal.id)) {
      expect(m.body).not.toContain(goal.title);
    }
  });
});

describe('profile visibility (public / friends / private)', () => {
  /** An owner with one completed solo goal and one judged goal that was missed. */
  async function ownerWithHistory() {
    setDevice('creator-device');
    const owner = await freshOwner();
    const solo = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    await api.completeSoloGoal(solo.id, owner.id);
    const judged = await api.createGoal(goalInput(owner.id, { recipients: [] }));
    setDevice('judge-device');
    await api.acceptJudge(judged.id, judged.judge.acceptToken, JUDGE_CODE);
    await api.requestEarlyDecision(judged.id, owner.id);
    await api.judgeDecision(judged.id, judged.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    setDevice('creator-device');
    return { owner, solo, judged };
  }

  it('splits goals into no-judge / judged and computes each success rate', async () => {
    const { owner, solo, judged } = await ownerWithHistory();
    const view = await api.getProfileGoals(owner.id, owner.id);
    expect(view.allowed).toBe(true);
    expect(view.solo.goals.map((g) => g.id)).toEqual([solo.id]);
    expect(view.judged.goals.map((g) => g.id)).toEqual([judged.id]);
    expect(view.solo.successRate).toBe(100); // 1 completed, 0 missed
    expect(view.judged.successRate).toBe(0); // 0 completed, 1 missed
  });

  it('a running goal never appears on a profile', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const running = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    const view = await api.getProfileGoals(owner.id, owner.id);
    expect([...view.solo.goals, ...view.judged.goals].map((g) => g.id)).not.toContain(running.id);
  });

  it('private hides the goals from everyone but the owner', async () => {
    const { owner } = await ownerWithHistory();
    await api.setProfileVisibility(owner.id, 'private');
    const stranger = await freshOwner();

    const asOwner = await api.getProfileGoals(owner.id, owner.id);
    expect(asOwner.allowed).toBe(true);

    const asStranger = await api.getProfileGoals(stranger.id, owner.id);
    expect(asStranger.allowed).toBe(false);
    expect(asStranger.blockedBy).toBe('private');
    expect(asStranger.solo.goals).toHaveLength(0);
  });

  it('friends-only needs a follow in BOTH directions', async () => {
    const { owner } = await ownerWithHistory();
    await api.setProfileVisibility(owner.id, 'friends');
    const other = await freshOwner();

    // Nobody follows anybody yet.
    expect((await api.getProfileGoals(other.id, owner.id)).blockedBy).toBe('friends-only');

    // One-way follow is still not enough.
    await api.toggleFollow(other.id, owner.id);
    expect((await api.getProfileGoals(other.id, owner.id)).allowed).toBe(false);

    // Followed back → friends → allowed.
    await api.toggleFollow(owner.id, other.id);
    expect((await api.getProfileGoals(other.id, owner.id)).allowed).toBe(true);
  });

  it('public lets anyone see them', async () => {
    const { owner } = await ownerWithHistory();
    await api.setProfileVisibility(owner.id, 'public');
    const stranger = await freshOwner();
    expect((await api.getProfileGoals(stranger.id, owner.id)).allowed).toBe(true);
  });

  it('visibility never reveals goal content, that stays per goal', async () => {
    const { owner, solo } = await ownerWithHistory();
    await api.setProfileVisibility(owner.id, 'public');
    const stranger = await freshOwner();
    const view = await api.getProfileGoals(stranger.id, owner.id);
    // The goal is visible in the list, but still unpublished…
    expect(view.solo.goals[0].id).toBe(solo.id);
    expect(view.solo.goals[0].isPublic).toBe(false);
    // …until the owner publishes that one goal.
    await api.setGoalVisibility(solo.id, owner.id, true);
    const after = await api.getProfileGoals(stranger.id, owner.id);
    expect(after.solo.goals[0].isPublic).toBe(true);
  });
});

describe('commitment app block (blocks an app while the goal runs)', () => {
  /** An active solo goal whose deadline is `days` away. */
  async function activeSoloGoal(days: number) {
    setDevice('creator-device');
    const owner = await freshOwner();
    const deadlineAt = new Date(Date.now() + days * 86_400_000).toISOString();
    const goal = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined, deadlineAt }));
    return { owner, goal };
  }

  it('is offered when the goal ends within the window, not before', async () => {
    const soon = await activeSoloGoal(10);
    expect(api.canSetCommitmentBlock(soon.goal)).toBe(true);

    const faraway = await activeSoloGoal(30);
    expect(api.canSetCommitmentBlock(faraway.goal)).toBe(false);
    await expect(
      api.setCommitmentBlock(faraway.goal.id, faraway.owner.id, 'com.instagram.android', 'Instagram'),
    ).rejects.toThrow(new RegExp(`${api.COMMITMENT_BLOCK_MAX_DAYS} days`));
  });

  it('blocks the app until the goal ends, and cannot be lifted early', async () => {
    const { owner, goal } = await activeSoloGoal(7);
    const blocked = await api.setCommitmentBlock(goal.id, owner.id, 'com.instagram.android', 'Instagram');
    expect(blocked.commitmentBlock?.appLabel).toBe('Instagram');
    // The hard stop is the goal's own deadline, a block can never outlive it.
    expect(blocked.commitmentBlock?.untilAt).toBe(goal.deadlineAt);
    expect(api.isCommitmentBlockLive(blocked)).toBe(true);
    // No second block while one is live, and no "turn it off" API at all.
    expect(api.canSetCommitmentBlock(blocked)).toBe(false);
    await expect(
      api.setCommitmentBlock(goal.id, owner.id, 'com.discord', 'Discord'),
    ).rejects.toThrow(/already blocked/i);
  });

  // NOTE: these deliberately re-read the goal through `api.getGoal` instead of
  // trusting the returned object. Lifting used to mutate the goal AFTER
  // `saveGoals`, so the returned copy looked right while storage never changed,
  // asserting on the return value alone hid the bug.
  it('lifts as soon as the goal is completed', async () => {
    const { owner, goal } = await activeSoloGoal(7);
    await api.setCommitmentBlock(goal.id, owner.id, 'com.instagram.android', 'Instagram');
    await api.completeSoloGoal(goal.id, owner.id);
    const stored = (await api.getGoal(goal.id))!;
    expect(stored.status).toBe('completed');
    expect(stored.commitmentBlock?.liftedAt).toBeTruthy();
    expect(api.isCommitmentBlockLive(stored)).toBe(false);
  });

  it('lifts when the goal is missed, and when it is cancelled', async () => {
    const missed = await activeSoloGoal(7);
    await api.setCommitmentBlock(missed.goal.id, missed.owner.id, 'com.discord', 'Discord');
    await api.failSoloGoal(missed.goal.id, missed.owner.id);
    const after = (await api.getGoal(missed.goal.id))!;
    expect(after.status).toBe('failed_notified');
    expect(after.commitmentBlock?.liftedAt).toBeTruthy();

    // A deadline that simply arrives leaves the goal alone: the block stops
    // being live because its own hard stop IS the deadline, and the goal waits
    // for its owner's verdict.
    const overdue = await activeSoloGoal(7);
    await api.setCommitmentBlock(overdue.goal.id, overdue.owner.id, 'com.discord', 'Discord');
    const past = new Date(Date.now() - 1000).toISOString();
    const rows = JSON.parse(localStorage.getItem('fineline:goals') || '[]');
    for (const g of rows) {
      if (g.id !== overdue.goal.id) continue;
      // `untilAt` tracks the deadline (see updateGoalDeadline), so move both.
      g.deadlineAt = past;
      g.commitmentBlock.untilAt = past;
    }
    localStorage.setItem('fineline:goals', JSON.stringify(rows));
    const still = (await api.getGoal(overdue.goal.id))!;
    expect(still.status).toBe('active');
    expect(api.isCommitmentBlockLive(still)).toBe(false);

    const cancelled = await activeSoloGoal(7);
    await api.setCommitmentBlock(cancelled.goal.id, cancelled.owner.id, 'com.discord', 'Discord');
    await api.cancelGoal(cancelled.goal.id);
    const gone = (await api.getGoal(cancelled.goal.id))!;
    expect(gone.status).toBe('cancelled');
    expect(gone.commitmentBlock?.liftedAt).toBeTruthy();
  });

  it('lifts when a judge decides, either way', async () => {
    for (const decision of ['completed', 'not_completed'] as const) {
      setDevice('creator-device');
      const owner = await freshOwner();
      const goal = await api.createGoal(goalInput(owner.id, { recipients: [] }));
      setDevice('judge-device');
      await api.acceptJudge(goal.id, goal.judge.acceptToken, JUDGE_CODE);
      setDevice('creator-device');
      await api.setCommitmentBlock(goal.id, owner.id, 'com.discord', 'Discord');
      await api.requestEarlyDecision(goal.id, owner.id);
      setDevice('judge-device'); // the creator can never rule on their own goal
      await api.judgeDecision(goal.id, goal.judge.acceptToken, decision, undefined, JUDGE_CODE);
      const stored = (await api.getGoal(goal.id))!;
      expect(stored.commitmentBlock?.liftedAt).toBeTruthy();
      expect(api.isCommitmentBlockLive(stored)).toBe(false);
    }
  });

  it('only the owner can set it, and only while the goal runs', async () => {
    const { owner, goal } = await activeSoloGoal(7);
    const stranger = await freshOwner();
    await expect(
      api.setCommitmentBlock(goal.id, stranger.id, 'com.discord', 'Discord'),
    ).rejects.toThrow(/owner/i);

    await api.completeSoloGoal(goal.id, owner.id);
    expect(api.canSetCommitmentBlock((await api.getGoal(goal.id))!)).toBe(false);
    await expect(
      api.setCommitmentBlock(goal.id, owner.id, 'com.discord', 'Discord'),
    ).rejects.toThrow(/while the goal is running/i);
  });
});

describe('a missed goal must be reflected on before a new one', () => {
  /** Create a solo goal and have its owner mark it not completed. */
  async function missedSoloGoal() {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    // A goal is only ever missed by being SAID to be missed: the deadline going
    // by leaves it active.
    expect((await api.failSoloGoal(goal.id, owner.id)).status).toBe('failed_notified');
    return { owner, goal };
  }

  it('blocks a new goal until both questions are answered', async () => {
    const { owner, goal } = await missedSoloGoal();
    expect((await api.listUnreflectedGoals(owner.id)).map((g) => g.id)).toEqual([goal.id]);
    await expect(api.createGoal(goalInput(owner.id, { recipients: [] }))).rejects.toThrow(/two questions/i);

    await api.submitGoalReflection(
      goal.id,
      owner.id,
      'I left it until the last day and ran out of time.',
      'I will do one small part of it every single morning.',
    );
    expect(await api.listUnreflectedGoals(owner.id)).toHaveLength(0);
    const next = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    expect(next.id).toBeTruthy();
  });

  it('rejects answers shorter than the minimum', async () => {
    const { owner, goal } = await missedSoloGoal();
    await expect(api.submitGoalReflection(goal.id, owner.id, 'no time', 'try harder next time please'))
      .rejects.toThrow(new RegExp(`${api.REFLECTION_MIN_CHARS} characters`));
    await expect(api.submitGoalReflection(goal.id, owner.id, 'I ran out of time completely', 'be better'))
      .rejects.toThrow(new RegExp(`${api.REFLECTION_MIN_CHARS} characters`));
    expect(await api.listUnreflectedGoals(owner.id)).toHaveLength(1);
  });

  it('a completed goal owes no answers', async () => {
    const { goal, owner } = await activatedGoal();
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'completed', undefined, JUDGE_CODE);
    expect(await api.listUnreflectedGoals(owner.id)).toHaveLength(0);
  });
});

describe('app-block penalty on a judged goal', () => {
  it('starts the block when the judge marks the goal not completed', async () => {
    const { goal } = await activatedGoal({
      appBlock: { packageName: 'com.instagram.android', appLabel: 'Instagram', durationMinutes: 60 },
    });
    const decided = await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    expect(decided.status).toBe('failed_notified');
    expect(decided.appBlockUntil).toBeTruthy();
    expect(+new Date(decided.appBlockUntil!)).toBeGreaterThan(Date.now());
  });

  it('does not block when the judge marks the goal completed', async () => {
    const { goal } = await activatedGoal({
      appBlock: { packageName: 'com.instagram.android', appLabel: 'Instagram', durationMinutes: 60 },
    });
    const decided = await api.judgeDecision(goal.id, goal.judge.acceptToken, 'completed', undefined, JUDGE_CODE);
    expect(decided.status).toBe('completed');
    expect(decided.appBlockUntil).toBeUndefined();
  });
});

describe('goals', () => {
  it('generates one planned step per required action', async () => {
    const { goal } = await activatedGoal();
    expect(goalRequired(goal)).toBe(3);
    expect(goal.plannedActions).toHaveLength(3);
    expect(goal.plannedActions.every((p) => p.actionType === 'step')).toBe(true);
  });

  it('honours a custom required-action count', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(
      goalInput(owner.id, { title: 'Finish the project by Friday', requiredActionsCount: 5 }),
    );
    expect(goal.plannedActions).toHaveLength(5);
    expect(goal.plannedActions.every((p) => p.actionType === 'step')).toBe(true);
    expect(goalRequired(goal)).toBe(5);
  });

  it('a rescheduled step keeps the same deadline', async () => {
    const { goal } = await activatedGoal();
    const action = goal.plannedActions.find((p) => p.status === 'planned')!;
    const g2 = await api.reschedulePlannedAction(goal.id, action.id, future());
    expect(g2.plannedActions.find((p) => p.id === action.id)!.status).toBe('rescheduled');
    expect(g2.deadlineAt).toBe(goal.deadlineAt);
  });
});

describe('trainer role', () => {
  async function makeUser(name: string, type: 'standard' | 'trainer') {
    const email = `${name}_${Math.random().toString(36).slice(2)}@e.com`;
    return api.register(name, email, 'pw', type);
  }

  it('a trainer only sees accepted clients', async () => {
    setDevice('trainer-device');
    const trainer = await makeUser('Coach', 'trainer');
    const client = await makeUser('Marek', 'standard');
    // Before acceptance the trainer has no clients.
    expect(await api.listTrainerClients(trainer.id)).toHaveLength(0);
    const invite = await api.getOrCreateTrainerInvite(trainer.id);
    await api.acceptTrainerInvite(invite.inviteToken, client.id);
    const clients = await api.listTrainerClients(trainer.id);
    expect(clients).toHaveLength(1);
    expect(clients[0].clientUserId).toBe(client.id);
    // The client sees the trainer as an available judge.
    expect((await api.listMyTrainers(client.id)).map((t) => t.id)).toContain(trainer.id);
  });

  it('a trainer can be a client judge and decide; others cannot; not their own goal', async () => {
    setDevice('trainer-device');
    const trainer = await makeUser('Coach', 'trainer');
    setDevice('client-device');
    const client = await makeUser('Marek', 'standard');
    const goal = await api.createGoal(
      goalInput(client.id, { judge: { name: 'Coach', channel: 'internal', judgeUserId: trainer.id } }),
    );
    const consents = await api.listOwnerConsents(client.id);
    await api.acceptRecipientConsent(consents[0].inviteToken);

    // The client (creator) cannot accept as judge.
    await expect(api.acceptJudgeByUser(goal.id, client.id)).rejects.toThrow(/your own goal/i);
    // A random user is not the judge.
    const stranger = await makeUser('Stranger', 'standard');
    await expect(api.judgeDecisionByUser(goal.id, stranger.id, 'completed')).rejects.toThrow(/not the judge/i);

    // The trainer accepts and decides.
    await api.acceptJudgeByUser(goal.id, trainer.id);
    const decided = await api.judgeDecisionByUser(goal.id, trainer.id, 'completed');
    expect(decided.status).toBe('completed');
  });
});

describe('a recipient is a friend, and answers in the app', () => {
  /**
   * The consent record lives in the OWNER's data, so the friend has nothing
   * local to accept: their answer arrives as a message and is applied here.
   * Without this the goal would wait for a recipient for ever.
   */
  it("a friend's answer, arriving in the inbox, accepts the consent and starts the goal", async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id));
    setDevice('judge-device');
    await api.acceptJudge(goal.id, goal.judge.acceptToken, JUDGE_CODE);
    setDevice('creator-device');

    const consent = (await api.listOwnerConsents(owner.id))[0];
    expect(consent.consentStatus).toBe('pending');
    expect(consent.recipientUserId).toBe('friend-alice');
    // Nothing may be sent, and the goal may not start, until they say yes.
    expect((await api.getGoal(goal.id))!.status).toBe('waiting_for_recipients_acceptance');

    const answer: PushMessage = {
      id: 'msg-1',
      kind: 'recipient_consent_answer',
      fromUserId: 'friend-alice',
      payload: { consentId: consent.id, accepted: true },
      createdAt: new Date().toISOString(),
    };
    expect(api.absorbConsentAnswers(owner.id, [answer])).toEqual(['msg-1']);

    expect((await api.listOwnerConsents(owner.id))[0].consentStatus).toBe('accepted');
    expect((await api.getGoal(goal.id))!.status).toBe('active');
  });

  it('a no keeps the recipient out, and is not asked again', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id));
    const consent = (await api.listOwnerConsents(owner.id))[0];

    const refusal: PushMessage = {
      id: 'msg-2',
      kind: 'recipient_consent_answer',
      fromUserId: 'friend-alice',
      payload: { consentId: consent.id, accepted: false },
      createdAt: new Date().toISOString(),
    };
    api.absorbConsentAnswers(owner.id, [refusal]);
    expect((await api.listOwnerConsents(owner.id))[0].consentStatus).toBe('revoked');

    // A later yes cannot undo a refusal: opting out has to be final.
    api.absorbConsentAnswers(owner.id, [{ ...refusal, id: 'msg-3', payload: { consentId: consent.id, accepted: true } }]);
    expect((await api.listOwnerConsents(owner.id))[0].consentStatus).toBe('revoked');
    expect((await api.getGoal(goal.id))!.status).not.toBe('active');
  });

  it("an answer about a consent this device never had is still consumed", async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const stray: PushMessage = {
      id: 'msg-4',
      kind: 'recipient_consent_answer',
      fromUserId: 'friend-alice',
      payload: { consentId: 'rc_nonexistent', accepted: true },
      createdAt: new Date().toISOString(),
    };
    // Consumed, or it would come back on every single sync for ever.
    expect(api.absorbConsentAnswers(owner.id, [stray])).toEqual(['msg-4']);
  });
});

describe('recipients optional / solo goals / active-goal protection', () => {
  it('a goal with a judge and no recipients activates once the judge accepts', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id, { recipients: [] }));
    expect((await api.getGoal(goal.id))!.status).toBe('waiting_for_judge_acceptance');
    setDevice('judge-device');
    await api.acceptJudge(goal.id, goal.judge.acceptToken, JUDGE_CODE);
    expect((await api.getGoal(goal.id))!.status).toBe('active');
  });

  it('a solo (judge-less) goal activates immediately and can be self-completed', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    expect(goal.status).toBe('active');
    expect(goal.noJudge).toBe(true);
    const done = await api.completeSoloGoal(goal.id, owner.id);
    expect(done.status).toBe('completed');
  });

  it('a judged goal: creator cannot cancel; judge can only after the user asks', async () => {
    const { goal, owner } = await activatedGoal();
    await expect(api.cancelGoal(goal.id)).rejects.toThrow(/judge/i);
    // Judge cannot cancel until the user requests it.
    await expect(api.judgeCancelGoal(goal.id, goal.judge.acceptToken)).rejects.toThrow(/asked|not asked/i);
    await api.requestCancel(goal.id, owner.id);
    const cancelled = await api.judgeCancelGoal(goal.id, goal.judge.acceptToken);
    expect(cancelled.status).toBe('cancelled');
  });

  it('the creator can cancel their own solo goal', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    const cancelled = await api.cancelGoal(goal.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('a solo goal past its deadline is NOT failed and blocks nothing', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(
      goalInput(owner.id, {
        recipients: [],
        judge: undefined,
        appBlock: { packageName: 'com.instagram.android', appLabel: 'Instagram', durationMinutes: 60 },
      }),
    );
    // Force the deadline into the past: nothing about it decides the goal.
    const stored = JSON.parse(localStorage.getItem('fineline:goals') || '[]');
    for (const g of stored) if (g.id === goal.id) g.deadlineAt = new Date(Date.now() - 1000).toISOString();
    localStorage.setItem('fineline:goals', JSON.stringify(stored));
    const after = (await api.getGoal(goal.id))!;
    expect(after.status).toBe('active');
    expect(after.appBlockUntil).toBeUndefined();

    // Only the owner's own verdict starts the block.
    const failed = await api.failSoloGoal(goal.id, owner.id);
    expect(failed.status).toBe('failed_notified');
    expect(+new Date(failed.appBlockUntil!)).toBeGreaterThan(Date.now());
  });

  it('an overdue solo goal can still be marked completed, and blocks nothing', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(
      goalInput(owner.id, {
        recipients: [],
        judge: undefined,
        appBlock: { packageName: 'com.instagram.android', appLabel: 'Instagram', durationMinutes: 60 },
      }),
    );
    const stored = JSON.parse(localStorage.getItem('fineline:goals') || '[]');
    for (const g of stored) if (g.id === goal.id) g.deadlineAt = new Date(Date.now() - 1000).toISOString();
    localStorage.setItem('fineline:goals', JSON.stringify(stored));
    const done = await api.completeSoloGoal(goal.id, owner.id);
    expect(done.status).toBe('completed');
    expect(done.appBlockUntil).toBeUndefined();
  });

  it('a judge cannot decide before the deadline unless the user asks', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id, { recipients: [] }));
    setDevice('judge-device');
    await api.acceptJudge(goal.id, goal.judge.acceptToken, JUDGE_CODE);
    await expect(api.judgeDecision(goal.id, goal.judge.acceptToken, 'completed', undefined, JUDGE_CODE)).rejects.toThrow(/deadline|early/i);
    // After the owner asks, the judge may decide.
    await api.requestEarlyDecision(goal.id, owner.id);
    const done = await api.judgeDecision(goal.id, goal.judge.acceptToken, 'completed', undefined, JUDGE_CODE);
    expect(done.status).toBe('completed');
  });

  it('a solo goal can be marked not completed, and that costs the app block', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(
      goalInput(owner.id, {
        recipients: [],
        judge: undefined,
        appBlock: { packageName: 'com.instagram.android', appLabel: 'Instagram', durationMinutes: 60 },
      }),
    );
    const failed = await api.failSoloGoal(goal.id, owner.id);
    expect(failed.status).toBe('failed_notified');
    // Saying so is the one and only thing that costs the app block.
    expect(+new Date(failed.appBlockUntil!)).toBeGreaterThan(Date.now());
    // No message goes anywhere: a solo goal has no recipients and no judge.
    expect(await api.listGoalNotifications(goal.id)).toHaveLength(0);
  });

  it('only the owner of a judge-less goal can mark it not completed', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const solo = await api.createGoal(goalInput(owner.id, { recipients: [], judge: undefined }));
    const stranger = await freshOwner();
    await expect(api.failSoloGoal(solo.id, stranger.id)).rejects.toThrow(/owner/i);
    // A judged goal is the judge's call, never the owner's.
    const judged = (await activatedGoal()).goal;
    await expect(api.failSoloGoal(judged.id, judged.userId)).rejects.toThrow(/judge/i);
  });
});

describe('a judged goal is only ever ended by its judge', () => {
  /** Rewrite a goal's stored deadline, the way time passing would. */
  function forceDeadline(goalId: string, at: number) {
    const stored = JSON.parse(localStorage.getItem('fineline:goals') || '[]') as { id: string; deadlineAt: string }[];
    for (const g of stored) if (g.id === goalId) g.deadlineAt = new Date(at).toISOString();
    localStorage.setItem('fineline:goals', JSON.stringify(stored));
  }

  it('stays active past its deadline, out of history and off the leaderboards', async () => {
    const { goal, owner } = await activatedGoal();
    // Deadline long gone (a month), and still nobody has decided.
    forceDeadline(goal.id, Date.now() - 31 * 86_400_000);
    const after = (await api.getGoal(goal.id))!;
    expect(after.status).toBe('active');
    expect(await api.listCompletedGoals(owner.id)).toHaveLength(0);
    const boards = await api.getLeaderboards(owner.id);
    expect(boards.completions.find((e) => e.id === owner.id)).toBeUndefined();
    expect(boards.consistency.find((e) => e.id === owner.id)).toBeUndefined();
    // Only the judge's decision ends it, however late that is.
    setDevice('judge-device');
    const decided = await api.judgeDecision(goal.id, goal.judge.acceptToken, 'completed', undefined, JUDGE_CODE);
    expect(decided.status).toBe('completed');
    expect(await api.listCompletedGoals(owner.id)).toHaveLength(1);
  });

  it('the judge link carries the request: Comitra messages the judge for nothing', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(goalInput(owner.id, { recipients: [] }));
    setDevice('judge-device');
    await api.acceptJudge(goal.id, goal.judge.acceptToken, JUDGE_CODE);
    // Nothing was ever queued to the judge beyond their original invite.
    const queued = await api.listOutbox(goal.id);
    expect(queued.filter((m) => m.kind === 'judge_review_request')).toHaveLength(0);

    // Opening the "ask for a decision" link is what unlocks deciding early.
    await expect(
      api.judgeDecision(goal.id, goal.judge.acceptToken, 'completed', undefined, JUDGE_CODE),
    ).rejects.toThrow(/deadline|early/i);
    await api.applyJudgeLinkRequest(goal.id, goal.judge.acceptToken, 'decision');
    expect((await api.getGoal(goal.id))!.earlyDecisionRequested).toBe(true);
    expect((await api.getGoal(goal.id))!.cancelRequested).toBeFalsy();
    expect(await api.listOutbox(goal.id)).toHaveLength(queued.length);

    // And the "ask for a change" link is what unlocks cancelling.
    await expect(api.judgeCancelGoal(goal.id, goal.judge.acceptToken)).rejects.toThrow(/asked/i);
    await api.applyJudgeLinkRequest(goal.id, goal.judge.acceptToken, 'edit');
    const cancelled = await api.judgeCancelGoal(goal.id, goal.judge.acceptToken);
    expect(cancelled.status).toBe('cancelled');
  });

  it('a judge deciding on their own phone leaves the message for the owner to send', async () => {
    const { goal } = await activatedGoal();
    // The judge's device holds the goal (it came from the shared store) but not
    // the owner's recipient consents — names and numbers never leave the owner's
    // phone. Marking the goal "notified" here would bury the message forever.
    const consents = localStorage.getItem('fineline:recipientConsents')!;
    localStorage.setItem('fineline:recipientConsents', '[]');
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    expect((await api.getGoal(goal.id))!.status).toBe('failed_pending_notification');
    expect(await api.listGoalNotifications(goal.id)).toHaveLength(0);

    // Back on the owner's device, pulling that decision sends it for real.
    localStorage.setItem('fineline:recipientConsents', consents);
    api.dispatchFailureNotifications(goal.id);
    expect((await api.getGoal(goal.id))!.status).toBe('failed_notified');
    expect((await api.listGoalNotifications(goal.id)).filter((n) => n.status === 'sent')).toHaveLength(1);
  });

  it('a wrong token never records a request', async () => {
    const { goal } = await activatedGoal();
    await api.applyJudgeLinkRequest(goal.id, 'not-the-token', 'edit');
    expect((await api.getGoal(goal.id))!.cancelRequested).toBeFalsy();
  });
});

describe('the deadline is the only thing the owner may edit', () => {
  it('moves the deadline, and refuses a past one', async () => {
    const { goal, owner } = await activatedGoal();
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const moved = await api.updateGoalDeadline(goal.id, owner.id, later);
    expect(moved.deadlineAt).toBe(later);
    await expect(
      api.updateGoalDeadline(goal.id, owner.id, new Date(Date.now() - 1000).toISOString()),
    ).rejects.toThrow(/future/i);
  });

  it('only the owner, and never after the goal is over', async () => {
    const { goal, owner } = await activatedGoal();
    const stranger = await freshOwner();
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await expect(api.updateGoalDeadline(goal.id, stranger.id, later)).rejects.toThrow(/owner/i);
    setDevice('judge-device');
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'completed', undefined, JUDGE_CODE);
    await expect(api.updateGoalDeadline(goal.id, owner.id, later)).rejects.toThrow(/finished|decided/i);
  });
});

describe('content is action-based', () => {
  it('blocks sensitive medical / mental-health goals', () => {
    expect(checkGoalContent('Beat my cancer diagnosis', '').ok).toBe(false);
    expect(checkGoalContent('Stop taking my medication', '').ok).toBe(false);
    expect(checkGoalContent('Fix my anxiety and depression', '').ok).toBe(false);
  });
  it('allows action-based personal goals', () => {
    expect(checkGoalContent('Study 3 times this week', 'Mon Wed Fri').ok).toBe(true);
    expect(checkGoalContent('Finish the project by Friday', '').ok).toBe(true);
  });
});

describe('no gambling mechanics anywhere in the flow', () => {
  it('a goal carries no deposit/pot/token/reward fields', async () => {
    const { goal } = await activatedGoal();
    const bag = goal as unknown as Record<string, unknown>;
    for (const key of ['deposit', 'payout', 'pot', 'token', 'reward', 'stake', 'charityId']) {
      expect(bag[key]).toBeUndefined();
    }
  });

  it('a notification carries no monetary amount', async () => {
    const { goal } = await activatedGoal();
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const notes = await api.listGoalNotifications(goal.id);
    for (const n of notes) {
      expect((n as unknown as Record<string, unknown>).amount).toBeUndefined();
    }
  });
});
