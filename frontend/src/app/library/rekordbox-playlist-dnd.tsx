"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { followCursor, TrackDragChip } from "@/components/track-playlist-dnd";
import { cn } from "@/lib/utils";

import type { RekordboxPlaylist, RekordboxTrack } from "./use-rekordbox";

/** What a dragged row carries: the tracks it adds when dropped on a playlist
 *  (the selection when the row is part of it, else the row itself). */
export interface RekordboxRowDragData {
  tracks: RekordboxTrack[];
  /** Dragged in from outside the table (the matching-tracks panel): dropped
   *  on the open playlist, it's inserted rather than moved. */
  external?: boolean;
}

/** Where dropped tracks land in the open playlist: next to a row, or at the
 *  end when `entryId` is null. */
export interface InsertTarget {
  entryId: string | null;
  after: boolean;
}

interface PlaylistDropData {
  playlist: RekordboxPlaylist;
}

const PLAYLIST_DROP_PREFIX = "rekordbox-playlist-drop:";

const isPlaylistDrop = (id: UniqueIdentifier) =>
  String(id).startsWith(PLAYLIST_DROP_PREFIX);

/** dnd-kit only targets sidebar playlists; rows of the open playlist are
 *  found from the DOM (see {@link insertTargetAt}). */
const collisionDetection: CollisionDetection = (args) =>
  pointerWithin(args).filter((h) => isPlaylistDrop(h.id));

/**
 * Where a drop at (x, y) lands in the open playlist, read from the DOM so it
 * stays right while the virtualized table scrolls mid-drag (dnd-kit's
 * measured rects go stale). Null over a drop blocker or off the table; the
 * table's empty area only counts for tracks from outside it.
 */
function insertTargetAt(
  x: number,
  y: number,
  external: boolean,
): InsertTarget | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest("[data-drop-blocker]")) return null;
    const row = el.closest<HTMLElement>("[data-drop-entry]");
    if (row) {
      const rect = row.getBoundingClientRect();
      return {
        entryId: row.dataset.dropEntry!,
        after: y > rect.top + rect.height / 2,
      };
    }
    if (external && el.closest("[data-table-drop]"))
      return { entryId: null, after: true };
  }
  return null;
}

const InsertTargetContext = createContext<InsertTarget | null>(null);

/**
 * Drag-and-drop scope for the Rekordbox view. Rows dropped on a sidebar
 * playlist are added to it; dropped on the open playlist, they move to the
 * insert line shown under the pointer. Rows never shift during a drag, which
 * keeps the line honest in a virtualized table. Uses dnd-kit because Tauri
 * intercepts HTML5 drag and drop.
 */
