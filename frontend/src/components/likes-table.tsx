"use client";

import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Ban,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Download,
  FolderCheck,
  GripVertical,
  Music,
  ShoppingCart,
} from "lucide-react";
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  SortableColumnHeader,
  SortableHeaderCell,
} from "@/components/columns/sortable-columns";
import {
  SoundcloudBpmCacheContext,
  SoundcloudBpmCell,
} from "@/components/soundcloud-bpm-cell";
import { SoundcloudLikeButton } from "@/components/soundcloud-like-button";
import { SoundcloudRowPlayButton } from "@/components/soundcloud-row-play-button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { ColumnDef } from "@/lib/columns/types";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { useIsScUnplayable } from "@/lib/sc-unplayable";
import type { SCTrack } from "@/lib/soundcloud";
import {
  getCachedSoundcloudPeaks,
  getCachedSoundcloudStreamUrl,
} from "@/lib/soundcloud-cache";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 48;
const DESCRIPTION_HEIGHT = 120;

type SortKey = "title" | "artist" | "genre" | "duration" | "playback_count";
type SortOrder = "asc" | "desc";

/** A single source of truth for likes-table columns. Drives both the header
 *  row and the per-track body row, making columns drag-reorderable.
 *  Sort is optional (the Links pseudo-column isn't sortable). */
interface LikesCol {
  id: string;
  header: string;
  sortKey?: SortKey;
  required?: boolean;
  defaultWidth: number;
  /** Style classes applied to the cell (no width — that's inline). */
  cellClassName: string;
  /** Custom header rendering (e.g. icon + text for Links). Optional. */
  renderHeader?: () => React.ReactNode;
  renderBody: (ctx: {
    track: SCTrack;
    isExpanded: boolean;
    inCollection: boolean;
    isNew: boolean;
    isLiked: boolean;
  }) => React.ReactNode;
}

/** Small ban-circle next to the title when SC won't let us stream the
 * track. Driven by two signals:
 *  - ``track.streamable === false`` from SoundCloud's metadata (rare,
 *    catches outright takedowns).
 *  - The session-level "discovered unplayable" set, populated by the
 *    player and BPM analyser when SC actually 403s. */
function UnstreamableBadge({ track }: { track: SCTrack }) {
  const trackId = extractId(track);
  const sessionUnplayable = useIsScUnplayable(trackId);
  const metadataUnstreamable = track.streamable === false;
  if (!sessionUnplayable && !metadataUnstreamable) return null;
  const reason = sessionUnplayable
    ? "SoundCloud refused to stream this track"
    : "Marked unstreamable by SoundCloud";
  return (
    <span
      className="text-muted-foreground/70 inline-flex shrink-0 items-center"
      title={reason}
      aria-label={reason}
    >
      <Ban className="size-3" />
    </span>
  );
}

