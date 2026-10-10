"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelTrackJob,
  getTrackBreakdown,
  startTrackJob,
  trackJobEventsUrl,
  type TrackBreakdown,
  type TrackJobEvent,
} from "@/lib/track-breakdown";

export type TrackJobState =
  | { status: "idle" }
  | {
      status: "running";
      jobId: string | null;
      stage: string | null;
      progress: number | null;
    }
  | { status: "error"; message: string }
  | { status: "cancelled" }
  | { status: "ready"; result: TrackBreakdown };

const STARTING: TrackJobState = {
  status: "running",
  jobId: null,
  stage: null,
  progress: null,
};

/**
 * Analyse `path` as soon as it is set and follow the job to its result.
 * A cached analysis completes within a second or two.
 */
export function useTrackJob(path: string | null) {
  const [runToken, setRunToken] = useState(0);
  const runKey = `${path}#${runToken}`;
  // State belongs to one run; a new path or re-run starts from STARTING.
  const [tracked, setTracked] = useState<{
    key: string;
    state: TrackJobState;
  } | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const state: TrackJobState = !path
    ? { status: "idle" }
    : tracked?.key === runKey
      ? tracked.state
      : STARTING;

  useEffect(() => {
    if (!path) return;
    let source: EventSource | null = null;
    let disposed = false;
    const update = (next: TrackJobState) => {
      if (!disposed) setTracked({ key: runKey, state: next });
    };

    const onEvent = async (event: TrackJobEvent) => {
      if (event.type === "stage") {
        update({
          status: "running",
          jobId: jobIdRef.current,
          stage: event.stage,
          progress: event.progress,
        });
        return;
      }
      source?.close();
      if (event.type === "complete") {
        try {
          update({
            status: "ready",
            result: await getTrackBreakdown(event.digest),
          });
        } catch (err) {
          update({ status: "error", message: String(err) });
        }
      } else if (event.type === "error") {
        update({ status: "error", message: event.message });
      } else {
        update({ status: "cancelled" });
      }
    };

    startTrackJob(path)
      .then((jobId) => {
        if (disposed) return;
        jobIdRef.current = jobId;
        source = new EventSource(trackJobEventsUrl(jobId));
        source.onmessage = (message) =>
          void onEvent(JSON.parse(message.data) as TrackJobEvent);
        // EventSource retries on its own and the server replays past events;
        // only a closed source means the job is gone.
        source.onerror = () => {
          if (source?.readyState === EventSource.CLOSED)
            update({ status: "error", message: "Lost connection to the job." });
        };
      })
      .catch((err: unknown) =>
        update({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );

    return () => {
      disposed = true;
      source?.close();
    };
  }, [path, runKey]);

  const cancel = useCallback(() => {
    if (jobIdRef.current) void cancelTrackJob(jobIdRef.current);
  }, []);

  const rerun = useCallback(() => setRunToken((n) => n + 1), []);

  const setResult = useCallback(
    (result: TrackBreakdown) =>
      setTracked({ key: runKey, state: { status: "ready", result } }),
    [runKey],
  );

  return { state, cancel, rerun, setResult };
}
