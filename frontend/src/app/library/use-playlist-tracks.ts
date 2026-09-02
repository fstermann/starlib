import { useEffect, useState } from "react";

import { getPlaylistTracks, type SCTrack } from "@/lib/soundcloud";

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { tracks: SCTrack[]; fetchedAt: number }>();
const inflight = new Map<string, Promise<SCTrack[]>>();

function getCached(urn: string): SCTrack[] | null {
  const entry = cache.get(urn);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL) {
    cache.delete(urn);
    return null;
  }
  return entry.tracks;
}

/** Drop a playlist's cached track list so the next fetch is fresh. Call after
 *  mutating the playlist (add/remove) so membership checks and the playlist
 *  view re-read the real contents. */
export function invalidatePlaylistTracks(urn: string) {
  cache.delete(urn);
  inflight.delete(urn);
}

/**
 * Fetches all tracks for a playlist, paginating through all pages.
 * Results are cached per-urn for CACHE_TTL; concurrent callers share the
 * in-flight promise so each playlist is fetched at most once.
 */
export async function fetchAllPlaylistTracks(urn: string): Promise<SCTrack[]> {
  const cached = getCached(urn);
  if (cached) return cached;

  const existing = inflight.get(urn);
  if (existing) return existing;

  const promise = (async () => {
    const all: SCTrack[] = [];
    let nextHref: string | undefined = undefined;
    do {
      const page = await getPlaylistTracks(urn, nextHref);
      const batch = page.collection ?? [];
      all.push(...batch);
      nextHref = page.next_href ?? undefined;
    } while (nextHref);
    cache.set(urn, { tracks: all, fetchedAt: Date.now() });
    return all;
  })();

  inflight.set(urn, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(urn);
  }
}

interface UsePlaylistTracksResult {
  tracks: SCTrack[];
  loading: boolean;
  error: string | null;
}

export function usePlaylistTracks(
  playlistUrn: string | null,
): UsePlaylistTracksResult {
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!playlistUrn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when input becomes null
      setTracks([]);
      setLoading(false);
      setError(null);
      return;
    }

    const cached = getCached(playlistUrn);
    if (cached) {
      setTracks(cached);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setTracks([]);
    setLoading(true);
    setError(null);

    fetchAllPlaylistTracks(playlistUrn)
      .then((all) => {
        if (!cancelled) setTracks(all);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load playlist",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [playlistUrn]);

  return { tracks, loading, error };
}
