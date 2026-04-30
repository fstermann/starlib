"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";

import {
  buildTracklistText,
  DEFAULT_JOB_OPTIONS,
  reanalyse,
  startAnalyserJob,
  type AnalyserJobOptions,
  type JobSnapshot,
} from "@/lib/analyser";

import { AnalyserCommands } from "./_components/commands";
import { AnalyserControls } from "./_components/controls";
import { AnalyserDetailPane } from "./_components/detail-pane";
import { AnalyserHeader } from "./_components/header";
import { AnalyserStartScreen } from "./_components/start-screen";
import { AnalyserTimeline } from "./_components/timeline";
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

  const { state, dispatch } = useAnalyserJob(jobId);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, options, state.selection]);

  const handleReanalyseAll = useCallback(async () => {
    if (!jobId || !state.meta.durationS) return;
    try {
      await reanalyse(
        jobId,
        [{ start_s: 0, end_s: state.meta.durationS }],
        options,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, options, state.meta.durationS]);

  const handlePasteUrl = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      void handleStart({ url: text.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [handleStart]);

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
      tracks: [...state.tracks.values()],
    };
  }, [
    options,
    state.errorMessage,
    state.jobId,
    state.meta.artist,
    state.meta.durationS,
    state.meta.title,
    state.sections,
    state.status,
    state.tracks,
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
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
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
      </main>
    );
  }

  return (
    <main
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6"
      data-testid="analyser-main"
    >
      <AnalyserCommands
        state={state}
        hasJob
        onPasteUrl={handlePasteUrl}
        onReanalyseSelection={handleReanalyseSelection}
        onExportTracklist={handleExportTracklist}
      />
      <AnalyserHeader state={state} />
      <AnalyserControls
        options={options}
        onChange={setOptions}
        onReanalyseAll={handleReanalyseAll}
        reanalyseDisabled={state.status === "running" || !state.meta.durationS}
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <AnalyserTimeline
          state={state}
          onSelectRange={(s, e) =>
            dispatch({ type: "select.range", start_s: s, end_s: e })
          }
        />
        <AnalyserDetailPane
          state={state}
          onReanalyse={(range) => {
            dispatch({ type: "select.range", ...range });
            void handleReanalyseSelection();
          }}
          onClearSelection={() => dispatch({ type: "select.clear" })}
        />
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
