"use client";

import { useEffect, useState } from "react";

import { getSetting, setSetting, type KeyNotation } from "@/lib/settings";

/** Dispatched on `window` when the key notation changes, for live sync
 * across the settings dialog and every mounted key cell. */
export const KEY_NOTATION_EVENT = "key-notation-changed";

/** Persist a new key notation and notify listeners in the same tab. */
export async function saveKeyNotation(notation: KeyNotation): Promise<void> {
  await setSetting("keyNotation", notation);
  window.dispatchEvent(
    new CustomEvent<KeyNotation>(KEY_NOTATION_EVENT, { detail: notation }),
  );
}

/**
 * Read the current key notation, kept in sync via {@link KEY_NOTATION_EVENT}.
 * Returns the default (`"camelot"`) until the async store load resolves.
 */
export function useKeyNotation(): KeyNotation {
  const [notation, setNotation] = useState<KeyNotation>("camelot");

  useEffect(() => {
    let cancelled = false;
    getSetting("keyNotation")
      .then((n) => {
        if (!cancelled) setNotation(n);
      })
      .catch(() => {});
    const onChange = (e: Event) => {
      setNotation((e as CustomEvent<KeyNotation>).detail);
    };
    window.addEventListener(KEY_NOTATION_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(KEY_NOTATION_EVENT, onChange);
    };
  }, []);

  return notation;
}
