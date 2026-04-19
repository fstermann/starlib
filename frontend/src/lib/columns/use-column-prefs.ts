"use client";

import * as React from "react";

import {
  applyOrder,
  emptyPrefs,
  isColumnVisible,
  type ColumnDef,
  type ColumnPrefs,
} from "@/lib/columns/types";
import { getRaw, setRaw } from "@/lib/settings";

const KEY_PREFIX = "columns.";

/**
 * Per-view column preferences backed by the Tauri Store (localStorage in
 * browser/dev). Loads asynchronously on mount; renders with defaults until
 * the load resolves.
 */
export function useColumnPrefs(
  viewId: string,
  columns: ColumnDef[],
): {
  prefs: ColumnPrefs;
  setHidden: (id: string, hidden: boolean) => void;
  setOrder: (ids: string[]) => void;
  setWidth: (id: string, width: number) => void;
  resetOrder: () => void;
  resetVisibility: () => void;
  resetWidths: () => void;
  resetWidth: (id: string) => void;
  isVisible: (id: string) => boolean;
  orderedColumns: ColumnDef[];
  visibleColumns: ColumnDef[];
} {
  const storeKey = KEY_PREFIX + viewId;
  const [prefs, setPrefs] = React.useState<ColumnPrefs>(emptyPrefs);

  React.useEffect(() => {
    let cancelled = false;
    getRaw<Partial<ColumnPrefs>>(storeKey, emptyPrefs)
      .then((loaded) => {
        if (cancelled) return;
        // Normalize older stored shapes that may lack fields added later.
        setPrefs({
          hidden: Array.isArray(loaded.hidden) ? loaded.hidden : [],
          order: Array.isArray(loaded.order) ? loaded.order : [],
          widths:
            loaded.widths && typeof loaded.widths === "object"
              ? (loaded.widths as Record<string, number>)
              : {},
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [storeKey]);

  const persist = React.useCallback(
    (next: ColumnPrefs) => {
      setPrefs(next);
      void setRaw(storeKey, next);
    },
    [storeKey],
  );

  const setHidden = React.useCallback(
    (id: string, hidden: boolean) => {
      const col = columns.find((c) => c.id === id);
      if (col?.required) return;
      persist({
        ...prefs,
        hidden: hidden
          ? Array.from(new Set([...prefs.hidden, id]))
          : prefs.hidden.filter((h) => h !== id),
      });
    },
    [columns, prefs, persist],
  );

  const setOrder = React.useCallback(
    (ids: string[]) => {
      persist({ ...prefs, order: ids });
    },
    [prefs, persist],
  );

  const setWidth = React.useCallback(
    (id: string, width: number) => {
      persist({
        ...prefs,
        widths: { ...prefs.widths, [id]: Math.max(40, Math.round(width)) },
      });
    },
    [prefs, persist],
  );

  const resetOrder = React.useCallback(
    () => persist({ ...prefs, order: [] }),
    [prefs, persist],
  );

  const resetVisibility = React.useCallback(
    () => persist({ ...prefs, hidden: [] }),
    [prefs, persist],
  );

  const resetWidths = React.useCallback(
    () => persist({ ...prefs, widths: {} }),
    [prefs, persist],
  );

  const resetWidth = React.useCallback(
    (id: string) => {
      const { [id]: _omit, ...rest } = prefs.widths;
      persist({ ...prefs, widths: rest });
    },
    [prefs, persist],
  );

  const isVisible = React.useCallback(
    (id: string) => {
      const col = columns.find((c) => c.id === id);
      return col ? isColumnVisible(col, prefs) : true;
    },
    [columns, prefs],
  );

  const orderedColumns = React.useMemo(
    () => applyOrder(columns, prefs.order),
    [columns, prefs.order],
  );

  const visibleColumns = React.useMemo(
    () => orderedColumns.filter((c) => isColumnVisible(c, prefs)),
    [orderedColumns, prefs],
  );

  return {
    prefs,
    setHidden,
    setOrder,
    setWidth,
    resetOrder,
    resetVisibility,
    resetWidths,
    resetWidth,
    isVisible,
    orderedColumns,
    visibleColumns,
  };
}
