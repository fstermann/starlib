"use client";

import { Check, ChevronDown, Info, Lock } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SHAZAM_TIER_DEFAULTS,
  type AnalyserJobOptions,
  type ShazamTier,
} from "@/lib/analyser";

/** Field label style — mirrors the library's track editor so the
 *  analyser's controls feel consistent with the rest of the app. */
const FIELD_LABEL =
  "text-2xs text-text-muted flex items-center gap-1 font-medium tracking-wider uppercase";

function FieldHelp({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-text-subtle hover:text-text-muted inline-flex"
          aria-label="What is this?"
        >
          <Info className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

interface ControlsProps {
  options: AnalyserJobOptions;
  onChange: (next: AnalyserJobOptions) => void;
  onReanalyseAll: () => void;
  reanalyseDisabled: boolean;
  onRunShazam: (tier: ShazamTier) => void;
  shazamDisabled: boolean;
  shazamReason?: string;
  /** Which tiers have already produced at least one cached scan. Drives
   *  the gating: refine unlocks once sweep has run, pinpoint once refine
   *  has run. Region scans (in DetailPane) bypass this gating. */
  tierCompleted: Record<ShazamTier, boolean>;
  onStopShazam?: () => void;
  /** When true, swap the Identify button for a Stop button. */
  shazamRunning?: boolean;
  /** When true, the Stop button is in flight — disable + relabel so the
   *  user gets feedback before the backend finalises. */
  shazamStopping?: boolean;
  /** Wipe BPM, sections, Shazam matches and tracklist edits — keep the
   *  job row so the user can re-run analysis against the same source. */
  onReset?: () => void;
  resetDisabled?: boolean;
}

export function AnalyserControls({
  options,
  onChange,
  onReanalyseAll,
  reanalyseDisabled,
  onRunShazam,
  shazamDisabled,
  shazamReason,
  tierCompleted,
  onStopShazam,
  shazamRunning = false,
  shazamStopping = false,
  onReset,
  resetDisabled = false,
}: ControlsProps) {
  // Single source of truth for the simplified pitch UI: tempo (start)
  // and an optional upper-bound. The backend's strategy/target/range
  // fields are derived on commit so we don't have to migrate the
  // schema or the API.
  const [tempoStart, setTempoStart] = useState(
    options.bpm_range?.[0]?.toString() ?? options.target_bpm?.toString() ?? "",
  );
  const [tempoEnd, setTempoEnd] = useState(
    options.bpm_range?.[1]?.toString() ?? "",
  );
  // The range is the advanced case — start collapsed unless a saved
  // upper bound already exists, then reveal it on demand.
  const [rangeOpen, setRangeOpen] = useState(Boolean(tempoEnd));

  const commit = (next: AnalyserJobOptions) => onChange(next);

  // Derive the backend's options shape from the two simple inputs.
  // start blank → strategy=none. start only → single (target=start).
  // start + end with end > start → range. end ≤ start → treat as single.
  const commitPitch = (start: string, end: string) => {
    const startNum = start ? Number(start) : null;
    const endNum = end ? Number(end) : null;
    if (startNum == null || !Number.isFinite(startNum)) {
      commit({
        ...options,
        pitch_strategy: "none",
        target_bpm: null,
        bpm_range: null,
      });
      return;
    }
    if (endNum != null && Number.isFinite(endNum) && endNum > startNum) {
      commit({
        ...options,
        pitch_strategy: "range",
        target_bpm: null,
        bpm_range: [startNum, endNum],
      });
      return;
    }
    commit({
      ...options,
      pitch_strategy: "single",
      target_bpm: startNum,
      bpm_range: null,
    });
  };

  // Collapsing the range drops the upper bound entirely — re-commit as a
  // single tempo so the backend strategy follows the visible UI.
  const closeRange = () => {
    setRangeOpen(false);
    setTempoEnd("");
    commitPitch(tempoStart, "");
  };

  // Hint when the band is narrow enough that the per-scan-point pitch
  // dedup will collapse it to a single midpoint query — keeps users
  // from expecting "3× hits" when the backend will only fire one call
  // per point. 4 BPM is the rough threshold (≈0.45 ST at 128 BPM,
  // both edges within 0.25 ST of midpoint after the symmetric split).
  const startNum = tempoStart ? Number(tempoStart) : null;
  const endNum = tempoEnd ? Number(tempoEnd) : null;
  const narrowBand =
    startNum != null &&
    endNum != null &&
    endNum > startNum &&
    endNum - startNum < 4;

  return (
    <section
      className="border-border bg-surface-2 flex flex-wrap items-start gap-4 rounded-lg border px-4 py-3"
      data-testid="analyser-controls"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="tempo-start" className={FIELD_LABEL}>
          Original tempo (BPM)
          <FieldHelp>
            DJs pitch tracks up or down to mix them. Set the original release
            tempo (128 house, 140 speedhouse, …) and each snippet is pitched
            back to it before Shazam listens — so it matches the release, not
            the sped-up mix. Leave blank to send the audio untouched (fastest;
            misses anything the DJ pitched).
          </FieldHelp>
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="tempo-start"
            type="number"
            min={60}
            max={200}
            className="w-24"
            aria-label="Original tempo (BPM)"
            placeholder="e.g. 128"
            value={tempoStart}
            onChange={(e) => setTempoStart(e.target.value)}
            onBlur={() => commitPitch(tempoStart, tempoEnd)}
          />
          {rangeOpen ? (
            <>
              <span className="text-text-subtle text-xs">to</span>
              <Input
                id="tempo-end"
                type="number"
                min={60}
                max={200}
                className="w-24"
                aria-label="Up to (BPM)"
                placeholder="up to"
                autoFocus
                value={tempoEnd}
                onChange={(e) => setTempoEnd(e.target.value)}
                onBlur={() => commitPitch(tempoStart, tempoEnd)}
                disabled={!tempoStart}
              />
              <button
                type="button"
                className="text-text-subtle hover:text-text-muted text-xs"
                onClick={closeRange}
                data-testid="toggle-tempo-range"
              >
                Remove
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-text-subtle hover:text-text-muted text-xs whitespace-nowrap disabled:pointer-events-none disabled:opacity-40"
              onClick={() => setRangeOpen(true)}
              disabled={!tempoStart}
              data-testid="toggle-tempo-range"
            >
              + tempo range
            </button>
          )}
        </div>
        {narrowBand && (
          <span
            className="text-text-subtle text-2xs"
            data-testid="tempo-narrow-hint"
          >
            Narrow range — single tempo will be used.
          </span>
        )}
      </div>
      {/* Action cluster sits to the right. ``mt-5`` pushes it down past
          the label row above so the buttons align with the input
          baseline rather than the labels. */}
      <div className="mt-5 ml-auto flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          {onReset && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={resetDisabled}
                  data-testid="reset-job"
                  className="text-text-muted hover:text-destructive"
                >
                  Reset
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent data-testid="reset-job-dialog">
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset analysis?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This wipes BPM windows, sections, Shazam matches and every
                    manual edit on the tracklist. The set itself (URL, title)
                    stays — you can re-analyse from scratch. Cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={onReset}
                    data-testid="reset-job-confirm"
                  >
                    Reset analysis
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={reanalyseDisabled}
            onClick={onReanalyseAll}
            data-testid="reanalyse-all"
          >
            Re-analyse all
          </Button>
          {shazamRunning ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={onStopShazam}
              disabled={!onStopShazam || shazamStopping}
              data-testid="stop-shazam"
            >
              {shazamStopping ? "Stopping…" : "Stop identifying"}
            </Button>
          ) : (
            <TierButtons
              shazamDisabled={shazamDisabled}
              tierCompleted={tierCompleted}
              onRunShazam={onRunShazam}
            />
          )}
        </div>
        {shazamDisabled && shazamReason && (
          <span className="text-text-subtle text-xs" data-testid="shazam-hint">
            {shazamReason}
          </span>
        )}
      </div>
    </section>
  );
}

const TIER_LABEL: Record<ShazamTier, string> = {
  sweep: "Sweep",
  refine: "Refine",
  pinpoint: "Pinpoint",
};

/** One-liner role per tier; the probe spacing + clip length are appended
 *  from ``SHAZAM_TIER_DEFAULTS`` so the "how often, how long" question the
 *  buttons never answered is now spelled out — and stays in sync with the
 *  backend table. */
const TIER_ROLE: Record<ShazamTier, string> = {
  sweep: "Coarse first pass.",
  refine: "Fills Sweep's gaps.",
  pinpoint: "Locks transitions.",
};

function tierHint(tier: ShazamTier): string {
  const { spacing_s, window_s } = SHAZAM_TIER_DEFAULTS[tier];
  return `${TIER_ROLE[tier]} ${window_s} s clip every ${spacing_s} s in each section.`;
}

const TIER_ORDER: ReadonlyArray<ShazamTier> = ["sweep", "refine", "pinpoint"];

/** Pick the tier the primary "Identify" button should default to:
 *  the first un-run tier in the chain, or pinpoint once everything's run
 *  (so a user can keep re-pinpointing without opening the menu). */
function nextTier(completed: Record<ShazamTier, boolean>): ShazamTier {
  if (!completed.sweep) return "sweep";
  if (!completed.refine) return "refine";
  return "pinpoint";
}

interface TierButtonsProps {
  shazamDisabled: boolean;
  tierCompleted: Record<ShazamTier, boolean>;
  onRunShazam: (tier: ShazamTier) => void;
}

function TierButtons({
  shazamDisabled,
  tierCompleted,
  onRunShazam,
}: TierButtonsProps) {
  const primary = nextTier(tierCompleted);
  // Gating: refine needs sweep, pinpoint needs refine. Used by the
  // dropdown to lock items the user shouldn't pick yet.
  const gated: Record<ShazamTier, boolean> = {
    sweep: false,
    refine: !tierCompleted.sweep,
    pinpoint: !tierCompleted.refine,
  };

  return (
    <div className="flex items-stretch" data-testid="tier-buttons">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={shazamDisabled}
            onClick={() => onRunShazam(primary)}
            data-testid={`run-shazam-${primary}`}
            // Brand-tinted outline — same vocabulary as the library's
            // "Apply rules" button so the analyser's primary action
            // reads as the affirmative one in this row.
            className="text-brand hover:bg-brand-soft hover:text-brand rounded-r-none border-r-0"
          >
            <img
              src="/icons/shazam.svg"
              alt=""
              aria-hidden="true"
              className="size-3.5 dark:invert"
            />
            {TIER_LABEL[primary]}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8} className="max-w-52 text-xs">
          {tierHint(primary)}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={shazamDisabled}
            aria-label="Choose scan tier"
            data-testid="run-shazam-menu"
            className="text-brand hover:bg-brand-soft hover:text-brand rounded-l-none px-1.5"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {TIER_ORDER.map((tier) => {
            const locked = gated[tier];
            const done = tierCompleted[tier];
            return (
              <DropdownMenuItem
                key={tier}
                disabled={locked}
                onSelect={() => onRunShazam(tier)}
                data-testid={`run-shazam-item-${tier}`}
                className="flex items-start gap-2"
              >
                <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                  {locked ? (
                    <Lock className="text-text-subtle size-3" />
                  ) : done ? (
                    <Check className="text-text-muted size-3.5" />
                  ) : null}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm">{TIER_LABEL[tier]}</span>
                  <span className="text-text-subtle text-xs">
                    {locked
                      ? tier === "refine"
                        ? "Run Sweep first"
                        : "Run Refine first"
                      : tierHint(tier)}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
