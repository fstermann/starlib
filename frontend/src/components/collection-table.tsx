'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryState } from 'nuqs';
import { searchParams } from '@/lib/search-params';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Play, Pause, ChevronUp, ChevronDown, ChevronsUpDown, Music } from 'lucide-react';
import { api, type TrackBrowse, type BrowseParams } from '@/lib/api';
import { usePlayer, type PlayerTrack } from '@/lib/player-context';
import { MiniWaveform } from '@/components/mini-waveform';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 50;
const ROW_HEIGHT = 48;

type SortBy = NonNullable<BrowseParams['sort_by']>;
type SortOrder = 'asc' | 'desc';

interface CollectionTableProps {
  mode: string;
  scrollToFilePath?: string;
  onSelect?: (item: TrackBrowse) => void;
  onTotalChange?: (total: number, cacheLoading: boolean) => void;
}

interface Column {
  key: SortBy;
  label: string;
  className: string;
  sortable?: boolean;
}

const COLUMNS: Column[] = [
  { key: 'title', label: 'Title', className: 'flex-[3] min-w-0', sortable: true },
  { key: 'artist', label: 'Artist', className: 'flex-[2] min-w-0', sortable: true },
  { key: 'genre', label: 'Genre', className: 'w-28 shrink-0', sortable: true },
  { key: 'bpm', label: 'BPM', className: 'w-14 shrink-0 text-right', sortable: true },
  { key: 'key', label: 'Key', className: 'w-14 shrink-0', sortable: true },
  { key: 'release_date', label: 'Date', className: 'w-20 shrink-0', sortable: true },
  { key: 'file_name', label: 'Length', className: 'w-14 shrink-0 text-right' },
];

function SortIcon({ col, sortBy, sortOrder }: { col: SortBy; sortBy: SortBy; sortOrder: SortOrder }) {
  if (col !== sortBy) return <ChevronsUpDown className="size-3 opacity-30" />;
  return sortOrder === 'asc'
    ? <ChevronUp className="size-3 text-primary" />
    : <ChevronDown className="size-3 text-primary" />;
}

interface RowProps {
  item: TrackBrowse;
  isActive: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  onSelect: () => void;
}

