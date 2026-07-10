import { describe, expect, it } from "vitest";

import {
  barBeatLabel,
  barSpanSeconds,
  buildDownbeatPrefix,
  decodeFloatPeaks,
  decodePwv3,
  decodePwv5,
  rgbCss,
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
