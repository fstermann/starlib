import { useEffect, useState } from "react";

import { ApiError, fetchApi } from "@/lib/api";

export interface SystemPlaylistSummary {
  urn: string;
  title: string;
  short_title: string | null;
  description: string | null;
  artwork_url: string | null;
  track_count: number;
  last_updated: string | null;
  permalink_url: string | null;
  track_ids: number[];
}

interface SystemPlaylistsResponse {
  playlists: SystemPlaylistSummary[];
}

interface UseSystemPlaylistsResult {
  playlists: SystemPlaylistSummary[];
  /** `false` only when the backend explicitly 404s the feature. */
  available: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const CACHE_TTL = 5 * 60 * 1000;
let cached: { playlists: SystemPlaylistSummary[]; fetchedAt: number } | null =
  null;

/** Fetches the SoundCloud-generated mixes (Weekly Wave, Daily Drops, Your
 * Mix N…). `enabled=false` skips the request entirely — used to gate this
 * hook to the "my library" tab, since mixes are personal. */
export function useSystemPlaylists(enabled: boolean): UseSystemPlaylistsResult {
  const [playlists, setPlaylists] = useState<SystemPlaylistSummary[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when feature disabled
      setPlaylists([]);
      setAvailable(true);
      setLoading(false);
      setError(null);
      return;
    }

    if (
      cached &&
      Date.now() - cached.fetchedAt < CACHE_TTL &&
      reloadKey === 0
    ) {
      setPlaylists(cached.playlists);
      setAvailable(true);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchApi<SystemPlaylistsResponse>("/api/soundcloud/system-playlists")
      .then((data) => {
        if (cancelled) return;
        cached = { playlists: data.playlists, fetchedAt: Date.now() };
        setPlaylists(data.playlists);
        setAvailable(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // 404 = session cookie not configured on this install → hide UI.
          setAvailable(false);
          setPlaylists([]);
          setError(null);
          return;
        }
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load system playlists",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  return {
    playlists,
    available,
    loading,
    error,
    reload: () => {
      cached = null;
      setReloadKey((k) => k + 1);
    },
  };
}
