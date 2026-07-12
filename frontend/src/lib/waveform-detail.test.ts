import { describe, expect, it } from "vitest";

import {
  barBeatLabel,
  barSpanSeconds,
  buildDownbeatPrefix,
  computeCueDisplays,
  decodeFloatPeaks,
  decodePwv3,
  decodePwv5,
  keySemitonesForRate,
  rgbCss,
  semitonesFloatForRate,
  transposeKey,
  type BeatTick,
} from "@/lib/waveform-detail";

describe("decodePwv5", () => {
  it("unpacks 3-bit RGB and 5-bit height from big-endian columns", () => {
    // Column bits: rrr ggg bbb hhhhh 00. Max R (7), zero G/B, max height (31).
    const maxRedFullHeight = 0b111_000_000_11111_00; // 0xE07C
    // Full green, half-ish height.
    const green = 0b000_111_000_10000_00; // 0x1C40
    const bytes = new Uint8Array([
      (maxRedFullHeight >> 8) & 0xff,
      maxRedFullHeight & 0xff,
      (green >> 8) & 0xff,
      green & 0xff,
    ]);
    const wave = decodePwv5(bytes);
    expect(wave.heights.length).toBe(2);
    expect(wave.heights[0]).toBeCloseTo(1, 5);
    expect(wave.colors).not.toBeNull();
    expect(rgbCss(wave.colors![0])).toBe("rgb(255, 0, 0)");
    expect(rgbCss(wave.colors![1])).toBe("rgb(0, 255, 0)");
    expect(wave.columnsPerSecond).toBe(150);
  });
});

describe("decodePwv3", () => {
  it("unpacks 5-bit height and produces a blue-palette colour", () => {
    const wave = decodePwv3(new Uint8Array([0x1f, 0x00]));
    expect(wave.heights[0]).toBeCloseTo(1, 5);
    expect(wave.heights[1]).toBe(0);
    expect(wave.colors).not.toBeNull();
    // No whiteness bits → the dim blue base colour.
    expect(rgbCss(wave.colors![1])).toBe("rgb(40, 120, 220)");
  });
});

describe("decodeFloatPeaks", () => {
  it("derives columns-per-second from the track length", () => {
    const wave = decodeFloatPeaks([0, 0.5, 1, 0.5], 2);
    expect(Array.from(wave.heights)).toEqual([0, 0.5, 1, 0.5]);
    expect(wave.colors).toBeNull();
    expect(wave.columnsPerSecond).toBe(2); // 4 columns / 2 s
  });
});

describe("barSpanSeconds", () => {
  it("maps bars to seconds at the given tempo", () => {
    // 4 bars * 4 beats = 16 beats; at 120 BPM that's 16 * 0.5 s = 8 s.
    expect(barSpanSeconds(4, 120)).toBeCloseTo(8, 5);
    // 8 bars at 128 BPM.
    expect(barSpanSeconds(8, 128)).toBeCloseTo((8 * 4 * 60) / 128, 5);
  });

  it("falls back to 120 BPM when tempo is unknown", () => {
    expect(barSpanSeconds(4, null)).toBe(barSpanSeconds(4, 120));
    expect(barSpanSeconds(4, 0)).toBe(barSpanSeconds(4, 120));
  });
});

describe("barBeatLabel", () => {
  const grid: BeatTick[] = [];
  // 8 beats at 120 BPM (500 ms/beat), beat cycling 1..4.
  for (let i = 0; i < 8; i++) {
    grid.push({ beat: (i % 4) + 1, timeMs: i * 500 });
  }
  const prefix = buildDownbeatPrefix(grid);

  it("counts bars from downbeats and reports beat-in-bar", () => {
    expect(barBeatLabel(0, grid, prefix)).toBe("1.1");
    expect(barBeatLabel(0.75, grid, prefix)).toBe("1.2"); // 750 ms → beat idx 1
    expect(barBeatLabel(2.0, grid, prefix)).toBe("2.1"); // 2000 ms → 5th beat, bar 2
    expect(barBeatLabel(3.5, grid, prefix)).toBe("2.4"); // 3500 ms → 8th beat
  });

  it("returns a dash before the first beat or without a grid", () => {
    expect(barBeatLabel(-1, grid, prefix)).toBe("–");
    expect(barBeatLabel(5, [], new Uint32Array())).toBe("–");
  });
});

