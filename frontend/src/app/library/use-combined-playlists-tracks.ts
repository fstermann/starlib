import { useEffect, useState } from "react";

import type { SCTrack } from "@/lib/soundcloud";

import { fetchAllPlaylistTracks } from "./use-playlist-tracks";

interface UseCombinedPlaylistsTracksResult {
  tracks: SCTrack[];
  loading: boolean;
  error: string | null;
}

const CONCURRENCY = 4;

/**
 * Fetches and concatenates tracks from every playlist in `urns`.
 * Tracks are deduplicated by urn. Updates progressively as playlists resolve.
 * Pass `null` to disable fetching.
 */
export function useCombinedPlaylistsTracks(
  urns: readonly string[] | null,
): UseCombinedPlaylistsTracksResult {
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable key so the effect reruns only when the set of urns actually changes.
  const key = urns ? urns.join("|") : null;

  useEffect(() => {
    if (!urns || urns.length === 0) {
      setTracks([]);
      setLoading(false);
      setError(null);
      return;
    }

    const list = [...urns];
    let cancelled = false;
    setTracks([]);
    setLoading(true);
    setError(null);

    const merged: SCTrack[] = [];
    const seen = new Set<string>();

    function absorb(batch: SCTrack[]) {
      for (const t of batch) {
        const u = t.urn;
        if (!u || seen.has(u)) continue;
        seen.add(u);
        merged.push(t);
      }
      if (!cancelled) setTracks([...merged]);
    }

    async function run() {
      try {
        const queue = [...list];
        async function worker() {
          while (!cancelled) {
            const next = queue.shift();
            if (!next) return;
            try {
              const all = await fetchAllPlaylistTracks(next);
              if (!cancelled) absorb(all);
            } catch {
              // Skip failed playlists; surface the first error below.
            }
          }
        }
        const workers = Array.from(
          { length: Math.min(CONCURRENCY, list.length) },
          () => worker(),
        );
        await Promise.all(workers);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load playlists",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { tracks, loading, error };
}
