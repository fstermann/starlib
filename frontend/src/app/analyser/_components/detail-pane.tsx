"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  /** Overwrite the BPM of every window in the range — manual correction
   *  for spans the detector got wrong. */
  onSetBpm: (range: { start_s: number; end_s: number }, bpm: number) => void;
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

/** Common metre-confusion ratios the detector falls into: half/double
 *  time and the 3-against-4 family. */
const METRE_RATIOS = [2, 3 / 2, 4 / 3, 3 / 4, 2 / 3, 1 / 2];

function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function AnalyserDetailPane({
  state,
  options,
  onReanalyse,
  onSetBpm,
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
  const median = medianOf(bpms);

  // Neighbour consensus: the nearest windows on each side of the
  // selection. Used to spot metre-confusion spans (the selection sits
  // at e.g. 2/3 of the surrounding tempo) and offer a one-click snap.
  const neighbourBpms = [
    ...state.windows.filter((w) => w.end_s <= start_s + 0.5).slice(-8),
    ...state.windows.filter((w) => w.start_s >= end_s - 0.5).slice(0, 8),
  ]
    .map((w) => w.bpm)
    .filter((b) => b > 0);
  const neighbour = medianOf(neighbourBpms);
  let snapTarget: number | null = null;
  if (median != null && neighbour != null) {
    const off = Math.abs(median - neighbour) / neighbour;
    if (
      off > 0.04 &&
      METRE_RATIOS.some(
        (r) => Math.abs(median * r - neighbour) / neighbour < 0.03,
      )
    ) {
      snapTarget = neighbour;
    }
  }
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
        <Stat
          label="Median BPM"
          value={median != null ? median.toFixed(1) : "—"}
        />
        <Stat label="Windows" value={String(inRange.length)} />
        <Stat label="Sections" value={String(sectionsInRange.length)} />
        <Stat label="Tracks" value={String(matchedTracks.length)} />
      </div>

      {inRange.length > 0 && (
        <BpmFix
          key={`${start_s}-${end_s}`}
          range={{ start_s, end_s }}
          snapTarget={snapTarget}
          onSetBpm={onSetBpm}
        />
      )}

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
            {overlapping} confirmed track{overlapping === 1 ? "" : "s"} in this
            range will be skipped — unconfirm to re-scan.
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
            Range scans use the same pitch strategy configured for the whole-mix
            scan — change it in the controls panel.
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

/** Manual BPM correction for the selected windows. Offers a one-click
 *  snap when the selection's tempo is metrically related to its
 *  neighbours (the classic 2:3 / 1:2 detector mistake), plus a free
 *  input for everything else. Keyed by the selection so the input
 *  resets when the range changes. */
function BpmFix({
  range,
  snapTarget,
  onSetBpm,
}: {
  range: { start_s: number; end_s: number };
  snapTarget: number | null;
  onSetBpm: (range: { start_s: number; end_s: number }, bpm: number) => void;
}) {
  const [input, setInput] = useState("");
  const parsed = Number(input.replace(",", "."));
  const valid = input.trim() !== "" && Number.isFinite(parsed) && parsed > 0;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="detail-bpm-fix"
    >
      <span className={FIELD_LABEL}>Fix BPM</span>
      {snapTarget != null && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onSetBpm(range, snapTarget)}
          data-testid="detail-bpm-snap"
        >
          Snap to {snapTarget.toFixed(1)}
        </Button>
      )}
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && valid) onSetBpm(range, parsed);
        }}
        inputMode="decimal"
        placeholder="BPM"
        className="h-8 w-20 font-mono text-sm tabular-nums"
        data-testid="detail-bpm-input"
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={!valid}
        onClick={() => onSetBpm(range, parsed)}
        data-testid="detail-bpm-apply"
      >
        Apply
      </Button>
    </div>
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
