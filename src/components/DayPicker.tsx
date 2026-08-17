import { DAY_LETTER, DAY_SHORT, EVERYDAY, WEEK_ORDER, isEveryday } from '../lib/renewing';
import type { Weekday } from '../lib/types';

/**
 * The seven-day schedule picker.
 *
 * `Everyday` is a shortcut, not a mode: it selects all seven days and lights up
 * when all seven happen to be selected, however they got that way. So a person
 * who taps six days and then the seventh sees the same "Every day" state as one
 * who pressed the button — there is no hidden flag that makes two identical
 * schedules behave differently later.
 */
export default function DayPicker({
  value,
  onChange,
  disabled,
}: {
  value: Weekday[];
  onChange: (next: Weekday[]) => void;
  disabled?: boolean;
}) {
  const all = isEveryday(value);

  function toggle(day: Weekday) {
    onChange(value.includes(day) ? value.filter((d) => d !== day) : [...value, day].sort((a, b) => a - b));
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-widest text-muted">Days</p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(all ? [] : [...EVERYDAY])}
          className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition ${
            all ? 'bg-accent text-on-accent' : 'bg-elevated text-muted hover:text-ink'
          } disabled:opacity-50`}
        >
          Everyday
        </button>
      </div>

      <div className="flex gap-1.5">
        {WEEK_ORDER.map((day) => {
          const on = value.includes(day);
          return (
            <button
              key={day}
              type="button"
              disabled={disabled}
              onClick={() => toggle(day)}
              // The full name is what a screen reader gets; the circle only has room for a letter.
              aria-label={DAY_SHORT[day]}
              aria-pressed={on}
              className={`flex h-11 flex-1 items-center justify-center rounded-xl border text-sm font-semibold transition disabled:opacity-50 ${
                on
                  ? 'border-accent bg-accent text-on-accent shadow-glow'
                  : 'border-line bg-surface text-muted hover:border-accent/40 hover:text-ink'
              }`}
            >
              {DAY_LETTER[day]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
