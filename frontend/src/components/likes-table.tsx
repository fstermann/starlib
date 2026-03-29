'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, ChevronsUpDown, Music, Check } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api';
import type { SCTrack } from '@/lib/soundcloud';

const ROW_HEIGHT = 48;
const IFRAME_HEIGHT = 120;

type SortKey = 'title' | 'artist' | 'genre' | 'duration' | 'playback_count';
type SortOrder = 'asc' | 'desc';

interface Column {
  key: SortKey;
  label: string;
  className: string;
}

const COLUMNS: Column[] = [
  { key: 'title', label: 'Title', className: 'flex-3 min-w-0' },
  { key: 'artist', label: 'Artist', className: 'flex-2 min-w-0' },
  { key: 'genre', label: 'Genre', className: 'w-24 shrink-0' },
  { key: 'duration', label: 'Length', className: 'w-16 shrink-0 text-right' },
  { key: 'playback_count', label: 'Plays', className: 'w-16 shrink-0 text-right' },
];

function SortIcon({ col, sortBy, sortOrder }: { col: SortKey; sortBy: SortKey | null; sortOrder: SortOrder }) {
  if (col !== sortBy) return <ChevronsUpDown className="size-3 opacity-30" />;
  return sortOrder === 'asc'
    ? <ChevronUp className="size-3 text-primary" />
    : <ChevronDown className="size-3 text-primary" />;
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return '—';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatPlays(count: number | undefined): string {
  if (count == null) return '—';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function extractId(track: SCTrack): number {
  if (!track.urn) return 0;
  const parts = track.urn.split(':');
  return parseInt(parts[parts.length - 1], 10) || 0;
}

function artworkUrl(track: SCTrack): string | null {
  const url = track.artwork_url;
  if (!url) return null;
  return api.proxyImageUrl(url);
}

interface TrackRowProps {
  track: SCTrack;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: () => void;
  onExpand: () => void;
}

function TrackRow({ track, isSelected, isExpanded, onToggleSelect, onExpand }: TrackRowProps) {
  const imgUrl = artworkUrl(track);

  return (
    <div>
      <div
        role="row"
        tabIndex={0}
        className={`flex items-center h-12 gap-2 px-3 border-b border-border/30 transition-colors select-none cursor-pointer
          ${isExpanded ? 'bg-accent/40' : 'hover:bg-accent/20'}`}
        onClick={onExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onExpand();
          if (e.key === ' ') { e.preventDefault(); onToggleSelect(); }
        }}
      >
        {/* Checkbox */}
        <div className="shrink-0 w-6 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={isSelected}
            onCheckedChange={onToggleSelect}
            className="size-3.5"
          />
        </div>

        {/* Artwork */}
        <div className="size-8 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
          {imgUrl
            ? <img src={imgUrl} alt="" className="size-8 object-cover" loading="lazy" />
            : <Music className="size-3.5 text-muted-foreground/50" />}
        </div>

        {/* Title */}
        <div className="flex-3 min-w-0 flex flex-col justify-center">
          <span className={`text-xs font-medium truncate leading-tight ${isExpanded ? 'text-primary' : ''}`}>
            {track.title || '—'}
          </span>
        </div>

        {/* Artist */}
        <span className="flex-2 min-w-0 text-xs text-muted-foreground truncate">
          {track.user?.username || '—'}
        </span>

        {/* Genre */}
        <span className="w-24 shrink-0 text-xs text-muted-foreground truncate">
          {track.genre || '—'}
        </span>

        {/* Duration */}
        <span className="w-16 shrink-0 text-xs text-muted-foreground text-right tabular-nums">
          {formatDuration(track.duration)}
        </span>

        {/* Play count */}
        <span className="w-16 shrink-0 text-xs text-muted-foreground text-right tabular-nums">
          {formatPlays(track.playback_count)}
        </span>
      </div>

      {/* SC iframe embed */}
      {isExpanded && track.permalink_url && (
        <div className="px-3 py-2 border-b border-border/30 bg-muted/20">
          <iframe
            width="100%"
            height={IFRAME_HEIGHT}
            scrolling="no"
            frameBorder="no"
            allow="autoplay"
            src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(track.permalink_url)}&color=%23e05d38&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=true`}
            className="rounded-lg overflow-hidden"
          />
        </div>
      )}
    </div>
  );
}

interface LikesTableProps {
  tracks: SCTrack[];
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
}

export function LikesTable({ tracks, selectedIds, onToggleSelect }: LikesTableProps) {
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);

  const sortedTracks = useMemo(() => {
    if (!sortBy) return tracks;
    const sorted = [...tracks].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'title':
          cmp = (a.title ?? '').localeCompare(b.title ?? '');
          break;
        case 'artist':
          cmp = (a.user?.username ?? '').localeCompare(b.user?.username ?? '');
          break;
        case 'genre':
          cmp = (a.genre ?? '').localeCompare(b.genre ?? '');
          break;
        case 'duration':
          cmp = (a.duration ?? 0) - (b.duration ?? 0);
          break;
        case 'playback_count':
          cmp = (a.playback_count ?? 0) - (b.playback_count ?? 0);
          break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [tracks, sortBy, sortOrder]);

  const virtualizer = useVirtualizer({
    count: sortedTracks.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: useCallback(
      (index: number) => {
        const track = sortedTracks[index];
        const id = track ? extractId(track) : 0;
        return id === expandedId ? ROW_HEIGHT + IFRAME_HEIGHT + 16 : ROW_HEIGHT;
      },
      [sortedTracks, expandedId],
    ),
    overscan: 12,
  });

  function handleSort(col: SortKey) {
    if (col !== sortBy) {
      setSortBy(col);
      setSortOrder('asc');
    } else if (sortOrder === 'asc') {
      setSortOrder('desc');
    } else {
      setSortBy(null);
      setSortOrder('asc');
    }
  }

  function handleExpand(track: SCTrack) {
    const id = extractId(track);
    setExpandedId((prev) => (prev === id ? null : id));
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div role="row" className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-border bg-muted/30 text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
        <div className="shrink-0 w-6" />
        <div className="shrink-0 size-8" />
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            className={`flex items-center gap-0.5 ${col.className} hover:text-foreground transition-colors cursor-pointer`}
            onClick={() => handleSort(col.key)}
          >
            {col.label}
            <SortIcon col={col.key} sortBy={sortBy} sortOrder={sortOrder} />
          </button>
        ))}
      </div>

      {/* Virtual scroll */}
      <div ref={scrollParentRef} className="flex-1 overflow-y-auto overscroll-contain min-h-0">
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {virtualItems.map((virtualRow) => {
            const track = sortedTracks[virtualRow.index];
            if (!track) return null;
            const id = extractId(track);

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <TrackRow
                  track={track}
                  isSelected={selectedIds.has(id)}
                  isExpanded={expandedId === id}
                  onToggleSelect={() => onToggleSelect(id)}
                  onExpand={() => handleExpand(track)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
