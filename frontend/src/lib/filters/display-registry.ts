import type { LucideIcon } from "lucide-react";
import { Cloud, Disc3, Music2, Search, Tag, Timer } from "lucide-react";

import type { FilterAttribute } from "@/lib/filters/schema";

/**
 * Display overrides keyed by attribute_id. Purely cosmetic — the schema works
 * without any entry here. Add an entry to polish an attribute's UI.
 */
export interface FilterDisplay {
  label?: string;
  icon?: LucideIcon;
  /** Comparator used *after* the selected-first sort inside MotionMultiselect. */
  compareOptions?: (a: string, b: string) => number;
  /** Formatter for numeric values (range labels, chip text). */
  format?: (n: number) => string;
}

function camelotRank(k: string): number {
  const m = k.match(/^(\d{1,2})([AB])$/i);
  if (!m) return Infinity;
  return parseInt(m[1], 10) * 2 + (m[2].toUpperCase() === "A" ? 0 : 1);
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

const REGISTRY: Record<string, FilterDisplay> = {
  search: { icon: Search },
  genre: { icon: Tag },
  key: {
    icon: Music2,
    compareOptions: (a, b) =>
      camelotRank(a) - camelotRank(b) || a.localeCompare(b),
  },
  bpm: { icon: Disc3 },
  duration: { icon: Timer, format: formatDuration },
  soundcloud_linked: { icon: Cloud, label: "SoundCloud" },
};

function humanize(id: string): string {
  return id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function resolveDisplay(attr: FilterAttribute): FilterDisplay & {
  label: string;
} {
  const entry = REGISTRY[attr.id] ?? {};
  return {
    ...entry,
    label: entry.label ?? attr.label ?? humanize(attr.id),
  };
}

/** Hint-driven fallback: honors schema's sortHint/formatHint without a registry entry. */
export function resolveFromHints(attr: FilterAttribute): FilterDisplay & {
  label: string;
} {
  const base = resolveDisplay(attr);
  if (!base.compareOptions && attr.sortHint === "camelot") {
    return {
      ...base,
      compareOptions: (a, b) =>
        camelotRank(a) - camelotRank(b) || a.localeCompare(b),
    };
  }
  if (!base.format && attr.formatHint === "duration") {
    return { ...base, format: formatDuration };
  }
  return base;
}
