import { useEffect, useState } from 'react';

/**
 * Re-render on a timer so time-based values (countdowns, elapsed-progress bars)
 * stay live instead of freezing at whatever they were when the screen mounted.
 * Returns the current epoch ms, so a component can use it as a dependency.
 *
 * The interval is cleared on unmount and while the tab is hidden the browser
 * throttles it on its own: no extra work needed.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
