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

// Cross-instance reload: the sidebar tree and the tracks table each mount their
// own useUserPlaylists. When one mutates playlists (create/add/remove), every
// mounted instance must refetch — otherwise the sidebar goes stale. Subscribers
// are notified to bump their reload key.
const subscribers = new Set<() => void>();

function cacheKey(userUrn: string | "me" | null) {
  return userUrn ?? "";
}

/** Invalidate the cached playlists for `userUrn` and refresh every mounted
 *  useUserPlaylists (e.g. after creating a playlist — a refetch picks it up). */
export function reloadUserPlaylists(userUrn: string | "me" | null) {
  if (userUrn) cache.delete(cacheKey(userUrn));
  subscribers.forEach((fn) => fn());
}

/**
 * Apply an optimistic edit to the cached playlists for `userUrn` and refresh
 * every mounted useUserPlaylists — without refetching. Use for delete/rename:
 * SoundCloud's GET /me/playlists is eventually consistent and can still return
 * a just-deleted (or just-renamed) playlist, so a refetch would show stale
 * data until it propagates.
 */
export function mutateCachedUserPlaylists(
  userUrn: string | "me" | null,
  updater: (playlists: SCPlaylist[]) => SCPlaylist[],
) {
  const entry = cache.get(cacheKey(userUrn));
  if (entry) {
    cache.set(cacheKey(userUrn), {
      playlists: updater(entry.playlists),
      fetchedAt: entry.fetchedAt,
    });
  }
  subscribers.forEach((fn) => fn());
}

export function useUserPlaylists(
  userUrn: string | "me" | null,
): UseUserPlaylistsResult {
  const [playlists, setPlaylists] = useState<SCPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const bump = () => setReloadKey((k) => k + 1);
    subscribers.add(bump);
    return () => {
      subscribers.delete(bump);
    };
  }, []);

  useEffect(() => {
    if (!userUrn) {
      setPlaylists([]);
      return;
    }

    // A reload deletes the cache entry (see reloadUserPlaylists) and bumps
    // reloadKey to re-run this effect, so a surviving fresh entry means nothing
    // changed for this user — reuse it rather than refetch.
    const key = cacheKey(userUrn);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
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
    reload: () => reloadUserPlaylists(userUrn),
  };
}
