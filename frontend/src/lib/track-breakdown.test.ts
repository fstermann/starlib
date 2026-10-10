import { describe, expect, it } from "vitest";

import { noteAt } from "./track-breakdown";

describe("noteAt", () => {
  it("names the nearest note with its octave", () => {
    expect(noteAt(440)).toBe("A4");
    expect(noteAt(261.63)).toBe("C4");
    expect(noteAt(81)).toBe("E2");
    expect(noteAt(61.7)).toBe("B1");
    expect(noteAt(29.5)).toBe("A#0");
  });
});
