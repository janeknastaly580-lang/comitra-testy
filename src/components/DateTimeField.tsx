import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toLocalInputValue } from '../lib/format';

/**
 * A date + time field split into separate day / month / year / hour / minute
 * boxes.
 *
 * WHY NOT `<input type="datetime-local">`: clearing one segment of the native
 * control makes it report an EMPTY value for the whole field. Bound to React
 * state that wiped the entire date the moment you tried to fix just the hour.
 * Here each segment holds its own text, so backspace only ever clears the part
 * the user is actually in, and a half-finished edit survives re-renders.
 *
 * `value` / `onChange` keep the same `YYYY-MM-DDTHH:mm` local format the native
 * input used, so callers didn't have to change. While the value is incomplete or
 * impossible (31 February), `onChange` receives `''`, existing "pick a future
 * date" validation then rejects it exactly as before.
 */

interface Parts {
  d: string;
  m: string;
  y: string;
  h: string;
  min: string;
}

const EMPTY: Parts = { d: '', m: '', y: '', h: '', min: '' };

/** Segment order on screen, with the limits each one accepts. */
const SEGMENTS = [
  { key: 'd', label: 'Day', len: 2, max: 31, width: 'w-9' },
  { key: 'm', label: 'Month', len: 2, max: 12, width: 'w-9' },
  { key: 'y', label: 'Year', len: 4, max: 9999, width: 'w-14' },
  { key: 'h', label: 'Hour', len: 2, max: 23, width: 'w-9' },
  { key: 'min', label: 'Min', len: 2, max: 59, width: 'w-9' },
] as const;

type SegmentKey = (typeof SEGMENTS)[number]['key'];

function parse(value: string): Parts {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value ?? '');
  if (!m) return EMPTY;
  return { y: m[1], m: m[2], d: m[3], h: m[4], min: m[5] };
}

/** Build the ISO-ish local string, or '' when the parts don't form a real date. */
function combine(p: Parts): string {
  if (p.y.length !== 4 || !p.m || !p.d || !p.h || !p.min) return '';
  const y = Number(p.y);
  const mo = Number(p.m);
  const d = Number(p.d);
  const h = Number(p.h);
  const mi = Number(p.min);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59) return '';
  // Rejects 31 April / 29 February in a common year: the Date would roll over.
  const dt = new Date(y, mo - 1, d, h, mi);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
}

/**
 * The digits the user just typed, given the box's previous text and the text the
 * browser produced. Typing into an already-full box (caret parked in "2025",
 * pressing 2/0/2/6) used to keep the OLD digits and drop the new ones, so a year
 * came out mangled — "0202" and friends. Diffing tells us which digits are new
 * so we can restart the box with them instead.
 */
