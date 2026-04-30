import { describe, expect, it } from "vitest";

import { scrubValue } from "./scrub-number-input";

describe("scrubValue", () => {
  it("returns the start value when delta is zero", () => {
    expect(scrubValue({ startValue: 128, dx: 0, pxPerUnit: 4 })).toBe(128);
  });

  it("steps by integer rounded amounts (one unit per pxPerUnit pixels)", () => {
    expect(scrubValue({ startValue: 100, dx: 20, pxPerUnit: 4 })).toBe(105);
    expect(scrubValue({ startValue: 100, dx: -20, pxPerUnit: 4 })).toBe(95);
    // 5 px / 4 px-per-unit rounds to 1 step.
    expect(scrubValue({ startValue: 100, dx: 5, pxPerUnit: 4 })).toBe(101);
  });

  it("never produces a non-integer value (issue #370 AC)", () => {
    for (const dx of [1, 3, 7, 9, 11, 17]) {
      const v = scrubValue({ startValue: 120, dx, pxPerUnit: 4 });
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("clamps to min/max when provided", () => {
    expect(scrubValue({ startValue: 5, dx: -1000, pxPerUnit: 4, min: 0 })).toBe(
      0,
    );
    expect(
      scrubValue({ startValue: 5, dx: 4000, pxPerUnit: 4, max: 300 }),
    ).toBe(300);
  });
});
