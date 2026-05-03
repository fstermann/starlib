"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";

import {
  buildTracklistText,
  cancelShazamScan,
  DEFAULT_JOB_OPTIONS,
  reanalyse,
  resetJob,
  startAnalyserJob,
  startShazamScan,
  updateTrack,
  type AnalyserJobOptions,
  type JobSnapshot,
  type ShazamTier,
  type TrackTimelineEntry,
} from "@/lib/analyser";

import { AnalyserCommands } from "./_components/commands";
import { AnalyserControls } from "./_components/controls";
import { AnalyserDetailPane } from "./_components/detail-pane";
import { AnalyserHeader } from "./_components/header";
import { useSetAudio } from "./_components/set-waveform";
import { AnalyserStartScreen } from "./_components/start-screen";
import { AnalyserTimeline } from "./_components/timeline";
import { TracklistPanel } from "./_components/tracklist-panel";
import { useAnalyserJob } from "./_hooks/use-analyser-job";

function AnalyserPageInner() {
  const router = useRouter();
  const search = useSearchParams();
  // The URL is the single source of truth for which job we're viewing —
  // keeping a parallel `useState` would desync from external navigations
  // (palette "Open job", browser back, deep links to a different ?job=).
  const jobId = search.get("job");
  const initialUrl = search.get("url") ?? "";

  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] =
    useState<AnalyserJobOptions>(DEFAULT_JOB_OPTIONS);

  const { state, dispatch, refresh } = useAnalyserJob(jobId);
  // Lift the WaveSurfer instance to the page so the tracklist's
  // per-row "Play matched section" buttons can drive the same playback
  // surface as the timeline's transport. Container ref is attached
  // inside the timeline's WaveformLane.
  // Defer mounting WaveSurfer until the backend reports a duration —
  // the audio file lands in the cache during the first BPM pass, so an
  // early load races the cache and surfaces "audio not yet cached"
  // inside the waveform on the first run of a job.
  const audio = useSetAudio(jobId, state.meta.durationS > 0);
  // Cross-component focus signal — clicking a band on the timeline
  // bumps a counter so the tracklist scrolls + flashes the matching
  // row. A counter (rather than a single key) lets the same row be
  // re-focused on repeat clicks.
  const [focusedTrack, setFocusedTrack] = useState<{
    key: string;
    nonce: number;
  } | null>(null);
  const handleFocusTrack = useCallback((key: string) => {
    setFocusedTrack((prev) => ({ key, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  // Confirmed state lives on the track row in the DB now (was a
  // localStorage-keyed set before the consolidation). The set we
  // expose to children is just the ids of currently-confirmed tracks
  // so the existing prop shape (``confirmed: Set<string>``) doesn't
  // change — the value is rebuilt whenever ``state.timeline`` changes.
  const confirmed = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const t of state.timeline) {
      if (t.confirmed) out.add(String(t.id));
    }
    return out;
  }, [state.timeline]);
  const toggleConfirmed = useCallback(
    (trackKey: string) => {
      if (!jobId) return;
      const id = Number(trackKey);
      if (!Number.isFinite(id)) return;
      const current = state.timeline.find((t) => t.id === id);
      void updateTrack(jobId, id, { confirmed: !(current?.confirmed ?? false) })
        .then(refresh)
        .catch((err) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
    },
    [jobId, refresh, state.timeline],
  );

  const setJobId = useCallback(
    (id: string | null) => {
      router.replace(
        id ? `/analyser?job=${encodeURIComponent(id)}` : "/analyser",
      );
    },
    [router],
  );

  const handleStart = useCallback(
    async ({ url }: { url: string }) => {
      setError(null);
      try {
        const { job_id } = await startAnalyserJob({ url, options });
        setJobId(job_id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [options, setJobId],
  );

  const handleReanalyseSelection = useCallback(async () => {
    if (!jobId || !state.selection) return;
    try {
      await reanalyse(jobId, [state.selection], options);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, options, refresh, state.selection]);

  const handleReanalyseAll = useCallback(async () => {
    if (!jobId || !state.meta.durationS) return;
    try {
      await reanalyse(
        jobId,
        [{ start_s: 0, end_s: state.meta.durationS }],
        options,
      );
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, options, refresh, state.meta.durationS]);

  const handlePasteUrl = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      void handleStart({ url: text.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [handleStart]);

  // Backend gating mirror: each pitch strategy needs its own BPM input.
  //   none   → no BPM info needed
  //   single → target_bpm required (one pitch shift)
  //   range  → bpm_range required (three-pitch sweep)
  const shazamReady =
    options.pitch_strategy === "none" ||
    (options.pitch_strategy === "single" && options.target_bpm != null) ||
    (options.pitch_strategy === "range" && options.bpm_range != null);

  const handleRunShazam = useCallback(
    async (tier: ShazamTier) => {
      if (!jobId) return;
      try {
        await startShazamScan(jobId, { tier, overrides: options });
        // The previous SSE was closed when the BPM pass emitted
        // ``job.complete``. Re-open it so the user sees scan progress
        // live instead of having to refresh the page when the run
        // finishes.
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [jobId, options, refresh],
  );

  const handleScanRange = useCallback(
    async (
      range: { start_s: number; end_s: number },
      tier: ShazamTier,
    ) => {
      if (!jobId) return;
      try {
        await startShazamScan(jobId, {
          tier,
          region: [range.start_s, range.end_s],
          overrides: options,
        });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [jobId, options, refresh],
  );

  /** Tier completion derived from cached scans — the user has "run X"
   *  if any cached scan row carries that tier. Drives gating: refine
   *  unlocks once sweep ran, pinpoint once refine ran. */
  const tierCompleted = useMemo(() => {
    const seen = { sweep: false, refine: false, pinpoint: false };
    for (const s of state.scans) {
      const t = s.tier;
      if (t === "sweep" || t === "refine" || t === "pinpoint") seen[t] = true;
    }
    return seen;
  }, [state.scans]);

  /** Confirmed-track ranges for the DetailPane's "X tracks excluded" hint. */
  const confirmedRanges = useMemo<Array<[number, number]>>(() => {
    return state.timeline
      .filter((t) => t.confirmed)
      .map((t) => [t.start_s, t.end_s] as [number, number]);
  }, [state.timeline]);

  // Remember which job the user asked to stop. When the backend
  // transitions that job out of ``running`` the derived ``stopping``
  // flips to ``false`` automatically — no useEffect-driven setState
  // shenanigans needed.
  const [stopRequestedJob, setStopRequestedJob] = useState<string | null>(null);
  const stopping =
    stopRequestedJob != null &&
    stopRequestedJob === jobId &&
    state.status === "running";

  /** Drag-edit handler from the timeline. Now trivial — every track
   *  has a real id, so a drag is just a PATCH. No conversions, no
   *  hide+insert dances. */
  const handleEditBounds = useCallback(
    async (
      track: TrackTimelineEntry,
      bounds: { start_s: number | null; end_s: number | null },
    ) => {
      if (!jobId) return;
      try {
        await updateTrack(jobId, track.id, {
          start_s: bounds.start_s ?? undefined,
          end_s: bounds.end_s ?? undefined,
        });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [jobId, refresh],
  );

  const handleReset = useCallback(async () => {
    if (!jobId) return;
    try {
      await resetJob(jobId);
      // Auto-kick a fresh BPM pass so "reset" matches the user's mental
      // model of "start over" — without this the page sits at an empty
      // Complete snapshot and the user has to click Re-analyse all to
      // actually do anything.
      const dur = state.meta.durationS;
      if (dur > 0) {
        await reanalyse(jobId, [{ start_s: 0, end_s: dur }], options);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, options, refresh, state.meta.durationS]);

  const handleStopShazam = useCallback(async () => {
    if (!jobId) return;
    // Optimistic local state: the backend's cancel is acked instantly
    // but the run only actually finalises after the current scan-point
    // task gets interrupted (sub-second now, but still not zero). Show
    // the user we heard the click immediately.
    setStopRequestedJob(jobId);
    try {
      await cancelShazamScan(jobId);
    } catch (err) {
      setStopRequestedJob(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId]);

  // We're in the Shazam phase if we're running AND scan events have
  // started arriving. Avoids showing Stop during the BPM phase, which
  // can't be cancelled the same way.
  const shazamRunning = state.status === "running" && state.scans.length > 0;

  const snapshot = useMemo<JobSnapshot | null>(() => {
    if (!state.jobId) return null;
    const persistedStatus =
      state.status === "idle" || state.status === "loading"
        ? "pending"
        : state.status;
    return {
      id: state.jobId,
      soundcloud_id: null,
      source_url: null,
      title: state.meta.title,
      artist: state.meta.artist,
      duration_s: state.meta.durationS,
      status: persistedStatus,
      options,
      error: state.errorMessage,
      created_at: 0,
      updated_at: 0,
      windows: state.windows,
      sections: state.sections,
      scans: state.scans,
      timeline: state.timeline,
    };
  }, [
    options,
    state.errorMessage,
    state.jobId,
    state.meta.artist,
    state.meta.durationS,
    state.meta.title,
    state.sections,
    state.scans,
    state.status,
    state.timeline,
    state.windows,
  ]);

  const handleExportTracklist = useCallback(() => {
    if (!snapshot) return;
    const text = buildTracklistText(snapshot);
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(snapshot.title ?? "tracklist").replace(/\s+/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [snapshot]);

  if (!jobId) {
    return (
      <main className="flex h-full min-h-0 w-full flex-1 justify-center overflow-y-auto">
        <div className="flex w-full max-w-3xl flex-col gap-6 p-6">
          <AnalyserCommands
            state={state}
            hasJob={false}
            onPasteUrl={handlePasteUrl}
            onReanalyseSelection={handleReanalyseSelection}
            onExportTracklist={handleExportTracklist}
          />
          <AnalyserStartScreen
            onStart={handleStart}
            onOpen={(id) => setJobId(id)}
            initialUrl={initialUrl}
            errorMessage={error}
          />
        </div>
      </main>
    );
  }

  return (
    <main
      className="flex h-full min-h-0 w-full flex-1 justify-center overflow-hidden"
      data-testid="analyser-main"
    >
      {/* The page itself does not scroll — the tracklist owns the only
          scroll region so its header stays put and scroll wheels there
          don't move the timeline. Upper sections sit at natural height. */}
      <div className="flex h-full min-h-0 w-full max-w-6xl flex-col gap-4 p-6">
        <AnalyserCommands
          state={state}
          hasJob
          onPasteUrl={handlePasteUrl}
          onReanalyseSelection={handleReanalyseSelection}
          onExportTracklist={handleExportTracklist}
        />
        {/* Timeline (2) sits on top full-width — the waveform reads best
            wide. Below it, a 1/3 · 2/3 split: job header + controls +
            detail pane on the left, tracklist filling the rest on the
            right so its bottom space stops being wasted. */}
        <AnalyserTimeline
          state={state}
          audio={audio}
          onSelectRange={(s, e) =>
            dispatch({ type: "select.range", start_s: s, end_s: e })
          }
          onFocusTrack={handleFocusTrack}
          confirmed={confirmed}
          onEditBounds={(track, bounds) =>
            void handleEditBounds(track as TrackTimelineEntry, bounds)
          }
        />
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex w-1/3 min-w-0 flex-col gap-4 overflow-y-auto pr-1">
            <AnalyserHeader state={state} cancelling={stopping} />
            <AnalyserControls
              options={options}
              onChange={setOptions}
              onReanalyseAll={handleReanalyseAll}
              reanalyseDisabled={
                state.status === "running" || !state.meta.durationS
              }
              onRunShazam={handleRunShazam}
              shazamDisabled={
                !shazamReady ||
                state.status === "running" ||
                !state.meta.durationS
              }
              shazamReason={
                !shazamReady
                  ? options.pitch_strategy === "single"
                    ? "Set Target BPM before identifying tracks."
                    : "Set BPM range before identifying tracks."
                  : state.status === "running"
                    ? "Wait for the current pass to finish."
                    : undefined
              }
              tierCompleted={tierCompleted}
              onStopShazam={handleStopShazam}
              shazamRunning={shazamRunning}
              shazamStopping={stopping}
              onReset={handleReset}
              resetDisabled={state.status === "running"}
            />
            <AnalyserDetailPane
              state={state}
              options={options}
              onReanalyse={(range) => {
                dispatch({ type: "select.range", ...range });
                void handleReanalyseSelection();
              }}
              onScanRange={(range, tier) => void handleScanRange(range, tier)}
              confirmedRanges={confirmedRanges}
              shazamDisabled={
                !shazamReady ||
                state.status === "running" ||
                !state.meta.durationS
              }
              shazamReason={
                !shazamReady
                  ? options.pitch_strategy === "single"
                    ? "Set Target BPM before identifying tracks."
                    : "Set BPM range before identifying tracks."
                  : state.status === "running"
                    ? "Wait for the current pass to finish."
                    : undefined
              }
              onClearSelection={() => dispatch({ type: "select.clear" })}
            />
          </div>
          <TracklistPanel
            state={state}
            audio={audio}
            focusedTrack={focusedTrack}
            confirmed={confirmed}
            onToggleConfirmed={toggleConfirmed}
            onTracklistChanged={refresh}
          />
        </div>
      </div>
    </main>
  );
}

export default function AnalyserPage() {
  return (
    <Suspense fallback={null}>
      <AnalyserPageInner />
    </Suspense>
  );
}
