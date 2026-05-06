import { useCallback, useEffect, useRef, useState } from "react";

import {
  getFeedTracksPage,
  parseSCTimestamp,
  type SCTrack,
} from "@/lib/soundcloud";

interface UseFollowingsTracksResult {
  tracks: SCTrack[];
  loading: boolean;
  loaded: number;
  error: string | null;
  reload: () => void;
}

// ---------------------------------------------------------------------------
// In-memory cache (survives tab switches, lost on reload)
// ---------------------------------------------------------------------------
const CACHE_TTL = 5 * 60 * 1000;
let followingsCache: { tracks: SCTrack[]; fetchedAt: number } | null = null;

function getCached(): SCTrack[] | null {
  if (!followingsCache) return null;
  if (Date.now() - followingsCache.fetchedAt > CACHE_TTL) {
    followingsCache = null;
    return null;
  }
  return followingsCache.tracks;
}

// ---------------------------------------------------------------------------
// Fetch tracks via paginated feed (newest first – stop once past the cutoff)
// ---------------------------------------------------------------------------
const PAGE_SIZE = 50;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

async function fetchRecentPages(
  signal: AbortSignal,
  onProgress: (tracks: SCTrack[]) => void,
): Promise<SCTrack[]> {
  const cutoff = Date.now() - TWO_WEEKS_MS;

  // The feed can surface the same track more than once (e.g. an original post
  // and reposts from multiple followed users). Dedupe by urn so downstream
  // consumers — most importantly the virtualizer keying rows by track.urn —
  // never see duplicate identities.
  const seen = new Set<string>();
  const allTracks: SCTrack[] = [];
  let nextHref: string | undefined;

  do {
    const { tracks, nextHref: next } = await getFeedTracksPage(
      PAGE_SIZE,
      nextHref,
    );
    nextHref = next;

    if (signal.aborted) return [];

    for (const t of tracks) {
      const key = t.urn;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      allTracks.push(t);
    }
    onProgress([...allTracks]);

    // Feed is newest-first. Once the oldest item on this page is before the
    // cutoff we know the rest will be too – stop paging.
    const oldest = tracks[tracks.length - 1];
    const oldestTs = parseSCTimestamp(oldest?.addedAt ?? oldest?.created_at);
    if (oldestTs != null && oldestTs < cutoff) break;
  } while (nextHref);

  return allTracks.filter((t) => {
    const ts = parseSCTimestamp(t.addedAt ?? t.created_at);
    return ts == null || ts >= cutoff;
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useFollowingsTracks(): UseFollowingsTracksResult {
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = useCallback(
    async (signal: AbortSignal, bypassCache = false) => {
      if (!bypassCache) {
        const cached = getCached();
        if (cached) {
          setTracks(cached);
          setLoading(false);
          setError(null);
          return;
        }
      }

      setLoading(true);
      setError(null);
      setTracks([]);

      try {
        const result = await fetchRecentPages(signal, (partial) => {
          if (!signal.aborted) setTracks(partial);
        });
        if (!signal.aborted) {
          followingsCache = { tracks: result, fetchedAt: Date.now() };
          setTracks(result);
        }
      } catch (err) {
        if (!signal.aborted) {
          setError(
            err instanceof Error ? err.message : "Failed to load tracks",
          );
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    fetchAll(controller.signal);
    return () => controller.abort();
  }, [fetchAll]);

  const reload = useCallback(() => {
    abortRef.current?.abort();
    followingsCache = null;
    const controller = new AbortController();
    abortRef.current = controller;
    fetchAll(controller.signal, true);
  }, [fetchAll]);

  return { tracks, loading, loaded: tracks.length, error, reload };
}
