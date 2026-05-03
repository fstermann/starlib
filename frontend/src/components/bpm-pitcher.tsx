"use client";

import { Gauge, Loader2, Waves } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useCommand } from "@/components/command-palette/use-command";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { analyzeLocalBpm, analyzeScBpm, isTauri } from "@/lib/tauri";
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
 * or null on failure. Caller handles toasts. */
async function detectBpmForTrack(track: PlayerTrack): Promise<number | null> {
  const scId = getScTrackId(track);
  if (scId !== null) {
    const { token } = await api.getSoundcloudClientToken();
    const result = await analyzeScBpm(scId, token);
    await api.saveSoundcloudBpm(scId, result.bpm).catch(() => {
      /* Persisting to backend cache is best-effort. */
    });
    return Math.round(result.bpm);
  }
  // Local file path.
  const result = await analyzeLocalBpm(track.filePath);
  return Math.round(result.bpm);
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
        toast.error(
          `BPM detection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => setDetecting(false));
  }, [pitchEnabled, currentTrack, currentBpm, setCurrentBpm, detecting]);

  const handleManualDetect = useCallback(async () => {
    if (!currentTrack || !isTauri() || detecting) return;
    setDetecting(true);
    try {
      const bpm = await detectBpmForTrack(currentTrack);
      if (bpm != null) {
        setCurrentBpm(bpm);
        toast.success(`Detected ${bpm} BPM`);
      }
    } catch (err) {
      toast.error(
        `BPM detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDetecting(false);
    }
  }, [currentTrack, detecting, setCurrentBpm]);

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
  const bpmLabel = currentBpm != null ? `${currentBpm}` : "—";
  const tauri = isTauri();

  return (
    <div className="flex shrink-0 items-center pr-1 pl-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="bpm-pitcher-trigger"
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs tabular-nums transition-colors",
              pitchEnabled && "text-primary hover:text-primary",
            )}
            title="Target BPM"
            aria-label="Target BPM pitcher"
          >
            <Gauge className="size-3.5" />
            <span className="font-medium">{bpmLabel}</span>
            <span className="text-2xs opacity-70">BPM</span>
            {pitchEnabled && currentBpm != null && (
              <span
                data-testid="bpm-pitcher-rate-badge"
                className={cn(
                  "text-2xs ml-0.5 rounded px-1 py-0.5 tabular-nums",
                  ratePercent === 0
                    ? "bg-surface-3"
                    : ratePercent > 0
                      ? "bg-primary/15 text-primary"
                      : "bg-primary/15 text-primary",
                )}
              >
                {ratePercent > 0 ? "+" : ""}
                {ratePercent.toFixed(1)}%
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
              <Button
                variant="outline"
                size="sm"
                onClick={handleManualDetect}
                disabled={detecting}
                data-testid="bpm-pitcher-detect"
                className="w-full"
              >
                {detecting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Detecting…
                  </>
                ) : (
                  <>
                    <Waves />
                    {currentBpm != null ? "Re-detect BPM" : "Detect BPM"}
                  </>
                )}
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
