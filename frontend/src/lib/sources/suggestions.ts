/**
 * Client + React hook for the metadata suggestion engine.
 *
 * The hook owns three concerns:
 *
 * 1. Debounce keystroke-driven re-fetches (the editor's `current` state changes
 *    every keystroke; we don't want a request per character).
 * 2. Drop suggestions whose top candidate already equals the in-flight value
 *    *after* normalization on the client. The server already filters by exact
 *    equality, but the editor is lazy and stores list fields as joined
 *    strings — comparing again here keeps the diff pill from flickering when
 *    the user types something equivalent in spirit.
 * 3. Expose two ergonomic actions: ``accept(field, suggestion)`` writes a
 *    single value through the supplied setter, and ``acceptAll()`` writes
 *    every top-ranked suggestion in one go.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { components } from "@/generated/backend";
import { fetchApi } from "@/lib/api";
import type { SCTrack } from "@/lib/soundcloud";

export type FieldSuggestion = components["schemas"]["FieldSuggestion"];
export type SuggestionRequest = components["schemas"]["SuggestionRequest"];
export type SuggestionResponse = components["schemas"]["SuggestionResponse"];

export type SuggestionMap = Record<string, FieldSuggestion[]>;

/** Editor field names the suggester pipeline targets. */
export type SuggestionField =
  | "title"
  | "artist"
  | "genre"
  | "bpm"
  | "key"
  | "original_artist"
  | "remixer"
  | "mix_name"
  | "release_date"
  | "release_year"
  | "artwork_url";

export async function fetchTrackSuggestions(
  filePath: string,
  scTrack: SCTrack | null,
  current: SuggestionRequest["current"],
  signal?: AbortSignal,
): Promise<SuggestionResponse> {
  return fetchApi("/api/suggestions/track", {
    method: "POST",
    body: JSON.stringify({
      file_path: filePath,
      sc_track: scTrack ?? null,
      current,
    } satisfies SuggestionRequest),
    signal,
  });
}

interface UseTrackSuggestionsArgs {
  filePath: string | null;
  scTrack: SCTrack | null;
  /** Stringified editor state. Equality is checked by reference, so callers
   *  should pass a stable object that only changes when the form does. */
  current: Record<string, unknown>;
  /** Per-field setter — called when the user accepts a suggestion. */
  onAccept: (field: SuggestionField, value: unknown) => void;
  /** Disables the hook entirely (e.g. for tests, or while the editor is
   *  loading initial data). */
  enabled?: boolean;
  /** Debounce delay in ms; 300 keeps the keystroke rate under control without
   *  being noticeable. */
  debounceMs?: number;
}

interface UseTrackSuggestionsResult {
  suggestions: SuggestionMap;
  loading: boolean;
  error: string | null;
  /** Apply the supplied suggestion to a single field. */
  accept: (field: SuggestionField, suggestion: FieldSuggestion) => void;
  /** Apply the top-ranked suggestion for every field at once. */
  acceptAll: () => void;
  /** Number of fields that currently have at least one suggestion to apply. */
  pendingCount: number;
}

const _NORMALIZE = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

export function useTrackSuggestions({
  filePath,
  scTrack,
  current,
  onAccept,
  enabled = true,
  debounceMs = 300,
}: UseTrackSuggestionsArgs): UseTrackSuggestionsResult {
  const [suggestions, setSuggestions] = useState<SuggestionMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable JSON of `current` so an unchanged object doesn't re-fetch.
  const currentKey = useMemo(() => JSON.stringify(current), [current]);

  // Always read the latest `current` and `onAccept` inside callbacks.
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;

  useEffect(() => {
    if (!enabled || !filePath) {
      setSuggestions({});
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetchTrackSuggestions(
          filePath,
          scTrack,
          JSON.parse(currentKey),
          controller.signal,
        );
        // Client-side dedup against current: belt-and-braces (the server does
        // this too), but normalises strings (trim/lower) which the server's
        // strict comparator does not.
        const filtered: SuggestionMap = {};
        const parsed = JSON.parse(currentKey) as Record<string, unknown>;
        for (const [field, candidates] of Object.entries(response.fields ?? {})) {
          const cur = _NORMALIZE(parsed[field]);
          const kept = candidates.filter(
            (c: FieldSuggestion) => _NORMALIZE(c.value) !== cur,
          );
          if (kept.length) filtered[field] = kept;
        }
        setSuggestions(filtered);
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load suggestions");
        setSuggestions({});
      } finally {
        setLoading(false);
      }
    }, debounceMs);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, filePath, scTrack, currentKey, debounceMs]);

  const accept = (field: SuggestionField, suggestion: FieldSuggestion) => {
    onAcceptRef.current(field, suggestion.value);
    // Optimistic prune: drop the field locally so the button vanishes
    // immediately. The next fetch will reconcile.
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const acceptAll = () => {
    for (const [field, candidates] of Object.entries(suggestions)) {
      const top = candidates[0];
      if (!top) continue;
      onAcceptRef.current(field as SuggestionField, top.value);
    }
    setSuggestions({});
  };

  return {
    suggestions,
    loading,
    error,
    accept,
    acceptAll,
    pendingCount: Object.keys(suggestions).length,
  };
}
