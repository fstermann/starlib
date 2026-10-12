import { describe, expect, it } from "vitest";

import { eqKnobAngle } from "@/components/transition-mixer";

/** Degrees from 12 o'clock per clock hour. */
const HOUR_DEG = 30;

describe("eqKnobAngle", () => {
  it("is 12 o'clock when flat", () => {
    expect(eqKnobAngle(0)).toBe(0);
  });

  it("puts the -9 dB mix cut near 10 o'clock", () => {
    const offTenOClock = Math.abs(eqKnobAngle(-9) + 2 * HOUR_DEG);
    expect(offTenOClock).toBeLessThan(HOUR_DEG / 2);
  });

  it("pins a kill to 7 o'clock and the boost limit to 5 o'clock", () => {
    expect(eqKnobAngle(-40)).toBe(-5 * HOUR_DEG);
    expect(eqKnobAngle(6)).toBe(5 * HOUR_DEG);
  });
});
