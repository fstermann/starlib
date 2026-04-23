import { useEffect, useState } from "react";

import { fetchApi } from "@/lib/api";
import type { SCTrack } from "@/lib/soundcloud";

interface SystemPlaylistTracksResponse {
  tracks: SCTrack[];
}

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { tracks: SCTrack[]; fetchedAt: number }>();

interface UseSystemPlaylistTracksResult {
  tracks: SCTrack[];
  loading: boolean;
  error: string | null;
}

/** Hydrate a system-playlist URN to full tracks. The backend calls api-v2
 * and returns SCTrack-shaped objects (api-v2 Track is a field-superset of
 * the public /tracks payload). */
export function useSystemPlaylistTracks(
  urn: string | null,
): UseSystemPlaylistTracksResult {
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!urn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when input becomes null
      setTracks([]);
      setLoading(false);
      setError(null);
      return;
    }

    const entry = cache.get(urn);
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) {
      setTracks(entry.tracks);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchApi<SystemPlaylistTracksResponse>(
      `/api/soundcloud/system-playlists/${encodeURIComponent(urn)}/tracks`,
    )
      .then((data) => {
        if (cancelled) return;
        cache.set(urn, { tracks: data.tracks, fetchedAt: Date.now() });
        setTracks(data.tracks);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load mix");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [urn]);

  return { tracks, loading, error };
}
