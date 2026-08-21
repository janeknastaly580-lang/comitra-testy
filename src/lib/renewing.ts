/**
 * Renewing goals: the same commitment, due again every week on the days you pick.
 *
 * The difference from an ordinary Pactista goal is what "done" means. A normal
 * goal is one deadline that either arrives kept or missed, and then it is over.
 * A renewing goal is never over — it asks the same thing every Monday, or every
 * day, and what you get back is a record of how often you actually did it.
 *
 * WHY THE WEEKDAYS ARE THE WHOLE MODEL. There is no separate "everyday" mode:
 * every day IS all seven weekdays selected. One representation means the streak
 * maths, the history and the UI never have to ask which kind of goal this is —
 * and someone who picks all seven by hand gets exactly what the Everyday button
 * gives them, instead of a subtly different object.
 *
 * DATES ARE LOCAL, DELIBERATELY. A habit belongs to the person's day, not to
 * UTC: someone in Warsaw marking Monday's run at 23:30 must not have it filed as
 * Tuesday. Everything here keys off `YYYY-MM-DD` built from local time.
 *
 * WHAT COUNTS AGAINST YOU. A due day in the past that was never marked is
 * `missed`, and it breaks the streak exactly like a failure. That is the only
 * honest reading — if silence were neutral, the way to keep a perfect streak
 * would be to stop opening the app. Today is the exception: while it is still
 * today the day is `pending`, so an unfinished morning never breaks anything.
 */

import type { RenewingEntry, RenewingGoal, Weekday } from './types';

/** Sunday-based, matching `Date.prototype.getDay()` so no conversion is needed. */
export const EVERYDAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * Monday first — the order the days are shown in.
 *
 * Separate from the storage order on purpose: `getDay()` is Sunday-based and
 * changing that would mean converting on every comparison, but a week that
 * starts on Sunday reads wrong to most of the people this app is for.
 */
export const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

export const DAY_SHORT: Record<Weekday, string> = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
};

/** One letter for the compact week strip. Two for Thursday/Sunday would collide. */
export const DAY_LETTER: Record<Weekday, string> = {
  0: 'S',
  1: 'M',
  2: 'T',
  3: 'W',
  4: 'T',
  5: 'F',
  6: 'S',
};

/** How far back the history walk will ever go, so a bad date cannot hang a render. */
const MAX_HISTORY_DAYS = 1100;

/* ─────────────────────────────────────────────────────────────────── dates ── */

/** `YYYY-MM-DD` in LOCAL time. `toISOString()` would shift the day for anyone east or west of UTC. */
export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Midnight local on the day a key names. */
export function fromDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, delta: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + delta);
  return out;
}

/* ──────────────────────────────────────────────────────────────── schedule ── */

export function isEveryday(days: readonly Weekday[]): boolean {
  return EVERYDAY.every((d) => days.includes(d));
}

/** How the schedule is described in one short line. */
export function scheduleLabel(days: readonly Weekday[]): string {
  if (days.length === 0) return 'No days picked';
  if (isEveryday(days)) return 'Every day';
  const ordered = WEEK_ORDER.filter((d) => days.includes(d));
  // Weekdays and weekends are common enough to be worth naming rather than listing.
  if (ordered.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d as Weekday))) return 'Weekdays';
  if (ordered.length === 2 && days.includes(6) && days.includes(0)) return 'Weekends';
  return ordered.map((d) => DAY_SHORT[d]).join(' · ');
}

export function isDueOn(days: readonly Weekday[], date: Date): boolean {
  return days.includes(date.getDay() as Weekday);
}

/** Is the goal asking for anything today? */
export function isDueToday(goal: RenewingGoal, now = new Date()): boolean {
  return !goal.archivedAt && isDueOn(goal.days, now);
}

/* ───────────────────────────────────────────────────────────────── history ── */

export type DayStatus = 'completed' | 'failed' | 'missed' | 'pending';

export interface HistoryRow {
  /** `YYYY-MM-DD`, local. */
  date: string;
  weekday: Weekday;
  status: DayStatus;
  /** When it was marked, for the ones that were. */
  at?: string;
}

