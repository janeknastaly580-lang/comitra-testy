export const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Date + time of day, e.g. "Aug 4, 2026 · 10:14 AM". */
export const dateAndTime = (iso: string) => `${shortDate(iso)} · ${timeOfDay(iso)}`;

/** Just the hour and minute, e.g. "10:14 AM". */
export const timeOfDay = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

/**
 * Clock-style time left, e.g. "6d 23:11:05" or "04:12:59". Always includes
 * seconds, so a display that re-renders each second visibly ticks.
 */
export function countdownClock(deadlineIso: string, now = Date.now()): { label: string; overdue: boolean } {
  const ms = +new Date(deadlineIso) - now;
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  const secs = Math.floor((abs % 60_000) / 1000);
  const clock = `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  const core = days > 0 ? `${days}d ${clock}` : clock;
  return { label: overdue ? `${core} overdue` : `${core} left`, overdue };
}

/**
 * Human countdown until (or since) a deadline. Inside the last hour it counts
 * seconds too, so a ticking display visibly moves.
 */
export function countdown(deadlineIso: string, now = Date.now()): { label: string; overdue: boolean } {
  const ms = +new Date(deadlineIso) - now;
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  const secs = Math.floor((abs % 60_000) / 1000);
  let core: string;
  if (days > 0) core = `${days}d ${hours}h`;
  else if (hours > 0) core = `${hours}h ${mins}m`;
  else core = `${mins}m ${secs}s`;
  return { label: overdue ? `${core} overdue` : `${core} left`, overdue };
}

/** Datetime-local input value (local time, minute precision). */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
