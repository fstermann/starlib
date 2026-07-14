"use client";

import { Blend } from "lucide-react";

import { useCommand } from "@/components/command-palette/use-command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CROSSFADE_SECONDS_MAX,
  CROSSFADE_SECONDS_MIN,
  MATCH_BARS_STEPS,
  MIX_MODE_DESCRIPTIONS,
  MIX_MODE_LABELS,
  type MixMode,
} from "@/lib/mix/config";
import { usePlayer } from "@/lib/player-context";
import { cn } from "@/lib/utils";

const MODES: MixMode[] = ["crossfade", "beatgrid", "beatgrid-eq", "loop-eq"];

/**
 * Player-rail control for auto-mix (crossfade). Mirrors the BpmPitcher popover:
 * a trigger showing the current state, opening a popover with the on/off
 * toggle, mode selector, and the mode's parameters.
 */
export function MixControls() {
  const { currentTrack, mixConfig, setMixConfig } = usePlayer();
  const { enabled, mode } = mixConfig;
  // Beatgrids come from Rekordbox analysis — SoundCloud streams never have
  // one, so a beatgrid mix would fall back to a plain crossfade.
  const hasBeatgrid = !!currentTrack?.rekordboxId;

  // Command palette: toggle auto-mix.
  useCommand({
    id: "mix.toggle",
    label: enabled ? "Disable auto-mix" : "Enable auto-mix",
    description: "Crossfade into the next track at the end of this one",
    icon: Blend,
    group: "Actions",
    keywords: ["mix", "crossfade", "transition", "blend", "automix"],
    when: currentTrack != null,
    run: () => setMixConfig({ ...mixConfig, enabled: !enabled }),
  });

  if (!currentTrack) return null;

  return (
    <div className="flex shrink-0 items-center">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="mix-controls-trigger"
            data-active={enabled || undefined}
            className={cn(
              "hover:bg-surface-3 flex h-9 cursor-pointer flex-col items-center justify-center rounded-md px-2 leading-none transition-colors",
              enabled ? "text-primary" : "text-muted-foreground",
            )}
            title="Auto-mix"
            aria-label="Auto-mix settings"
          >
            <Blend className="size-4" />
            <span className="text-[8px] tracking-wider uppercase">Mix</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          side="top"
          className="w-72"
          data-testid="mix-controls-popover"
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-2xs text-muted-foreground font-medium tracking-wider uppercase">
                Auto-mix
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                data-testid="mix-enabled-toggle"
                onClick={() =>
                  setMixConfig({ ...mixConfig, enabled: !enabled })
                }
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                  enabled ? "bg-primary" : "bg-surface-3",
                )}
                title={enabled ? "Auto-mix on" : "Auto-mix off"}
              >
                <span
                  className={cn(
                    "bg-background inline-block size-4 transform rounded-full shadow transition-transform",
                    enabled ? "translate-x-4" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>

            {/* Mode selector — the selected card expands with its settings */}
            <div className="flex flex-col gap-1">
              {MODES.map((m) => (
                <div
                  key={m}
                  data-testid={`mix-mode-${m}-card`}
                  className={cn(
                    "rounded-md border transition-colors",
                    mode === m
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-surface-3",
                  )}
                >
                  <button
                    type="button"
                    data-testid={`mix-mode-${m}`}
                    data-active={mode === m || undefined}
                    onClick={() => setMixConfig({ ...mixConfig, mode: m })}
                    className="flex w-full cursor-pointer flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                  >
                    <span
                      className={cn(
                        "text-sm font-medium",
                        mode === m ? "text-primary" : "text-foreground",
                      )}
                    >
                      {MIX_MODE_LABELS[m]}
                    </span>
                    <span className="text-muted-foreground text-xs leading-snug">
                      {MIX_MODE_DESCRIPTIONS[m]}
                    </span>
                  </button>

                  {mode === m && m === "crossfade" && (
                    <div className="border-border mx-2 flex flex-col gap-1.5 border-t pt-1.5 pb-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          Fade length
                        </span>
                        <span
                          className="tabular-nums"
                          data-testid="mix-crossfade-seconds-readout"
                        >
                          {mixConfig.crossfadeSeconds}s
                        </span>
                      </div>
                      <input
                        type="range"
                        min={CROSSFADE_SECONDS_MIN}
                        max={CROSSFADE_SECONDS_MAX}
                        step={1}
                        value={mixConfig.crossfadeSeconds}
                        data-testid="mix-crossfade-seconds"
                        onChange={(e) =>
                          setMixConfig({
                            ...mixConfig,
                            crossfadeSeconds: Number(e.target.value),
                          })
                        }
                        className="accent-primary h-1 w-full cursor-pointer"
                      />
                    </div>
                  )}

                  {mode === m &&
                    (m === "beatgrid" ||
                      m === "beatgrid-eq" ||
                      m === "loop-eq") && (
                      <div className="border-border mx-2 flex flex-col gap-2 border-t pt-1.5 pb-2">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground text-xs">
                            Overlap
                          </span>
                          <div className="flex items-center gap-0.5">
                            {MATCH_BARS_STEPS.map((bars) => (
                              <button
                                key={bars}
                                type="button"
                                data-testid={`mix-bars-${bars}`}
                                data-active={
                                  mixConfig.matchBars === bars || undefined
                                }
                                onClick={() =>
                                  setMixConfig({
                                    ...mixConfig,
                                    matchBars: bars,
                                  })
                                }
                                className={cn(
                                  "flex h-6 w-9 cursor-pointer items-center justify-center rounded-md border text-xs font-semibold tabular-nums transition-colors",
                                  mixConfig.matchBars === bars
                                    ? "border-primary text-primary"
                                    : "border-border text-muted-foreground hover:bg-surface-3",
                                )}
                              >
                                {bars}
                              </button>
                            ))}
                            <span className="text-muted-foreground ml-1 text-xs">
                              bars
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground text-xs">
                            Section-aware
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={mixConfig.sectionAware}
                            data-testid="mix-section-aware"
                            onClick={() =>
                              setMixConfig({
                                ...mixConfig,
                                sectionAware: !mixConfig.sectionAware,
                              })
                            }
                            className={cn(
                              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                              mixConfig.sectionAware
                                ? "bg-primary"
                                : "bg-surface-3",
                            )}
                            title="Snap mix to section boundaries"
                          >
                            <span
                              className={cn(
                                "bg-background inline-block size-4 transform rounded-full shadow transition-transform",
                                mixConfig.sectionAware
                                  ? "translate-x-4"
                                  : "translate-x-0.5",
                              )}
                            />
                          </button>
                        </div>
                        {hasBeatgrid ? (
                          <p className="text-muted-foreground text-xs leading-snug">
                            Needs a beatgrid on both tracks; without one this
                            transition falls back to a plain crossfade.
                          </p>
                        ) : (
                          <p
                            className="text-warning text-xs leading-snug"
                            data-testid="mix-beatgrid-unavailable"
                          >
                            This track has no beatgrid — a plain crossfade is
                            used instead.
                          </p>
                        )}
                      </div>
                    )}
                </div>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
