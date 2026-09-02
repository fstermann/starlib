"use client";

import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import * as React from "react";

import {
  SortableColumnHeader,
  SortableHeaderCell,
} from "@/components/columns/sortable-columns";
import { cn } from "@/lib/utils";

/** A single column descriptor. Generic over the row item type so callers can
 *  attach render helpers in their wrappers — TrackTable itself only owns
 *  identity, ordering, sizing, sort UI, and visibility. */
export interface TrackTableColumn {
  /** Stable id; persistence key + sortable-context id. */
  id: string;
  header: string;
  defaultWidth: number;
  /** Sort key passed back to `onSort`. Absent = unsortable. */
  sortKey?: string;
  /** Marks the column as un-hideable (for callers that hook visibility). */
  required?: boolean;
  /** Class applied to BOTH the header cell and the matching body cell. */
  className?: string;
  /** Custom header content. Falls back to {header} + sort icon. */
  renderHeader?: () => React.ReactNode;
}

export type ResolvedColumn = TrackTableColumn & { width: number };

export interface TrackTableHandle {
  scrollToIndex: (
    index: number,
    opts?: { align?: "start" | "center" | "end" | "auto" },
  ) => void;
  getVirtualItems: () => VirtualItem[];
}

export interface TrackTableProps<T> {
  items: T[];
  columns: TrackTableColumn[];

  /** Virtualizer count. Defaults to items.length; pass a larger value to
   *  let the virtualizer reserve space for not-yet-loaded rows (paged data). */
  totalCount?: number;
  estimateRowSize: number | ((index: number) => number);
  overscan?: number;
  /** Stable identity for virtualized rows; survives sort/reorder. */
  getItemKey?: (index: number, item: T | undefined) => string;

  // ── Sort (controlled) ──
  sortBy: string | null;
  sortOrder: "asc" | "desc";
  onSort?: (sortKey: string) => void;

  // ── Column prefs (controlled) ──
  columnOrder?: string[];
  onColumnOrderChange?: (ids: string[]) => void;
  columnWidths?: Record<string, number>;
  onColumnWidthChange?: (id: string, width: number) => void;
  onColumnWidthReset?: (id: string) => void;
  isColumnVisible?: (id: string) => boolean;

  // ── Header chrome slots ──
  /** Rendered inside the sticky header, before the reorderable cells. Typical
   *  use: select-all checkbox, artwork spacer, waveform/play spacer. */
  renderHeaderLead?: () => React.ReactNode;
  /** Rendered after the reorderable cells. Typical use: trailing static
   *  columns like "Added" / "File" that participate in sort but not reorder. */
  renderHeaderTrail?: (ctx: {
    sortBy: string | null;
    sortOrder: "asc" | "desc";
  }) => React.ReactNode;
  /** Class on the header row container. */
  headerClassName?: string;

  // ── Body ──
  renderRow: (ctx: {
    item: T | undefined;
    index: number;
    visibleColumns: ResolvedColumn[];
  }) => React.ReactNode;
  renderSkeletonRow?: () => React.ReactNode;
  /** Rendered immediately after the virtualized body (e.g. "Loading…" footer). */
  bodyTrailing?: React.ReactNode;

  // ── Range tracking ──
  /** Fires when the visible window moves. Use for auto-paging. */
  onVisibleRangeChange?: (range: { start: number; end: number }) => void;

  // ── Misc ──
  /** Dims the table while a reload is in flight. */
  reloading?: boolean;
  /** Class on the outermost flex column. */
  className?: string;
  /** Class on the scroll container. */
  scrollClassName?: string;

  /** Imperative handle. */
  tableRef?: React.Ref<TrackTableHandle>;
}

function SortIcon({
  col,
  sortBy,
  sortOrder,
}: {
  col: string;
  sortBy: string | null;
  sortOrder: "asc" | "desc";
}) {
  if (col !== sortBy) return <ChevronsUpDown className="size-3 opacity-30" />;
  return sortOrder === "asc" ? (
    <ChevronUp className="text-primary size-3" />
  ) : (
    <ChevronDown className="text-primary size-3" />
  );
}

/** A small sortable trailing-header button used by callers via
 *  {@link TrackTableProps.renderHeaderTrail}. Exported as a convenience so
 *  every table doesn't reimplement the same chevron logic. */
export function TrailingSortButton({
  sortKey,
  sortBy,
  sortOrder,
  onSort,
  className,
  children,
}: {
  sortKey: string;
  sortBy: string | null;
  sortOrder: "asc" | "desc";
  onSort: (key: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        "hover:text-foreground flex shrink-0 cursor-pointer items-center gap-0.5 transition-colors",
        className,
      )}
      onClick={() => onSort(sortKey)}
    >
      {children}
      <SortIcon col={sortKey} sortBy={sortBy} sortOrder={sortOrder} />
    </button>
  );
}

/**
 * Shared table chrome for track-like lists. Owns:
 *  - Horizontal-scroll container with sticky sortable/resizable/reorderable header
 *  - Virtualized row body
 *  - Live width state during a resize drag (committed via onColumnWidthChange)
 *
 * The body, row chrome (checkboxes, artwork, play buttons), and per-column
 * cell rendering are delegated to the caller via renderRow/header slots. This
 * keeps TrackTable minimal while letting each consumer keep its own row
 * complexity (edit cells, DnD, expanded descriptions, …).
 */