export function RekordboxPlaylistDndProvider({
  onAdd,
  onMove,
  onInsert,
  children,
}: {
  onAdd: (playlist: RekordboxPlaylist, tracks: RekordboxTrack[]) => void;
  /** Rows of the open playlist dropped at `target`; `entryIds` keep their
   *  playlist order. */
  onMove: (entryIds: string[], target: InsertTarget) => void;
  /** Tracks from outside the table dropped on the open playlist. */
  onInsert: (tracks: RekordboxTrack[], target: InsertTarget) => void;
  children: React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [active, setActive] = useState<RekordboxRowDragData | null>(null);
  const [target, setTarget] = useState<InsertTarget | null>(null);
  const pointer = useRef({ x: 0, y: 0 });

  // Follow the pointer, and re-check on scroll: autoscroll moves rows under
  // a still pointer.
  useEffect(() => {
    if (!active) return;
    const update = () => {
      const next = insertTargetAt(
        pointer.current.x,
        pointer.current.y,
        !!active.external,
      );
      setTarget((prev) =>
        prev?.entryId === next?.entryId && prev?.after === next?.after
          ? prev
          : next,
      );
    };
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      update();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("scroll", update, true);
    };
  }, [active]);

  function handleDragStart(e: DragStartEvent) {
    const start = e.activatorEvent as PointerEvent;
    pointer.current = { x: start.clientX, y: start.clientY };
    setActive(
      (e.active.data.current as RekordboxRowDragData | undefined) ?? null,
    );
  }

  function handleDragEnd(e: DragEndEvent) {
    setActive(null);
    setTarget(null);
    // The dragged row may have scrolled out of the virtualized table and
    // unmounted, taking its data with it; use what it carried at drag start.
    const source =
      active ?? (e.active.data.current as RekordboxRowDragData | undefined);
    if (!source) return;
    const playlistDrop = e.over?.data.current as PlaylistDropData | undefined;
    if (e.over && isPlaylistDrop(e.over.id) && playlistDrop) {
      onAdd(playlistDrop.playlist, source.tracks);
      return;
    }
    const at = insertTargetAt(
      pointer.current.x,
      pointer.current.y,
      !!source.external,
    );
    if (!at) return;
    if (source.external) {
      onInsert(source.tracks, at);
    } else {
      const entryIds = source.tracks
        .map((t) => t.entry_id)
        .filter((id): id is string => !!id);
      if (entryIds.length > 0) onMove(entryIds, at);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActive(null);
        setTarget(null);
      }}
    >
      <InsertTargetContext.Provider value={target}>
        {children}
      </InsertTargetContext.Provider>
      <DragOverlay dropAnimation={null} modifiers={[followCursor]}>
        {active ? (
          <TrackDragChip
            label={
              active.tracks.length > 1
                ? `${active.tracks.length} tracks`
                : (active.tracks[0]?.title ?? "Track")
            }
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface RowDrag {
  listeners: ReturnType<typeof useDraggable>["listeners"];
  isDragging: boolean;
}

/** A table row that drags onto playlists. With `entryId`, rows can also be
 *  dropped next to it, and it shows the insert line while they hover. */
export function DraggableRekordboxRow({
  id,
  entryId,
  data,
  children,
}: {
  id: string;
  entryId: string | null;
  data: RekordboxRowDragData;
  children: (drag: RowDrag) => React.ReactNode;
}) {
  const { listeners, setNodeRef, isDragging } = useDraggable({ id, data });
  const target = useContext(InsertTargetContext);
  const insert = entryId && target?.entryId === entryId ? target : null;
  return (
    <div
      ref={setNodeRef}
      data-drop-entry={entryId ?? undefined}
      className="relative"
    >
      {children({ listeners, isDragging })}
      {insert && (
        <div
          data-testid="playlist-insert-line"
          className={cn(
            "pointer-events-none absolute inset-x-0 h-0.5 bg-[var(--brand)]",
            insert.after ? "-bottom-px" : "-top-px",
          )}
        />
      )}
    </div>
  );
}

/** Wraps a playlist tree node so dropped rows are added to `playlist`. */
export function RekordboxPlaylistDropTarget({
  playlist,
  children,
}: {
  playlist: RekordboxPlaylist;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${PLAYLIST_DROP_PREFIX}${playlist.id}`,
    data: { playlist } satisfies PlaylistDropData,
  });
  return (
    <div
      ref={setNodeRef}
      data-testid="playlist-drop-target"
      data-drop-over={isOver ? "true" : undefined}
      className={cn(
        "rounded-sm",
        isOver && "bg-[var(--brand-soft)] ring-1 ring-[var(--brand)]",
      )}
    >
      {children}
    </div>
  );
}

/** The open playlist's table: tracks from outside dropped below the rows are
 *  appended. */
export function RekordboxTableDropTarget({
  disabled,
  children,
}: {
  disabled: boolean;
  children: React.ReactNode;
}) {
  const target = useContext(InsertTargetContext);
  return (
    <div
      data-testid="playlist-table-drop"
      data-table-drop={disabled ? undefined : ""}
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        target?.entryId === null && "ring-1 ring-[var(--brand)] ring-inset",
      )}
    >
      {children}
    </div>
  );
}

/** A matching-tracks result row, draggable onto the open view's playlists. */
export function useExternalTrackDrag(track: RekordboxTrack) {
  return useDraggable({
    id: `external:${track.id}`,
    data: { tracks: [track], external: true } satisfies RekordboxRowDragData,
  });
}

/** Mark a surface floating over the table (the matching-tracks panel) with
 *  this, so drops on it don't fall through to the rows underneath. */
export const DROP_BLOCKER = { "data-drop-blocker": "" } as const;
