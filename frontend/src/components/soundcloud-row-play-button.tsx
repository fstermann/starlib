"use client";

import { Loader2, Pause, Play } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { usePlayer } from "@/lib/player-context";
import { cn } from "@/lib/utils";

interface SoundcloudRowPlayButtonProps {
  trackId: number | string;
  title?: string;
  artist?: string;
  /** Pre-rendered SoundCloud waveform URL, if known. */
  waveformUrl?: string;
  /** SoundCloud permalink URL for the track. */
  permalinkUrl?: string;
  /** Track artwork URL. */
  artworkUrl?: string;
  /** Known BPM for the track (cached or metadata) — seeds the pitcher. */
  bpm?: number | null;
  className?: string;
  /** When provided, called instead of the button's default single-track
   * playback. Lets the parent install queue context before playback begins.
   * Should return a promise that resolves once playback has started. */
  onStartPlay?: () => Promise<void> | void;
}

/** Small icon-only play button for a SoundCloud row. Fetches a short-lived
 * HLS stream URL from the backend and hands it to the shared player. */
export function SoundcloudRowPlayButton({
  trackId,
  title,
  artist,
  waveformUrl,
  permalinkUrl,
  artworkUrl,
  bpm,
  className,
  onStartPlay,
}: SoundcloudRowPlayButtonProps) {
  const { currentTrack, isPlaying, play, toggle } = usePlayer();
  const [loading, setLoading] = useState(false);

  const trackKey = `soundcloud:${trackId}`;
  const isCurrent = currentTrack?.filePath === trackKey;
  const isActive = isCurrent && isPlaying;

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (isCurrent) {
      toggle();
      return;
    }
    setLoading(true);
    try {
      if (onStartPlay) {
        await onStartPlay();
      } else {
        const { url } = await api.getSoundcloudStreamUrl(trackId);
        play({
          filePath: trackKey,
          fileName: title ?? String(trackId),
          title,
          artist,
          streamUrl: url,
          waveformUrl,
          streamRefreshKey: trackId,
          permalinkUrl,
          artworkUrl,
          bpm: bpm ?? null,
        });
      }
    } catch (err) {
      console.error("Failed to start SoundCloud playback:", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={isActive ? "Pause" : "Play"}
      aria-busy={loading}
      disabled={loading}
      onClick={handleClick}
      className={cn(isActive && "text-primary", className)}
    >
      {loading ? (
        <Loader2 className="animate-spin" />
      ) : isActive ? (
        <Pause />
      ) : (
        <Play />
      )}
    </Button>
  );
}
