"use client";

import { useCallback, useEffect, useReducer, useState } from "react";

import {
  getJobSnapshot,
  subscribeToJob,
  type AnalyserEvent,
} from "@/lib/analyser";

import {
  analyserReducer,
  INITIAL_STATE,
  type AnalyserAction,
  type AnalyserUiState,
} from "../_state";

export interface UseAnalyserJobResult {
  state: AnalyserUiState;
  dispatch: React.Dispatch<AnalyserAction>;
  /**
   * Force a fresh snapshot fetch + SSE re-subscribe. Call this after
   * triggering a backend action that flips the job back into ``running``
   * (e.g. ``startShazamScan``) — the previous SSE connection has already
   * been closed by the close-on-terminal handler, so without an explicit
   * reconnect the new pass would stream into the void.
   */
  refresh: () => void;
}

/**
 * Loads a job snapshot and subscribes to its SSE stream.
 *
 * The snapshot replay populates the UI without waiting for the next live
 * event — important for late subscribers and for the deep-link / reload
 * paths. The SSE subscription tears down on unmount or job-id change.
 */
export function useAnalyserJob(jobId: string | null): UseAnalyserJobResult {
  const [state, dispatch] = useReducer(analyserReducer, INITIAL_STATE);
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((e) => e + 1), []);

  useEffect(() => {
    if (!jobId) {
      dispatch({ type: "reset" });
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      try {
        const snap = await getJobSnapshot(jobId);
        if (cancelled) return;
        dispatch({ type: "load.snapshot", snapshot: snap });
      } catch (err) {
        console.error("analyser: snapshot load failed", err);
      }

      if (cancelled) return;
      unsubscribe = subscribeToJob(jobId, (event: AnalyserEvent) => {
        dispatch({ type: "sse", event });
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [jobId, epoch]);

  return { state, dispatch, refresh };
}
