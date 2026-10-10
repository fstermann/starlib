import { describe, expect, it } from "vitest";

import { laneGains, type LaneMix, type LaneName } from "./use-stem-player";

const lane = (change: Partial<LaneMix> = {}): LaneMix => ({
  volume: 1,
  muted: false,
  solo: false,
  ...change,
});

const mix = (
  changes: Partial<Record<LaneName, Partial<LaneMix>>>,
): Record<LaneName, LaneMix> => {
  const names: LaneName[] = [
    "original",
    "drums",
    "bass",
    "other",
    "vocals",
    "kick",
    "mids",
    "tops",
  ];
  return Object.fromEntries(
    names.map((name) => [name, lane(changes[name])]),
  ) as Record<LaneName, LaneMix>;
};

describe("laneGains", () => {
  it("plays unmuted lanes at their volume", () => {
    expect(
      laneGains(
        mix({
          original: { muted: true },
          drums: { volume: 0.5 },
          other: { muted: true },
        }),
      ),
    ).toEqual({
      original: 0,
      drums: 0.5,
      bass: 1,
      other: 0,
      vocals: 1,
      kick: 1,
      mids: 1,
      tops: 1,
    });
  });

  it("plays only soloed lanes, even muted ones, while any lane is soloed", () => {
    const gains = laneGains(
      mix({ original: { muted: true, solo: true }, bass: { solo: true } }),
    );
    expect(gains).toMatchObject({
      original: 1,
      drums: 0,
      bass: 1,
      other: 0,
      vocals: 0,
    });
  });

  it("soloing a drum part plays the drums with only that part", () => {
    const gains = laneGains(mix({ kick: { solo: true } }));
    expect(gains).toMatchObject({
      drums: 1,
      bass: 0,
      other: 0,
      kick: 1,
      mids: 0,
      tops: 0,
    });
  });

  it("a drum part solo combines with a soloed stem", () => {
    const gains = laneGains(
      mix({ kick: { solo: true }, bass: { solo: true } }),
    );
    expect(gains).toMatchObject({ drums: 1, bass: 1, kick: 1, tops: 0 });
  });

  it("muting a drum part leaves the rest of the drums", () => {
    const gains = laneGains(mix({ tops: { muted: true } }));
    expect(gains).toMatchObject({ drums: 1, kick: 1, mids: 1, tops: 0 });
  });
});
