import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api';
import { KEYS, write } from '../storage';
import type { CreateGoalInput } from '../api';
import { buildGoalReport, goalDone, goalRequired } from '../goal';
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
    includeGoalTitleInFailureMessage: false,
    includeGoalDescriptionInFailureMessage: false,
    ackNotifyConsent: true,
    ackJudgeSeesContent: true,
    judge: { name: 'Judge', channel: 'phone', contact: '+48500100200' },
    recipients: [
      { name: 'Alice', channel: 'phone', contact: '+48111222333' },
      { name: 'Bob', channel: 'email', contact: 'bob@example.com' },
    ],
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
  await api.acceptRecipientConsent(alice.inviteToken); // Alice accepts; Bob stays pending
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
    // Recipient accepted, but judge has NOT — must not be active.
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
    const { goal } = await activatedGoal();
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const notes = await api.listGoalNotifications(goal.id);
    // Bob (pending) suppressed, Alice (accepted) sent.
    const sent = notes.filter((n) => n.status === 'sent');
    const suppressed = notes.filter((n) => n.status === 'suppressed');
    expect(sent).toHaveLength(1);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].reason).toBe('not_accepted');
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

describe('goal content is private by default', () => {
  it('does not include the goal title in the failure message by default', async () => {
    const { goal, alice } = await activatedGoal(); // includeTitle defaults false
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const notes = await api.listGoalNotifications(goal.id);
    const body = notes.find((n) => n.recipientConsentId === alice.id)!.body;
    expect(body).not.toContain('Study 3 times');
    expect(body).not.toContain(goal.title);
  });

  it('includes the title only when explicitly opted in', async () => {
    const { goal, alice } = await activatedGoal({ includeGoalTitleInFailureMessage: true });
    await api.judgeDecision(goal.id, goal.judge.acceptToken, 'not_completed', undefined, JUDGE_CODE);
    const notes = await api.listGoalNotifications(goal.id);
    const body = notes.find((n) => n.recipientConsentId === alice.id)!.body;
    expect(body).toContain(goal.title);
  });
});

describe('goals', () => {
  it('generates planned steps and tracks proof + report', async () => {
    const { goal } = await activatedGoal();
    expect(goalRequired(goal)).toBe(3);
    expect(goal.plannedActions).toHaveLength(3);
    expect(goal.plannedActions.every((p) => p.actionType === 'step')).toBe(true);

    const g2 = await api.addEvidence(goal.id, {
      type: 'text',
      content: 'session',
      note: 'Good session',
      actionDate: new Date().toISOString(),
    });
    expect(goalDone(g2)).toBe(1);
    expect(g2.plannedActions.some((p) => p.status === 'evidence_added')).toBe(true);

    const report = buildGoalReport(g2);
    expect(report.plannedCount).toBe(3);
    expect(report.completedCount).toBe(1);
    expect(report.evidenceCount).toBe(1);
  });

  it('builds one planned step per required action', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(
      goalInput(owner.id, { title: 'Finish the project by Friday', requiredActionsCount: 5 }),
    );
    expect(goal.plannedActions).toHaveLength(5);
    expect(goal.plannedActions.every((p) => p.actionType === 'step')).toBe(true);
    expect(goalRequired(goal)).toBe(5);
  });

  it('rescheduling a step does NOT increase progress', async () => {
    const { goal } = await activatedGoal();
    const before = goalDone(goal);
    const action = goal.plannedActions.find((p) => p.status === 'planned')!;
    const g2 = await api.reschedulePlannedAction(goal.id, action.id, future());
    expect(g2.plannedActions.find((p) => p.id === action.id)!.status).toBe('rescheduled');
    expect(goalDone(g2)).toBe(before); // unchanged
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

  it('the creator cannot cancel an active goal, but the judge can', async () => {
    const { goal } = await activatedGoal();
    await expect(api.cancelGoal(goal.id)).rejects.toThrow(/judge/i);
    const cancelled = await api.judgeCancelGoal(goal.id, goal.judge.acceptToken);
    expect(cancelled.status).toBe('cancelled');
  });

  it('a missed solo goal applies the app-block penalty', async () => {
    setDevice('creator-device');
    const owner = await freshOwner();
    const goal = await api.createGoal(
      goalInput(owner.id, {
        recipients: [],
        judge: undefined,
        appBlock: { packageName: 'com.instagram.android', appLabel: 'Instagram', durationMinutes: 60 },
      }),
    );
    // Force the deadline into the past, then let resolveExpired run.
    const stored = JSON.parse(localStorage.getItem('fineline:goals') || '[]');
    for (const g of stored) if (g.id === goal.id) g.deadlineAt = new Date(Date.now() - 1000).toISOString();
    localStorage.setItem('fineline:goals', JSON.stringify(stored));
    const after = (await api.getGoal(goal.id))!;
    expect(after.status).toBe('failed_notified');
    expect(after.appBlockUntil).toBeTruthy();
    expect(+new Date(after.appBlockUntil!)).toBeGreaterThan(Date.now());
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
