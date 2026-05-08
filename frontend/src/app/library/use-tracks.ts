import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchTracksPage,
  getMyTracks,
  getUserTracks,
  parseSCTimestamp,
  type SCTrack,
} from "@/lib/soundcloud";

interface UseTracksResult {
  tracks: SCTrack[];
  loading: boolean;
  loaded: number;
  hasMore: boolean;
  error: string | null;
  reload: () => void;
}

const CACHE_TTL = 5 * 60 * 1000;
const tracksCache = new Map<string, { tracks: SCTrack[]; fetchedAt: number }>();

function getCached(key: string): SCTrack[] | null {
  const entry = tracksCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL) {
    tracksCache.delete(key);
    return null;
  }
  return entry.tracks;
}

const PAGE_SIZE = 200;

function sortByCreatedAtDesc(tracks: SCTrack[]): SCTrack[] {
  return [...tracks].sort((a, b) => {
    const ta = parseSCTimestamp(a.created_at) ?? 0;
    const tb = parseSCTimestamp(b.created_at) ?? 0;
    return tb - ta;
  });
}

async function fetchAllPages(
  userUrn: string | "me",
  signal: AbortSignal,
  onProgress: (tracks: SCTrack[]) => void,
): Promise<SCTrack[]> {
  const allTracks: SCTrack[] = [];

  const first =
    userUrn === "me"
      ? await getMyTracks(PAGE_SIZE)
      : await getUserTracks(userUrn, PAGE_SIZE);

  if (signal.aborted) return allTracks;

  const page = first.collection ?? [];
  if (page.length > 0) allTracks.push(...page);
  onProgress(sortByCreatedAtDesc(allTracks));

  let nextUrl = first.next_href;

  while (nextUrl && !signal.aborted) {
    const resp = await fetchTracksPage(nextUrl);
    if (signal.aborted) return allTracks;

    const tracks = resp.collection ?? [];
    if (tracks.length > 0) allTracks.push(...tracks);
    onProgress(sortByCreatedAtDesc(allTracks));

    nextUrl = resp.next_href;
  }

  return sortByCreatedAtDesc(allTracks);
}

export function useTracks(userUrn: string | "me" | null): UseTracksResult {
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = useCallback(
    async (signal: AbortSignal, bypassCache = false) => {
      if (!userUrn) return;

      if (!bypassCache) {
        const cached = getCached(userUrn);
        if (cached) {
          setTracks(cached);
          setHasMore(false);
          setLoading(false);
          setError(null);
          return;
        }
      }

      setTracks([]);
      setLoading(true);
      setHasMore(true);
      setError(null);

      try {
        const all = await fetchAllPages(userUrn, signal, (progress) => {
          if (!signal.aborted) setTracks(progress);
        });

        if (!signal.aborted) {
          setTracks(all);
          setHasMore(false);
          tracksCache.set(userUrn, { tracks: all, fetchedAt: Date.now() });
        }
      } catch (err) {
        if (signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to fetch tracks");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [userUrn],
  );

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetchAll(controller.signal);
    return () => controller.abort();
  }, [fetchAll]);

  const reload = useCallback(() => {
    if (userUrn) tracksCache.delete(userUrn);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetchAll(controller.signal, true);
  }, [fetchAll, userUrn]);

  return { tracks, loading, loaded: tracks.length, hasMore, error, reload };
}
