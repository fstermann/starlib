import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchLikesPage,
  getMyLikedTracks,
  getUserLikedTracks,
  type SCTrack,
} from "@/lib/soundcloud";

interface UseLikesResult {
  tracks: SCTrack[];
  loading: boolean;
  loaded: number;
  hasMore: boolean;
  error: string | null;
  reload: () => void;
}

// ---------------------------------------------------------------------------
// In-memory cache (survives tab switches & re-mounts, lost on full reload)
// ---------------------------------------------------------------------------
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const likesCache = new Map<string, { tracks: SCTrack[]; fetchedAt: number }>();

function getCached(key: string): SCTrack[] | null {
  const entry = likesCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL) {
    likesCache.delete(key);
    return null;
  }
  return entry.tracks;
}

// ---------------------------------------------------------------------------
// Sequential cursor-based pagination
// ---------------------------------------------------------------------------
const PAGE_SIZE = 200;

async function fetchAllPages(
  userUrn: string | "me",
  signal: AbortSignal,
  onProgress: (tracks: SCTrack[]) => void,
): Promise<SCTrack[]> {
  const allTracks: SCTrack[] = [];

  // First page via typed client
  const first =
    userUrn === "me"
      ? await getMyLikedTracks(PAGE_SIZE)
      : await getUserLikedTracks(userUrn, PAGE_SIZE);

  if (signal.aborted) return allTracks;

  const page = first.collection ?? [];
  if (page.length > 0) allTracks.push(...page);
  onProgress([...allTracks]);

  // Subsequent pages: follow next_href directly (cursor-based)
  let nextUrl = first.next_href;

  while (nextUrl && !signal.aborted) {
    const resp = await fetchLikesPage(nextUrl);
    if (signal.aborted) return allTracks;

    const tracks = resp.collection ?? [];
    if (tracks.length > 0) allTracks.push(...tracks);
    onProgress([...allTracks]);

    nextUrl = resp.next_href;
  }

  return allTracks;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useLikes(userUrn: string | "me" | null): UseLikesResult {
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Seed from the cache (or reset for a fresh fetch) as soon as the user
  // changes, so the effect below only has to start the network work.
  const [seededUrn, setSeededUrn] = useState<string | null>(null);
  if (userUrn && userUrn !== seededUrn) {
    setSeededUrn(userUrn);
    const cached = getCached(userUrn);
    setTracks(cached ?? []);
    setHasMore(!cached);
    setLoading(!cached);
    setError(null);
  }

  const fetchAll = useCallback(
    (signal: AbortSignal) => {
      if (!userUrn) return;
      fetchAllPages(userUrn, signal, (progress) => {
        if (!signal.aborted) setTracks(progress);
      })
        .then((all) => {
          if (signal.aborted) return;
          setTracks(all);
          setHasMore(false);
          likesCache.set(userUrn, { tracks: all, fetchedAt: Date.now() });
        })
        .catch((err) => {
          if (signal.aborted) return;
          setError(
            err instanceof Error ? err.message : "Failed to fetch likes",
          );
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false);
        });
    },
    [userUrn],
  );

  useEffect(() => {
    abortRef.current?.abort();
    if (!userUrn || getCached(userUrn)) return;
    const controller = new AbortController();
    abortRef.current = controller;
    fetchAll(controller.signal);
    return () => controller.abort();
  }, [fetchAll, userUrn]);

  const reload = useCallback(() => {
    abortRef.current?.abort();
    if (!userUrn) return;
    likesCache.delete(userUrn);
    setTracks([]);
    setLoading(true);
    setHasMore(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    fetchAll(controller.signal);
  }, [fetchAll, userUrn]);

  return { tracks, loading, loaded: tracks.length, hasMore, error, reload };
}
