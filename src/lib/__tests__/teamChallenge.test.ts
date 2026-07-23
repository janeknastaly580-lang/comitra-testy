import { describe, expect, it } from 'vitest';
import * as api from '../api';
import {
  everyoneAccepted,
  outcomeOf,
  relayPct,
  sideScore,
  teamsBalanced,
  tugMarkerPct,
  tugPull,
} from '../teamChallenge';
import type { ChallengeTask, TeamChallenge, TeamChallengeMode, TeamSide } from '../types';

const future = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

/* ─────────────────────────────────────────────────── pure scoring rules ── */

function task(side: TeamSide, status: ChallengeTask['status'], n: number): ChallengeTask {
  return {
    id: `t${side}${status}${n}`,
    memberId: `m${side}`,
    side,
    title: 'Goal',
    status,
    createdAt: new Date().toISOString(),
    decidedAt: status === 'pending' ? undefined : new Date().toISOString(),
  };
}

function challenge(mode: TeamChallengeMode, tasks: ChallengeTask[], pointsToWin = 4): TeamChallenge {
  return {
    id: 'c1',
    createdByUserId: 'u1',
    mode,
    name: 'Test',
    task: 'Do the thing',
    teamSize: 1,
    teamAName: 'A',
    teamBName: 'B',
    pointsToWin,
    deadlineAt: future(),
    status: 'active',
    members: [
      { id: 'mA', userId: 'u1', name: 'A player', avatar: '', side: 'A', role: 'player', inviteStatus: 'accepted' },
      { id: 'mB', userId: 'u2', name: 'B player', avatar: '', side: 'B', role: 'player', inviteStatus: 'accepted' },
      { id: 'jA', userId: 'u3', name: 'A judge', avatar: '', side: 'A', role: 'judge', inviteStatus: 'accepted' },
      { id: 'jB', userId: 'u4', name: 'B judge', avatar: '', side: 'B', role: 'judge', inviteStatus: 'accepted' },
    ],
    tasks,
    createdAt: new Date().toISOString(),
  };
}

describe('team challenge scoring', () => {
  it('counts approvals, rejections and open claims per side', () => {
    const c = challenge('relay', [task('A', 'approved', 1), task('A', 'rejected', 2), task('B', 'pending', 3)]);
    expect(sideScore(c, 'A')).toMatchObject({ approved: 1, rejected: 1, pending: 0, net: 0 });
    expect(sideScore(c, 'B')).toMatchObject({ approved: 0, rejected: 0, pending: 1, net: 0 });
  });

  it('pulls the tug marker toward the scoring team and away on a rejection', () => {
    const even = challenge('tug_of_war', []);
    expect(tugMarkerPct(even)).toBe(50);

    // Team A scores twice out of four: the marker travels halfway to A's end.
    const aLeads = challenge('tug_of_war', [task('A', 'approved', 1), task('A', 'approved', 2)]);
    expect(tugPull(aLeads)).toBe(2);
    expect(tugMarkerPct(aLeads)).toBe(25);

    // A missed goal hands ground back to the other side.
    const aMissed = challenge('tug_of_war', [task('A', 'approved', 1), task('A', 'rejected', 2)]);
    expect(tugPull(aMissed)).toBe(0);
    expect(tugMarkerPct(aMissed)).toBe(50);

    const bLeads = challenge('tug_of_war', [task('B', 'approved', 1), task('A', 'rejected', 2)]);
    expect(tugMarkerPct(bLeads)).toBe(75);
  });

  it('only advances a relay runner on approvals, never on stumbles', () => {
    const c = challenge('relay', [
      task('A', 'approved', 1),
      task('A', 'rejected', 2),
      task('A', 'rejected', 3),
    ]);
    expect(relayPct(c, 'A')).toBe(25);
    expect(relayPct(c, 'B')).toBe(0);
  });

  it('declares a winner at the target and hands a level game to nobody', () => {
    const relayWin = challenge('relay', [1, 2, 3, 4].map((n) => task('A', 'approved', n)));
    expect(outcomeOf(relayWin)).toBe('A');

    const tugWin = challenge('tug_of_war', [1, 2, 3, 4].map((n) => task('B', 'approved', n)));
    expect(outcomeOf(tugWin)).toBe('B');

    const running = challenge('relay', [task('A', 'approved', 1)]);
    expect(outcomeOf(running)).toBeNull();

    // At the deadline the lead decides it; dead level is a draw.
    const past = { ...running, deadlineAt: new Date(Date.now() - 1000).toISOString() };
    expect(outcomeOf(past)).toBe('A');
    expect(outcomeOf({ ...past, tasks: [] })).toBe('draw');
  });

  it('never starts until both sides are full and everyone has accepted', () => {
    const c = challenge('relay', []);
    expect(teamsBalanced(c)).toBe(true);
    expect(everyoneAccepted(c)).toBe(true);

    const oneWaiting: TeamChallenge = {
      ...c,
      members: c.members.map((m) => (m.id === 'jB' ? { ...m, inviteStatus: 'pending' as const } : m)),
    };
    expect(everyoneAccepted(oneWaiting)).toBe(false);

    const shortHanded: TeamChallenge = { ...c, members: c.members.filter((m) => m.id !== 'mB') };
    expect(teamsBalanced(shortHanded)).toBe(false);
    expect(everyoneAccepted(shortHanded)).toBe(false);
  });
});