export function TrackTable<T>({
  items,
  columns,
  totalCount,
  estimateRowSize,
  overscan = 12,
  getItemKey,
  sortBy,
  sortOrder,
  onSort,
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthChange,
  onColumnWidthReset,
  isColumnVisible,
  renderHeaderLead,
  renderHeaderTrail,
  headerClassName,
  renderRow,
  renderSkeletonRow,
  bodyTrailing,
  onVisibleRangeChange,
  reloading,
  className,
  scrollClassName,
  tableRef,
}: TrackTableProps<T>) {
  const scrollParentRef = React.useRef<HTMLDivElement>(null);

  const colVisible = React.useCallback(
    (id: string) => (isColumnVisible ? isColumnVisible(id) : true),
    [isColumnVisible],
  );

  // Live widths during a resize drag. Overlays user widths until pointer-up.
  const [liveWidths, setLiveWidths] = React.useState<Record<string, number>>(
    {},
  );

  const orderedColumns = React.useMemo(() => {
    if (!columnOrder?.length) return columns;
    const byId = new Map(columns.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const out: TrackTableColumn[] = [];
    for (const id of columnOrder) {
      const c = byId.get(id);
      if (c && !seen.has(id)) {
        out.push(c);
        seen.add(id);
      }
    }
    for (const c of columns) if (!seen.has(c.id)) out.push(c);
    return out;
  }, [columns, columnOrder]);

  const visibleColumns = React.useMemo<ResolvedColumn[]>(
    () =>
      orderedColumns
        .filter((c) => colVisible(c.id))
        .map((c) => ({
          ...c,
          width: liveWidths[c.id] ?? columnWidths?.[c.id] ?? c.defaultWidth,
        })),
    [orderedColumns, colVisible, columnWidths, liveWidths],
  );

  const effectiveCount = totalCount ?? items.length;

  const virtualizer = useVirtualizer({
    count: effectiveCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize:
      typeof estimateRowSize === "function"
        ? estimateRowSize
        : () => estimateRowSize,
    overscan,
    getItemKey: getItemKey
      ? (index) => getItemKey(index, items[index])
      : undefined,
  });

  // Expose imperative API.
  React.useImperativeHandle(
    tableRef,
    () => ({
      scrollToIndex: (index, opts) =>
        virtualizer.scrollToIndex(index, opts ?? { align: "center" }),
      getVirtualItems: () => virtualizer.getVirtualItems(),
    }),
    [virtualizer],
  );

  // Fire range callback whenever the visible window changes.
  const virtualItems = virtualizer.getVirtualItems();
  const rangeStart = virtualItems[0]?.index ?? 0;
  const rangeEnd = virtualItems[virtualItems.length - 1]?.index ?? 0;
  React.useEffect(() => {
    onVisibleRangeChange?.({ start: rangeStart, end: rangeEnd });
  }, [rangeStart, rangeEnd, onVisibleRangeChange]);

  const handleHeaderReorder = React.useCallback(
    (nextIds: string[]) => {
      if (!onColumnOrderChange) return;
      // Preserve hidden ids by appending them after the user-arranged visible ids.
      const hidden = columns
        .map((c) => c.id)
        .filter((id) => !visibleColumns.some((v) => v.id === id));
      onColumnOrderChange([...nextIds, ...hidden]);
    },
    [columns, visibleColumns, onColumnOrderChange],
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div
        ref={scrollParentRef}
        className={cn(
          "min-h-0 flex-1 overflow-auto overscroll-contain transition-opacity duration-150",
          reloading ? "opacity-40" : "opacity-100",
          scrollClassName,
        )}
      >
        <div className="w-max min-w-full">
          <div
            role="row"
            className={cn(
              "border-border text-muted-foreground sticky top-0 z-20 flex h-9 items-center gap-1.5 border-b bg-[var(--surface-2)] pr-0 pl-3 text-xs font-medium",
              headerClassName,
            )}
          >
            {renderHeaderLead?.()}
            <SortableColumnHeader
              ids={visibleColumns.map((c) => c.id)}
              onOrderChange={handleHeaderReorder}
            >
              {visibleColumns.map((col) => {
                const sortKey = col.sortKey;
                return (
                  <SortableHeaderCell
                    key={col.id}
                    id={col.id}
                    className={cn("min-w-0 shrink-0", col.className)}
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
                    ) : sortKey && onSort ? (
                      <button
                        className="hover:text-foreground flex w-full cursor-pointer items-center gap-0.5 transition-colors"
                        onClick={() => onSort(sortKey)}
                      >
                        {col.header}
                        <SortIcon
                          col={sortKey}
                          sortBy={sortBy}
                          sortOrder={sortOrder}
                        />
                      </button>
                    ) : (
                      <span>{col.header}</span>
                    )}
                  </SortableHeaderCell>
                );
              })}
            </SortableColumnHeader>
            {renderHeaderTrail?.({ sortBy, sortOrder })}
          </div>

          <div>
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: "relative",
              }}
            >
              {virtualItems.map((virtualRow) => {
                const item = items[virtualRow.index];
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
                    {item
                      ? renderRow({
                          item,
                          index: virtualRow.index,
                          visibleColumns,
                        })
                      : (renderSkeletonRow?.() ?? null)}
                  </div>
                );
              })}
            </div>
            {bodyTrailing}
          </div>
        </div>
      </div>
    </div>
  );
}
