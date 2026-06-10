"use client";

import { ChevronDown, Waves, X } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";

import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { analyzeSc, TrackUnanalysableError } from "@/lib/sc-bpm";
import type { SCTrack } from "@/lib/soundcloud";
import { isTauri } from "@/lib/tauri";
import {
  useBatchBpmRunner,
  useConsensusPref,
  useStrongPref,
} from "@/lib/use-batch-bpm-runner";

interface Props {
  tracks: SCTrack[];
  className?: string;
}

const CONCURRENCY = 2;

/** Custom DOM event cells listen for to update in-session without
 * re-fetching the bulk prefill. */
export const SC_BPM_UPDATED_EVENT = "sc-bpm-updated";
export interface ScBpmUpdatedDetail {
  trackId: number;
  bpm: number;
}

function extractId(track: SCTrack): number {
  if (!track.urn) return 0;
  const parts = track.urn.split(":");
  return parseInt(parts[parts.length - 1], 10) || 0;
}

function dispatchBpmUpdate(trackId: number, bpm: number) {
  window.dispatchEvent(
    new CustomEvent<ScBpmUpdatedDetail>(SC_BPM_UPDATED_EVENT, {
      detail: { trackId, bpm },
    }),
  );
}

/**
 * Batch BPM analyzer for the SoundCloud library toolbar.
 *
 * Scans the currently-visible (filtered) tracks, skipping any that already
 * have a metadata BPM or a cached analysis. Network concurrency is capped
 * at 2 — the knee of the SC throughput curve in our benchmark, and polite
 * enough that interactive Detect clicks stay snappy.
 *
 * Completed tracks dispatch a `sc-bpm-updated` CustomEvent so cells refresh
 * without waiting for a page reload.
 */
export function SoundcloudBatchAnalyzeButton({ tracks, className }: Props) {
  const { running, total, done, failed, cancel, start } =
    useBatchBpmRunner(CONCURRENCY);
  const [consensus, setConsensus] = useConsensusPref();
  const [strong, setStrong] = useStrongPref();

  const run = useCallback(async () => {
    if (!isTauri()) return;
    // Identify tracks that need analysis: no metadata bpm.
    const candidates: number[] = [];
    for (const t of tracks) {
      if (t.bpm != null) continue;
      const id = extractId(t);
      if (id > 0) candidates.push(id);
    }
    if (candidates.length === 0) {
      toast.info("All visible tracks already have a BPM");
      return;
    }

    // Drop anything already in the server cache; broadcast those hits so cells
    // still update live even if the user skipped the table remount.
    let queue = candidates;
    try {
      const resp = await api.getSoundcloudBpmsBulk(candidates);
      const cached = new Set(Object.keys(resp.bpms).map(Number));
      queue = candidates.filter((id) => !cached.has(id));
      for (const [idStr, bpm] of Object.entries(resp.bpms)) {
        dispatchBpmUpdate(Number(idStr), bpm);
      }
    } catch {
      /* best-effort */
    }
    if (queue.length === 0) {
      toast.info("All visible tracks already analyzed");
      return;
    }

    let unanalysable = 0;
    const { completed, failures, cancelled } = await start(
      queue,
      async (trackId) => {
        try {
          const result = await analyzeSc(trackId, consensus, strong);
          await api.saveSoundcloudBpm(trackId, result.bpm);
          dispatchBpmUpdate(trackId, Math.round(result.bpm));
        } catch (err) {
          // Tracks SC refuses to stream count as a clean skip, not a
          // failure — they would never succeed no matter how many times
          // we retried, so the summary should make that clear.
          if (err instanceof TrackUnanalysableError) {
            unanalysable += 1;
            return;
          }
          throw err;
        }
      },
    );

    const succeeded = completed - failures - unanalysable;
    if (cancelled) {
      toast(`Cancelled after ${completed} track${completed === 1 ? "" : "s"}`);
    } else if (failures > 0 || unanalysable > 0) {
      const parts = [`Analyzed ${succeeded}/${queue.length}`];
      if (failures > 0) parts.push(`${failures} failed`);
      if (unanalysable > 0) parts.push(`${unanalysable} unavailable`);
      toast.warning(parts.join(" — "));
    } else {
      toast.success(`Analyzed ${completed} track${completed === 1 ? "" : "s"}`);
    }
  }, [tracks, consensus, strong, start]);

  const modeSuffix = [consensus ? "consensus" : null, strong ? "strong" : null]
    .filter(Boolean)
    .join(" · ");

  if (!isTauri()) return null;

  if (running) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className={className}
        onClick={cancel}
        title="Cancel batch analysis"
      >
        <Spinner className="size-3.5" />
        <span className="tabular-nums">
          {done}/{total}
          {failed > 0 ? ` · ${failed} failed` : ""}
        </span>
        <X className="size-3.5" />
      </Button>
    );
  }

  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        className={className}
        onClick={run}
        title={
          modeSuffix
            ? `Analyze visible tracks (${modeSuffix})`
            : "Analyze BPM for all visible tracks that don't have one"
        }
      >
        <Waves className="size-3.5" />
        Analyze BPMs{modeSuffix ? ` · ${modeSuffix}` : ""}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className={className}
            aria-label="Batch analyze settings"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuCheckboxItem
            checked={consensus}
            onCheckedChange={setConsensus}
            data-testid="batch-analyze-consensus"
            className="items-start py-2"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Consensus mode</span>
              <span className="text-muted-foreground text-xs">
                Median of 3 windows — robust to intros &amp; breakdowns
              </span>
            </div>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={strong}
            onCheckedChange={setStrong}
            data-testid="batch-analyze-strong"
            className="items-start py-2"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Stronger algorithm</span>
              <span className="text-muted-foreground text-xs">
                DP beat tracker — fixes dotted/triplet sub-rate locks
              </span>
            </div>
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
