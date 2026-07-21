/**
 * Comitra Analytics — a pure, deterministic statistics engine.
 *
 * Every number is derived from the user's own goal history (the mock
 * LocalStorage DB) with plain JavaScript. No AI, no randomness, no network, and
 * NO money — there are no stakes, deposits or rewards in this app.
 */
import type { Goal } from './types';

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const HOUR_BUCKET_STARTS = [0, 3, 6, 9, 12, 15, 18, 21];

export interface HourBucket {
  start: number;
  end: number;
  label: string;
  count: number;
}

const HOURS = 3_600_000;

const hourLabel = (start: number, end: number) =>
  `${String(start).padStart(2, '0')}:00–${String(end % 24 === 0 ? 24 : end % 24).padStart(2, '0')}:00`;

function emptyHourBuckets(): HourBucket[] {
  return HOUR_BUCKET_STARTS.map((start) => ({ start, end: start + 3, label: hourLabel(start, start + 3), count: 0 }));
}

function bucketIndexForHour(hour: number): number {
  return Math.min(HOUR_BUCKET_STARTS.length - 1, Math.floor(hour / 3));
}

export function formatSpan(ms: number): string {
  const abs = Math.abs(ms);
  const totalMin = Math.round(abs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

const deadlineOf = (g: Goal) => g.deadlineAt ?? g.deadline ?? g.createdAt;
const isCompleted = (g: Goal) => g.status === 'completed';
const isFailed = (g: Goal) => g.status === 'failed_notified';
const isResolved = (g: Goal) => isCompleted(g) || isFailed(g);
const completedAtOf = (g: Goal) => g.completedAt ?? g.judge?.decisionAt;

// ─────────────────────────────────────────────── 1. Motivation Peak ──────────

export interface MotivationSection {
  completions: number;
  weekdayCounts: number[];
  hourBuckets: HourBucket[];
  peakWeekday: number | null;
  peakHour: HourBucket | null;
  peakLabel: string | null;
  avgLeadMs: number | null;
  avgLeadLabel: string | null;
  risk: 'high' | 'moderate' | 'low' | null;
}

function buildMotivation(goals: Goal[]): MotivationSection {
  const done = goals.filter((g) => isCompleted(g) && !!completedAtOf(g));
  const weekdayCounts = Array(7).fill(0) as number[];
  const hourBuckets = emptyHourBuckets();
  let leadSum = 0;
  let leadCount = 0;

  for (const g of done) {
    const at = new Date(completedAtOf(g)!);
    weekdayCounts[at.getDay()]++;
    hourBuckets[bucketIndexForHour(at.getHours())].count++;
    const lead = +new Date(deadlineOf(g)) - +at;
    if (Number.isFinite(lead)) {
      leadSum += lead;
      leadCount++;
    }
  }

  const peakWeekday = done.length > 0 ? weekdayCounts.indexOf(Math.max(...weekdayCounts)) : null;
  const peakHour = done.length > 0 ? hourBuckets.reduce((best, b) => (b.count > best.count ? b : best), hourBuckets[0]) : null;
  const peakLabel = peakWeekday != null && peakHour && peakHour.count > 0 ? `${WEEKDAYS[peakWeekday]}s, ${peakHour.label}` : null;

  const avgLeadMs = leadCount ? leadSum / leadCount : null;
  let risk: MotivationSection['risk'] = null;
  if (avgLeadMs != null) {
    if (avgLeadMs < 1 * HOURS) risk = 'high';
    else if (avgLeadMs < 6 * HOURS) risk = 'moderate';
    else risk = 'low';
  }

  return {
    completions: done.length,
    weekdayCounts,
    hourBuckets,
    peakWeekday,
    peakHour,
    peakLabel,
    avgLeadMs,
    avgLeadLabel: avgLeadMs != null ? formatSpan(avgLeadMs) : null,
    risk,
  };
}

// ───────────────────────────────────────── 2. Judge Trust Score ─────────────

export interface JudgeStat {
  name: string;
  verdicts: number;
  approvals: number;
  rejections: number;
  approvalRate: number;
  avgDecisionMs: number;
  isFriend: boolean;
}

export interface SocialSection {
  judges: JudgeStat[];
  strictest: JudgeStat | null;
  mostLenient: JudgeStat | null;
  cohort: { friendRate: number; friendCount: number; strangerRate: number; strangerCount: number; delta: number } | null;
}

function buildSocial(goals: Goal[], friendNames: Set<string>): SocialSection {
  const judged = goals.filter((g) => isResolved(g) && (g.judge?.decision === 'completed' || g.judge?.decision === 'not_completed'));
  const map = new Map<string, JudgeStat>();
  for (const g of judged) {
    const name = (g.judge?.name || 'Judge').trim();
    const key = name.toLowerCase();
    const decision = g.judge?.decision;
    const decidedAt = g.judge?.decisionAt ?? completedAtOf(g) ?? g.failedAt;
    const span = decidedAt ? +new Date(decidedAt) - +new Date(g.createdAt) : 0;
    const j =
      map.get(key) ??
      ({ name, verdicts: 0, approvals: 0, rejections: 0, approvalRate: 0, avgDecisionMs: 0, isFriend: friendNames.has(key) } as JudgeStat);
    j.verdicts++;
    if (decision === 'completed') j.approvals++;
    else if (decision === 'not_completed') j.rejections++;
    j.avgDecisionMs += Math.max(0, span);
    map.set(key, j);
  }

  const judges = [...map.values()].map((j) => ({
    ...j,
    approvalRate: j.verdicts ? j.approvals / j.verdicts : 0,
    avgDecisionMs: j.verdicts ? j.avgDecisionMs / j.verdicts : 0,
  }));

  const strictest = judges.length ? [...judges].sort((a, b) => b.rejections / b.verdicts - a.rejections / a.verdicts || a.avgDecisionMs - b.avgDecisionMs)[0] : null;
  const mostLenient = judges.length ? [...judges].sort((a, b) => b.approvalRate - a.approvalRate || b.avgDecisionMs - a.avgDecisionMs)[0] : null;

  let friendWon = 0, friendTotal = 0, strangerWon = 0, strangerTotal = 0;
  for (const g of goals) {
    if (!isResolved(g)) continue;
    const key = (g.judge?.name || '').trim().toLowerCase();
    const won = isCompleted(g) ? 1 : 0;
    if (friendNames.has(key)) { friendTotal++; friendWon += won; } else { strangerTotal++; strangerWon += won; }
  }
  const cohort =
    friendTotal > 0 && strangerTotal > 0
      ? { friendRate: friendWon / friendTotal, friendCount: friendTotal, strangerRate: strangerWon / strangerTotal, strangerCount: strangerTotal, delta: friendWon / friendTotal - strangerWon / strangerTotal }
      : null;

  return { judges, strictest, mostLenient, cohort };
}

// ────────────────────────────────────────── 3. Vulnerability Radar ───────────

export interface WeekdayStat {
  day: number;
  total: number;
  won: number;
  rate: number;
}

export interface VulnerabilitySection {
  events: number;
  weekdayEvents: number[];
  hourBuckets: HourBucket[];
  worstMoment: string | null;
  weekdayRates: WeekdayStat[];
  overallRate: number;
  weakestDay: { day: number; rate: number; dropPct: number } | null;
}

function buildVulnerability(goals: Goal[]): VulnerabilitySection {
  const crises = goals.filter((g) => isFailed(g));
  const weekdayEvents = Array(7).fill(0) as number[];
  const hourBuckets = emptyHourBuckets();
  for (const g of crises) {
    const at = new Date(g.failedAt ?? deadlineOf(g));
    weekdayEvents[at.getDay()]++;
    hourBuckets[bucketIndexForHour(at.getHours())].count++;
  }
  const peakDay = crises.length ? weekdayEvents.indexOf(Math.max(...weekdayEvents)) : null;
  const peakHour = crises.length ? hourBuckets.reduce((best, b) => (b.count > best.count ? b : best), hourBuckets[0]) : null;
  const worstMoment = peakDay != null && peakHour && peakHour.count > 0 ? `${WEEKDAYS[peakDay]}s, ${peakHour.label}` : null;

  const resolved = goals.filter(isResolved);
  const weekdayRates: WeekdayStat[] = Array.from({ length: 7 }, (_, day) => {
    const onDay = resolved.filter((g) => new Date(deadlineOf(g)).getDay() === day);
    const won = onDay.filter(isCompleted).length;
    return { day, total: onDay.length, won, rate: onDay.length ? won / onDay.length : 0 };
  });
  const overallRate = resolved.length ? resolved.filter(isCompleted).length / resolved.length : 0;

  const played = weekdayRates.filter((d) => d.total > 0);
  const weakest = played.length ? [...played].sort((a, b) => a.rate - b.rate)[0] : null;
  const weakestDay = weakest && overallRate > 0 ? { day: weakest.day, rate: weakest.rate, dropPct: Math.max(0, Math.round((1 - weakest.rate / overallRate) * 100)) } : null;

  return { events: crises.length, weekdayEvents, hourBuckets, worstMoment, weekdayRates, overallRate, weakestDay };
}

// ─────────────────────────────────────────────────── Top-level ───────────────

export interface Analysis {
  generatedAt: string;
  totalGoals: number;
  resolved: number;
  winRate: number;
  motivation: MotivationSection;
  social: SocialSection;
  vulnerability: VulnerabilitySection;
}

export function analyze(goals: Goal[], friendNames: string[] = []): Analysis {
  const friends = new Set(friendNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const resolved = goals.filter(isResolved);
  const won = resolved.filter(isCompleted).length;
  return {
    generatedAt: new Date().toISOString(),
    totalGoals: goals.length,
    resolved: resolved.length,
    winRate: resolved.length ? Math.round((won / resolved.length) * 100) : 0,
    motivation: buildMotivation(goals),
    social: buildSocial(goals, friends),
    vulnerability: buildVulnerability(goals),
  };
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Render the full analysis as a printable plain-text Comitra report. */
export function buildReport(name: string, a: Analysis): string {
  const line = '═'.repeat(54);
  const sub = '─'.repeat(54);
  const L: string[] = [];
  const push = (...xs: string[]) => L.push(...xs);

  push(line);
  push('  COMITRA — GOAL ACCOUNTABILITY ANALYTICS');
  push(line);
  push(`  Member    : ${name}`);
  push(`  Generated : ${new Date(a.generatedAt).toLocaleString('en-US')}`);
  push('');
  push('  OVERVIEW');
  push(`  - Total goals    : ${a.totalGoals}`);
  push(`  - Resolved       : ${a.resolved}`);
  push(`  - Completion rate: ${a.winRate}%`);
  push('');

  push(sub);
  push('  1. MOTIVATION PEAK');
  push(sub);
  const m = a.motivation;
  if (m.completions === 0) {
    push('  Not enough completed goals yet.');
  } else {
    push(`  Completed goals analysed : ${m.completions}`);
    push(`  Motivation peak          : ${m.peakLabel ?? 'n/a'}`);
    push(`  Avg. finish before due   : ${m.avgLeadLabel ?? 'n/a'}`);
  }
  push('');

  push(sub);
  push('  2. JUDGE TRUST SCORE');
  push(sub);
  const s = a.social;
  if (s.judges.length === 0) push('  No judged decisions yet.');
  else {
    if (s.strictest) push(`  Strictest judge    : ${s.strictest.name} — ${pct(1 - s.strictest.approvalRate)} rejections`);
    if (s.mostLenient) push(`  Most lenient judge : ${s.mostLenient.name} — ${pct(s.mostLenient.approvalRate)} approvals`);
  }
  push('');

  push(sub);
  push('  3. VULNERABILITY RADAR');
  push(sub);
  const v = a.vulnerability;
  push(`  Missed goals : ${v.events}`);
  if (v.worstMoment) push(`  Most vulnerable window : ${v.worstMoment}`);
  if (v.weakestDay) push(`  Weakest weekday        : ${WEEKDAYS[v.weakestDay.day]} — completion drops ~${v.weakestDay.dropPct}%.`);
  push('');
  push(line);
  push('  Generated by Comitra · deterministic, proof-backed analytics');
  push(line);
  return L.join('\n');
}
