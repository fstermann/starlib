/**
 * Unified filter schema shared across sources (filesystem, soundcloud, …).
 *
 * The same shape is produced by:
 *   - backend endpoints (filesystem today, other sources later), or
 *   - client-side builders (soundcloud today, over the in-browser SCTrack[]).
 *
 * Consumers (<FilterPanel>, <ActiveFilterChips>, useFilterState) are source-agnostic.
 */

export type FilterKind = "enum" | "range" | "bool" | "text";

export interface FilterAttribute {
  /** Stable id; also used as URL param key + display-registry key. */
  id: string;
  /** Human label. The display registry may override this. */
  label: string;
  kind: FilterKind;
  /** enum: full option set present in the source (after filtering). */
  options?: string[];
  /** enum: option id → count under current filter state. 0 = disabled. */
  counts?: Record<string, number>;
  /** range: numeric bounds of the source (ignoring current filters). */
  min?: number;
  max?: number;
  /** range: step hint for the slider. */
  step?: number;
  /** Hints the display registry can use; purely cosmetic. */
  sortHint?: "camelot" | "alpha" | "count";
  formatHint?: "bpm" | "duration" | "date";
}

export interface FilterSchemaResponse {
  source: string;
  attributes: FilterAttribute[];
}

/** State shape: map of attribute id → value. Value type depends on kind. */
export type FilterValue =
  | string[] // enum
  | [number | null, number | null] // range
  | boolean
  | null // bool (null = unset)
  | string; // text

export type FilterState = Record<string, FilterValue>;

export function emptyStateFor(schema: FilterSchemaResponse): FilterState {
  const out: FilterState = {};
  for (const a of schema.attributes) {
    switch (a.kind) {
      case "enum":
        out[a.id] = [];
        break;
      case "range":
        out[a.id] = [null, null];
        break;
      case "bool":
        out[a.id] = null;
        break;
      case "text":
        out[a.id] = "";
        break;
    }
  }
  return out;
}

export function isAttributeActive(
  attr: FilterAttribute,
  value: FilterValue,
): boolean {
  switch (attr.kind) {
    case "enum":
      return Array.isArray(value) && value.length > 0;
    case "range": {
      if (!Array.isArray(value)) return false;
      const [lo, hi] = value as [number | null, number | null];
      return lo !== null || hi !== null;
    }
    case "bool":
      return value !== null;
    case "text":
      return typeof value === "string" && value.trim().length > 0;
  }
}
