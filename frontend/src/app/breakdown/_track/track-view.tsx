"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { useTopBar } from "@/components/layout/top-bar-context";
import { StemSetup } from "@/components/stem-setup";
import { Button } from "@/components/ui/button";
import {
  trackSourceFrom,
  trackSourceHref,
  type TrackBreakdown,
  type TrackSource,
} from "@/lib/track-breakdown";

import { BreakdownTitle } from "../_components/breakdown-title";
import { fileStem, TrackPicker } from "./track-picker";
import { TrackProgress } from "./track-progress";
import { useTrackJob } from "./use-track-job";
import { TrackWorkspace } from "./workspace";

/** Name of the track, once known for a SoundCloud one. */
function sourceTitle(source: TrackSource, result: TrackBreakdown | null) {
  if (source.kind === "file") return fileStem(source.path);
  const sc = result?.soundcloud;
  if (sc?.title) return sc.artist ? `${sc.artist} - ${sc.title}` : sc.title;
  return "SoundCloud track";
}

/** `/breakdown?view=track&path=…` or `&sc=<id>`: analyse one track and explore it. */
export function TrackBreakdownView() {
  const router = useRouter();
  const params = useSearchParams();
  const source = trackSourceFrom(params);
  const { state, cancel, rerun, setResult } = useTrackJob(source);
  const title =
    source &&
    sourceTitle(source, state.status === "ready" ? state.result : null);

  useTopBar({
    title: (
      <BreakdownTitle view="track">
        {title && (
          <span
            className="truncate text-sm text-[var(--text-muted)]"
            data-testid="track-breakdown-title"
          >
            {title}
          </span>
        )}
      </BreakdownTitle>
    ),
  });

  if (!source || !title) {
    return (
      <TrackPicker onPick={(picked) => router.push(trackSourceHref(picked))} />
    );
  }

  if (state.status === "ready") {
    return (
      <TrackWorkspace
        key={state.result.digest}
        source={source}
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
          title={title}
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
