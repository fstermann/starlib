import type { PlayerTrack } from "@/lib/player-context";

/** Which analysis source the player derives its waveform peaks from. */
export type PeaksSource =
  | { kind: "rekordbox"; id: string; device?: string }
  | { kind: "soundcloud"; waveformUrl?: string }
  | { kind: "file" };

/**
 * Pick the peaks source for a track.
 *
 * Rekordbox analysis (PWV4) wins whenever a track carries a `rekordboxId`.
 * SoundCloud is keyed off `streamRefreshKey`, not `streamUrl`: Rekordbox tracks
 * also set `streamUrl` to stream audio by id, and treating them as SoundCloud
 * would render a flat placeholder waveform.
 */
export function selectPeaksSource(track: PlayerTrack): PeaksSource {
  if (track.rekordboxId) {
    return {
      kind: "rekordbox",
      id: track.rekordboxId,
      device: track.rekordboxDevice,
    };
  }
  if (track.streamRefreshKey !== undefined)
    return { kind: "soundcloud", waveformUrl: track.waveformUrl };
  return { kind: "file" };
}
