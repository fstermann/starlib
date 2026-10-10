/**
 * Pure edits on a section list. Every operation keeps the invariant the
 * backend validates: sections cover bar 1 to the last bar, in order, with no
 * gaps or overlaps. Bars are 1-based and inclusive.
 */

import type { Section } from "./track-breakdown";

/** Index of the section containing `bar`, or -1. */
export function sectionIndexAt(sections: Section[], bar: number): number {
  return sections.findIndex((s) => s.start_bar <= bar && bar <= s.end_bar);
}

/**
 * Move the boundary between section `index` and the next one so the next
 * section starts at `startBar`. Clamped so both keep at least one bar.
 */
export function moveBoundary(
  sections: Section[],
  index: number,
  startBar: number,
): Section[] {
  const left = sections[index];
  const right = sections[index + 1];
  if (!left || !right) return sections;
  const clamped = Math.min(
    Math.max(startBar, left.start_bar + 1),
    right.end_bar,
  );
  if (clamped === right.start_bar) return sections;
  return sections.map((s, i) => {
    if (i === index) return { ...s, end_bar: clamped - 1 };
    if (i === index + 1) return { ...s, start_bar: clamped };
    return s;
  });
}

/** Split the section containing `bar` so a new section starts at `bar`. */
export function splitAt(sections: Section[], bar: number): Section[] {
  const index = sectionIndexAt(sections, bar);
  if (index < 0 || sections[index].start_bar === bar) return sections;
  const s = sections[index];
  return [
    ...sections.slice(0, index),
    { ...s, end_bar: bar - 1 },
    { ...s, start_bar: bar },
    ...sections.slice(index + 1),
  ];
}

/** Merge section `index` with the one after it, keeping the first label. */
export function mergeWithNext(sections: Section[], index: number): Section[] {
  const next = sections[index + 1];
  if (!next) return sections;
  return [
    ...sections.slice(0, index),
    { ...sections[index], end_bar: next.end_bar },
    ...sections.slice(index + 2),
  ];
}

export function renameSection(
  sections: Section[],
  index: number,
  label: string,
): Section[] {
  const trimmed = label.trim();
  if (!trimmed || !sections[index]) return sections;
  return sections.map((s, i) => (i === index ? { ...s, label: trimmed } : s));
}