function TrackRow({ item, isActive, isPlaying, onPlay, onSelect }: RowProps) {
  const artworkUrl = item.has_artwork ? api.getArtworkUrl(item.file_path) : null;
  const [artworkReady, setArtworkReady] = useState(!item.has_artwork);
  const track: PlayerTrack = {
    filePath: item.file_path,
    fileName: item.file_name,
    title: item.title ?? undefined,
    artist: item.artist ?? undefined,
  };

  return (
    <div
      role="row"
      tabIndex={0}
      className={`flex items-center h-12 gap-2 px-3 border-b border-border/30 transition-colors select-none cursor-pointer
        ${isActive ? 'bg-accent/40' : 'hover:bg-accent/20'}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
        if (e.key === ' ') { e.preventDefault(); onPlay(); }
      }}
    >
      {/* Play / Pause button */}
      <button
        className={`shrink-0 w-6 h-6 flex items-center justify-center rounded transition-colors cursor-pointer ${isActive ? 'text-primary hover:text-primary/80' : 'text-muted-foreground hover:text-foreground'}`}
        onClick={(e) => { e.stopPropagation(); onPlay(); }}
        aria-label={isActive && isPlaying ? 'Pause' : `Play ${item.title || item.file_name}`}
      >
        {isActive && isPlaying
          ? <Pause className="size-3.5 fill-primary text-primary" />
          : <Play className={`size-3.5 ${isActive ? 'fill-primary text-primary' : ''}`} />}
      </button>

      {/* Mini waveform */}
      <div className="w-28 h-7 shrink-0">
        <MiniWaveform track={track} artworkReady={artworkReady} />
      </div>

      {/* Artwork thumbnail */}
      <div className="size-8 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
        {artworkUrl
          ? <img src={artworkUrl} alt="" className="size-8 object-cover" loading="lazy"
              onLoad={() => setArtworkReady(true)}
              onError={() => setArtworkReady(true)}
            />
          : <Music className="size-3.5 text-muted-foreground/50" />}
      </div>

      {/* Title */}
      <div className="flex-[3] min-w-0 flex flex-col justify-center">
        <span className={`text-xs font-medium truncate leading-tight ${isActive ? 'text-primary' : ''}`}>
          {item.title || item.file_name}
        </span>
        {item.title && (
          <span className="text-[10px] text-muted-foreground truncate leading-tight">{item.file_name}</span>
        )}
      </div>

      {/* Artist */}
      <span className="flex-[2] min-w-0 text-xs text-muted-foreground truncate">{item.artist || '—'}</span>

      {/* Genre */}
      <span className="w-28 shrink-0 text-xs text-muted-foreground truncate">{item.genre || '—'}</span>

      {/* BPM */}
      <span className="w-14 shrink-0 text-xs text-muted-foreground text-right tabular-nums">
        {item.bpm ?? '—'}
      </span>

      {/* Key */}
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{item.key || '—'}</span>

      {/* Date */}
      <span className="w-20 shrink-0 text-xs text-muted-foreground">
        {item.release_date ? item.release_date.slice(0, 7) : '—'}
      </span>

      {/* Duration */}
      <span className="w-14 shrink-0 text-xs text-muted-foreground text-right tabular-nums">
        {item.duration != null
          ? `${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}`
          : '—'}
      </span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center h-12 gap-2 px-3 border-b border-border/30">
      <Skeleton className="size-6 rounded" />
      <Skeleton className="w-28 h-7" />
      <Skeleton className="size-8 rounded" />
      <div className="flex-[3] min-w-0 flex flex-col gap-1">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-2.5 w-1/2" />
      </div>
      <Skeleton className="flex-[2] h-3" />
      <Skeleton className="w-28 h-3" />
      <Skeleton className="w-14 h-3" />
      <Skeleton className="w-14 h-3" />
      <Skeleton className="w-20 h-3" />
      <Skeleton className="w-14 h-3" />
    </div>
  );
}

export function CollectionTable({ mode, scrollToFilePath, onSelect, onTotalChange }: CollectionTableProps) {
  const [sortBy, setSortBy] = useQueryState('sort', searchParams.sort);
  const [sortOrder, setSortOrder] = useQueryState('order', searchParams.order);
  const [search] = useQueryState('search', searchParams.search);
  const [genres] = useQueryState('genres', searchParams.genres);
  const [keys] = useQueryState('keys', searchParams.keys);
  const [bpmMin] = useQueryState('bpmMin', searchParams.bpmMin);
  const [bpmMax] = useQueryState('bpmMax', searchParams.bpmMax);
  const [items, setItems] = useState<TrackBrowse[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [cacheLoading, setCacheLoading] = useState(false);

  const loadingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const { currentTrack, isPlaying, toggle, load } = usePlayer();

  const scrollParentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: total > 0 ? total : items.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const loadPage = useCallback(
    async (pageNum: number, reset: boolean, overrideSortBy?: SortBy, overrideSortOrder?: SortOrder) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);

      // Cancel any in-flight request so stale responses never overwrite current data
      abortRef.current?.abort(new DOMException('Request cancelled', 'AbortError'));
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const resp = await api.browseFiles(mode, {
          search: search || undefined,
          genres: genres.length ? genres : undefined,
          keys: keys.length ? keys : undefined,
          bpm_min: bpmMin ?? undefined,
          bpm_max: bpmMax ?? undefined,
          sort_by: overrideSortBy ?? sortBy,
          sort_order: overrideSortOrder ?? sortOrder,
          page: pageNum,
          size: PAGE_SIZE,
        }, controller.signal);
        setItems((prev) => (reset ? resp.items : [...prev, ...resp.items]));
        setHasMore(pageNum < resp.pages);
        setPage(pageNum);
        setTotal(resp.total);
        setCacheLoading(resp.cacheLoading ?? false);
        onTotalChange?.(resp.total, resp.cacheLoading ?? false);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      } finally {
        loadingRef.current = false;
        setLoading(false);
        setReloading(false);
      }
    },
    [mode, search, genres, keys, bpmMin, bpmMax, sortBy, sortOrder]
  );

  // Reload on mode / filter / sort change
  const filtersKey = `${mode}|${search}|${genres.join(',')}|${keys.join(',')}|${bpmMin}|${bpmMax}|${sortBy}|${sortOrder}`;
  useEffect(() => {
    // Cancel any in-flight request from the previous mode/filters
    abortRef.current?.abort(new DOMException('Request cancelled', 'AbortError'));
    abortRef.current = null;
    setReloading(true);
    setPage(1);
    // Reset guard so a mode switch always triggers a fresh load
    loadingRef.current = false;
    loadPage(1, true);
  }, [filtersKey, loadPage]);

  // Auto-refresh while cache is still loading (server is progressively reading files)
  useEffect(() => {
    if (!cacheLoading) return;
    const timer = setInterval(() => {
      loadPage(1, true);
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheLoading, filtersKey]);

  // Fetch next page when virtualizer reaches near the loaded boundary
  useEffect(() => {
    const virtualItems = virtualizer.getVirtualItems();
    if (!virtualItems.length || !hasMore || loading) return;
    const lastVirtualItem = virtualItems[virtualItems.length - 1];
    if (lastVirtualItem.index >= items.length - PAGE_SIZE / 2) {
      loadPage(page + 1, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualizer.getVirtualItems()]);

  // Scroll to a specific track when switching to view mode
  useEffect(() => {
    if (!scrollToFilePath || !items.length) return;
    const idx = items.findIndex((item) => item.file_path === scrollToFilePath);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToFilePath, items.length]);

  function handleSort(col: SortBy) {
    if (col !== sortBy) {
      setSortBy(col);
      setSortOrder('asc');
    } else if (sortOrder === 'asc') {
      setSortOrder('desc');
    } else {
      // Third click: reset to default
      setSortBy('file_name');
      setSortOrder('asc');
    }
  }

  function handlePlay(item: TrackBrowse) {
    toggle({ filePath: item.file_path, fileName: item.file_name, title: item.title ?? undefined, artist: item.artist ?? undefined });
  }

  function handleSelect(item: TrackBrowse) {
    load({ filePath: item.file_path, fileName: item.file_name, title: item.title ?? undefined, artist: item.artist ?? undefined });
    onSelect?.(item);
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header row */}
      <div role="row" className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-border bg-muted/30 text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
        {/* Spacers for play + waveform + artwork */}
        <div className="shrink-0 w-6" />
        <div className="shrink-0 w-28" />
        <div className="shrink-0 size-8" />

        {COLUMNS.map((col) => (
          <button
            key={col.key}
            className={`flex items-center gap-0.5 ${col.className} ${col.sortable ? 'hover:text-foreground transition-colors cursor-pointer' : 'cursor-default'}`}
            onClick={() => col.sortable && handleSort(col.key)}
            aria-sort={col.sortable && col.key === sortBy ? (sortOrder === 'asc' ? 'ascending' : 'descending') : undefined}
          >
            {col.label}
            {col.sortable && <SortIcon col={col.key} sortBy={sortBy} sortOrder={sortOrder} />}
          </button>
        ))}
      </div>

      {/* Virtual scroll container */}
      <div ref={scrollParentRef} className={`flex-1 overflow-y-auto overscroll-contain min-h-0 transition-opacity duration-150 ${reloading ? 'opacity-40' : 'opacity-100'}`}>
        {/* Total height for virtual scroll */}
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {virtualItems.map((virtualRow) => {
            const item = items[virtualRow.index];
            const isActive = currentTrack?.filePath === item?.file_path;

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
                {item ? (
                  <TrackRow
                    item={item}
                    isActive={isActive}
                    isPlaying={isActive && isPlaying}
                    onPlay={() => handlePlay(item)}
                    onSelect={() => handleSelect(item)}
                  />
                ) : (
                  <SkeletonRow />
                )}
              </div>
            );
          })}
        </div>

        {/* Loader at end */}
        {loading && hasMore && (
          <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
            Loading…
          </div>
        )}
      </div>

    </div>
  );
}
