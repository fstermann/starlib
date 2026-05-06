/** Session-scoped set of SoundCloud track ids we've discovered to be
 * unstreamable for this app's auth (403/404 from the public API). Lets the
 * library table render a clear "unavailable" indicator and disables play /
 * Detect buttons so the user doesn't keep retrying tracks SC will never
 * let us stream.
 *
 * Module-level store rather than a React context: writers (the player,
 * the pitcher's auto-detect, the per-row Detect cell, the batch button)
 * live in different parts of the tree from readers (the table title cell),
 * and a global sidesteps the provider plumbing. Cleared on full reload.
 */

import { useSyncExternalStore } from "react";

const _unplayable = new Set<number>();
const _listeners = new Set<() => void>();

function emit(): void {
  for (const l of _listeners) l();
}

/** Mark a SoundCloud track id unplayable for this session. */
export function markScUnplayable(trackId: number): void {
  if (!Number.isFinite(trackId) || trackId <= 0) return;
  if (_unplayable.has(trackId)) return;
  _unplayable.add(trackId);
  emit();
}

/** True if a track has been flagged unplayable this session. */
export function isScUnplayable(trackId: number): boolean {
  return _unplayable.has(trackId);
}

// Tests need to drive the unplayable state without setting up a real 403
// stream, so expose the writer on window. The set holds session-scoped
// boolean flags — no secrets — so this is harmless in production too.
if (typeof window !== "undefined") {
  (window as unknown as { __starlibScUnplayable?: unknown }).__starlibScUnplayable =
    { markScUnplayable, isScUnplayable };
}

/** React hook: re-renders the caller when the unplayable set changes. */
export function useIsScUnplayable(trackId: number | null | undefined): boolean {
  return useSyncExternalStore(
    (cb) => {
      _listeners.add(cb);
      return () => _listeners.delete(cb);
    },
    () => (trackId != null && _unplayable.has(trackId)) || false,
    () => false,
  );
}
