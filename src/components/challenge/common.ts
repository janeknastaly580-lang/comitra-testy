import { useEffect, useRef, useState } from 'react';
import type { TeamSide } from '../../lib/types';

/**
 * Team colours. Both boards need two tellable-apart sides, so team A takes the
 * app's accent and team B the secondary "active" colour — both are defined by
 * every theme, so the boards stay on-palette without introducing any new colour.
 * Tailwind only sees literal class names, hence the spelled-out map.
 */
export const SIDE_STYLE: Record<
  TeamSide,
  { text: string; fill: string; softFill: string; border: string; tint: string }
> = {
  A: {
    text: 'text-accent',
    fill: 'bg-accent',
    softFill: 'bg-accent/20',
    border: 'border-accent',
    tint: 'bg-accent/10',
  },
  B: {
    text: 'text-active',
    fill: 'bg-active',
    softFill: 'bg-active/20',
    border: 'border-active',
    tint: 'bg-active/10',
  },
};

/**
 * Returns a counter that ticks whenever `key` changes — but never on the first
 * render. Used as a React `key` on an animated node so a CSS animation replays
 * on each new judge decision instead of only running once on mount.
 */
export function useChangeTick(key: string | number | undefined): number {
  const previous = useRef(key);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    setTick((t) => t + 1);
  }, [key]);
  return tick;
}
