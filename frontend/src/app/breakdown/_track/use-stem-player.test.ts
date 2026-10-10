import { describe, expect, it } from "vitest";

import { laneGains, type LaneMix } from "./use-stem-player";

const lane = (change: Partial<LaneMix> = {}): LaneMix => ({
  volume: 1,
  muted: false,
  solo: false,
  ...change,
});

describe("laneGains", () => {
  it("plays unmuted lanes at their volume", () => {
    const gains = laneGains({
      original: lane({ muted: true }),
      drums: lane({ volume: 0.5 }),
      bass: lane(),
      other: lane({ muted: true }),
      vocals: lane(),
    });
    expect(gains).toEqual({
      original: 0,
      drums: 0.5,
      bass: 1,
      other: 0,
      vocals: 1,
    });
  });

  it("plays only soloed lanes, even muted ones, while any lane is soloed", () => {
    const gains = laneGains({
      original: lane({ muted: true, solo: true }),
      drums: lane(),
      bass: lane({ solo: true }),
      other: lane(),
      vocals: lane(),
    });
    expect(gains).toEqual({
      original: 1,
      drums: 0,
      bass: 1,
      other: 0,
      vocals: 0,
    });
  });
});
