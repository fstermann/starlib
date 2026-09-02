"use client";

import * as React from "react";

import { fetchFilesystemSchema } from "@/lib/filters/filesystem-adapter";
import type { FilterSchemaResponse, FilterState } from "@/lib/filters/schema";
import { buildSoundcloudSchema } from "@/lib/filters/soundcloud-adapter";
import type { SCTrack } from "@/lib/soundcloud";

export type FilterSchemaSource =
  | {
      source: "filesystem";
      mode?: string;
      folderPath?: string;
      state: FilterState;
    }
  | {
      source: "soundcloud";
      tracks: SCTrack[];
      bpmByTrack?: Map<number, number>;
    };

export interface UseFilterSchemaResult {
  schema: FilterSchemaResponse | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Uniform schema source. Filesystem hits the backend (with dependent counts
 * conditioned on current filter state); SoundCloud computes in-browser from
 * the track list. Consumers see one interface.
 *
 * Caller is responsible for debouncing the input (e.g. debounce `state` so
 * each keystroke doesn't re-fetch). This hook re-runs whenever the relevant
 * inputs change.
 */
export function useFilterSchema(
  input: FilterSchemaSource,
): UseFilterSchemaResult {
  const [schema, setSchema] = React.useState<FilterSchemaResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  // SoundCloud: synchronous compute; memoize on tracks + bpm-map reference.
  const scTracks = input.source === "soundcloud" ? input.tracks : null;
  const scBpm = input.source === "soundcloud" ? input.bpmByTrack : undefined;
  const scSchema = React.useMemo(() => {
    if (!scTracks) return null;
    return buildSoundcloudSchema({ tracks: scTracks, bpmByTrack: scBpm });
  }, [scTracks, scBpm]);

  // Filesystem: async fetch; re-run on state/folder changes.
  const fsKey =
    input.source === "filesystem"
      ? JSON.stringify({
          mode: input.mode,
          folderPath: input.folderPath,
          state: input.state,
        })
      : null;

  // Capture current fetch inputs in a ref so the debounce closure reads the
  // freshest values without invalidating the effect on every render.
  const fsInputsRef = React.useRef(input);
  fsInputsRef.current = input;

  React.useEffect(() => {
    if (input.source !== "filesystem") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const fresh = fsInputsRef.current;
      if (fresh.source !== "filesystem") return;
      setLoading(true);
      setError(null);
      fetchFilesystemSchema({
        mode: fresh.mode,
        folderPath: fresh.folderPath,
        state: fresh.state,
      })
        .then((next) => {
          if (!cancelled) setSchema(next);
        })
        .catch((e: unknown) => {
          if (!cancelled)
            setError(e instanceof Error ? e : new Error(String(e)));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on fsKey
  }, [fsKey]);

  if (input.source === "soundcloud") {
    return { schema: scSchema, loading: false, error: null };
  }
  return { schema, loading, error };
}