/* ────────────────────────────────────────────────────── api behaviour ── */

async function person(name: string) {
  const email = `${name}_${Math.random().toString(36).slice(2)}@e.com`;
  return api.register(name, email, 'pw');
}

/** Four real accounts, all mutual follows (= friends) with the creator. */
async function cast() {
  const owner = await person('Owner');
  const rival = await person('Rival');
  const judgeA = await person('JudgeA');
  const judgeB = await person('JudgeB');
  for (const other of [rival, judgeA, judgeB]) {
    await api.toggleFollow(owner.id, other.id);
    await api.toggleFollow(other.id, owner.id);
  }
  return { owner, rival, judgeA, judgeB };
}

function input(c: Awaited<ReturnType<typeof cast>>, over: Record<string, unknown> = {}) {
  return {
    creatorUserId: c.owner.id,
    mode: 'relay' as TeamChallengeMode,
    name: 'Showdown',
    task: 'Do the thing',
    teamSize: 1,
    teamAName: 'Reds',
    teamBName: 'Blues',
    pointsToWin: 2,
    deadlineAt: future(),
    teamAPlayerIds: [] as string[],
    teamBPlayerIds: [c.rival.id],
    judgeAUserId: c.judgeA.id,
    judgeBUserId: c.judgeB.id,
    ...over,
  };
}

describe('team challenge api', () => {
  it('refuses unequal teams, strangers and double-booked people', async () => {
    const c = await cast();
    await expect(api.createTeamChallenge(input(c, { teamBPlayerIds: [] }))).rejects.toThrow(/exactly 1/);

    const stranger = await person('Stranger');
    await expect(
      api.createTeamChallenge(input(c, { teamBPlayerIds: [stranger.id] })),
    ).rejects.toThrow(/friends list/);

    await expect(
      api.createTeamChallenge(input(c, { judgeBUserId: c.rival.id })),
    ).rejects.toThrow(/one seat/);
  });

  it('waits for every invite before it starts, then scores through the judges', async () => {
    const c = await cast();
    const created = await api.createTeamChallenge(input(c));
    expect(created.status).toBe('pending_invites');

    // Nobody can play while an invite is outstanding.
    await expect(api.submitChallengeTask(created.id, c.owner.id)).rejects.toThrow(/not running/);

    await api.respondToChallengeInvite(created.id, c.rival.id, true);
    await api.respondToChallengeInvite(created.id, c.judgeA.id, true);
    const started = await api.respondToChallengeInvite(created.id, c.judgeB.id, true);
    expect(started.status).toBe('active');

    await api.submitChallengeTask(created.id, c.owner.id, 'done');
    const open = (await api.getTeamChallenge(created.id))!.tasks[0];

    // The other team's judge has no say over this claim.
    await expect(
      api.decideChallengeTask(created.id, open.id, c.judgeB.id, 'approved'),
    ).rejects.toThrow(/your own team/);

    const scored = await api.decideChallengeTask(created.id, open.id, c.judgeA.id, 'approved');
    expect(sideScore(scored, 'A').approved).toBe(1);
    expect(scored.status).toBe('active');

    // Second approval reaches the target and ends it.
    await api.submitChallengeTask(created.id, c.owner.id);
    const next = (await api.getTeamChallenge(created.id))!.tasks.find((t) => t.status === 'pending')!;
    const done = await api.decideChallengeTask(created.id, next.id, c.judgeA.id, 'approved');
    expect(done.status).toBe('finished');
    expect(done.winner).toBe('A');
  });

  it('calls the whole thing off when an invite is declined', async () => {
    const c = await cast();
    const created = await api.createTeamChallenge(input(c));
    const after = await api.respondToChallengeInvite(created.id, c.rival.id, false);
    expect(after.status).toBe('cancelled');
    expect(after.declinedByName).toBe('Rival');
  });
});
