import { describe, expect, it } from "vitest";

import type { BandLevel } from "./breakdown";
import {
  bellGainDb,
  equalisedBands,
  equalisedSpectrum,
  type BellEq,
} from "./eq";

const BOOST: BellEq = { on: true, freqHz: 3000, gainDb: 1, q: 0.7 };
const RATE = 48000;

const CENTRES = Array.from({ length: 60 }, (_, i) => 20 * 2 ** ((i + 0.5) / 6));
// Pink noise: every 1/6 octave carries the same share.
const PINK = {
  centres_hz: CENTRES,
  level_db: CENTRES.map(() => 10 * Math.log10(1 / 60)),
};
const BANDS: BandLevel[] = [
  [20, 2000],
  [2000, 20000],
].map(([low_hz, high_hz]) => ({
  name: `${low_hz}`,
  low_hz,
  high_hz,
  level_db: 10 * Math.log10(Math.log2(high_hz / low_hz) / Math.log2(1000)),
}));

describe("bellGainDb", () => {
  it("gives the full gain at the centre and none far away", () => {
    expect(bellGainDb(BOOST, 3000, RATE)).toBeCloseTo(1, 3);
    expect(bellGainDb(BOOST, 30, RATE)).toBeCloseTo(0, 2);
  });

  it("is flat when off or at 0 dB", () => {
    expect(bellGainDb({ ...BOOST, on: false }, 3000, RATE)).toBe(0);
    expect(bellGainDb({ ...BOOST, gainDb: 0 }, 3000, RATE)).toBe(0);
  });

  it("narrows as Q rises", () => {
    expect(bellGainDb({ ...BOOST, q: 4 }, 1500, RATE)).toBeLessThan(
      bellGainDb(BOOST, 1500, RATE),
    );
  });
});

describe("equalisedSpectrum", () => {
  it("keeps the levels relative to the whole range", () => {
    const after = equalisedSpectrum(PINK, { ...BOOST, gainDb: 6 }, RATE);
    const total = after.level_db.reduce((s, db) => s + 10 ** (db / 10), 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("raises the boosted region and lowers the rest", () => {
    const after = equalisedSpectrum(PINK, BOOST, RATE);
    const at = (hz: number) => CENTRES.findIndex((c) => c * 2 ** (1 / 12) > hz);
    expect(after.level_db[at(3000)]).toBeGreaterThan(PINK.level_db[at(3000)]);
    expect(after.level_db[at(50)]).toBeLessThan(PINK.level_db[at(50)]);
  });
});

describe("equalisedBands", () => {
  it("leaves the bands alone when the EQ is off", () => {
    const after = equalisedBands(BANDS, PINK, { ...BOOST, on: false }, RATE);
    expect(after.map((b) => b.level_db)).toEqual(BANDS.map((b) => b.level_db));
  });

  it("shifts power toward the boosted band", () => {
    const [low, high] = equalisedBands(BANDS, PINK, BOOST, RATE);
    const rise = high.level_db - BANDS[1].level_db;
    // A 1 dB bell lifts a 3.3-octave band by less than its peak.
    expect(rise).toBeGreaterThan(0.1);
    expect(rise).toBeLessThan(1);
    expect(low.level_db).toBeLessThan(BANDS[0].level_db);
  });
});