function insertedDigits(prev: string, next: string): string {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let end = 0;
  while (
    end < prev.length - start &&
    end < next.length - start &&
    prev[prev.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  return next.slice(start, next.length - end);
}

export default function DateTimeField({
  value,
  onChange,
  className = '',
  min = 'now',
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  /**
   * Earliest moment the field accepts. `'now'` (the default) means the current
   * clock time, re-read while the form is open so a page left sitting around
   * can't smuggle through a moment that has since passed. `null` disables the
   * check; a `YYYY-MM-DDTHH:mm` string pins a fixed floor.
   */
  min?: string | null;
}) {
  const [parts, setParts] = useState<Parts>(() => parse(value));
  const refs = useRef<Partial<Record<SegmentKey, HTMLInputElement | null>>>({});
  const nativeRef = useRef<HTMLInputElement>(null);

  // The app's own clock, ticking so "is this in the future?" stays honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (min !== 'now') return;
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [min]);

  const minTime = min === null ? null : min === 'now' ? now : new Date(min).getTime();

  // Adopt a value set from the outside (a "1 week" preset, a reset), but never
  // clobber a partially typed one: while editing, `combine` already equals the
  // value we last emitted, so this stays quiet.
  useEffect(() => {
    if (value !== combine(parts)) setParts(parse(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commit(next: Parts) {
    setParts(next);
    onChange(combine(next));
  }

  function focusSegment(index: number) {
    const seg = SEGMENTS[index];
    if (!seg) return;
    const el = refs.current[seg.key];
    el?.focus();
    el?.select();
  }

  function onSegmentInput(index: number, raw: string) {
    const seg = SEGMENTS[index];
    const prev = parts[seg.key];
    let digits = raw.replace(/\D/g, '');
    if (digits.length > seg.len) {
      // Overflowing means the user typed into a box that was already full: keep
      // what they just pressed and throw the stale digits away.
      const typed = insertedDigits(prev, digits);
      digits = (typed || digits).slice(0, seg.len);
    }
    commit({ ...parts, [seg.key]: digits });

    // Jump on when the box is full, or when another digit couldn't fit anyway
    // (typing "5" as the month can only mean May).
    const filled = digits.length === seg.len;
    const cannotGrow = digits.length > 0 && Number(digits) * 10 > seg.max;
    if (filled || cannotGrow) focusSegment(index + 1);
  }

  function onSegmentKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    const seg = SEGMENTS[index];
    const current = parts[seg.key];
    if (e.key === 'Backspace' && current === '') {
      // Already empty: step back rather than swallowing the keystroke, so a run
      // of backspaces walks left instead of clearing everything at once.
      e.preventDefault();
      focusSegment(index - 1);
    } else if (e.key === 'ArrowLeft' && (e.target as HTMLInputElement).selectionStart === 0) {
      e.preventDefault();
      focusSegment(index - 1);
    } else if (e.key === 'ArrowRight' && (e.target as HTMLInputElement).selectionEnd === current.length) {
      e.preventDefault();
      focusSegment(index + 1);
    }
  }

  /** Tidy a segment when leaving it: pad "5" → "05" and clamp out-of-range. */
  function onSegmentBlur(index: number) {
    const seg = SEGMENTS[index];
    const raw = parts[seg.key];
    if (!raw) return;

    if (seg.key === 'y') {
      // Never left-pad a year: that turned a half-typed "202" into the year 202.
      // Two digits are read as this century ("26" → 2026); anything else short
      // is left alone and flagged, so the user can just finish typing it.
      if (raw.length === 2) {
        const century = Math.floor(new Date(minTime ?? Date.now()).getFullYear() / 100) * 100;
        commit({ ...parts, y: String(century + Number(raw)) });
      }
      return;
    }

    let n = Number(raw);
    const min = seg.key === 'h' || seg.key === 'min' ? 0 : 1;
    n = Math.min(seg.max, Math.max(min, n));
    const padded = String(n).padStart(2, '0'); // the year returned above; the rest are 2-digit
    if (padded !== raw) commit({ ...parts, [seg.key]: padded });
  }

  /** The calendar button hands off to the platform's own picker. */
  function openNativePicker() {
    const el = nativeRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        /* not allowed here: fall through to a plain click */
      }
    }
    el.click();
  }

  const combined = combine(parts);
  const allFilled = SEGMENTS.every((s) => parts[s.key]);
  const inPast = combined !== '' && minTime !== null && new Date(combined).getTime() <= minTime;

  let problem = '';
  if (allFilled && combined === '') {
    problem = parts.y.length !== 4 ? 'Write the year in full, e.g. 2026.' : 'That date doesn’t exist.';
  } else if (inPast) {
    problem = 'That moment has already passed — pick a later one.';
  }
  const invalid = problem !== '';

  return (
    <div className={className}>
      <div
        className={`flex items-center gap-1 rounded-xl border bg-elevated px-3 py-2 transition focus-within:border-accent ${
          invalid ? 'border-danger' : 'border-line'
        }`}
      >
        {SEGMENTS.map((seg, i) => (
          <div key={seg.key} className="flex items-center gap-1">
            {/* Separators: day/month/year then a gap, hour:minute. */}
            {i === 1 && <span className="text-muted">/</span>}
            {i === 2 && <span className="text-muted">/</span>}
            {i === 3 && <span className="w-1" />}
            {i === 4 && <span className="text-muted">:</span>}
            <div className="text-center">
              <input
                ref={(el) => (refs.current[seg.key] = el)}
                value={parts[seg.key]}
                onChange={(e) => onSegmentInput(i, e.target.value)}
                onKeyDown={(e) => onSegmentKeyDown(i, e)}
                onBlur={() => onSegmentBlur(i)}
                onFocus={(e) => e.target.select()}
                inputMode="numeric"
                autoComplete="off"
                placeholder={seg.len === 4 ? 'YYYY' : seg.label === 'Month' ? 'MM' : seg.label === 'Day' ? 'DD' : seg.label === 'Hour' ? 'HH' : 'MM'}
                aria-label={seg.label}
                className={`${seg.width} bg-transparent text-center font-mono text-sm text-ink outline-none placeholder:text-muted/50`}
              />
              <p className="font-mono text-[8px] uppercase tracking-widest text-muted">{seg.label}</p>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={openNativePicker}
          aria-label="Open calendar"
          className="ml-auto shrink-0 rounded-lg p-1.5 text-muted transition hover:text-accent"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
          </svg>
        </button>

        {/* Off-screen, but still a real control so the OS picker works on mobile. */}
        <input
          ref={nativeRef}
          type="datetime-local"
          value={combined}
          // A minute past the floor: `min` on the native control is inclusive,
          // and the deadline has to be strictly later than now.
          min={minTime === null ? undefined : toLocalInputValue(new Date(minTime + 60_000))}
          onChange={(e) => {
            if (e.target.value) commit(parse(e.target.value));
          }}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute h-0 w-0 opacity-0"
        />
      </div>
      {invalid && <p className="mt-1 font-mono text-[11px] text-danger">{problem}</p>}
    </div>
  );
}
