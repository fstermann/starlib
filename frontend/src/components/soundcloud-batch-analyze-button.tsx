"use client";

import { Loader2, Waves, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { SCTrack } from "@/lib/soundcloud";
import { analyzeScBpm, isTauri } from "@/lib/tauri";

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

/**
 * Batch BPM analyzer for the SoundCloud library toolbar.
 *
 * Scans the currently-visible (filtered) tracks, skipping any that already
 * have a metadata BPM or a cached analysis. Network concurrency is capped
 * at 2 — empirically the knee of the SC throughput curve in our benchmark,
 * and polite enough that the user's interactive Detect clicks stay snappy.
 *
 * Completed tracks dispatch a `sc-bpm-updated` CustomEvent so
 * SoundcloudBpmCell instances can refresh without waiting for a page
 * reload / re-prefill.
 */
export function SoundcloudBatchAnalyzeButton({ tracks, className }: Props) {
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    if (!isTauri()) return;
    // Identify tracks that need analysis: no metadata bpm.
    const candidates: number[] = [];
    const needsAnalysis = tracks.filter((t) => t.bpm == null);
    for (const t of needsAnalysis) {
      const id = extractId(t);
      if (id > 0) candidates.push(id);
    }

    if (candidates.length === 0) {
      toast.info("All visible tracks already have a BPM");
      return;
    }

    // Filter out tracks that already have a cached analysis server-side.
    let queue = candidates;
    try {
      const resp = await api.getSoundcloudBpmsBulk(candidates);
      const cached = new Set(Object.keys(resp.bpms).map(Number));
      queue = candidates.filter((id) => !cached.has(id));
      if (queue.length < candidates.length) {
        for (const [idStr, bpm] of Object.entries(resp.bpms)) {
          window.dispatchEvent(
            new CustomEvent<ScBpmUpdatedDetail>(SC_BPM_UPDATED_EVENT, {
              detail: { trackId: Number(idStr), bpm },
            }),
          );
        }
      }
    } catch {
      // Cache probe is best-effort; fall through to analyzing everything.
    }

    if (queue.length === 0) {
      toast.info("All visible tracks already analyzed");
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setTotal(queue.length);
    setDone(0);
    setFailed(0);

    let token: string;
    try {
      ({ token } = await api.getSoundcloudClientToken());
    } catch (err) {
      toast.error(
        `Couldn't fetch SoundCloud token: ${err instanceof Error ? err.message : String(err)}`,
      );
      setRunning(false);
      return;
    }

    // Simple worker-pool loop with shared cursor.
    let cursor = 0;
    let completed = 0;
    let failures = 0;

    async function worker() {
      while (!abort.signal.aborted) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const trackId = queue[idx];
        try {
          const result = await analyzeScBpm(trackId, token);
          const rounded = Math.round(result.bpm);
          await api.saveSoundcloudBpm(trackId, result.bpm);
          window.dispatchEvent(
            new CustomEvent<ScBpmUpdatedDetail>(SC_BPM_UPDATED_EVENT, {
              detail: { trackId, bpm: rounded },
            }),
          );
        } catch {
          failures++;
          setFailed(failures);
        }
        completed++;
        setDone(completed);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    setRunning(false);
    if (abort.signal.aborted) {
      toast(`Cancelled after ${completed} track${completed === 1 ? "" : "s"}`);
    } else if (failures > 0) {
      toast.warning(
        `Analyzed ${completed - failures}/${queue.length} — ${failures} failed`,
      );
    } else {
      toast.success(`Analyzed ${completed} track${completed === 1 ? "" : "s"}`);
    }
  }, [tracks]);

  if (!isTauri()) return null;

  if (running) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className={className}
        onClick={() => abortRef.current?.abort()}
        title="Cancel batch analysis"
      >
        <Loader2 className="size-3.5 animate-spin" />
        <span className="tabular-nums">
          {done}/{total}
          {failed > 0 ? ` · ${failed} failed` : ""}
        </span>
        <X className="size-3.5" />
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      onClick={start}
      title="Analyze BPM for all visible tracks that don't have one"
    >
      <Waves className="size-3.5" />
      Analyze BPMs
    </Button>
  );
}
