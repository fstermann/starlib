import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchRepostsPage,
  getMyRepostedTracks,
  getUserRepostedTracks,
  type SCTrack,
} from "@/lib/soundcloud";

interface UseRepostsResult {
  tracks: SCTrack[];
  loading: boolean;
  loaded: number;
  hasMore: boolean;
  error: string | null;
  reload: () => void;
}

const CACHE_TTL = 5 * 60 * 1000;
const repostsCache = new Map<
  string,
  { tracks: SCTrack[]; fetchedAt: number }
>();

function getCached(key: string): SCTrack[] | null {
  const entry = repostsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL) {
    repostsCache.delete(key);
    return null;
  }
  return entry.tracks;
}

const PAGE_SIZE = 200;

async function fetchAllPages(
  userUrn: string | "me",
  signal: AbortSignal,
  onProgress: (tracks: SCTrack[]) => void,
): Promise<SCTrack[]> {
  const allTracks: SCTrack[] = [];

  const first =
    userUrn === "me"
      ? await getMyRepostedTracks(PAGE_SIZE)
      : await getUserRepostedTracks(userUrn, PAGE_SIZE);

  if (signal.aborted) return allTracks;

  const page = first.collection ?? [];
  if (page.length > 0) allTracks.push(...page);
  onProgress([...allTracks]);

  let nextUrl = first.next_href;

  while (nextUrl && !signal.aborted) {
    const resp = await fetchRepostsPage(nextUrl);
    if (signal.aborted) return allTracks;

    const tracks = resp.collection ?? [];
    if (tracks.length > 0) allTracks.push(...tracks);
    onProgress([...allTracks]);

    nextUrl = resp.next_href;
  }

  return allTracks;
}

export function useReposts(userUrn: string | "me" | null): UseRepostsResult {
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
          repostsCache.set(userUrn, { tracks: all, fetchedAt: Date.now() });
        })
        .catch((err) => {
          if (signal.aborted) return;
          setError(
            err instanceof Error ? err.message : "Failed to fetch reposts",
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
    repostsCache.delete(userUrn);
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
