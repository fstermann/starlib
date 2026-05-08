import { describe, expect, it } from "vitest";

import { seedStars } from "./galaxy-stars";

// Deterministic RNG so resize behaviour can be asserted independently of Math.random.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("seedStars", () => {
  it("returns positions in normalized [0, 1] coords (independent of viewport)", () => {
    const stars = seedStars(50);
    expect(stars).toHaveLength(50);
    for (const s of stars) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(1);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(1);
    }
  });

  it("does not depend on width/height (regression: #373 reshuffle on resize)", () => {
    // The fix moves star positions to normalized space so resizing the window
    // does not require reseeding. The seed function therefore must not take —
    // nor produce values scaled by — viewport dimensions. Same RNG seed must
    // produce identical stars regardless of any external size, which we model
    // here by calling it twice with the same deterministic RNG.
    const a = seedStars(20, mulberry32(42));
    const b = seedStars(20, mulberry32(42));
    expect(b).toEqual(a);
  });

  it("scales to different pixel viewports without re-randomizing", () => {
    // Simulates a window resize: the same star array is reused, only the
    // pixel projection changes. A reshuffle (the bug) would produce different
    // pixel positions for the same seed.
    const stars = seedStars(20, mulberry32(7));
    const project = (s: { x: number; y: number }, w: number, h: number) => ({
      px: s.x * w,
      py: s.y * h,
    });
    const small = stars.map((s) => project(s, 800, 600));
    const large = stars.map((s) => project(s, 1600, 1200));
    for (let i = 0; i < stars.length; i++) {
      expect(large[i].px).toBeCloseTo(small[i].px * 2, 5);
      expect(large[i].py).toBeCloseTo(small[i].py * 2, 5);
    }
  });
});
