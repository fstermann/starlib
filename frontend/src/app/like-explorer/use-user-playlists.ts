import { useEffect, useState } from "react";

import {
  getMyPlaylists,
  getUserPlaylists,
  type SCPlaylist,
  type SCPlaylists,
} from "@/lib/soundcloud";

interface UseUserPlaylistsResult {
  playlists: SCPlaylist[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { playlists: SCPlaylist[]; fetchedAt: number }>();

function cacheKey(userUrn: string | "me" | null) {
  return userUrn ?? "";
}

export function useUserPlaylists(
  userUrn: string | "me" | null,
): UseUserPlaylistsResult {
  const [playlists, setPlaylists] = useState<SCPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!userUrn) {
      setPlaylists([]);
      return;
    }

    const key = cacheKey(userUrn);
    const cached = cache.get(key);
    if (
      cached &&
      Date.now() - cached.fetchedAt < CACHE_TTL &&
      reloadKey === 0
    ) {
      setPlaylists(cached.playlists);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setPlaylists([]);
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const all: SCPlaylist[] = [];
        let nextHref: string | undefined = undefined;
        do {
          // show_tracks=false → playlist metadata only, much faster.
          // Tracks are fetched lazily per-playlist when selected.
          const page: SCPlaylists =
            userUrn === "me"
              ? await getMyPlaylists(50, nextHref, false)
              : await getUserPlaylists(userUrn!, 50, nextHref, false);
          if (cancelled) return;
          const batch = page.collection ?? [];
          all.push(...batch);
          setPlaylists([...all]);
          nextHref = page.next_href ?? undefined;
        } while (nextHref && !cancelled);

        if (cancelled) return;
        cache.set(key, { playlists: all, fetchedAt: Date.now() });
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

    load();
    return () => {
      cancelled = true;
    };
  }, [userUrn, reloadKey]);

  return {
    playlists,
    loading,
    error,
    reload: () => {
      if (userUrn) cache.delete(cacheKey(userUrn));
      setReloadKey((k) => k + 1);
    },
  };
}
