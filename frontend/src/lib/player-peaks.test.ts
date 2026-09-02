import { describe, expect, it } from "vitest";

import type { PlayerTrack } from "@/lib/player-context";
import { selectPeaksSource } from "@/lib/player-peaks";

function track(overrides: Partial<PlayerTrack>): PlayerTrack {
  return { filePath: "/x.mp3", fileName: "x.mp3", ...overrides };
}

describe("selectPeaksSource", () => {
  it("uses Rekordbox PWV4 for a USB export track even though it has a streamUrl", () => {
    // Regression: USB tracks set `streamUrl` (device audio endpoint) *and*
    // `rekordboxId`. The old `isStream`-first ordering routed them to the
    // SoundCloud branch → flat placeholder. Analysis must win.
    const src = selectPeaksSource(
      track({
        rekordboxId: "u-1",
        rekordboxDevice: "/Volumes/USB",
        streamUrl: "/api/rekordbox/tracks/u-1/audio?device=/Volumes/USB",
      }),
    );
    expect(src).toEqual({
      kind: "rekordbox",
      id: "u-1",
      device: "/Volumes/USB",
    });
  });

  it("uses Rekordbox PWV4 for a local-install track (no device)", () => {
    const src = selectPeaksSource(track({ rekordboxId: "l-1" }));
    expect(src).toEqual({ kind: "rekordbox", id: "l-1", device: undefined });
  });

  it("uses the SoundCloud branch for a stream track with a waveform URL", () => {
    const src = selectPeaksSource(
      track({ streamRefreshKey: 42, waveformUrl: "https://cdn/wave.png" }),
    );
    expect(src).toEqual({
      kind: "soundcloud",
      waveformUrl: "https://cdn/wave.png",
    });
  });

  it("uses the file (ffmpeg) branch for a plain local file", () => {
    const src = selectPeaksSource(track({}));
    expect(src).toEqual({ kind: "file" });
  });
});
