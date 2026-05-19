"use client";

import { ChevronDown, Waves } from "lucide-react";
import React, { useContext, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  SC_BPM_UPDATED_EVENT,
  type ScBpmUpdatedDetail,
} from "@/components/soundcloud-batch-analyze-button";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NumberInput } from "@/components/ui/number-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { analyzeSc, TrackUnanalysableError } from "@/lib/sc-bpm";
import { markScUnplayable, useIsScUnplayable } from "@/lib/sc-unplayable";
import { isTauri } from "@/lib/tauri";

interface Props {
  trackId: number;
  /** SoundCloud-metadata BPM from the track object; often null for user uploads. */
  metadataBpm: number | null | undefined;
}

/** Lookup table of track_id → cached BPM, provided by the table that pre-fills
 * the page's visible rows in one bulk call (see likes-table.tsx). A null value
 * means "pre-fill attempted but no row in the cache"; an entry missing
 * entirely means pre-fill hasn't resolved yet. */
export const SoundcloudBpmCacheContext = React.createContext<
  Map<number, number>
>(new Map());

function dispatchBpmUpdate(trackId: number, bpm: number) {
  window.dispatchEvent(
    new CustomEvent<ScBpmUpdatedDetail>(SC_BPM_UPDATED_EVENT, {
      detail: { trackId, bpm },
    }),
  );
}

/** BPM cell for SoundCloud library rows.
 *
 * Precedence: locally-computed cached BPM (this session) > backend-cached
 * BPM (set by a previous analyze) > metadata-supplied BPM > "Detect" button.
 *
 * When a BPM is shown, clicking it opens a popover that supports both
 * re-analyzing (re-runs the Tauri BPM pipeline) and a manual override
 * (for cases where detection was wrong). Outside the Tauri WebView the
 * popover is suppressed because analyze + save round-trip via Tauri/IPC.
 */
export function SoundcloudBpmCell({ trackId, metadataBpm }: Props) {
  const [analyzedBpm, setAnalyzedBpm] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [unanalysable, setUnanalysable] = useState(false);
  const sessionUnplayable = useIsScUnplayable(trackId);
  const bpmCache = useContext(SoundcloudBpmCacheContext);

  const cachedBpm = bpmCache.get(trackId);
  const displayBpm = analyzedBpm ?? cachedBpm ?? metadataBpm ?? null;

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draft, setDraft] = useState<string>("");

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ScBpmUpdatedDetail>).detail;
      if (detail?.trackId === trackId) {
        setAnalyzedBpm(detail.bpm);
      }
    };
    window.addEventListener(SC_BPM_UPDATED_EVENT, handler);
    return () => window.removeEventListener(SC_BPM_UPDATED_EVENT, handler);
  }, [trackId]);

  // Seed the draft from the currently shown BPM each time the popover opens
  // so the user's starting point is what they see in the cell.
  useEffect(() => {
    if (popoverOpen) {
      setDraft(displayBpm != null ? String(displayBpm) : "");
    }
  }, [popoverOpen, displayBpm]);

  async function persistBpm(bpm: number) {
    await api.saveSoundcloudBpm(trackId, bpm);
    setAnalyzedBpm(bpm);
    dispatchBpmUpdate(trackId, bpm);
  }

  async function handleAnalyze(closeOnDone: boolean, strong = false) {
    if (!isTauri() || !trackId || loading) return;
    setLoading(true);
    try {
      const result = await analyzeSc(trackId, false, strong);
      const rounded = Math.round(result.bpm);
      await persistBpm(rounded);
      toast.success(
        `Detected ${rounded} BPM (${result.confidence} confidence${
          strong ? ", DP" : ""
        })`,
      );
      if (closeOnDone) setPopoverOpen(false);
    } catch (err) {
      if (err instanceof TrackUnanalysableError) {
        setUnanalysable(true);
        markScUnplayable(trackId);
        toast.warning(err.message);
        setPopoverOpen(false);
      } else {
        toast.error(
          `BPM detection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveManual() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter a positive BPM value");
      return;
    }
    const rounded = Math.round(n);
    setLoading(true);
    try {
      await persistBpm(rounded);
      toast.success(`BPM set to ${rounded}`);
      setPopoverOpen(false);
    } catch (err) {
      toast.error(
        `Failed to save BPM: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }

  if (displayBpm != null) {
    return (
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="hover:bg-accent hover:text-foreground -mx-1 cursor-pointer rounded px-1 tabular-nums transition-colors"
            title="Edit or reanalyze BPM"
            data-testid="sc-bpm-edit-trigger"
          >
            {displayBpm}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-3">
          <div className="flex flex-col gap-2">
            <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
              BPM
            </span>
            <div className="flex items-center gap-2">
              <NumberInput
                value={draft}
                onChange={setDraft}
                min={1}
                max={400}
                ariaLabel="BPM"
                testId="sc-bpm-edit-input"
                className="h-8 text-xs"
                placeholder="—"
              />
              <Button
                size="sm"
                onClick={handleSaveManual}
                disabled={
                  loading || draft === "" || draft === String(displayBpm)
                }
                data-testid="sc-bpm-save"
              >
                Save
              </Button>
            </div>
            {isTauri() && (
              <div className="flex items-stretch gap-px">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleAnalyze(true)}
                  disabled={loading || unanalysable || sessionUnplayable}
                  data-testid="sc-bpm-reanalyze"
                  className="flex-1 rounded-r-none"
                >
                  {loading ? <Spinner /> : <Waves />}
                  Reanalyze
                </Button>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loading || unanalysable || sessionUnplayable}
                      aria-label="Reanalyze options"
                      data-testid="sc-bpm-reanalyze-menu"
                      className="rounded-l-none border-l-0 px-1.5"
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuItem
                      onClick={() => handleAnalyze(true, true)}
                      data-testid="sc-bpm-reanalyze-strong"
                      className="items-start py-2"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">
                          Reanalyze (stronger)
                        </span>
                        <span className="text-muted-foreground text-xs">
                          DP beat tracker — try this if BPM seems wrong
                        </span>
                      </div>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  }
  if (!isTauri()) {
    return <>—</>;
  }
  if (unanalysable || sessionUnplayable) {
    return (
      <span
        className="text-muted-foreground/60 text-xs"
        title="SoundCloud doesn't allow this track to be streamed for analysis"
      >
        —
      </span>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={() => handleAnalyze(false)}
      disabled={loading}
      title="Detect BPM"
      data-testid="sc-bpm-detect"
    >
      {loading ? <Spinner /> : <Waves />}
    </Button>
  );
}
