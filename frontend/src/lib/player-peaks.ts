import type { PlayerTrack } from "@/lib/player-context";

/** Which analysis source the player derives its waveform peaks from. */
export type PeaksSource =
  | { kind: "rekordbox"; id: string; device?: string }
  | { kind: "soundcloud"; waveformUrl?: string }
  | { kind: "file" };

/**
 * Pick the peaks source for a track.
 *
 * Rekordbox analysis (PWV4) wins whenever a track carries a `rekordboxId`. USB
 * export tracks also set `streamUrl` to route *audio* through the device
 * endpoint, so keying the peaks decision off `streamUrl`/`isStream` first would
 * misroute them into the SoundCloud branch — which, lacking a `waveformUrl`,
 * falls back to a flat placeholder and renders a peakless waveform. Checking
 * `rekordboxId` before the stream heuristic keeps that from happening while
 * leaving audio routing (which still uses `streamUrl`) untouched.
 */
export function selectPeaksSource(track: PlayerTrack): PeaksSource {
  if (track.rekordboxId) {
    return {
      kind: "rekordbox",
      id: track.rekordboxId,
      device: track.rekordboxDevice,
    };
  }
  const isStream = !!track.streamUrl || track.streamRefreshKey !== undefined;
  if (isStream) return { kind: "soundcloud", waveformUrl: track.waveformUrl };
  return { kind: "file" };
}
