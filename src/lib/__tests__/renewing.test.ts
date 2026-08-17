import { beforeEach, describe, expect, it } from 'vitest';
import * as api from '../api';
import {
  EVERYDAY,
  bestStreak,
  dayKey,
  history,
  isEveryday,
  scheduleLabel,
  streak,
  todayStatus,
  totals,
} from '../renewing';
import type { RenewingEntryStatus, RenewingGoal, Weekday } from '../types';

/**
 * Renewing goals: the streak is the product, so these tests are mostly about the
 * one thing that could quietly make it a lie — a day that was never marked.
 *
 * If silence counted as neutral, the way to keep a perfect streak would be to
 * stop opening the app, which is the opposite of what the feature is for. So a
 * past due day with no entry has to break the run, while TODAY must not: an
 * unfinished morning is not a failure yet.
 */

beforeEach(() => {
  localStorage.clear();
});

/** Midnight local, N days before `from`. Local on purpose — see renewing.ts. */
function daysAgo(n: number, from = new Date()): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() - n);
  return d;
}

function goalWith(
  days: Weekday[],
  startedDaysAgo: number,
  marks: Array<[number, RenewingEntryStatus]> = [],
): RenewingGoal {
  const now = new Date().toISOString();
  return {
    id: 'renew_test',
    userId: 'user_1',
    title: 'Run',
    days,
    startedAt: daysAgo(startedDaysAgo).toISOString(),
    entries: marks.map(([ago, status]) => ({ date: dayKey(daysAgo(ago)), status, at: now })),
    createdAt: now,
    updatedAt: now,
  };
}

