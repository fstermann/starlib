import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVolumeFade } from "@/lib/mix/html-deck";

// html-deck imports hls.js for the deck factory; the volume driver under test
// never touches it.
vi.mock("hls.js", () => ({ default: { isSupported: () => false } }));

/** Minimal element stand-in — the driver only reads/writes `volume`. */
function makeAudio(): HTMLMediaElement {
  return { volume: 1 } as HTMLMediaElement;
}

describe("createVolumeFade", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "performance",
      ],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the initial volume and reports it as value", () => {
    const audio = makeAudio();
    const { gainParam } = createVolumeFade(audio, 0);
    expect(audio.volume).toBe(0);
    expect(gainParam.value).toBe(0);
  });

  it("runs a linear ramp anchored at the preceding setValueAtTime", () => {
    const audio = makeAudio();
    const { gainParam } = createVolumeFade(audio, 1);
    // Engine sequence: cancel, anchor at now (arbitrary clock), ramp to now+4.
    gainParam.cancelScheduledValues(100);
    gainParam.setValueAtTime(1, 100);
    gainParam.linearRampToValueAtTime(0, 104);
    vi.advanceTimersByTime(2000);
    expect(audio.volume).toBeGreaterThan(0.4);
    expect(audio.volume).toBeLessThan(0.6);
    vi.advanceTimersByTime(2100);
    expect(audio.volume).toBe(0);
  });

  it("follows a value curve over its duration", () => {
    const audio = makeAudio();
    const { gainParam } = createVolumeFade(audio, 0);
    gainParam.setValueAtTime(0, 0);
    gainParam.setValueCurveAtTime(new Float32Array([0, 0.5, 1]), 0, 2);
    vi.advanceTimersByTime(1000);
    expect(audio.volume).toBeGreaterThan(0.4);
    expect(audio.volume).toBeLessThan(0.6);
    vi.advanceTimersByTime(1100);
    expect(audio.volume).toBe(1);
  });

  it("cancelScheduledValues freezes the current value (engine pause)", () => {
    const audio = makeAudio();
    const { gainParam } = createVolumeFade(audio, 1);
    gainParam.setValueAtTime(1, 0);
    gainParam.linearRampToValueAtTime(0, 4);
    vi.advanceTimersByTime(2000);
    const held = audio.volume;
    gainParam.cancelScheduledValues(2);
    gainParam.setValueAtTime(held, 2);
    vi.advanceTimersByTime(5000);
    expect(audio.volume).toBe(held);
  });

  it("dispose stops automation without resetting the volume", () => {
    const audio = makeAudio();
    const { gainParam, dispose } = createVolumeFade(audio, 1);
    gainParam.setValueAtTime(1, 0);
    gainParam.linearRampToValueAtTime(0, 4);
    vi.advanceTimersByTime(1000);
    const at = audio.volume;
    dispose();
    vi.advanceTimersByTime(5000);
    expect(audio.volume).toBe(at);
  });

  it("clamps values to the element's [0, 1] volume range", () => {
    const audio = makeAudio();
    const { gainParam } = createVolumeFade(audio, 1);
    gainParam.setValueAtTime(1.4, 0);
    expect(audio.volume).toBe(1);
    gainParam.setValueAtTime(-0.2, 0);
    expect(audio.volume).toBe(0);
  });
});