function entryMap(goal: RenewingGoal): Map<string, RenewingEntry> {
  return new Map((goal.entries ?? []).map((e) => [e.date, e]));
}

/**
 * Every due day from the goal's start up to today, newest first.
 *
 * Bounded by MAX_HISTORY_DAYS: the start date comes from stored data, and a
 * corrupted one must not turn a render into an infinite walk.
 */
export function history(goal: RenewingGoal, now = new Date()): HistoryRow[] {
  const entries = entryMap(goal);
  const today = startOfDay(now);
  const todayKey = dayKey(today);
  const started = startOfDay(new Date(goal.startedAt ?? goal.createdAt));
  // An archived goal stops asking for anything after the day it was archived.
  const end = goal.archivedAt ? startOfDay(new Date(goal.archivedAt)) : today;
  const last = end < today ? end : today;

  const out: HistoryRow[] = [];
  let cursor = last;
  for (let i = 0; i < MAX_HISTORY_DAYS && cursor >= started; i++) {
    if (isDueOn(goal.days, cursor)) {
      const key = dayKey(cursor);
      const entry = entries.get(key);
      out.push({
        date: key,
        weekday: cursor.getDay() as Weekday,
        status: entry ? entry.status : key === todayKey ? 'pending' : 'missed',
        at: entry?.at,
      });
    }
    cursor = addDays(cursor, -1);
  }
  return out;
}

/**
 * The run of due days completed without a break, counting back from the most
 * recent one that has actually been decided.
 *
 * Today is skipped while it is still `pending` rather than treated as a break:
 * a streak should not appear to collapse every morning and come back every
 * evening.
 */
export function streak(goal: RenewingGoal, now = new Date()): number {
  let count = 0;
  for (const row of history(goal, now)) {
    if (row.status === 'pending') continue;
    if (row.status !== 'completed') break;
    count++;
  }
  return count;
}

/** The longest run ever achieved, so a broken streak still shows what it was. */
export function bestStreak(goal: RenewingGoal, now = new Date()): number {
  let best = 0;
  let run = 0;
  // Oldest first, so a run is counted forwards.
  for (const row of [...history(goal, now)].reverse()) {
    if (row.status === 'pending') continue;
    if (row.status === 'completed') {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

export interface RenewingTotals {
  completed: number;
  failed: number;
  missed: number;
  /** Due days that have been decided one way or the other. */
  decided: number;
  /** Completed as a percentage of decided days, or null before anything is decided. */
  rate: number | null;
}

export function totals(goal: RenewingGoal, now = new Date()): RenewingTotals {
  let completed = 0;
  let failed = 0;
  let missed = 0;
  for (const row of history(goal, now)) {
    if (row.status === 'completed') completed++;
    else if (row.status === 'failed') failed++;
    else if (row.status === 'missed') missed++;
  }
  const decided = completed + failed + missed;
  return { completed, failed, missed, decided, rate: decided ? Math.round((completed / decided) * 100) : null };
}

/** What today is currently marked as, if anything. */
export function todayStatus(goal: RenewingGoal, now = new Date()): DayStatus | null {
  if (!isDueOn(goal.days, now)) return null;
  const entry = entryMap(goal).get(dayKey(now));
  return entry ? entry.status : 'pending';
}

/* ─────────────────────────────────────────────────────────────── formatting ── */

/** `Mon, 17 Aug` — long enough to place, short enough for a narrow phone row. */
export function formatDay(key: string): string {
  const date = fromDayKey(key);
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** `August 2026`, for the month headings the history is grouped under. */
export function formatMonth(key: string): string {
  return fromDayKey(key).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** History split into month blocks, newest first, so a long record stays readable. */
export function byMonth(rows: HistoryRow[]): { month: string; rows: HistoryRow[] }[] {
  const out: { month: string; rows: HistoryRow[] }[] = [];
  for (const row of rows) {
    const month = formatMonth(row.date);
    const last = out[out.length - 1];
    if (last && last.month === month) last.rows.push(row);
    else out.push({ month, rows: [row] });
  }
  return out;
}
