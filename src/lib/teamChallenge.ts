/**
 * Pure rules for team challenges — no storage, no React, no clock of its own.
 *
 * Everything the two boards draw (rope marker, runner distance) and everything
 * the api layer enforces (equal sides, "nobody starts until all accept", who
 * won) is derived here so it can be unit-tested on its own.
 *
 * Scoring, in one place:
 *   • an APPROVED goal is worth +1 to the scoring team;
 *   • a REJECTED goal costs that team 1 in Tug of war (the rope moves toward the
 *     opponents) and simply doesn't advance the runner in Relay.
 */
import type { ChallengeMember, TeamChallenge, TeamSide } from './types';

/** Rosters run from 1v1 to 8v8. Both sides always hold the same number. */
export const CHALLENGE_MIN_TEAM = 1;
export const CHALLENGE_MAX_TEAM = 8;

/** How many approved goals a side needs to win. */
export const CHALLENGE_MIN_POINTS = 1;
export const CHALLENGE_MAX_POINTS = 20;

export const OTHER_SIDE: Record<TeamSide, TeamSide> = { A: 'B', B: 'A' };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/* ─────────────────────────────────────────────────────────── rosters ── */

export function membersOf(c: TeamChallenge, side: TeamSide): ChallengeMember[] {
  return c.members.filter((m) => m.side === side);
}

export function playersOf(c: TeamChallenge, side: TeamSide): ChallengeMember[] {
  return c.members.filter((m) => m.side === side && m.role === 'player');
}

export function judgeOf(c: TeamChallenge, side: TeamSide): ChallengeMember | undefined {
  return c.members.find((m) => m.side === side && m.role === 'judge');
}

export function memberForUser(c: TeamChallenge, userId: string): ChallengeMember | undefined {
  return c.members.find((m) => m.userId === userId);
}

export function sideName(c: TeamChallenge, side: TeamSide): string {
  return side === 'A' ? c.teamAName : c.teamBName;
}

/** Both teams must field exactly `teamSize` players, and each needs one judge. */
export function teamsBalanced(c: TeamChallenge): boolean {
  return (
    playersOf(c, 'A').length === c.teamSize &&
    playersOf(c, 'B').length === c.teamSize &&
    !!judgeOf(c, 'A') &&
    !!judgeOf(c, 'B')
  );
}

/** Everyone who hasn't answered their invite yet — players and judges alike. */
export function pendingMembers(c: TeamChallenge): ChallengeMember[] {
  return c.members.filter((m) => m.inviteStatus === 'pending');
}

export function declinedMembers(c: TeamChallenge): ChallengeMember[] {
  return c.members.filter((m) => m.inviteStatus === 'declined');
}

/**
 * The start gate: every invited player AND both judges have pressed accept.
 * A challenge with an unbalanced roster can never be ready, whatever anyone
 * accepted.
 */
export function everyoneAccepted(c: TeamChallenge): boolean {
  return (
    teamsBalanced(c) &&
    c.members.length > 0 &&
    c.members.every((m) => m.inviteStatus === 'accepted')
  );
}

/* ──────────────────────────────────────────────────────────── scoring ── */

export interface SideScore {
  approved: number;
  rejected: number;
  /** Claims still waiting for that side's judge. */
  pending: number;
  /** approved − rejected. Only Tug of war spends this; Relay ignores it. */
  net: number;
}

export function sideScore(c: TeamChallenge, side: TeamSide): SideScore {
  let approved = 0;
  let rejected = 0;
  let pending = 0;
  for (const t of c.tasks) {
    if (t.side !== side) continue;
    if (t.status === 'approved') approved += 1;
    else if (t.status === 'rejected') rejected += 1;
    else pending += 1;
  }
  return { approved, rejected, pending, net: approved - rejected };
}

/**
 * Rope position as a signed number of pulls. Positive = team A is winning the
 * pull, negative = team B. A rejected goal counts against the team that missed
 * it, which is what makes the marker slide backwards.
 */
export function tugPull(c: TeamChallenge): number {
  return sideScore(c, 'A').net - sideScore(c, 'B').net;
}

/**
 * Where to draw the marker, as a percentage of the rope from the left edge.
 * 50 = dead centre, 0 = team A has pulled it all the way home (A sits on the
 * left of the board, B on the right).
 */
export function tugMarkerPct(c: TeamChallenge): number {
  const ratio = clamp(tugPull(c) / Math.max(1, c.pointsToWin), -1, 1);
  return 50 - ratio * 50;
}

/** How far along the track a relay team is, 0–100. Rejections don't advance it. */
export function relayPct(c: TeamChallenge, side: TeamSide): number {
  return clamp((sideScore(c, side).approved / Math.max(1, c.pointsToWin)) * 100, 0, 100);
}

/** Whichever side is ahead under this challenge's own rules — null if level. */
export function leaderOf(c: TeamChallenge): TeamSide | null {
  if (c.mode === 'tug_of_war') {
    const pull = tugPull(c);
    return pull === 0 ? null : pull > 0 ? 'A' : 'B';
  }
  const a = sideScore(c, 'A').approved;
  const b = sideScore(c, 'B').approved;
  return a === b ? null : a > b ? 'A' : 'B';
}

/** A side that has already hit the target, before the deadline matters. */
export function winnerByTarget(c: TeamChallenge): TeamSide | null {
  if (c.mode === 'tug_of_war') {
    const pull = tugPull(c);
    if (pull >= c.pointsToWin) return 'A';
    if (pull <= -c.pointsToWin) return 'B';
    return null;
  }
  if (sideScore(c, 'A').approved >= c.pointsToWin) return 'A';
  if (sideScore(c, 'B').approved >= c.pointsToWin) return 'B';
  return null;
}

export function isPastDeadline(c: TeamChallenge, now = Date.now()): boolean {
  return now >= +new Date(c.deadlineAt);
}

/**
 * The result, or `null` while the challenge is still live: a side wins by
 * reaching the target, otherwise the deadline hands it to whoever leads (level
 * scores at the deadline are a draw).
 */
export function outcomeOf(c: TeamChallenge, now = Date.now()): TeamSide | 'draw' | null {
  const target = winnerByTarget(c);
  if (target) return target;
  if (!isPastDeadline(c, now)) return null;
  return leaderOf(c) ?? 'draw';
}
