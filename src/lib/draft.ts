/**
 * Half-finished forms, kept across navigation.
 *
 * Every screen unmounts the moment you switch tab, so without this a goal you
 * were halfway through typing is gone by the time you come back — and the app
 * asks people to write things (a goal, two answers about a miss) that are
 * genuinely annoying to write twice.
 *
 * Drafts live OUTSIDE `src/lib/storage.ts` on purpose. That module's prefix is
 * what the sync engine enumerates into the account document, so a draft written
 * through it would be pushed to the server on every keystroke and turn up on the
 * user's other devices. A form you have not submitted is device-local scratch,
 * and it stays that way: nothing here is ever synced, and `clearDraft` is the
 * only thing that outlives the screen.
 */
import { useEffect, useRef } from 'react';

const PREFIX = 'comitra:draft:';

/** Everything saved for one form. Callers own the shape; this file never reads it. */
export type Draft = object;

/**
 * What was typed last time, or `{}`. Meant for `useState` initialisers, so a
 * restored field is the component's first value rather than a later overwrite
 * that would fight with anything the user typed in between.
 */
export function loadDraft<T extends Draft>(key: string): Partial<T> {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveDraft<T extends Draft>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // A full quota must never break typing. The draft is a convenience.
  }
}

/** Forget a draft: the form was submitted, or deliberately thrown away. */
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing to do: an unremovable draft is harmless.
  }
}

/** Drop every draft on this device. Used when an account signs out. */
export function clearAllDrafts(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    // No LocalStorage at all. Nothing was stored either.
  }
}

/**
 * Keep `value` saved under `key` for as long as the form is on screen.
 *
 * Nothing is written until the form actually changes. Opening a screen and
 * leaving it alone must not create a draft of its own defaults — that would
 * write on every visit, and would put an empty draft straight back after a
 * submitted form cleared its own.
 *
 * Pass `enabled: false` for a form that is closed or already submitted.
 */
export function useDraft<T extends Draft>(key: string, value: T, enabled = true): void {
  // Serialise in the dependency so the effect fires on a real change of content,
  // not on every render (the object literal callers pass is new each time).
  const json = JSON.stringify(value);
  const pristine = useRef(json);
  const touched = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (!touched.current) {
      if (json === pristine.current) return; // Untouched form: nothing to save.
      touched.current = true;
    }
    try {
      localStorage.setItem(PREFIX + key, json);
    } catch {
      // See saveDraft.
    }
  }, [key, json, enabled]);
}