describe("keySemitonesForRate", () => {
  it("is zero at unity and rounds to whole semitones", () => {
    expect(keySemitonesForRate(1)).toBe(0);
    expect(keySemitonesForRate(2)).toBe(12); // octave up
    expect(keySemitonesForRate(0.5)).toBe(-12); // octave down
    expect(keySemitonesForRate(140 / 124.5)).toBe(2); // +12.5%ish ≈ +2
  });

  it("guards against non-positive or non-finite rates", () => {
    expect(keySemitonesForRate(0)).toBe(0);
    expect(keySemitonesForRate(-1)).toBe(0);
    expect(keySemitonesForRate(Number.NaN)).toBe(0);
  });
});

describe("semitonesFloatForRate", () => {
  it("returns the unrounded shift so between-key pitches read honestly", () => {
    expect(semitonesFloatForRate(1)).toBe(0);
    expect(semitonesFloatForRate(2)).toBeCloseTo(12, 5);
    // +12.5% pitch lands ~+2.04 semitones — between keys, not exactly +2.
    expect(semitonesFloatForRate(1.125)).toBeCloseTo(2.039, 3);
    expect(keySemitonesForRate(1.125)).toBe(2); // nearest key still +2
  });

  it("guards against non-positive or non-finite rates", () => {
    expect(semitonesFloatForRate(0)).toBe(0);
    expect(semitonesFloatForRate(Number.NaN)).toBe(0);
  });
});

describe("transposeKey", () => {
  it("returns the input unchanged for a zero shift", () => {
    expect(transposeKey("8A", 0)).toBe("8A");
  });

  it("moves Camelot keys +7 wheel positions per semitone, wrapping", () => {
    expect(transposeKey("8A", 2)).toBe("10A");
    expect(transposeKey("8A", 1)).toBe("3A"); // 8 + 7 = 15 → 3
    expect(transposeKey("11B", 3)).toBe("8B"); // +21 → +9 → 11+9=20 → 8
    expect(transposeKey("1a", -1)).toBe("6A"); // wraps, letter normalised
  });

  it("transposes standard note names and preserves minor quality", () => {
    expect(transposeKey("C", 2)).toBe("D");
    expect(transposeKey("Am", 3)).toBe("Cm");
    expect(transposeKey("Db", 1)).toBe("D"); // enharmonic flat → sharp scale
    expect(transposeKey("B", 1)).toBe("C"); // wraps octave
  });

  it("leaves unrecognised keys alone", () => {
    expect(transposeKey("", 2)).toBe("");
    expect(transposeKey("N/A", 2)).toBe("N/A");
  });
});

describe("computeCueDisplays", () => {
  it("colours hot cues by slot with letters, numbers memory cues from 1", () => {
    const displays = computeCueDisplays([
      { type: "hot", index: 1 },
      { type: "memory", index: null },
      { type: "hot", index: 3 },
      { type: "memory", index: null },
    ]);
    // Hot cues → letter labels, palette colour, isHot true.
    expect(displays[0]).toEqual({
      color: "#eb4b71",
      label: "A",
      isHot: true,
      isLoop: false,
    });
    expect(displays[2].label).toBe("C");
    expect(displays[2].isHot).toBe(true);
    expect(displays[2].color).not.toBe(displays[0].color); // slot-varied
    // Memory cues → sequential numbers from 1, not hot.
    expect(displays[1]).toMatchObject({ label: "1", isHot: false });
    expect(displays[3].label).toBe("2");
  });

  it("honours an explicit cue colour over the slot palette", () => {
    const [d] = computeCueDisplays([
      { type: "hot", index: 1, color: "#00ff00" },
    ]);
    expect(d.color).toBe("#00ff00");
  });

  it("renders loops in Rekordbox loop orange, overriding the slot colour", () => {
    const [loop, point] = computeCueDisplays([
      { type: "hot", index: 1, timeMs: 1000, outMs: 5000 }, // loop
      { type: "hot", index: 1, timeMs: 1000, outMs: 500 }, // out < in → not a loop
    ]);
    expect(loop).toMatchObject({ color: "#f09235", label: "A", isLoop: true });
    expect(point.isLoop).toBe(false);
    expect(point.color).toBe("#eb4b71");
  });
});
