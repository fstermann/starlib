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
import { analyzeLocalBpm, isTauri } from "@/lib/tauri";
import {
  useBatchBpmRunner,
  useConsensusPref,
  useStrongPref,
} from "@/lib/use-batch-bpm-runner";

interface Props {
  /** Absolute path of the current folder view. Batch analyses all indexed
   * tracks beneath this path that lack a BPM in the cache DB. */
  folderPath?: string;
  /** Called when the batch completes so the parent can refresh the table. */
  onComplete?: () => void;
  className?: string;
}

// Local decode + analysis is CPU-bound and roughly constant per track;
// concurrency=2 lets us overlap one track's decode with another's analysis
// without oversubscribing on typical 4-core laptops.
const CONCURRENCY = 2;

/**
 * Batch BPM analyzer for the filesystem library toolbar.
 *
 * Unlike the SC variant, the list of candidates is fetched from the cache
 * DB (`bpm IS NULL`) rather than derived from the in-memory table view,
 * so a single click analyses every indexed track under the current folder
 * — not just the visible page.
 *
 * Rows refresh on completion via `onComplete` (parent bumps its refresh
 * token); we don't stream per-row updates the way the SC variant does
 * because local analysis is fast enough (~50 ms/track) that a single
 * post-batch refresh is indistinguishable from live.
 */
export function FilesystemBatchAnalyzeButton({
  folderPath,
  onComplete,
  className,
}: Props) {
  const { running, total, done, failed, cancel, start } =
    useBatchBpmRunner(CONCURRENCY);
  const [consensus, setConsensus] = useConsensusPref();
  const [strong, setStrong] = useStrongPref();

  const run = useCallback(async () => {
    if (!isTauri() || !folderPath) return;

    let paths: string[] = [];
    try {
      const resp = await api.getLocalBpmCandidates(folderPath, true);
      paths = resp.file_paths;
    } catch (err) {
      toast.error(
        `Couldn't list candidates: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (paths.length === 0) {
      toast.info("All indexed tracks in this folder already have a BPM");
      return;
    }

    const { completed, failures, cancelled } = await start(
      paths,
      async (path) => {
        const result = await analyzeLocalBpm(path, consensus, strong);
        await api.saveLocalBpm(path, result.bpm, result.algorithm_version);
      },
    );

    onComplete?.();

    if (cancelled) {
      toast(`Cancelled after ${completed} track${completed === 1 ? "" : "s"}`);
    } else if (failures > 0) {
      toast.warning(
        `Analyzed ${completed - failures}/${paths.length} — ${failures} failed`,
      );
    } else {
      toast.success(`Analyzed ${completed} track${completed === 1 ? "" : "s"}`);
    }
  }, [folderPath, consensus, strong, start, onComplete]);

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
        disabled={!folderPath}
        title={
          modeSuffix
            ? `Analyze unanalyzed tracks in this folder (${modeSuffix})`
            : "Analyze BPM for all tracks in this folder that don't have one"
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
