'use client';

import { useState } from 'react';
import { ChevronUp, ChevronDown, Maximize2, Minimize2, Play, Pause } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { usePlayer } from '@/lib/player-context';
import { MiniWaveform } from '@/components/mini-waveform';

/**
 * Compact player docked at the bottom of the tree panel.
 *
 * Default: small artwork + title + mini waveform.
 * ▲ toggle → square cover expands above the row.
 * ⤢ toggle → hides the small waveform and slides the full-width bottom
 *           waveform player into view. Only one waveform is visible at a time.
 */
export function TreePanelMiniPlayer() {
  const { currentTrack, isPlaying, toggle, largePlayer, setLargePlayer } = usePlayer();
  const [coverExpanded, setCoverExpanded] = useState(false);

  if (!currentTrack) return null;

  const artworkUrl = api.getArtworkUrl(currentTrack.filePath);
  const titleText = currentTrack.title ?? currentTrack.fileName;
  const artistText = currentTrack.artist ?? '';

  return (
    <div className="shrink-0 border-t border-border bg-[var(--surface-2)] relative overflow-hidden">
      {/* Expanded cover — in-flow above the row */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          coverExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="aspect-square w-full rounded-md overflow-hidden bg-muted">
              <img
                src={artworkUrl}
                alt=""
                className="size-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
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
          className="relative shrink-0 size-10 rounded-md overflow-hidden bg-muted flex items-center justify-center cursor-pointer group/art"
          onClick={() => toggle()}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          <img
            src={artworkUrl}
            alt=""
            className="size-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <span className="absolute inset-0 bg-black/0 group-hover/art:bg-black/40 transition-colors flex items-center justify-center">
            {isPlaying
              ? <Pause className="size-4 text-white opacity-0 group-hover/art:opacity-100 transition-opacity" />
              : <Play className="size-4 text-white opacity-0 group-hover/art:opacity-100 transition-opacity" />}
          </span>
        </button>

        {/* Title + (animated) waveform */}
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="text-xs truncate" title={titleText}>{titleText}</div>
          <div
            className={cn(
              'w-full transition-[height,opacity] duration-200 ease-out',
              largePlayer ? 'h-0 opacity-0' : 'h-4 opacity-100',
            )}
          >
            {!largePlayer && (
              <MiniWaveform track={currentTrack} className="w-full h-full" halfHeight />
            )}
          </div>
          {artistText && (
            <div className="text-xs text-muted-foreground truncate" title={artistText}>{artistText}</div>
          )}
        </div>

        {/* Toggle column */}
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setCoverExpanded((v) => !v)}
            className={cn(
              'size-5 flex items-center justify-center rounded-sm cursor-pointer transition-colors',
              'text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)]',
              coverExpanded && 'text-foreground bg-[var(--surface-3)]',
            )}
            title={coverExpanded ? 'Collapse cover' : 'Show cover'}
            aria-pressed={coverExpanded}
          >
            {coverExpanded ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          </button>
          <button
            type="button"
            onClick={() => setLargePlayer((v) => !v)}
            className={cn(
              'size-5 flex items-center justify-center rounded-sm cursor-pointer transition-colors',
              'text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)]',
              largePlayer && 'text-foreground bg-[var(--surface-3)]',
            )}
            title={largePlayer ? 'Collapse waveform' : 'Expand waveform'}
            aria-pressed={largePlayer}
          >
            {largePlayer ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
          </button>
        </div>
      </div>
    </div>
  );
}
