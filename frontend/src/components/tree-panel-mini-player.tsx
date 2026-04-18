"use client";

import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Pause,
  Play,
} from "lucide-react";
import { useState } from "react";

import { MiniWaveform } from "@/components/mini-waveform";
import { api } from "@/lib/api";
import { usePlayer } from "@/lib/player-context";
import { cn } from "@/lib/utils";

/**
 * Compact player docked at the bottom of the tree panel.
 *
 * Default: small artwork + title + mini waveform.
 * ▲ toggle → square cover expands above the row.
 * ⤢ toggle → hides the small waveform and slides the full-width bottom
 *           waveform player into view. Only one waveform is visible at a time.
 */
export function TreePanelMiniPlayer() {
  const { currentTrack, isPlaying, toggle, largePlayer, setLargePlayer } =
    usePlayer();
  const [coverExpanded, setCoverExpanded] = useState(false);

  if (!currentTrack) return null;

  const artworkUrl = api.getArtworkUrl(currentTrack.filePath);
  const titleText = currentTrack.title ?? currentTrack.fileName;
  const artistText = currentTrack.artist ?? "";

  return (
    <div className="border-border relative shrink-0 overflow-hidden border-t bg-[var(--surface-2)]">
      {/* Expanded cover — in-flow above the row */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          coverExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="border-border border-b p-2">
            <div className="bg-muted aspect-square w-full overflow-hidden rounded-md">
              <img
                src={artworkUrl}
                alt=""
                className="size-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Default row */}
      <div className="flex items-center gap-2 p-2">
        {/* Artwork — click toggles play */}
        <button
          type="button"
          data-testid="player-toggle"
          className="bg-muted group/art relative flex size-10 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md"
          onClick={() => toggle()}
          title={isPlaying ? "Pause" : "Play"}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          <img
            src={artworkUrl}
            alt=""
            className="size-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/art:bg-black/40">
            {isPlaying ? (
              <Pause className="size-4 text-white opacity-0 transition-opacity group-hover/art:opacity-100" />
            ) : (
              <Play className="size-4 text-white opacity-0 transition-opacity group-hover/art:opacity-100" />
            )}
          </span>
        </button>

        {/* Title + (animated) waveform */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate text-xs" title={titleText}>
            {titleText}
          </div>
          <div
            className={cn(
              "w-full transition-[height,opacity] duration-200 ease-out",
              largePlayer ? "h-0 opacity-0" : "h-4 opacity-100",
            )}
          >
            {!largePlayer && (
              <MiniWaveform
                track={currentTrack}
                className="h-full w-full"
                halfHeight
              />
            )}
          </div>
          {artistText && (
            <div
              className="text-muted-foreground truncate text-xs"
              title={artistText}
            >
              {artistText}
            </div>
          )}
        </div>

        {/* Toggle column */}
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <button
            type="button"
            onClick={() => setCoverExpanded((v) => !v)}
            className={cn(
              "flex size-5 cursor-pointer items-center justify-center rounded-sm transition-colors",
              "text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)]",
              coverExpanded && "text-foreground bg-[var(--surface-3)]",
            )}
            title={coverExpanded ? "Collapse cover" : "Show cover"}
            aria-pressed={coverExpanded}
          >
            {coverExpanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronUp className="size-3" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setLargePlayer((v) => !v)}
            className={cn(
              "flex size-5 cursor-pointer items-center justify-center rounded-sm transition-colors",
              "text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)]",
              largePlayer && "text-foreground bg-[var(--surface-3)]",
            )}
            title={largePlayer ? "Collapse waveform" : "Expand waveform"}
            aria-pressed={largePlayer}
          >
            {largePlayer ? (
              <Minimize2 className="size-3" />
            ) : (
              <Maximize2 className="size-3" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
