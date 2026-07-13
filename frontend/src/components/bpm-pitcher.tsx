"use client";

import { ChevronDown, Gauge, Waves } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useCommand } from "@/components/command-palette/use-command";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { analyzeSc, TrackUnanalysableError } from "@/lib/sc-bpm";
import { markScUnplayable } from "@/lib/sc-unplayable";
import { analyzeLocalBpm, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const PITCH_RATE_MIN = 0.5;
const PITCH_RATE_MAX = 2.0;

/** Compute the playback rate the WaveformPlayer should apply. */
export function computePlaybackRate(
  pitchEnabled: boolean,
  currentBpm: number | null,
  targetBpm: number,
): number {
  if (!pitchEnabled || !currentBpm || currentBpm <= 0) return 1;
  const raw = targetBpm / currentBpm;
  return Math.min(PITCH_RATE_MAX, Math.max(PITCH_RATE_MIN, raw));
}

/** True if `track` is a SoundCloud track (has a numeric refresh key). */
function getScTrackId(track: PlayerTrack): number | null {
  const key = track.streamRefreshKey;
  if (typeof key === "number") return key;
  if (typeof key === "string") {
    const n = Number(key);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Run BPM detection for whichever track type is current. Returns rounded BPM
 * or null on failure. Caller handles toasts.
 *
 * `force=true` skips the cache lookup and re-runs analysis even when a
 * cached value exists — used by the manual "Re-detect" path. The auto-detect
 * effect always passes `force=false` so it never silently overwrites a
 * previously-saved BPM (e.g. one the user just edited in the table). */
async function detectBpmForTrack(
  track: PlayerTrack,
  { strong = false, force = false }: { strong?: boolean; force?: boolean } = {},
): Promise<number | null> {
  const scId = getScTrackId(track);
  if (scId !== null) {
    if (!force) {
      try {
        const cached = await api.getSoundcloudBpmsBulk([scId]);
        const hit = cached.bpms[String(scId)];
        if (typeof hit === "number" && hit > 0) {
          return hit;
        }
      } catch {
        /* Cache lookup is best-effort; fall through to fresh analysis. */
      }
    }
    const result = await analyzeSc(scId, false, strong);
    const rounded = Math.round(result.bpm);
    await api.saveSoundcloudBpm(scId, result.bpm).catch(() => {
      /* Persisting to backend cache is best-effort. */
    });
    // Notify table cells (and any other listener) so the visible BPM
    // updates without a full re-fetch of the bulk prefill.
    window.dispatchEvent(
      new CustomEvent<ScBpmUpdatedDetail>(SC_BPM_UPDATED_EVENT, {
        detail: { trackId: scId, bpm: rounded },
      }),
    );
    return rounded;
  }
  // Local file path.
  const result = await analyzeLocalBpm(track.filePath, false, strong);
  return Math.round(result.bpm);
}

/**
 * Resolve a track's BPM without user interaction: queue hint → backend cache
 * → fresh analysis (Tauri only). Used by the auto-mix arm step so the incoming
 * deck can fade in already pitched to the target BPM instead of snapping to it
 * after adoption. Dispatches `SC_BPM_UPDATED_EVENT` on resolution so the queue
 * hint (and table cells) pick the value up. Returns null when unknown.
 */
export async function resolveTrackBpm(
  track: PlayerTrack,
): Promise<number | null> {
  if (track.bpm != null) return track.bpm;
  const scId = getScTrackId(track);
  const announce = (bpm: number) => {
    if (scId === null) return;
    window.dispatchEvent(
      new CustomEvent<ScBpmUpdatedDetail>(SC_BPM_UPDATED_EVENT, {
        detail: { trackId: scId, bpm: Math.round(bpm) },
      }),
    );
  };
  try {
    if (!isTauri()) {
      // No analysis bridge — the backend BPM cache is the best we can do.
      if (scId === null) return null;
      const cached = await api.getSoundcloudBpmsBulk([scId]);
      const hit = cached.bpms[String(scId)];
      if (typeof hit === "number" && hit > 0) {
        announce(hit);
        return Math.round(hit);
      }
      return null;
    }
    const bpm = await detectBpmForTrack(track);
    // detectBpmForTrack only dispatches after fresh analysis; a cache hit must
    // reach the queue hint too (re-dispatch is idempotent for listeners).
    if (bpm != null) announce(bpm);
    return bpm;
  } catch (err) {
    console.warn("[mix] BPM resolution failed for", track.fileName, err);
    if (err instanceof TrackUnanalysableError && scId !== null) {
      markScUnplayable(scId);
    }
    return null;
  }
}

export function BpmPitcher() {
  const {
    currentTrack,
    currentBpm,
    setCurrentBpm,
    targetBpm,
    setTargetBpm,
    pitchEnabled,
    setPitchEnabled,
  } = usePlayer();

  const [open, setOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [targetInput, setTargetInput] = useState<string>(String(targetBpm));

  // Keep the input synced when targetBpm changes externally (load from
  // localStorage, or another control writes it).
  useEffect(() => {
    setTargetInput(String(targetBpm));
  }, [targetBpm]);

  // Auto-detect when pitch is enabled but the current track has no BPM yet.
  // Tauri-only — analysis APIs require the Rust bridge.
  const autoDetectGuardRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pitchEnabled || !currentTrack || currentBpm != null) return;
    // PlayerProvider reseeds `currentBpm` from `currentTrack.bpm` in a
    // post-commit effect, so on track switch this effect can briefly see
    // the previous render's `currentBpm = null` while the new track
    // already has a hint. Bail on the stable hint to avoid re-detecting
    // (and re-toasting) tracks that already have a BPM.
    if (currentTrack.bpm != null) return;
    if (!isTauri()) return;
    if (detecting) return;
    if (autoDetectGuardRef.current === currentTrack.filePath) return;
    autoDetectGuardRef.current = currentTrack.filePath;

    setDetecting(true);
    detectBpmForTrack(currentTrack)
      .then((bpm) => {
        if (bpm == null) return;
        setCurrentBpm(bpm);
        toast.success(`Detected ${bpm} BPM`);
      })
      .catch((err) => {
        if (err instanceof TrackUnanalysableError) {
          // SoundCloud refused the stream URL. Auto-detect runs silently —
          // no toast, the user didn't ask for this in the first place.
          const scId = currentTrack ? getScTrackId(currentTrack) : null;
          if (scId !== null) markScUnplayable(scId);
          console.warn("[bpm-pitcher] auto-detect skipped:", err.message);
          return;
        }
        toast.error(
          `BPM detection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => setDetecting(false));
  }, [pitchEnabled, currentTrack, currentBpm, setCurrentBpm, detecting]);

  const handleManualDetect = useCallback(
    async (strong = false) => {
      if (!currentTrack || !isTauri() || detecting) return;
      setDetecting(true);
      try {
        const bpm = await detectBpmForTrack(currentTrack, {
          force: true,
          strong,
        });
        if (bpm != null) {
          setCurrentBpm(bpm);
          toast.success(`Detected ${bpm} BPM`);
        }
      } catch (err) {
        // For a manual click the user is owed feedback either way — but soften
        // the message when SoundCloud just refuses the track.
        if (err instanceof TrackUnanalysableError) {
          const scId = currentTrack ? getScTrackId(currentTrack) : null;
          if (scId !== null) markScUnplayable(scId);
          toast.warning(err.message);
        } else {
          toast.error(
            `BPM detection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        setDetecting(false);
      }
    },
    [currentTrack, detecting, setCurrentBpm],
  );

  const commitTarget = useCallback(() => {
    const parsed = Number(targetInput);
    if (Number.isFinite(parsed) && parsed >= 60 && parsed <= 200) {
      setTargetBpm(parsed);
    } else {
      // Reject — restore previous value in the input.
      setTargetInput(String(targetBpm));
    }
  }, [targetInput, targetBpm, setTargetBpm]);

  // Command palette: toggle pitching.
  useCommand({
    id: "pitcher.toggle",
    label: pitchEnabled
      ? "Disable target-BPM pitching"
      : "Enable target-BPM pitching",
    description: `Pitch playback to ${targetBpm} BPM`,
    icon: Gauge,
    group: "Actions",
    keywords: ["bpm", "pitch", "tempo", "pitcher"],
    when: currentTrack != null,
    run: () => {
      setPitchEnabled(!pitchEnabled);
    },
  });

  if (!currentTrack) return null;

  const rate = computePlaybackRate(pitchEnabled, currentBpm, targetBpm);
  const ratePercent = (rate - 1) * 100;
  // When pitching is on, show the effective playback BPM (what you actually
  // hear). The rate is clamped to [0.5, 2.0], so this isn't always equal to
  // ``targetBpm`` — derive it from the rate so the readout stays honest.
  const effectiveBpm =
    pitchEnabled && currentBpm != null ? Math.round(currentBpm * rate) : null;
  const bpmLabel =
    effectiveBpm != null
      ? `${effectiveBpm}`
      : currentBpm != null
        ? `${currentBpm}`
        : "—";
  const tauri = isTauri();

  return (
    <div className="flex shrink-0 items-center pr-1 pl-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="bpm-pitcher-trigger"
            className="text-muted-foreground hover:bg-surface-3 flex h-9 cursor-pointer flex-col items-center justify-center rounded-md px-2 leading-none tabular-nums transition-colors"
            title="Target BPM"
            aria-label="Target BPM pitcher"
          >
            <span className="flex items-baseline gap-1">
              <span
                className={cn(
                  "text-xs font-semibold",
                  pitchEnabled ? "text-primary" : "text-foreground",
                )}
              >
                {bpmLabel}
              </span>
              {/* Label is never tinted — the value carries the pitch colour. */}
              <span className="text-muted-foreground text-[8px] tracking-wider uppercase">
                BPM
              </span>
            </span>
            {pitchEnabled && currentBpm != null && (
              <span
                data-testid="bpm-pitcher-rate-badge"
                className="text-2xs mt-0.5 tabular-nums"
              >
                {/* Original BPM in gray; the delta carries the pitch colour. */}
                <span className="text-muted-foreground">{currentBpm}</span>{" "}
                <span
                  className={
                    ratePercent === 0 ? "text-muted-foreground" : "text-primary"
                  }
                >
                  {ratePercent > 0 ? "+" : ""}
                  {ratePercent.toFixed(1)}%
                </span>
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          side="top"
          className="w-64"
          data-testid="bpm-pitcher-popover"
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                Target BPM
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={pitchEnabled}
                data-testid="bpm-pitcher-toggle"
                onClick={() => setPitchEnabled(!pitchEnabled)}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                  pitchEnabled ? "bg-primary" : "bg-surface-3",
                )}
                title={pitchEnabled ? "Pitching on" : "Pitching off"}
              >
                <span
                  className={cn(
                    "bg-background inline-block size-4 transform rounded-full shadow transition-transform",
                    pitchEnabled ? "translate-x-4" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                min={60}
                max={200}
                step={0.1}
                data-testid="bpm-pitcher-target-input"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                onBlur={commitTarget}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitTarget();
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
                className="border-input bg-background focus-visible:ring-ring/50 h-8 w-full rounded-md border px-2 text-sm tabular-nums focus-visible:ring-[3px] focus-visible:outline-none"
              />
              <span className="text-muted-foreground text-xs">BPM</span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Current</span>
              <span className="tabular-nums" data-testid="bpm-pitcher-current">
                {currentBpm != null ? `${currentBpm} BPM` : "Unknown"}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Playback rate</span>
              <span
                className="tabular-nums"
                data-testid="bpm-pitcher-rate-readout"
              >
                {rate.toFixed(3)}× ({ratePercent >= 0 ? "+" : ""}
                {ratePercent.toFixed(1)}%)
              </span>
            </div>

            {tauri && (
              <div className="flex items-stretch gap-px">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleManualDetect(false)}
                  disabled={detecting}
                  data-testid="bpm-pitcher-detect"
                  className="flex-1 rounded-r-none"
                >
                  {detecting ? (
                    <>
                      <Spinner />
                      Detecting…
                    </>
                  ) : (
                    <>
                      <Waves />
                      {currentBpm != null ? "Re-detect BPM" : "Detect BPM"}
                    </>
                  )}
                </Button>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={detecting}
                      aria-label="Detect options"
                      data-testid="bpm-pitcher-detect-menu"
                      className="rounded-l-none border-l-0 px-1.5"
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuItem
                      onClick={() => handleManualDetect(true)}
                      data-testid="bpm-pitcher-detect-strong"
                      className="items-start py-2"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">
                          {currentBpm != null ? "Re-detect" : "Detect"}{" "}
                          (stronger)
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
    </div>
  );
}