describe('the schedule', () => {
  it('treats all seven days as "every day", however they were picked', () => {
    expect(isEveryday(EVERYDAY)).toBe(true);
    // Chosen one at a time, in a jumbled order: still every day.
    expect(isEveryday([3, 1, 0, 6, 4, 2, 5])).toBe(true);
    expect(isEveryday([1, 2, 3, 4, 5])).toBe(false);
    expect(scheduleLabel(EVERYDAY)).toBe('Every day');
    expect(scheduleLabel([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(scheduleLabel([0, 6])).toBe('Weekends');
  });

  it('only asks on the days that were picked', () => {
    const today = new Date();
    const dueToday = today.getDay() as Weekday;
    const notToday = ((dueToday + 1) % 7) as Weekday;

    expect(todayStatus(goalWith([dueToday], 10))).toBe('pending');
    // Not due today at all — there is nothing to mark, which is not the same as
    // an unmarked day.
    expect(todayStatus(goalWith([notToday], 10))).toBe(null);
  });
});

describe('the streak', () => {
  it('counts consecutive completed days', () => {
    const goal = goalWith(EVERYDAY, 3, [
      [1, 'completed'],
      [2, 'completed'],
      [3, 'completed'],
    ]);
    expect(streak(goal)).toBe(3);
  });

  it('does not break just because today has not been marked yet', () => {
    const goal = goalWith(EVERYDAY, 2, [
      [1, 'completed'],
      [2, 'completed'],
    ]);
    // Today is due and pending. The run behind it still stands.
    expect(todayStatus(goal)).toBe('pending');
    expect(streak(goal)).toBe(2);
  });

  it('breaks on a day that was never marked at all', () => {
    // Three days ago was completed, two days ago was simply never opened.
    const goal = goalWith(EVERYDAY, 3, [
      [1, 'completed'],
      [3, 'completed'],
    ]);
    expect(streak(goal)).toBe(1);
    expect(totals(goal).missed).toBe(1);
  });

  it('breaks on an explicit failure', () => {
    const goal = goalWith(EVERYDAY, 3, [
      [1, 'completed'],
      [2, 'failed'],
      [3, 'completed'],
    ]);
    expect(streak(goal)).toBe(1);
  });

  it('skips the days the goal is not due on', () => {
    const today = new Date();
    const due = today.getDay() as Weekday;
    // Due once a week. Last week's and the week before's were both kept, and the
    // six days in between are not misses — nothing was ever asked of them.
    const goal = goalWith([due], 21, [
      [7, 'completed'],
      [14, 'completed'],
      [21, 'completed'],
    ]);
    expect(streak(goal)).toBe(3);
    expect(totals(goal).missed).toBe(0);
  });

  it('remembers the best run after it is broken', () => {
    const goal = goalWith(EVERYDAY, 5, [
      [1, 'completed'],
      [2, 'failed'],
      [3, 'completed'],
      [4, 'completed'],
      [5, 'completed'],
    ]);
    expect(streak(goal)).toBe(1);
    expect(bestStreak(goal)).toBe(3);
  });

  it('does not count days from before the goal existed', () => {
    const goal = goalWith(EVERYDAY, 2);
    // Started two days ago: three due days (then, yesterday, today), not a
    // lifetime of misses.
    expect(history(goal)).toHaveLength(3);
  });
});

describe('marking days', () => {
  it('records today and starts a streak', async () => {
    const goal = await api.createRenewingGoal({ userId: 'user_1', title: 'Run', days: EVERYDAY });
    expect(streak(goal)).toBe(0);

    const marked = await api.markRenewingDay(goal.id, 'user_1', 'completed');
    expect(streak(marked)).toBe(1);
    expect(todayStatus(marked)).toBe('completed');
  });

  it('refuses a day that has not happened yet', async () => {
    const goal = await api.createRenewingGoal({ userId: 'user_1', title: 'Run', days: EVERYDAY });
    const tomorrow = dayKey(daysAgo(-1));
    await expect(api.markRenewingDay(goal.id, 'user_1', 'completed', tomorrow)).rejects.toThrow(
      /hasn't happened yet/i,
    );
  });

  it('refuses a day the goal is not due on', async () => {
    const today = new Date();
    const notToday = (((today.getDay() as number) + 1) % 7) as Weekday;
    const goal = await api.createRenewingGoal({ userId: 'user_1', title: 'Run', days: [notToday] });
    await expect(api.markRenewingDay(goal.id, 'user_1', 'completed')).rejects.toThrow(/isn't due/i);
  });

  it('replaces a mark rather than stacking two for one day', async () => {
    const goal = await api.createRenewingGoal({ userId: 'user_1', title: 'Run', days: EVERYDAY });
    await api.markRenewingDay(goal.id, 'user_1', 'completed');
    const fixed = await api.markRenewingDay(goal.id, 'user_1', 'failed');
    expect(fixed.entries).toHaveLength(1);
    expect(todayStatus(fixed)).toBe('failed');
  });

  it('lets a wrong tap be cleared', async () => {
    const goal = await api.createRenewingGoal({ userId: 'user_1', title: 'Run', days: EVERYDAY });
    await api.markRenewingDay(goal.id, 'user_1', 'failed');
    const cleared = await api.clearRenewingDay(goal.id, 'user_1', dayKey(new Date()));
    expect(cleared.entries).toHaveLength(0);
    expect(todayStatus(cleared)).toBe('pending');
  });

  it('will not touch somebody else‘s goal', async () => {
    const goal = await api.createRenewingGoal({ userId: 'user_1', title: 'Run', days: EVERYDAY });
    await expect(api.markRenewingDay(goal.id, 'someone_else', 'completed')).rejects.toThrow(
      /belongs to someone else/i,
    );
  });
});

describe('retiring', () => {
  it('keeps the history and stops asking', async () => {
    const goal = await api.createRenewingGoal({ userId: 'user_1', title: 'Run', days: EVERYDAY });
    await api.markRenewingDay(goal.id, 'user_1', 'completed');
    const retired = await api.archiveRenewingGoal(goal.id, 'user_1');

    expect(retired.archivedAt).toBeTruthy();
    expect(retired.entries).toHaveLength(1);
    // Restarting does not hold the gap against you: history begins again today.
    const resumed = await api.resumeRenewingGoal(goal.id, 'user_1');
    expect(resumed.archivedAt).toBeUndefined();
    expect(history(resumed)).toHaveLength(1);
  });

  it('needs at least one day of the week', async () => {
    await expect(
      api.createRenewingGoal({ userId: 'user_1', title: 'Run', days: [] }),
    ).rejects.toThrow(/at least one day/i);
  });
});
