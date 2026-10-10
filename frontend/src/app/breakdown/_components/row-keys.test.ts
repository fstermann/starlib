import { describe, expect, it } from "vitest";

import { computeNextStarts, rowKeyOf } from "./row-keys";

describe("row keys", () => {
  const persisted = [
    { id: 7, start_s: 0, title: "A", shazam_id: "a" },
    { id: 8, start_s: 120, title: "B", shazam_id: "b" },
    { id: 9, start_s: 300, title: "C", shazam_id: "c" },
  ];

  it("computeNextStarts keys match the render row key", () => {
    // Regression: nextStarts used to key by `${start_s}-${shazam_id}`
    // while rows rendered keyed by id — every lookup missed, the span
    // fell back to Infinity, and set-play marked ALL rows as playing.
    const m = computeNextStarts(persisted);
    for (const t of persisted) {
      expect(m.has(rowKeyOf(t))).toBe(true);
    }
  });

  it("maps each row to the next row's start, last to Infinity", () => {
    const m = computeNextStarts(persisted);
    expect(m.get("7")).toBe(120);
    expect(m.get("8")).toBe(300);
    expect(m.get("9")).toBe(Number.POSITIVE_INFINITY);
  });

  it("exactly one row spans any given playhead position", () => {
    const m = computeNextStarts(persisted);
    const active = persisted.filter((t) => {
      const next = m.get(rowKeyOf(t)) ?? Number.POSITIVE_INFINITY;
      return 150 >= t.start_s && 150 < next;
    });
    expect(active.map((t) => t.id)).toEqual([8]);
  });

  it("derived runs without ids fall back to start+title", () => {
    expect(rowKeyOf({ start_s: 42, title: "Live" })).toBe("42-Live");
  });
});
