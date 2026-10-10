"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { useTopBar } from "@/components/layout/top-bar-context";
import { StemSetup } from "@/components/stem-setup";
import { Button } from "@/components/ui/button";
import { trackBreakdownHref } from "@/lib/track-breakdown";

import { BreakdownTitle } from "../_components/breakdown-title";
import { fileStem, TrackPicker } from "./track-picker";
import { TrackProgress } from "./track-progress";
import { useTrackJob } from "./use-track-job";
import { TrackWorkspace } from "./workspace";

/** `/breakdown?view=track&path=…` — analyse one local track and explore it. */
export function TrackBreakdownView() {
  const router = useRouter();
  const path = useSearchParams().get("path");
  const { state, cancel, rerun, setResult } = useTrackJob(path);

  useTopBar({
    title: (
      <BreakdownTitle view="track">
        {path && (
          <span
            className="truncate text-sm text-[var(--text-muted)]"
            data-testid="track-breakdown-title"
          >
            {fileStem(path)}
          </span>
        )}
      </BreakdownTitle>
    ),
  });

  if (!path) {
    return (
      <TrackPicker
        onPick={(picked) => router.push(trackBreakdownHref(picked))}
      />
    );
  }

  if (state.status === "ready") {
    return (
      <TrackWorkspace
        key={state.result.digest}
        result={state.result}
        onResult={setResult}
        onRemeasure={rerun}
      />
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-4">
      {state.status === "running" || state.status === "idle" ? (
        <TrackProgress
          stage={state.status === "running" ? state.stage : null}
          progress={state.status === "running" ? state.progress : null}
          onCancel={cancel}
        />
      ) : (
        <div
          className="flex max-w-md flex-col items-center gap-3 text-center"
          data-testid="track-breakdown-failed"
        >
          <p className="text-base text-[var(--text)]">
            {state.status === "cancelled"
              ? "Analysis cancelled."
              : state.message}
          </p>
          {state.status === "error" && state.needsStemSetup ? (
            <StemSetup onReady={rerun} />
          ) : (
            <Button variant="ghost" size="sm" onClick={rerun}>
              Try again
            </Button>
          )}
        </div>
      )}
    </main>
  );
}
