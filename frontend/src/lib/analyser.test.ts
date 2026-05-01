import { describe, expect, it } from "vitest";

import {
  effectiveDurationInSet,
  originalBpmFromSet,
  pitchSpeedRatio,
} from "@/lib/analyser";

describe("pitchSpeedRatio", () => {
  it("returns 1 for offset 0", () => {
    expect(pitchSpeedRatio(0)).toBeCloseTo(1, 6);
  });

  it("matches the semitone ratio 2^(N/12)", () => {
    expect(pitchSpeedRatio(12)).toBeCloseTo(2, 6);
    expect(pitchSpeedRatio(-12)).toBeCloseTo(0.5, 6);
    expect(pitchSpeedRatio(1)).toBeCloseTo(1.05946, 4);
  });
});

describe("originalBpmFromSet", () => {
  it("returns null when set BPM is missing or non-positive", () => {
    expect(originalBpmFromSet(null, 0)).toBeNull();
    expect(originalBpmFromSet(0, 0)).toBeNull();
  });

  it("returns null when pitch offset is unknown", () => {
    expect(originalBpmFromSet(128, null)).toBeNull();
  });

  it("scales set BPM by the speed ratio", () => {
    // DJ pitched up 1 ST: pitch_offset is the offset we applied to come
    // back to the original (negative). 128 BPM in set → ~120.8 BPM original.
    expect(originalBpmFromSet(128, -1)).toBeCloseTo(128 * 2 ** (-1 / 12), 4);
  });
});

describe("effectiveDurationInSet", () => {
  it("falls back to the original when no pitch offset is set", () => {
    expect(effectiveDurationInSet(300, null)).toBe(300);
  });

  it("returns null for missing or zero original duration", () => {
    expect(effectiveDurationInSet(null, 0)).toBeNull();
    expect(effectiveDurationInSet(0, 0)).toBeNull();
  });

  it("shortens the duration when the original was pitched up in the set", () => {
    // Pitched up 1 ST in the set → offset = -1 (we applied -1 to match
    // the original) → effective length ≈ 0.943 × original.
    const out = effectiveDurationInSet(300, -1);
    expect(out).not.toBeNull();
    expect(out!).toBeLessThan(300);
    expect(out!).toBeCloseTo(300 * 2 ** (-1 / 12), 4);
  });
});
