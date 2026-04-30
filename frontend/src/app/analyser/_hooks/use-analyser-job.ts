"use client";

import { useEffect, useReducer } from "react";

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
  }, [jobId]);

  return { state, dispatch };
}
