import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetPlaybackForTests,
  claimPlayback,
  releasePlayback,
} from "./exclusive-audio";

describe("exclusive-audio", () => {
  beforeEach(() => _resetPlaybackForTests());

  it("pauses the previous holder when a different source claims", () => {
    const pauseSet = vi.fn();
    const pausePreview = vi.fn();
    claimPlayback("analyser-set", pauseSet);
    claimPlayback("shazam-preview", pausePreview);
    expect(pauseSet).toHaveBeenCalledTimes(1);
    expect(pausePreview).not.toHaveBeenCalled();
  });

  it("re-claiming the same source does not pause itself", () => {
    const pause = vi.fn();
    claimPlayback("analyser-set", pause);
    claimPlayback("analyser-set", pause);
    expect(pause).not.toHaveBeenCalled();
  });

  it("release prevents a stale pause from firing on the next claim", () => {
    const pauseSet = vi.fn();
    claimPlayback("analyser-set", pauseSet);
    releasePlayback("analyser-set");
    claimPlayback("global-player", vi.fn());
    expect(pauseSet).not.toHaveBeenCalled();
  });

  it("release by a non-holder is a no-op", () => {
    const pauseSet = vi.fn();
    claimPlayback("analyser-set", pauseSet);
    releasePlayback("shazam-preview");
    claimPlayback("global-player", vi.fn());
    expect(pauseSet).toHaveBeenCalledTimes(1);
  });
});