const LIKES_COLUMNS: LikesCol[] = [
  {
    id: "title",
    header: "Title",
    sortKey: "title",
    required: true,
    defaultWidth: 320,
    cellClassName: "flex min-w-0 shrink-0 items-center gap-1.5",
    renderBody: ({ track, isExpanded, isNew }) => (
      <>
        <UnstreamableBadge track={track} />
        <span
          className={`truncate text-xs leading-tight font-medium ${isExpanded ? "text-primary" : ""}`}
        >
          {track.title || "—"}
        </span>
        {isNew && (
          <span className="shrink-0 rounded bg-[var(--brand-soft)] px-1 py-0.5 text-xs leading-none font-semibold text-[var(--brand)]">
            NEW
          </span>
        )}
      </>
    ),
  },
  {
    id: "artist",
    header: "Artist",
    sortKey: "artist",
    defaultWidth: 200,
    cellClassName: "text-muted-foreground min-w-0 shrink-0 truncate text-xs",
    renderBody: ({ track }) => <>{track.user?.username || "—"}</>,
  },
  {
    id: "genre",
    header: "Genre",
    sortKey: "genre",
    defaultWidth: 96,
    cellClassName: "text-muted-foreground shrink-0 truncate text-xs",
    renderBody: ({ track }) => <>{track.genre || "—"}</>,
  },
  {
    id: "duration",
    header: "Length",
    sortKey: "duration",
    defaultWidth: 64,
    cellClassName:
      "text-muted-foreground shrink-0 text-right text-xs tabular-nums",
    renderBody: ({ track }) => <>{formatDuration(track.duration)}</>,
  },
  {
    id: "bpm",
    header: "BPM",
    defaultWidth: 56,
    cellClassName:
      "text-muted-foreground shrink-0 text-right text-xs tabular-nums",
    renderBody: ({ track }) => (
      <SoundcloudBpmCell
        trackId={extractId(track)}
        metadataBpm={track.bpm ?? null}
      />
    ),
  },
  {
    id: "playback_count",
    header: "Plays",
    sortKey: "playback_count",
    defaultWidth: 64,
    cellClassName:
      "text-muted-foreground shrink-0 text-right text-xs tabular-nums",
    renderBody: ({ track }) => <>{formatPlays(track.playback_count)}</>,
  },
  {
    id: "links",
    header: "Links",
    defaultWidth: 112,
    cellClassName: "shrink-0",
    renderHeader: () => (
      <div className="flex items-center justify-center gap-1">
        <FolderCheck className="size-3 opacity-50" />
        <span className="text-xs opacity-50">Links</span>
      </div>
    ),
    renderBody: ({ track, inCollection, isLiked }) => (
      <div
        className={`flex items-center justify-between ${inCollection ? "opacity-35" : ""}`}
      >
        <div
          className="flex size-5 items-center justify-center"
          title={inCollection ? "In collection" : undefined}
        >
          {inCollection && <FolderCheck className="text-primary size-3.5" />}
        </div>
        <TooltipProvider>
          {track.urn ? (
            <SoundcloudLikeButton trackUrn={track.urn} initialLiked={isLiked} />
          ) : (
            <div className="size-5" />
          )}
          {track.download_url ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={track.download_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center transition-colors"
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
          {track.purchase_url ? (
            (() => {
              const icon = purchaseIcon(track.purchase_url);
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href={track.purchase_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {icon ? (
                        <img
                          src={icon.src}
                          alt={icon.alt}
                          className="size-3.5"
                        />
                      ) : (
                        <ShoppingCart className="size-3" />
                      )}
                    </a>
                  </TooltipTrigger>
                  <TooltipContent>
                    {track.purchase_title || icon?.alt || "Buy"}
                  </TooltipContent>
                </Tooltip>
              );
            })()
          ) : (
            <div className="size-5" />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={`https://bandcamp.com/search?q=${encodeURIComponent(searchQuery(track))}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex size-5 items-center justify-center opacity-40 transition-opacity hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <img
                  src="/icons/bandcamp.svg"
                  alt="Bandcamp"
                  className="size-3.5"
                />
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
                className="flex size-5 items-center justify-center opacity-40 transition-opacity hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <img
                  src="/icons/beatport.svg"
                  alt="Beatport"
                  className="size-3.5"
                />
              </a>
            </TooltipTrigger>
            <TooltipContent>Search Beatport</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    ),
  },
];

export const LIKES_COLUMN_DEFS: ColumnDef[] = LIKES_COLUMNS.map((c) => ({
  id: c.id,
  header: c.header,
  required: c.required,
}));

function SortIcon({
  col,
  sortBy,
  sortOrder,
}: {
  col: SortKey;
  sortBy: SortKey | null;
  sortOrder: SortOrder;
}) {
  if (col !== sortBy) return <ChevronsUpDown className="size-3 opacity-30" />;
  return sortOrder === "asc" ? (
    <ChevronUp className="text-primary size-3" />
  ) : (
    <ChevronDown className="text-primary size-3" />
  );
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatPlays(count: number | undefined): string {
  if (count == null) return "—";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function extractId(track: SCTrack): number {
  if (!track.urn) return 0;
  const parts = track.urn.split(":");
  return parseInt(parts[parts.length - 1], 10) || 0;
}

function artworkUrl(track: SCTrack): string | null {
  const url = track.artwork_url;
  if (!url) return null;
  return api.proxyImageUrl(url);
}

function searchQuery(track: SCTrack): string {
  const artist = track.user?.username ?? "";
  const title = track.title ?? "";
  return `${artist} ${title}`.trim();
}

function purchaseIcon(url: string): { src: string; alt: string } | null {
  try {
    const host = new URL(url).hostname;
    if (host.includes("hypeddit"))
      return { src: "/icons/hypeddit.svg", alt: "Hypeddit" };
    if (host.includes("bandcamp"))
      return { src: "/icons/bandcamp.svg", alt: "Bandcamp" };
    if (host.includes("beatport"))
      return { src: "/icons/beatport.svg", alt: "Beatport" };
  } catch {
    /* invalid url */
  }
  return null;
}

/** A column enriched with its resolved pixel width. */
type ResolvedLikesCol = LikesCol & { width: number };

interface TrackRowProps {
  track: SCTrack;
  isSelected: boolean;
  isExpanded: boolean;
  inCollection: boolean;
  isLiked: boolean;
  isNew?: boolean;
  onToggleSelect: (shiftKey: boolean) => void;
  onExpand: () => void;
  /** Install the queue starting at this row and begin playback. */
  onStartPlay: () => Promise<void> | void;
  /** Columns filtered and ordered per user preferences, with resolved widths. */
  visibleColumns: ResolvedLikesCol[];
  /** When set, the row renders a drag handle and participates in SortableContext. */
  dragHandle?: {
    attributes: React.HTMLAttributes<HTMLButtonElement>;
    listeners: React.DOMAttributes<HTMLButtonElement> | undefined;
    isDragging: boolean;
  };
}

function TrackRowInner({
  track,
  isSelected,
  isExpanded,
  inCollection,
  isLiked,
  isNew,
  onToggleSelect,
  onExpand,
  onStartPlay,
  visibleColumns,
  dragHandle,
}: TrackRowProps) {
  const imgUrl = artworkUrl(track);
  const scTrackId = extractId(track);

  // Hover prefetch: warm the stream URL + peaks cache after a short dwell.
  // Eliminates the 500–700ms cold SC resolve for rows the user is about
  // to click. Cancelled if the mouse leaves before the dwell elapses.
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wavUrl = track.waveform_url ?? undefined;
  const onPointerEnter = useCallback(() => {
    if (hoverTimeoutRef.current) return;
    hoverTimeoutRef.current = setTimeout(() => {
      hoverTimeoutRef.current = null;
      if (scTrackId) {
        getCachedSoundcloudStreamUrl(scTrackId).catch(() => {});
      }
      if (wavUrl) {
        getCachedSoundcloudPeaks(wavUrl, 800).catch(() => {});
      }
    }, 120);
  }, [scTrackId, wavUrl]);
  const onPointerLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  return (
    <div>
      <div
        role="row"
        tabIndex={0}
        className={`group border-border flex h-10 cursor-pointer items-center gap-2 border-b px-3 transition-colors select-none ${isSelected ? "bg-[var(--brand-soft)]" : isExpanded ? "bg-[var(--surface-3)]" : "hover:bg-[var(--surface-3)]"} ${dragHandle?.isDragging ? "opacity-40" : ""}`}
        onClick={onExpand}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onKeyDown={(e) => {
          if (e.key === "Enter") onExpand();
          if (e.key === " ") {
            e.preventDefault();
            onToggleSelect(e.shiftKey);
          }
        }}
      >
        {/* Drag handle */}
        {dragHandle && (
          <button
            {...dragHandle.attributes}
            {...dragHandle.listeners}
            tabIndex={-1}
            aria-label="Drag to reorder"
            data-testid="likes-row-drag-handle"
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground/50 hover:text-foreground flex size-4 shrink-0 cursor-grab items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
          >
            <GripVertical className="size-3" />
          </button>
        )}

        {/* Checkbox */}
        <div
          className="flex w-6 shrink-0 cursor-pointer items-center justify-center self-stretch"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(e.shiftKey);
          }}
        >
          <Checkbox
            checked={isSelected}
            className="pointer-events-none size-3.5"
          />
        </div>

        {/* Artwork */}
        <div className="bg-muted flex size-7 shrink-0 items-center justify-center overflow-hidden rounded">
          {imgUrl ? (
            <img
              src={imgUrl}
              alt=""
              className="size-7 object-cover"
              loading="lazy"
            />
          ) : (
            <Music className="text-muted-foreground size-3.5" />
          )}
        </div>

        {/* Play button — streams via the backend HLS endpoint. */}
        {scTrackId ? (
          <SoundcloudRowPlayButton
            trackId={scTrackId}
            title={track.title ?? undefined}
            artist={track.user?.username ?? undefined}
            waveformUrl={track.waveform_url ?? undefined}
            permalinkUrl={track.permalink_url ?? undefined}
            artworkUrl={imgUrl ?? undefined}
            onStartPlay={onStartPlay}
          />
        ) : (
          <div className="size-6 shrink-0" />
        )}

        {/* Reorderable column cells */}
        {visibleColumns.map((col) => (
          <div
            key={col.id}
            className={col.cellClassName}
            style={{ width: col.width }}
          >
            {col.renderBody({
              track,
              isExpanded,
              inCollection,
              isLiked,
              isNew: isNew ?? false,
            })}
          </div>
        ))}
      </div>

      {/* Expanded detail: description */}
      {isExpanded && track.description && (
        <div className="border-border bg-muted border-b px-3 py-2">
          <p className="text-muted-foreground max-w-prose text-xs whitespace-pre-line">
            {track.description}
          </p>
        </div>
      )}
    </div>
  );
}

function SortableTrackRow(props: TrackRowProps & { sortableId: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.sortableId });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <TrackRowInner
        {...props}
        dragHandle={{ attributes, listeners, isDragging }}
      />
    </div>
  );
}

function TrackRow(props: TrackRowProps & { sortableId?: string }) {
  const { sortableId, ...rest } = props;
  if (sortableId) {
    return <SortableTrackRow {...rest} sortableId={sortableId} />;
  }
  return <TrackRowInner {...rest} />;
}

interface LikesTableProps {
  tracks: SCTrack[];
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onRangeSelect: (ids: number[]) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  collectionIds?: Set<number>;
  /** IDs of tracks the authenticated user has liked. When a track's id is in
   *  this set, the like button renders as active. */
  likedIds?: Set<number>;
  newTrackUrns?: Set<string>;
  /** Per-column visibility. When omitted, all columns render. */
  isColumnVisible?: (id: string) => boolean;
  /** User-chosen column order by id. */
  columnOrder?: string[];
  /** Persist a new column order. */
  onColumnOrderChange?: (ids: string[]) => void;
  /** User-resized widths (px) by column id. Missing = use default. */
  columnWidths?: Record<string, number>;
  /** Persist a width on resize commit. */
  onColumnWidthChange?: (id: string, width: number) => void;
  /** Reset a single column's width to its default (double-click handle). */
  onColumnWidthReset?: (id: string) => void;
  /** When provided, rows become drag-reorderable. Called with the new URN order
   *  after each drag. Enabling this forces the natural track order (sort is
   *  cleared and sort controls are disabled). */
  onReorderTracks?: (orderedUrns: string[]) => void;
  /** Reports the current *visible* URN order (after sort). Fires whenever
   *  the sorted display changes so callers can save whatever the user sees. */
  onVisibleOrderChange?: (orderedUrns: string[]) => void;
}

export function LikesTable({
  tracks,
  selectedIds,
  onToggleSelect,
  onRangeSelect,
  onSelectAll,
  onDeselectAll,
  collectionIds,
  likedIds,
  newTrackUrns,
  isColumnVisible,
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthChange,
  onColumnWidthReset,
  onReorderTracks,
  onVisibleOrderChange,
}: LikesTableProps) {
  const reorderEnabled = !!onReorderTracks;
  const { playQueue } = usePlayer();

  // Pre-fill cached BPMs for all tracks in this table in a single bulk
  // request, rather than making one GET per visible row. The map survives
  // re-renders; cells read it via SoundcloudBpmCacheContext.
  const [bpmCache, setBpmCache] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    const ids: number[] = [];
    for (const t of tracks) {
      if (t.urn) {
        const parts = t.urn.split(":");
        const id = parseInt(parts[parts.length - 1], 10);
        if (id > 0) ids.push(id);
      }
    }
    if (ids.length === 0) return;
    let cancelled = false;
    api
      .getSoundcloudBpmsBulk(ids)
      .then((resp) => {
        if (cancelled) return;
        const next = new Map<number, number>();
        for (const [k, v] of Object.entries(resp.bpms)) next.set(Number(k), v);
        setBpmCache(next);
      })
      .catch(() => {
        /* Prefill is best-effort; cells fall back to metadata + Detect button. */
      });
    return () => {
      cancelled = true;
    };
  }, [tracks]);

  const colVisible = React.useCallback(
    (id: string) => (isColumnVisible ? isColumnVisible(id) : true),
    [isColumnVisible],
  );
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const visibleColumns = React.useMemo<ResolvedLikesCol[]>(() => {
    const byId = new Map(LIKES_COLUMNS.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const ordered: LikesCol[] = [];
    for (const id of columnOrder ?? []) {
      const c = byId.get(id);
      if (c && !seen.has(id)) {
        ordered.push(c);
        seen.add(id);
      }
    }
    for (const c of LIKES_COLUMNS) {
      if (!seen.has(c.id)) ordered.push(c);
    }
    return ordered
      .filter((c) => colVisible(c.id))
      .map((c) => ({
        ...c,
        width: liveWidths[c.id] ?? columnWidths?.[c.id] ?? c.defaultWidth,
      }));
  }, [columnOrder, colVisible, columnWidths, liveWidths]);
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndexRef = useRef<number | null>(null);

  const sortedTracks = useMemo(() => {
    if (!sortBy) return tracks;
    const sorted = [...tracks].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "title":
          cmp = (a.title ?? "").localeCompare(b.title ?? "");
          break;
        case "artist":
          cmp = (a.user?.username ?? "").localeCompare(b.user?.username ?? "");
          break;
        case "genre":
          cmp = (a.genre ?? "").localeCompare(b.genre ?? "");
          break;
        case "duration":
          cmp = (a.duration ?? 0) - (b.duration ?? 0);
          break;
        case "playback_count":
          cmp = (a.playback_count ?? 0) - (b.playback_count ?? 0);
          break;
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [tracks, sortBy, sortOrder]);

  // Row reordering is only active when no column sort is applied — otherwise
  // the user's drag target (sorted position) wouldn't map to a meaningful
  // underlying order.
  const reorderable = reorderEnabled && !sortBy;

  // Build a PlayerTrack queue from the currently visible (sorted) SC tracks
  // and start playback at `index`. Every entry is a skeleton — the player
  // resolves streamUrl on demand via the shared TTL cache, so the clicked
  // row's URL is fetched in parallel with peaks + waveform init rather
  // than serialised before the UI updates.
  const handleStartPlay = useCallback(
    (index: number) => {
      const queue: PlayerTrack[] = sortedTracks.map((t) => {
        const id = extractId(t);
        return {
          filePath: `soundcloud:${id}`,
          fileName: t.title ?? String(id),
          title: t.title ?? undefined,
          artist: t.user?.username ?? undefined,
          waveformUrl: t.waveform_url ?? undefined,
          streamRefreshKey: id,
          permalinkUrl: t.permalink_url ?? undefined,
          artworkUrl: artworkUrl(t) ?? undefined,
          bpm: bpmCache.get(id) ?? t.bpm ?? null,
        };
      });
      playQueue(queue, index);
    },
    [sortedTracks, playQueue, bpmCache],
  );

  // Report the current visible order (after sort) to callers so they can save
  // whatever the user currently sees.
  const sortedUrnsKey = useMemo(
    () => sortedTracks.map((t) => t.urn ?? "").join("|"),
    [sortedTracks],
  );
  React.useEffect(() => {
    if (!onVisibleOrderChange) return;
    const urns = sortedTracks.map((t) => t.urn).filter((u): u is string => !!u);
    onVisibleOrderChange(urns);
  }, [sortedUrnsKey, sortedTracks, onVisibleOrderChange]);

  const sortableIds = useMemo(
    () =>
      reorderable ? sortedTracks.map((t, i) => t.urn ?? `__idx_${i}`) : [],
    [reorderable, sortedTracks],
  );

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const activeDragTrack = useMemo(
    () =>
      activeDragId
        ? (sortedTracks.find(
            (t, i) => (t.urn ?? `__idx_${i}`) === activeDragId,
          ) ?? null)
        : null,
    [activeDragId, sortedTracks],
  );

  function handleReorderDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id));
  }

  function handleReorderDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = e;
    if (!over || active.id === over.id || !onReorderTracks) return;
    const ids = sortableIds;
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const nextIds = arrayMove(ids, oldIdx, newIdx).filter(
      (id) => !id.startsWith("__idx_"),
    );
    onReorderTracks(nextIds);
  }

  // React Compiler can't memoize TanStack Virtual's returned functions safely; skip.

  const virtualizer = useVirtualizer({
    count: sortedTracks.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: useCallback(
      (index: number) => {
        const track = sortedTracks[index];
        const id = track ? extractId(track) : 0;
        if (id !== expandedId) return ROW_HEIGHT;
        if (!track?.description) return ROW_HEIGHT;
        return ROW_HEIGHT + 16 + DESCRIPTION_HEIGHT;
      },
      [sortedTracks, expandedId],
    ),
    overscan: 12,
  });

  function handleSort(col: SortKey) {
    if (col !== sortBy) {
      setSortBy(col);
      setSortOrder("asc");
    } else if (sortOrder === "asc") {
      setSortOrder("desc");
    } else {
      setSortBy(null);
      setSortOrder("asc");
    }
  }

  function handleExpand(track: SCTrack) {
    const id = extractId(track);
    setExpandedId((prev) => (prev === id ? null : id));
  }

  const virtualItems = virtualizer.getVirtualItems();
  const someSelected = selectedIds.size > 0;
  const allSelected =
    sortedTracks.length > 0 &&
    sortedTracks.every((t) => {
      const id = extractId(t);
      return id != null && selectedIds.has(id);
    });

  return (
    <SoundcloudBpmCacheContext.Provider value={bpmCache}>
      <div className="flex h-full min-h-0 flex-col">
        {/* Header */}
        <div
          role="row"
          className="border-border text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b bg-[var(--surface-2)] px-3 text-xs font-medium"
        >
          {reorderable && <div className="size-4 shrink-0" aria-hidden />}
          <div
            className="flex w-6 shrink-0 items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={
                allSelected ? true : someSelected ? "indeterminate" : false
              }
              onCheckedChange={(checked) =>
                checked ? onSelectAll() : onDeselectAll()
              }
              aria-label="Select all"
              className={cn(
                "size-3.5 cursor-pointer",
                "data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:text-primary-foreground",
                allSelected &&
                  "data-[state=checked]:bg-primary data-[state=checked]:border-primary",
              )}
            />
          </div>
          <div className="size-7 shrink-0" aria-hidden />
          <div className="size-6 shrink-0" aria-hidden />
          <SortableColumnHeader
            ids={visibleColumns.map((c) => c.id)}
            onOrderChange={(nextIds) => {
              if (!onColumnOrderChange) return;
              const hidden = LIKES_COLUMNS.map((c) => c.id).filter(
                (id) => !visibleColumns.some((v) => v.id === id),
              );
              onColumnOrderChange([...nextIds, ...hidden]);
            }}
          >
            {visibleColumns.map((col) => (
              <SortableHeaderCell
                key={col.id}
                id={col.id}
                className={col.cellClassName}
                style={{ width: col.width }}
                onResize={(w, phase) => {
                  if (phase === "drag") {
                    setLiveWidths((p) => ({ ...p, [col.id]: w }));
                  } else {
                    onColumnWidthChange?.(col.id, w);
                    setLiveWidths((p) => {
                      const { [col.id]: _omit, ...rest } = p;
                      return rest;
                    });
                  }
                }}
                onResetWidth={() => onColumnWidthReset?.(col.id)}
              >
                {col.renderHeader ? (
                  col.renderHeader()
                ) : col.sortKey ? (
                  <button
                    className="hover:text-foreground flex w-full cursor-pointer items-center gap-0.5 transition-colors"
                    onClick={() => col.sortKey && handleSort(col.sortKey)}
                  >
                    {col.header}
                    <SortIcon
                      col={col.sortKey}
                      sortBy={sortBy}
                      sortOrder={sortOrder}
                    />
                  </button>
                ) : (
                  <span>{col.header}</span>
                )}
              </SortableHeaderCell>
            ))}
          </SortableColumnHeader>
        </div>

        {/* Virtual scroll */}
        <div
          ref={scrollParentRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {(() => {
            const body = (
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  position: "relative",
                }}
              >
                {virtualItems.map((virtualRow) => {
                  const track = sortedTracks[virtualRow.index];
                  if (!track) return null;
                  const id = extractId(track);
                  const sortableId = reorderable
                    ? (track.urn ?? `__idx_${virtualRow.index}`)
                    : undefined;

                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <TrackRow
                        sortableId={sortableId}
                        track={track}
                        isSelected={selectedIds.has(id)}
                        isExpanded={expandedId === id}
                        inCollection={collectionIds?.has(id) ?? false}
                        isLiked={
                          likedIds?.has(id) ?? track.user_favorite === true
                        }
                        isNew={
                          newTrackUrns
                            ? track.urn
                              ? newTrackUrns.has(track.urn)
                              : false
                            : undefined
                        }
                        onToggleSelect={(shiftKey) => {
                          const currentIndex = virtualRow.index;
                          if (
                            shiftKey &&
                            lastSelectedIndexRef.current !== null
                          ) {
                            const start = Math.min(
                              lastSelectedIndexRef.current,
                              currentIndex,
                            );
                            const end = Math.max(
                              lastSelectedIndexRef.current,
                              currentIndex,
                            );
                            const rangeIds = sortedTracks
                              .slice(start, end + 1)
                              .map(extractId)
                              .filter(Boolean);
                            onRangeSelect(rangeIds);
                          } else {
                            onToggleSelect(id);
                            lastSelectedIndexRef.current = currentIndex;
                          }
                        }}
                        onExpand={() => handleExpand(track)}
                        onStartPlay={() => handleStartPlay(virtualRow.index)}
                        visibleColumns={visibleColumns}
                      />
                    </div>
                  );
                })}
              </div>
            );
            if (!reorderable) return body;
            return (
              <DndContext
                sensors={dndSensors}
                collisionDetection={closestCenter}
                onDragStart={handleReorderDragStart}
                onDragEnd={handleReorderDragEnd}
                onDragCancel={() => setActiveDragId(null)}
              >
                <SortableContext
                  items={sortableIds}
                  strategy={verticalListSortingStrategy}
                >
                  {body}
                </SortableContext>
                <DragOverlay>
                  {activeDragTrack ? (
                    <div className="bg-[var(--surface-2)] opacity-95 shadow-lg">
                      <TrackRowInner
                        track={activeDragTrack}
                        isSelected={false}
                        isExpanded={false}
                        inCollection={false}
                        isLiked={false}
                        isNew={false}
                        onToggleSelect={() => undefined}
                        onExpand={() => undefined}
                        onStartPlay={() => undefined}
                        visibleColumns={visibleColumns}
                        dragHandle={{
                          attributes: {},
                          listeners: undefined,
                          isDragging: false,
                        }}
                      />
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            );
          })()}
        </div>
      </div>
    </SoundcloudBpmCacheContext.Provider>
  );
}
