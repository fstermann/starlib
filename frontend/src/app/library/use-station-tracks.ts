import { useEffect, useState } from "react";

import { fetchApi } from "@/lib/api";
import type { SCTrack } from "@/lib/soundcloud";

interface StationTracksResponse {
  title: string | null;
  tracks: SCTrack[];
}

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<
  string,
  { title: string | null; tracks: SCTrack[]; fetchedAt: number }
>();

interface UseStationTracksResult {
  title: string | null;
  tracks: SCTrack[];
  loading: boolean;
  error: string | null;
}

/** Load a track-station's tracks by seed track id. The backend proxies
 * api-v2 and returns SCTrack-shaped objects; needs the SoundCloud session
 * cookie, so this 404s (surfaced as an error) when Mixes are unavailable. */
export function useStationTracks(
  seedTrackId: string | null,
): UseStationTracksResult {
  const [title, setTitle] = useState<string | null>(null);
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seedTrackId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when input becomes null
      setTracks([]);
      setTitle(null);
      setLoading(false);
      setError(null);
      return;
    }

    const entry = cache.get(seedTrackId);
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) {
      setTitle(entry.title);
      setTracks(entry.tracks);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchApi<StationTracksResponse>(
      `/api/soundcloud/stations/${encodeURIComponent(seedTrackId)}/tracks`,
    )
      .then((data) => {
        if (cancelled) return;
        cache.set(seedTrackId, {
          title: data.title,
          tracks: data.tracks,
          fetchedAt: Date.now(),
        });
        setTitle(data.title);
        setTracks(data.tracks);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load station");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [seedTrackId]);

  return { title, tracks, loading, error };
}
