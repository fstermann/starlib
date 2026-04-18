'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, ChevronsUpDown, Music, FolderCheck, ShoppingCart, Download } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { SCTrack } from '@/lib/soundcloud';

const ROW_HEIGHT = 48;
const IFRAME_HEIGHT = 166;
const DESCRIPTION_HEIGHT = 120;

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

function searchQuery(track: SCTrack): string {
  const artist = track.user?.username ?? '';
  const title = track.title ?? '';
  return `${artist} ${title}`.trim();
}

function purchaseIcon(url: string): { src: string; alt: string } | null {
  try {
    const host = new URL(url).hostname;
    if (host.includes('hypeddit')) return { src: '/icons/hypeddit.svg', alt: 'Hypeddit' };
    if (host.includes('bandcamp')) return { src: '/icons/bandcamp.svg', alt: 'Bandcamp' };
    if (host.includes('beatport')) return { src: '/icons/beatport.svg', alt: 'Beatport' };
  } catch { /* invalid url */ }
  return null;
}

interface TrackRowProps {
  track: SCTrack;
  isSelected: boolean;
  isExpanded: boolean;
  inCollection: boolean;
  isNew?: boolean;
  onToggleSelect: (shiftKey: boolean) => void;
  onExpand: () => void;
}

function TrackRow({ track, isSelected, isExpanded, inCollection, isNew, onToggleSelect, onExpand }: TrackRowProps) {
  const imgUrl = artworkUrl(track);

  return (
    <div>
      <div
        role="row"
        tabIndex={0}
        className={`flex items-center h-10 gap-2 px-3 border-b border-border transition-colors select-none cursor-pointer
          ${isSelected ? 'bg-[var(--brand-soft)]' : isExpanded ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-3)]'}`}
        onClick={onExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onExpand();
          if (e.key === ' ') { e.preventDefault(); onToggleSelect(e.shiftKey); }
        }}
      >
        {/* Checkbox */}
        <div
          className="shrink-0 w-6 self-stretch flex items-center justify-center cursor-pointer"
          onClick={(e) => { e.stopPropagation(); onToggleSelect(e.shiftKey); }}
        >
          <Checkbox
            checked={isSelected}
            className="size-3.5 pointer-events-none"
          />
        </div>

        {/* Artwork */}
        <div className="size-7 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
          {imgUrl
            ? <img src={imgUrl} alt="" className="size-7 object-cover" loading="lazy" />
            : <Music className="size-3.5 text-muted-foreground/50" />}
        </div>

        {/* Title */}
        <div className="flex-3 min-w-0 flex items-center gap-1.5">
          <span className={`text-xs font-medium truncate leading-tight ${isExpanded ? 'text-primary' : ''}`}>
            {track.title || '—'}
          </span>
          {isNew && (
            <span className="shrink-0 text-[9px] font-semibold px-1 py-0.5 rounded bg-[var(--brand-soft)] text-[var(--brand)] leading-none">
              NEW
            </span>
          )}
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

        {/* Links group: Collection + Download + Buy/Search */}
        <div className={`w-28 shrink-0 flex items-center justify-between ${inCollection ? 'opacity-35' : ''}`}>
          <div className="flex items-center justify-center size-5" title={inCollection ? 'In collection' : undefined}>
            {inCollection && <FolderCheck className="size-3.5 text-primary" />}
          </div>
          <TooltipProvider>
            {track.download_url ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={track.download_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center size-5 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Download className="size-3" />
                  </a>
                </TooltipTrigger>
                <TooltipContent>Download</TooltipContent>
              </Tooltip>
            ) : (
              <div className="size-5" />
            )}
            {track.purchase_url ? (() => {
              const icon = purchaseIcon(track.purchase_url);
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href={track.purchase_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center size-5 text-muted-foreground hover:text-foreground transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {icon
                        ? <img src={icon.src} alt={icon.alt} className="size-3.5" />
                        : <ShoppingCart className="size-3" />}
                    </a>
                  </TooltipTrigger>
                  <TooltipContent>{track.purchase_title || icon?.alt || 'Buy'}</TooltipContent>
                </Tooltip>
              );
            })() : (
              <div className="size-5" />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={`https://bandcamp.com/search?q=${encodeURIComponent(searchQuery(track))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center size-5 opacity-40 hover:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <img src="/icons/bandcamp.svg" alt="Bandcamp" className="size-3.5" />
                </a>
              </TooltipTrigger>
              <TooltipContent>Search Bandcamp</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={`https://www.beatport.com/search?q=${encodeURIComponent(searchQuery(track))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center size-5 opacity-40 hover:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <img src="/icons/beatport.svg" alt="Beatport" className="size-3.5" />
                </a>
              </TooltipTrigger>
              <TooltipContent>Search Beatport</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Expanded detail: player + description */}
      {isExpanded && (
        <div className="px-3 py-2 border-b border-border/30 bg-muted/20 space-y-2">
          {track.permalink_url && (
            <iframe
              width="100%"
              height={IFRAME_HEIGHT}
              scrolling="no"
              frameBorder="no"
              allow="autoplay"
              src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(track.permalink_url)}&color=${encodeURIComponent('#bde752')}&auto_play=false&buying=false&sharing=false&download=false&show_artwork=true&show_playcount=false&show_user=true&hide_related=true&show_comments=false&show_reposts=false&show_teaser=false&visual=true`}
              className="rounded-lg overflow-hidden"
            />
          )}
          {track.description && (
            <p className="text-xs text-muted-foreground whitespace-pre-line max-w-prose">
              {track.description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface LikesTableProps {
  tracks: SCTrack[];
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onRangeSelect: (ids: number[]) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  collectionIds?: Set<number>;
  newTrackUrns?: Set<string>;
}

export function LikesTable({ tracks, selectedIds, onToggleSelect, onRangeSelect, onSelectAll, onDeselectAll, collectionIds, newTrackUrns }: LikesTableProps) {
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);

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
        if (id !== expandedId) return ROW_HEIGHT;
        let h = ROW_HEIGHT + 16; // padding
        if (track?.permalink_url) h += IFRAME_HEIGHT;
        if (track?.description) h += DESCRIPTION_HEIGHT;
        return h;
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
  const someSelected = selectedIds.size > 0;
  const allSelected = sortedTracks.length > 0 && sortedTracks.every((t) => { const id = extractId(t); return id != null && selectedIds.has(id); });

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div role="row" className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-border bg-[var(--surface-2)] text-xs font-medium text-muted-foreground">
        <div className="shrink-0 w-6 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={(checked) => checked ? onSelectAll() : onDeselectAll()}
            aria-label="Select all"
            className={cn(
              "size-3.5 cursor-pointer",
              "data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:text-primary-foreground",
              allSelected && "data-[state=checked]:bg-primary data-[state=checked]:border-primary",
            )}
          />
        </div>
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
        <div className="w-28 shrink-0 flex items-center justify-center gap-1" title="Links">
          <FolderCheck className="size-3 opacity-50" />
          <span className="text-[10px] opacity-50">Links</span>
        </div>
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
                  inCollection={collectionIds?.has(id) ?? false}
                  isNew={newTrackUrns ? (track.urn ? newTrackUrns.has(track.urn) : false) : undefined}
                  onToggleSelect={(shiftKey) => {
                    const currentIndex = virtualRow.index;
                    if (shiftKey && lastSelectedIndexRef.current !== null) {
                      const start = Math.min(lastSelectedIndexRef.current, currentIndex);
                      const end = Math.max(lastSelectedIndexRef.current, currentIndex);
                      const rangeIds = sortedTracks.slice(start, end + 1).map(extractId).filter(Boolean);
                      onRangeSelect(rangeIds);
                    } else {
                      onToggleSelect(id);
                      lastSelectedIndexRef.current = currentIndex;
                    }
                  }}
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
