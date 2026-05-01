"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { formatTimecode } from "@/lib/analyser";
import { resolveUrl } from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

import type { AnalyserUiState } from "../_state";

const SET_COVER_CACHE = new Map<string, string | null>();

/** Resolve the SoundCloud track behind ``source_url`` to grab its
 *  artwork URL. Cached at module level so revisiting the job doesn't
 *  re-fetch. Falls back to ``null`` on auth failure / non-SC sources. */
function useSetCoverUrl(sourceUrl: string | null): string | null {
  const [, force] = useState(0);
  const cached = sourceUrl != null ? SET_COVER_CACHE.get(sourceUrl) : null;
  useEffect(() => {
    if (!sourceUrl) return;
    if (SET_COVER_CACHE.has(sourceUrl)) return;
    SET_COVER_CACHE.set(sourceUrl, null);
    let cancelled = false;
    (async () => {
      try {
        const resolved = await resolveUrl(sourceUrl);
        const artwork =
          resolved && "artwork_url" in resolved
            ? ((resolved.artwork_url as string | null | undefined) ?? null)
            : null;
        SET_COVER_CACHE.set(sourceUrl, artwork);
      } catch {
        // unauthenticated or non-track URL — keep the null sentinel
      }
      if (!cancelled) force((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceUrl]);
  return cached ?? null;
}

interface HeaderProps {
  state: AnalyserUiState;
  /** Optimistic: the user just clicked Stop; the backend hasn't yet
   *  flipped the job out of ``running``. */
  cancelling?: boolean;
}

const STATUS_LABEL: Record<AnalyserUiState["status"], string> = {
  idle: "Ready",
  loading: "Loading",
  pending: "Queued",
  running: "Analysing",
  complete: "Complete",
  error: "Error",
};

interface Progress {
  phase: "starting" | "bpm" | "shazam";
  label: string;
  /** 0..1, or null if duration unknown. */
  ratio: number | null;
  detail: string;
}

/** Bounds the active progression to a set of analysis ranges. During a
 *  re-analyse pass ``state.activeRanges`` is non-empty so we anchor the
 *  ratio to those ranges; during a fresh full pass it falls back to
 *  ``[0, duration]``. Returns ``null`` when no bounds are available
 *  (duration unknown). */
function activeBounds(
  state: AnalyserUiState,
): { totalSpan: number; ranges: Array<{ start_s: number; end_s: number }> } | null {
  const dur = state.meta.durationS;
  if (state.activeRanges.length > 0) {
    const totalSpan = state.activeRanges.reduce(
      (acc, r) => acc + Math.max(0, r.end_s - r.start_s),
      0,
    );
    if (totalSpan <= 0) return null;
    return { totalSpan, ranges: state.activeRanges };
  }
  if (dur > 0) return { totalSpan: dur, ranges: [{ start_s: 0, end_s: dur }] };
  return null;
}

function ratioWithinRanges(
  t: number,
  bounds: { totalSpan: number; ranges: Array<{ start_s: number; end_s: number }> },
): number {
  let progressed = 0;
  for (const r of bounds.ranges) {
    if (t <= r.start_s) continue;
    progressed += Math.min(t, r.end_s) - r.start_s;
  }
  return Math.min(1, Math.max(0, progressed / bounds.totalSpan));
}

function computeProgress(
  state: AnalyserUiState,
  cancelling: boolean,
): Progress | null {
  if (state.status !== "running") return null;
  const bounds = activeBounds(state);
  // ``activeRanges`` is set only by ``job.reanalyse_started`` (BPM
  // reanalyse). Don't switch to the Shazam phase in that case — the
  // scans that ``state.scans`` carries are leftovers from a prior full
  // run and would otherwise stick the bar at ~99%.
  const isBpmReanalyse = state.activeRanges.length > 0;
  // Shazam phase: prefer the per-run progress signal from
  // ``shazam.scan_started`` (counts the actual scheduler walk) over the
  // cumulative scans-array heuristic. The latter pins refines to ~99%
  // because the prior sweep already populated the array up to the mix
  // end.
  if (!isBpmReanalyse && state.activeShazamScan != null) {
    const run = state.activeShazamScan;
    const done = run.arrivedScanS.length;
    const total = Math.max(run.totalPoints, done);
    const ratio = total > 0 ? Math.min(1, done / total) : null;
    const tierLabel =
      run.tier.charAt(0).toUpperCase() + run.tier.slice(1);
    const regionLabel = run.region
      ? ` · ${formatTimecode(run.region.start_s)}–${formatTimecode(run.region.end_s)}`
      : "";
    return {
      phase: "shazam",
      label: cancelling ? "Stopping…" : `${tierLabel} scan${regionLabel}`,
      ratio,
      detail:
        total > 0
          ? `${done}/${total} points`
          : `${done} point${done === 1 ? "" : "s"}`,
    };
  }
  // Fallback: snapshot reload landed mid-scan (no scan_started replay
  // yet) — show indeterminate progress so the user at least sees we're
  // still scanning, instead of jumping back to the BPM phase.
  if (!isBpmReanalyse && state.scans.length > 0) {
    const matched = state.scans.filter((s) => s.title != null).length;
    return {
      phase: "shazam",
      label: cancelling ? "Stopping…" : "Identifying tracks",
      ratio: null,
      detail: `${state.scans.length} scan${state.scans.length === 1 ? "" : "s"} · ${matched} match${matched === 1 ? "" : "es"}`,
    };
  }
  if (state.windows.length > 0) {
    const lastEnd = state.windows[state.windows.length - 1].end_s;
    return {
      phase: "bpm",
      label: "Analysing BPM",
      ratio: bounds ? ratioWithinRanges(lastEnd, bounds) : null,
      detail: `${state.windows.length} window${state.windows.length === 1 ? "" : "s"}`,
    };
  }
  return {
    phase: "starting",
    label: "Starting",
    ratio: null,
    detail: "preparing audio",
  };
}

export function AnalyserHeader({ state, cancelling = false }: HeaderProps) {
  const isRunning = state.status === "running";
  const progress = computeProgress(state, cancelling);
  const coverUrl = useSetCoverUrl(state.meta.sourceUrl);
  return (
    <header
      className="border-border bg-surface-2 flex flex-wrap items-end justify-between gap-3 rounded-lg border px-4 py-3"
      data-testid="analyser-header"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="bg-surface-3 relative size-14 shrink-0 overflow-hidden rounded-md"
          aria-hidden="true"
          data-testid="analyser-set-cover"
        >
          {coverUrl && (
            <img
              src={coverUrl}
              alt=""
              className="size-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-text-subtle text-[11px] tracking-wider uppercase">
            Set
          </div>
          <div className="text-text flex min-w-0 items-center gap-1.5 text-lg font-semibold">
            <span className="truncate">
              {state.meta.title ?? "(untitled set)"}
            </span>
            {state.meta.sourceUrl && (
              <a
                href={state.meta.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text-subtle hover:text-text shrink-0 transition-colors"
                aria-label="Open set source URL"
                title={state.meta.sourceUrl}
                data-testid="analyser-source-link"
              >
                <ExternalLink className="size-4" />
              </a>
            )}
          </div>
          <div className="text-text-muted truncate text-sm">
            {state.meta.artist ?? "(unknown artist)"} ·{" "}
            {state.meta.durationS > 0
              ? formatTimecode(state.meta.durationS)
              : "—"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm">
        {isRunning && (
          <Loader2
            className="text-brand size-4 animate-spin"
            data-testid="analysing-spinner"
          />
        )}
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            state.status === "error"
              ? "bg-destructive/10 text-destructive"
              : state.status === "complete"
                ? "bg-brand-soft text-text"
                : "bg-surface-3 text-text-muted",
          )}
          data-testid="analyser-status"
        >
          {STATUS_LABEL[state.status]}
        </span>
      </div>
      {progress && (
        <div
          className="flex w-full flex-col gap-1"
          data-testid="analyser-progress"
        >
          <div className="text-text-muted flex items-center justify-between text-xs tabular-nums">
            <span>
              <span className="text-text font-medium">{progress.label}</span>
              <span className="text-text-subtle"> · {progress.detail}</span>
            </span>
            <span data-testid="analyser-progress-percent">
              {progress.ratio == null
                ? "…"
                : `${Math.round(progress.ratio * 100)}%`}
            </span>
          </div>
          <div
            className="bg-surface-3 relative h-1.5 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              progress.ratio == null
                ? undefined
                : Math.round(progress.ratio * 100)
            }
            aria-label={progress.label}
          >
            {progress.ratio == null ? (
              <div className="bg-brand/60 absolute inset-y-0 left-0 w-1/4 animate-pulse" />
            ) : (
              <div
                className="bg-brand absolute inset-y-0 left-0 transition-[width] duration-200"
                style={{ width: `${progress.ratio * 100}%` }}
              />
            )}
          </div>
        </div>
      )}
      {state.errorMessage && (
        <div className="bg-destructive/10 text-destructive w-full rounded p-2 text-xs">
          {state.errorMessage}
        </div>
      )}
    </header>
  );
}
