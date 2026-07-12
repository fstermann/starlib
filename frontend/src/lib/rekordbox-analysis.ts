import type { components } from "@/generated/backend";
import { api } from "@/lib/api";

export type TrackAnalysis = components["schemas"]["TrackAnalysisResponse"];
export type AnalysisBeat = components["schemas"]["BeatModel"];
export type AnalysisSection = components["schemas"]["SectionModel"];
export type AnalysisCue = components["schemas"]["CueModel"];

// Module-level cache keyed by device+trackId, mirroring `loadWaveform` — the
// player and (later) row overlays request the same analysis; refetching per
// render would spam the backend.
const cache = new Map<string, TrackAnalysis | null>();
const inflight = new Map<string, Promise<TrackAnalysis | null>>();

function key(trackId: string, device: string | undefined): string {
  return device ? `${device}:${trackId}` : trackId;
}

/** Fetch a track's beatgrid/sections/cues once, cached and inflight-deduped. */
export function getCachedRekordboxAnalysis(
  trackId: string,
  device?: string,
): Promise<TrackAnalysis | null> {
  const k = key(trackId, device);
  const hit = cache.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = api
      .getRekordboxAnalysis(trackId, device)
      .catch(() => null)
      .then((data) => {
        cache.set(k, data);
        inflight.delete(k);
        return data;
      });
    inflight.set(k, p);
  }
  return p;
}
