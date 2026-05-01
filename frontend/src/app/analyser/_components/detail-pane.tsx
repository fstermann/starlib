"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  formatTimecode,
  type AnalyserJobOptions,
  type ShazamTier,
} from "@/lib/analyser";

import type { AnalyserUiState } from "../_state";

interface DetailPaneProps {
  state: AnalyserUiState;
  /** Active analyser options. Used to surface the pitch strategy that
   *  range scans will run with — they share the page-level config. */
  options: AnalyserJobOptions;
  onReanalyse: (range: { start_s: number; end_s: number }) => void;
  onScanRange: (
    range: { start_s: number; end_s: number },
    tier: ShazamTier,
  ) => void;
  /** Confirmed-track ranges. Used to flag how many fall inside the
   *  current selection so the user knows the scheduler will skip them. */
  confirmedRanges: Array<[number, number]>;
  shazamDisabled: boolean;
  shazamReason?: string;
  onClearSelection: () => void;
}

const TIER_LABEL: Record<ShazamTier, string> = {
  sweep: "Sweep",
  refine: "Refine",
  pinpoint: "Pinpoint",
};

const TIER_HINT: Record<ShazamTier, string> = {
  sweep: "Coarse pass — 60 s grid.",
  refine: "Mid pass — 20 s grid.",
  pinpoint: "Fine pass — 8 s grid.",
};

const FIELD_LABEL =
  "text-2xs text-text-muted font-medium tracking-wider uppercase";

/** Short label describing how a range scan will probe Shazam, given the
 *  page-level pitch settings. Mirrors the gating in ``page.tsx``. */
function describePitchStrategy(options: AnalyserJobOptions): string {
  switch (options.pitch_strategy) {
    case "single":
      return options.target_bpm != null
        ? `Target ${options.target_bpm} BPM`
        : "Target BPM not set";
    case "range":
      return options.bpm_range != null
        ? `Range ${options.bpm_range[0]}–${options.bpm_range[1]} BPM`
        : "BPM range not set";
    default:
      return "Native pitch";
  }
}

export function AnalyserDetailPane({
  state,
  options,
  onReanalyse,
  onScanRange,
  confirmedRanges,
  shazamDisabled,
  shazamReason,
  onClearSelection,
}: DetailPaneProps) {
  if (!state.selection) {
    return (
      <aside
        className="border-border bg-surface-2 text-text-muted rounded-lg border p-4 text-sm"
        data-testid="detail-empty"
      >
        Drag a range on the timeline to inspect or re-analyse a region.
      </aside>
    );
  }

  const { start_s, end_s } = state.selection;
  const inRange = state.windows.filter(
    (w) => w.start_s >= start_s - 0.5 && w.end_s <= end_s + 0.5,
  );
  const bpms = inRange.map((w) => w.bpm).filter((b) => b > 0);
  const median = bpms.length
    ? bpms.sort((a, b) => a - b)[Math.floor(bpms.length / 2)]
    : null;
  const sectionsInRange = state.sections.filter(
    (s) => s.start_s < end_s && s.end_s > start_s,
  );
  const matchedTracks = state.timeline.filter(
    (t) => t.start_s < end_s && t.end_s + 1e-3 >= start_s,
  );

  return (
    <aside
      className="border-border bg-surface-2 flex flex-col gap-3 rounded-lg border px-4 py-3"
      data-testid="detail-pane"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className={FIELD_LABEL}>Range</span>
          <h2 className="text-text font-mono text-sm font-semibold tabular-nums">
            {formatTimecode(start_s)} – {formatTimecode(end_s)}
          </h2>
          <span className="text-text-subtle text-xs tabular-nums">
            {formatTimecode(end_s - start_s)} long
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          className="-mr-2"
        >
          Clear
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Stat label="Median BPM" value={median != null ? median.toFixed(1) : "—"} />
        <Stat label="Windows" value={String(inRange.length)} />
        <Stat label="Sections" value={String(sectionsInRange.length)} />
        <Stat label="Tracks" value={String(matchedTracks.length)} />
      </div>

      {matchedTracks.length > 0 && (
        <ul className="border-border/60 flex flex-col gap-1 border-t pt-2">
          {matchedTracks.map((t) => (
            <li
              key={`${t.start_s}-${t.shazam_id ?? t.title}`}
              className="grid grid-cols-[1fr_auto] items-center gap-3 text-xs"
            >
              <span className="min-w-0 truncate">
                <span className="text-text font-medium">{t.title}</span>
                {t.artist && (
                  <span className="text-text-muted"> — {t.artist}</span>
                )}
              </span>
              <span className="text-text-subtle font-mono tabular-nums">
                {Math.round(t.confidence * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Confirmed-track exclusion notice — the scheduler skips scan
          points that overlap a confirmed track regardless of tier. */}
      {(() => {
        const overlapping = confirmedRanges.filter(
          ([s, e]) => e > start_s && s < end_s,
        ).length;
        if (overlapping === 0) return null;
        return (
          <div
            className="text-text-subtle text-xs"
            data-testid="detail-excluded-confirmed"
          >
            {overlapping} confirmed track{overlapping === 1 ? "" : "s"}{" "}
            in this range will be skipped — unconfirm to re-scan.
          </div>
        );
      })()}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="border-border bg-surface-3 text-text-muted inline-flex cursor-help items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
              data-testid="detail-pitch-chip"
            >
              <span className={FIELD_LABEL}>Pitch</span>
              <span>{describePitchStrategy(options)}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs">
            Range scans use the same pitch strategy configured for the
            whole-mix scan — change it in the controls panel.
          </TooltipContent>
        </Tooltip>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onReanalyse({ start_s, end_s })}
            data-testid="detail-reanalyse"
          >
            Re-analyse BPM
          </Button>
          <span className="text-text-subtle text-xs">Scan:</span>
          {(["sweep", "refine", "pinpoint"] as const).map((tier) => (
            <Tooltip key={tier}>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant={tier === "sweep" ? "secondary" : "ghost"}
                  disabled={shazamDisabled}
                  onClick={() => onScanRange({ start_s, end_s }, tier)}
                  data-testid={`detail-scan-${tier}`}
                >
                  {TIER_LABEL[tier]}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                {shazamDisabled && shazamReason
                  ? shazamReason
                  : TIER_HINT[tier]}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={FIELD_LABEL}>{label}</span>
      <span className="text-text font-mono text-sm tabular-nums">{value}</span>
    </div>
  );
}
