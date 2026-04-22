"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { resolveUrl, searchTracks, type SCTrack } from "@/lib/soundcloud";

export interface UseSoundcloudTrackSearchResult {
  tracks: SCTrack[];
  loading: boolean;
  loaded: number;
  hasMore: boolean;
  error: string | null;
  reload: () => void;
}

const TRACK_URL_RE = /^https?:\/\/(www\.)?soundcloud\.com\//i;
const DEBOUNCE_MS = 400;
const RESULT_LIMIT = 50;

export function useSoundcloudTrackSearch(
  query: string,
): UseSoundcloudTrackSearchResult {
  const [tracks, setTracks] = useState<SCTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastQueryRef = useRef<string>("");

  const run = useCallback(async (q: string, signal: AbortSignal) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setTracks([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (TRACK_URL_RE.test(trimmed)) {
        const resolved = await resolveUrl(trimmed);
        if (signal.aborted) return;
        if (resolved && "title" in resolved) {
          setTracks([resolved as SCTrack]);
        } else {
          setTracks([]);
          setError("URL did not resolve to a track");
        }
      } else {
        const results = await searchTracks(trimmed, RESULT_LIMIT);
        if (signal.aborted) return;
        setTracks(results);
      }
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : "SoundCloud search failed");
      setTracks([]);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    lastQueryRef.current = query;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const trimmed = query.trim();
    if (!trimmed) {
      setTracks([]);
      setError(null);
      setLoading(false);
      return () => controller.abort();
    }

    const timeout = setTimeout(
      () => run(query, controller.signal),
      DEBOUNCE_MS,
    );
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, run]);

  const reload = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    run(lastQueryRef.current, controller.signal);
  }, [run]);

  return {
    tracks,
    loading,
    loaded: tracks.length,
    hasMore: false,
    error,
    reload,
  };
}
