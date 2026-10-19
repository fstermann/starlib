"use client";

import { useCallback, useEffect, useState } from "react";

import {
  getLoudness,
  getLoudnessProgress,
  measureLoudness,
  type LoudnessReport,
} from "@/lib/breakdown";

import type { BreakdownUiState } from "../_state";

const TARGET_STORAGE_KEY = "starlib.breakdown.loudnessTarget";
const CHART_STORAGE_KEY = "starlib.breakdown.timelineChart";
const PROGRESS_POLL_MS = 500;

/** What the timeline's top lane plots. */
export type TimelineChart = "bpm" | "lufs";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice just isn't remembered.
  }
}

/** A set's loudness report and its measurement. */
export interface LoudnessReading {
  report: LoudnessReport | null;
  measuring: boolean;
  /** Fraction measured while measuring, 0 to 1; null before the backend reports any. */
  progress: number | null;
  error: string | null;
  /** Resolves true once the report is in. */
  measure: () => Promise<boolean>;
}

type ReadingState = Omit<LoudnessReading, "measure">;

const NOT_LOADED: ReadingState = {
  report: null,
  measuring: false,
  progress: null,
  error: null,
};

export interface LoudnessReadings {
  reading: (jobId: string) => ReadingState;
  measure: (jobId: string) => Promise<boolean>;
}

/** Loudness reports of several sets, re-read whenever ``refreshKey`` or ``minMatches`` changes. */
export function useLoudnessReports(
  jobIds: string[],
  refreshKey = "",
  minMatches = 1,
): LoudnessReadings {
  // Keyed by job, so switching jobs never shows another set's report.
  const [states, setStates] = useState<Record<string, ReadingState>>({});
  const update = useCallback(
    (jobId: string, patch: Partial<ReadingState>) =>
      setStates((all) => ({
        ...all,
        [jobId]: { ...(all[jobId] ?? NOT_LOADED), ...patch },
      })),
    [],
  );

  const idsKey = jobIds.join(",");
  useEffect(() => {
    let cancelled = false;
    for (const jobId of idsKey ? idsKey.split(",") : []) {
      getLoudness(jobId, minMatches)
        .then((res) => {
          if (!cancelled) update(jobId, { report: res.report });
        })
        .catch((err) => console.warn("breakdown: loudness read failed", err));
    }
    return () => {
      cancelled = true;
    };
  }, [idsKey, refreshKey, minMatches, update]);

  const measure = useCallback(
    async (jobId: string) => {
      update(jobId, { measuring: true, progress: null, error: null });
      const poll = setInterval(() => {
        getLoudnessProgress(jobId)
          .then((res) => {
            if (res.progress != null) update(jobId, { progress: res.progress });
          })
          .catch(() => {
            // A missed poll only delays the bar.
          });
      }, PROGRESS_POLL_MS);
      try {
        update(jobId, {
          report: (await measureLoudness(jobId, minMatches)).report,
        });
        return true;
      } catch (err) {
        update(jobId, {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      } finally {
        clearInterval(poll);
        update(jobId, { measuring: false });
      }
    },
    [minMatches, update],
  );

  const reading = useCallback(
    (jobId: string) => states[jobId] ?? NOT_LOADED,
    [states],
  );
  return { reading, measure };
}

/** The loudness report of ``jobId``, re-read whenever ``refreshKey`` or ``minMatches`` changes. */
export function useLoudnessReport(
  jobId: string | null,
  refreshKey = "",
  minMatches = 1,
): LoudnessReading {
  const readings = useLoudnessReports(
    jobId ? [jobId] : [],
    refreshKey,
    minMatches,
  );
  const measureJob = readings.measure;
  const measure = useCallback(
    async () => (jobId ? measureJob(jobId) : false),
    [jobId, measureJob],
  );
  return { ...(jobId ? readings.reading(jobId) : NOT_LOADED), measure };
}

export interface Loudness extends LoudnessReading {
  /** Target integrated loudness as typed, "" when unset. */
  target: string;
  setTarget: (value: string) => void;
  /** Input gain that brings the set to the target; null without both. */
  gainDb: number | null;
  chart: TimelineChart;
  setChart: (chart: TimelineChart) => void;
}

/** The set's loudness report, the target the user levels it to, and the timeline chart choice.
 *  Per-track levels cover the tracks the tracklist shows at ``minMatches``. */
export function useLoudness(
  state: BreakdownUiState,
  minMatches: number,
): Loudness {
  // Per-track levels follow the tracklist, so re-read the report when it changes.
  const segmentsKey = state.timeline.map((t) => t.start_s).join(",");
  const reading = useLoudnessReport(state.jobId, segmentsKey, minMatches);
  const { report } = reading;
  const [target, setTargetState] = useState(
    () => readStored(TARGET_STORAGE_KEY) ?? "",
  );
  const [chart, setChartState] = useState<TimelineChart>(() =>
    readStored(CHART_STORAGE_KEY) === "lufs" ? "lufs" : "bpm",
  );

  const setTarget = useCallback((value: string) => {
    setTargetState(value);
    store(TARGET_STORAGE_KEY, value);
  }, []);

  const setChart = useCallback((value: TimelineChart) => {
    setChartState(value);
    store(CHART_STORAGE_KEY, value);
  }, []);

  const measureReport = reading.measure;
  const measure = useCallback(async () => {
    const measured = await measureReport();
    if (measured) setChart("lufs");
    return measured;
  }, [measureReport, setChart]);

  const targetLufs = target.trim() === "" ? null : Number(target);
  const gainDb =
    report?.integrated_lufs != null &&
    targetLufs != null &&
    Number.isFinite(targetLufs)
      ? targetLufs - report.integrated_lufs
      : null;

  return {
    ...reading,
    measure,
    target,
    setTarget,
    gainDb,
    chart: report ? chart : "bpm",
    setChart,
  };
}

/** Where a limiter would act: true peaks above this after the input gain. */
export const TRUE_PEAK_CEILING_DBTP = -1;

/** Start times (s) of the curve steps whose true peak, plus ``gainDb``, exceeds the ceiling. */
export function peakOvers(report: LoudnessReport, gainDb: number): number[] {
  const { step_s, true_peak_dbtp } = report.curve;
  const overs: number[] = [];
  true_peak_dbtp.forEach((peak, i) => {
    if (peak + gainDb > TRUE_PEAK_CEILING_DBTP) overs.push(i * step_s);
  });
  return overs;
}

/** Match key between a tracklist row and its loudness segment. */
export function segmentKey(startS: number): string {
  return Math.max(0, startS).toFixed(1);
}
