import {
  SC_BPM_UPDATED_EVENT,
  type ScBpmUpdatedDetail,
} from "@/components/soundcloud-batch-analyze-button";
import { api } from "@/lib/api";
import type { PlayerTrack } from "@/lib/player-context";
import { selectPeaksSource } from "@/lib/player-peaks";
import type { TrackAnalysis } from "@/lib/rekordbox-analysis";

// Only successes are cached: a failed download or analysis retries next time.
const cache = new Map<number, TrackAnalysis>();
const inflight = new Map<number, Promise<TrackAnalysis | null>>();

/** The SoundCloud track id of a streamed track, else null. */
export function soundcloudTrackId(track: PlayerTrack): number | null {
  if (selectPeaksSource(track).kind !== "soundcloud") return null;
  const id = Number(track.streamRefreshKey);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** The analysis already fetched for a track, without triggering a download. */
export function peekSoundcloudAnalysis(
  trackId: number,
): TrackAnalysis | undefined {
  return cache.get(trackId);
}

/**
 * Fetch a SoundCloud track's detected beatgrid/phrases once, inflight-deduped.
 * The first fetch makes the backend download and analyse the track.
 */
export function getCachedSoundcloudAnalysis(
  trackId: number,
): Promise<TrackAnalysis | null> {
  const hit = cache.get(trackId);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(trackId);
  if (!p) {
    p = api
      .getSoundcloudAnalysis(trackId)
      .then((data) => {
        cache.set(trackId, data);
        announceGridBpm(trackId, data);
        return data;
      })
      .catch(() => null)
      .finally(() => inflight.delete(trackId));
    inflight.set(trackId, p);
  }
  return p;
}

/**
 * SoundCloud's listed BPM is a whole number that can be off by 1-2 BPM; the
 * grid's tempo is measured. Publish it so the pitcher and queue sync on it.
 */
function announceGridBpm(trackId: number, analysis: TrackAnalysis) {
  const bpm = analysis.beatgrid[0]?.bpm;
  if (!bpm) return;
  window.dispatchEvent(
    new CustomEvent<ScBpmUpdatedDetail>(SC_BPM_UPDATED_EVENT, {
      detail: { trackId, bpm: Math.round(bpm * 100) / 100 },
    }),
  );
}
