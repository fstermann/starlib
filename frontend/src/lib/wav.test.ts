import { describe, expect, it } from "vitest";

import { encodeWav } from "./wav";

describe("encodeWav", () => {
  it("writes a stereo float WAV with interleaved samples", () => {
    const wav = encodeWav(
      [Float32Array.of(0.5, -1), Float32Array.of(0.25, 1)],
      48000,
    );
    const view = new DataView(wav.buffer);
    const text = (at: number, n: number) =>
      String.fromCharCode(...wav.subarray(at, at + n));

    expect(wav.length).toBe(44 + 2 * 2 * 4);
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(16);
    expect([0, 1, 2, 3].map((i) => view.getFloat32(44 + i * 4, true))).toEqual([
      0.5, 0.25, -1, 1,
    ]);
  });
});
