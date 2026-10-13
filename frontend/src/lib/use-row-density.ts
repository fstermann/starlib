"use client";

import { useEffect, useState } from "react";

import { getSetting, setSetting, type RowDensity } from "@/lib/settings";

/** Dispatched on `window` when the row-density setting changes, for live sync
 * across the settings dialog and every mounted library table. */
export const ROW_DENSITY_EVENT = "row-density-changed";

/** Per-density sizing shared by the library tables. `cover` and `spacer` size
 * the artwork cell and its header placeholder so the columns stay aligned. */
export const ROW_DENSITY_STYLES: Record<
  RowDensity,
  { height: number; row: string; cover: string | undefined; spacer: string }
> = {
  comfortable: { height: 40, row: "h-10", cover: undefined, spacer: "w-7" },
  compact: { height: 32, row: "h-8", cover: "size-6", spacer: "w-6" },
  dense: { height: 24, row: "h-6", cover: "size-5", spacer: "w-5" },
};

/** Persist the row-density setting and notify listeners in the same tab. */
export async function saveRowDensity(density: RowDensity): Promise<void> {
  await setSetting("rowDensity", density);
  window.dispatchEvent(
    new CustomEvent<RowDensity>(ROW_DENSITY_EVENT, { detail: density }),
  );
}

/**
 * Row density of the library tables, kept in sync via {@link ROW_DENSITY_EVENT}.
 * Returns `"comfortable"` until the async store load resolves.
 */
export function useRowDensity(): RowDensity {
  const [density, setDensity] = useState<RowDensity>("comfortable");

  useEffect(() => {
    let cancelled = false;
    getSetting("rowDensity")
      .then((d) => {
        if (!cancelled) setDensity(d);
      })
      .catch(() => {});
    const onChange = (e: Event) => {
      setDensity((e as CustomEvent<RowDensity>).detail);
    };
    window.addEventListener(ROW_DENSITY_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(ROW_DENSITY_EVENT, onChange);
    };
  }, []);

  return density;
}
