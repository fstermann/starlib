"use client";

import { useCallback, useEffect, useReducer, useState } from "react";

import {
  getJobSnapshot,
  subscribeToJob,
  type BreakdownEvent,
} from "@/lib/breakdown";

import {
  breakdownReducer,
  INITIAL_STATE,
  type BreakdownAction,
  type BreakdownUiState,
} from "../_state";

export interface UseBreakdownJobResult {
  state: BreakdownUiState;
  dispatch: React.Dispatch<BreakdownAction>;
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
export function useBreakdownJob(jobId: string | null): UseBreakdownJobResult {
  const [state, dispatch] = useReducer(breakdownReducer, INITIAL_STATE);
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
        console.error("breakdown: snapshot load failed", err);
      }

      if (cancelled) return;
      unsubscribe = subscribeToJob(jobId, (event: BreakdownEvent) => {
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
