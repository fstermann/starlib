"use client";

import { Ban, Music, Pause, Play } from "lucide-react";
import { useState } from "react";

import { Spinner } from "@/components/spinner";
import { usePlayer } from "@/lib/player-context";
import { cn } from "@/lib/utils";

interface CoverPlayButtonProps {
  /** Artwork image URL; falls back to a music-note glyph. */
  artworkUrl?: string | null;
  /** Whether this row's track is the one loaded in the player. */
  isCurrent: boolean;
  /** Start playback for this row (parent installs queue context). Awaited so
   * the cover shows a spinner while e.g. an SC stream URL resolves. When
   * omitted (and the row isn't current), the cover renders non-interactive. */
  onStartPlay?: () => void | Promise<void>;
  /** Playback is known to fail (e.g. SC refuses to stream) — shows a Ban
   * glyph on hover and disables the button. */
  unplayable?: boolean;
  /** Track name for the accessible button label. */
  label?: string;
  className?: string;
}

const COVER_CLASSES =
  "bg-muted relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded";

/**
 * Row artwork cover with a play/pause overlay on hover — the shared playback
 * affordance across the Filesystem / SoundCloud / Rekordbox track tables.
 * Clicking toggles the current track or starts playback via `onStartPlay`.
 */
export function CoverPlayButton({
  artworkUrl,
  isCurrent,
  onStartPlay,
  unplayable = false,
  label,
  className,
}: CoverPlayButtonProps) {
  const { isPlaying, toggle } = usePlayer();
  const [loading, setLoading] = useState(false);
  const isActive = isCurrent && isPlaying;

  const art = artworkUrl ? (
    <img
      src={artworkUrl}
      alt=""
      className="size-7 object-cover"
      loading="lazy"
    />
  ) : (
    <Music className="text-muted-foreground size-3.5" />
  );

  if (!unplayable && !onStartPlay && !isCurrent) {
    return <div className={cn(COVER_CLASSES, className)}>{art}</div>;
  }

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (unplayable || loading) return;
    if (isCurrent) {
      toggle();
      return;
    }
    if (!onStartPlay) return;
    setLoading(true);
    try {
      await onStartPlay();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={unplayable}
      aria-busy={loading}
      aria-label={
        unplayable
          ? "Track unavailable for playback"
          : `${isActive ? "Pause" : "Play"}${label ? ` ${label}` : ""}`
      }
      title={unplayable ? "Track unavailable for playback" : undefined}
      className={cn(
        "group/cover",
        COVER_CLASSES,
        unplayable ? "cursor-default" : "cursor-pointer",
        className,
      )}
    >
      {art}
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity",
          "group-hover/cover:opacity-100 group-focus-visible/cover:opacity-100",
          loading && "opacity-100",
        )}
      >
        {loading ? (
          <Spinner className="size-3.5" />
        ) : unplayable ? (
          <Ban className="size-3.5" />
        ) : isActive ? (
          <Pause className="size-3.5 fill-current" />
        ) : (
          <Play className="size-3.5 fill-current" />
        )}
      </span>
    </button>
  );
}
