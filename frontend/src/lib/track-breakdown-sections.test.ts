import { describe, expect, it } from "vitest";

import type { Section } from "./track-breakdown";
import {
  mergeWithNext,
  moveBoundary,
  renameSection,
  sectionIndexAt,
  splitAt,
} from "./track-breakdown-sections";

const SECTIONS: Section[] = [
  { start_bar: 1, end_bar: 16, label: "intro" },
  { start_bar: 17, end_bar: 48, label: "groove" },
  { start_bar: 49, end_bar: 64, label: "build" },
];

describe("section edits", () => {
  it("finds the section holding a bar", () => {
    expect(sectionIndexAt(SECTIONS, 17)).toBe(1);
    expect(sectionIndexAt(SECTIONS, 65)).toBe(-1);
  });

  it("moves a boundary and clamps it inside the neighbours", () => {
    expect(moveBoundary(SECTIONS, 0, 9).slice(0, 2)).toEqual([
      { start_bar: 1, end_bar: 8, label: "intro" },
      { start_bar: 9, end_bar: 48, label: "groove" },
    ]);
    expect(moveBoundary(SECTIONS, 0, -5)[1].start_bar).toBe(2);
    expect(moveBoundary(SECTIONS, 0, 99)[1]).toEqual({
      start_bar: 48,
      end_bar: 48,
      label: "groove",
    });
  });

  it("splits a section at a bar", () => {
    expect(splitAt(SECTIONS, 33)).toEqual([
      SECTIONS[0],
      { start_bar: 17, end_bar: 32, label: "groove" },
      { start_bar: 33, end_bar: 48, label: "groove" },
      SECTIONS[2],
    ]);
    expect(splitAt(SECTIONS, 17)).toBe(SECTIONS);
  });

  it("merges with the next section", () => {
    expect(mergeWithNext(SECTIONS, 1)).toEqual([
      SECTIONS[0],
      { start_bar: 17, end_bar: 64, label: "groove" },
    ]);
    expect(mergeWithNext(SECTIONS, 2)).toBe(SECTIONS);
  });

  it("renames, ignoring blank labels", () => {
    expect(renameSection(SECTIONS, 2, " drop ")[2].label).toBe("drop");
    expect(renameSection(SECTIONS, 2, "  ")).toBe(SECTIONS);
  });

  it("keeps full coverage through any edit", () => {
    const edited = mergeWithNext(splitAt(moveBoundary(SECTIONS, 1, 41), 5), 0);
    let expected = 1;
    for (const s of edited) {
      expect(s.start_bar).toBe(expected);
      expected = s.end_bar + 1;
    }
    expect(expected).toBe(65);
  });
});
