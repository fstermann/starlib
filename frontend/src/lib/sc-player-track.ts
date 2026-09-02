import { api } from "@/lib/api";
import type { PlayerTrack } from "@/lib/player-context";
import type { SCTrack } from "@/lib/soundcloud";

/** Numeric SoundCloud track id parsed from its `urn`. Returns 0 when missing. */
function scTrackId(track: SCTrack): number {
  if (!track.urn) return 0;
  const parts = track.urn.split(":");
  return parseInt(parts[parts.length - 1], 10) || 0;
}

/**
 * Build a `PlayerTrack` skeleton from a SoundCloud track. The player resolves
 * `streamUrl` on demand via the shared TTL cache, so only hints are filled in.
 * Pass `bpmCache` to enrich BPM from an analysis cache; otherwise the track's
 * own `bpm` (if any) is used.
 */
export function scTrackToPlayerTrack(
  track: SCTrack,
  bpmCache?: Map<number, number>,
): PlayerTrack {
  const id = scTrackId(track);
  return {
    filePath: `soundcloud:${id}`,
    fileName: track.title ?? String(id),
    title: track.title ?? undefined,
    artist: track.user?.username ?? undefined,
    waveformUrl: track.waveform_url ?? undefined,
    streamRefreshKey: id,
    permalinkUrl: track.permalink_url ?? undefined,
    artworkUrl: track.artwork_url
      ? api.proxyImageUrl(track.artwork_url)
      : undefined,
    bpm: bpmCache?.get(id) ?? track.bpm ?? null,
  };
}
