"use client";

import { useEffect, useState } from "react";

import { getSetting, setSetting } from "@/lib/settings";

/** Dispatched on `window` when the compact-rows setting changes, for live sync
 * across the settings dialog and every mounted library table. */
export const COMPACT_ROWS_EVENT = "compact-rows-changed";

/** Persist the compact-rows setting and notify listeners in the same tab. */
export async function saveCompactRows(compact: boolean): Promise<void> {
  await setSetting("compactRows", compact);
  window.dispatchEvent(
    new CustomEvent<boolean>(COMPACT_ROWS_EVENT, { detail: compact }),
  );
}

/**
 * Whether library tables render compact rows, kept in sync via
 * {@link COMPACT_ROWS_EVENT}. Returns `false` until the async store load resolves.
 */
export function useCompactRows(): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSetting("compactRows")
      .then((c) => {
        if (!cancelled) setCompact(c);
      })
      .catch(() => {});
    const onChange = (e: Event) => {
      setCompact((e as CustomEvent<boolean>).detail);
    };
    window.addEventListener(COMPACT_ROWS_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(COMPACT_ROWS_EVENT, onChange);
    };
  }, []);

  return compact;
}
