import { describe, expect, it } from "vitest";

import {
  harmonicMatch,
  keyRelation,
  tempoShift,
  toCamelot,
} from "./harmonic-match";

describe("toCamelot", () => {
  it.each([
    ["8A", { num: 8, minor: true }],
    ["12b", { num: 12, minor: false }],
    ["Am", { num: 8, minor: true }],
    ["C", { num: 8, minor: false }],
    ["F#m", { num: 11, minor: true }],
    ["Dbmin", { num: 12, minor: true }],
    ["Bb", { num: 6, minor: false }],
  ])("%s", (key, expected) => {
    expect(toCamelot(key)).toEqual(expected);
  });

  it("rejects unknown keys", () => {
    expect(toCamelot("13A")).toBeNull();
    expect(toCamelot("H")).toBeNull();
    expect(toCamelot(null)).toBeNull();
  });
});

describe("keyRelation from 8A", () => {
  const src = toCamelot("8A")!;
  it.each([
    ["8A", "same"],
    ["9A", "adjacent"],
    ["7A", "adjacent"],
    ["8B", "relative"],
    ["9B", "diagonal"],
    ["10A", "boost2"],
    ["6A", "boost2"],
    ["3A", "semitone"],
    ["1A", "semitone"],
    ["11B", "parallel"],
    ["7B", null],
    ["5B", null],
    ["11A", null],
  ])("→ %s is %s", (key, rule) => {
    expect(keyRelation(src, toCamelot(key)!)).toBe(rule);
  });
});

describe("keyRelation from 8B", () => {
  const src = toCamelot("8B")!;
  it.each([
    ["8A", "relative"],
    ["7A", "diagonal"],
    ["5A", "parallel"],
    ["9A", null],
  ])("→ %s is %s", (key, rule) => {
    expect(keyRelation(src, toCamelot(key)!)).toBe(rule);
  });
});

describe("harmonicMatch", () => {
  it("compares unpitched keys with key lock", () => {
    expect(
      harmonicMatch({ key: "8A", bpm: 130 }, { key: "9A", bpm: 122 }, true),
    ).toEqual({ rule: "adjacent", shift: 0, detune: 0 });
  });

  it("pitches the candidate to the source tempo", () => {
    // 122.7 → 130 is +1 semitone, so 1A sounds as 8A.
    const m = harmonicMatch(
      { key: "8A", bpm: 130 },
      { key: "1A", bpm: 122.7 },
      false,
    );
    expect(m?.rule).toBe("same");
    expect(m?.shift).toBe(1);
    expect(m?.detune).toBeLessThan(0.01);
  });

  it("rejects a key that only matches unpitched", () => {
    expect(
      harmonicMatch({ key: "8A", bpm: 130 }, { key: "8A", bpm: 122.7 }, false)
        ?.rule,
    ).toBe("semitone");
    expect(
      harmonicMatch({ key: "8A", bpm: 130 }, { key: "9A", bpm: 122.7 }, false),
    ).toBeNull();
  });

  it("reports detune for a near-quarter-tone shift", () => {
    const m = harmonicMatch(
      { key: "8A", bpm: 134 },
      { key: "8A", bpm: 130 },
      false,
    );
    expect(m?.shift).toBe(1);
    expect(m?.detune).toBeCloseTo(0.474, 2);
  });

  it("returns null for an unparseable key", () => {
    expect(
      harmonicMatch({ key: "8A", bpm: 130 }, { key: "?", bpm: 130 }, false),
    ).toBeNull();
  });
});

describe("tempoShift", () => {
  it("is zero with key lock", () => {
    expect(tempoShift(130, 138, true)).toBe(0);
  });
  it("is about one semitone from 130 to 138", () => {
    expect(tempoShift(130, 138, false)).toBeCloseTo(1.034, 2);
  });
});
