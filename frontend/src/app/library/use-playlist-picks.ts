import { useEffect, useState } from "react";

import { fetchApi } from "@/lib/api";
import type { SCTrack } from "@/lib/soundcloud";

/** A pick carries how many of the seed's playlists contain it. The table's
 *  opt-in "playlist_count" column reads this field. */
export type PlaylistPickTrack = SCTrack & { __playlistCount: number };

interface PlaylistPicksResponse {
  playlist_count: number;
  picks: { count: number; track: SCTrack }[];
}

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<
  string,
  { playlistCount: number; tracks: PlaylistPickTrack[]; fetchedAt: number }
>();

interface UsePlaylistPicksResult {
  /** How many playlists containing the seed were scanned. */
  playlistCount: number;
  tracks: PlaylistPickTrack[];
  loading: boolean;
  error: string | null;
}

/** Load tracks from the public playlists containing the seed track, ranked by
 *  how many of those playlists contain them. Backed by api-v2, so it needs the
 *  SoundCloud session cookie; the backend answers 404 without it. */
export function usePlaylistPicks(
  seedTrackId: string | null,
): UsePlaylistPicksResult {
  const [playlistCount, setPlaylistCount] = useState(0);
  const [tracks, setTracks] = useState<PlaylistPickTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seedTrackId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when input becomes null
      setTracks([]);
      setPlaylistCount(0);
      setLoading(false);
      setError(null);
      return;
    }

    const entry = cache.get(seedTrackId);
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) {
      setPlaylistCount(entry.playlistCount);
      setTracks(entry.tracks);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchApi<PlaylistPicksResponse>(
      `/api/soundcloud/playlist-picks/${encodeURIComponent(seedTrackId)}`,
    )
      .then((data) => {
        if (cancelled) return;
        const picked = data.picks.map((p) => ({
          ...p.track,
          __playlistCount: p.count,
        }));
        cache.set(seedTrackId, {
          playlistCount: data.playlist_count,
          tracks: picked,
          fetchedAt: Date.now(),
        });
        setPlaylistCount(data.playlist_count);
        setTracks(picked);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load playlist picks",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [seedTrackId]);

  return { playlistCount, tracks, loading, error };
}
