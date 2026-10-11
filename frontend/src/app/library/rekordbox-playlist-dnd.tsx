"use client";

import {
  closestCenter,
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
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";

import { followCursor, TrackDragChip } from "@/components/track-playlist-dnd";
import { cn } from "@/lib/utils";

import type { RekordboxPlaylist, RekordboxTrack } from "./use-rekordbox";

/** What a dragged row carries: the tracks it adds when dropped on a playlist
 *  (the selection when the row is part of it, else the row itself). */
export interface RekordboxRowDragData {
  tracks: RekordboxTrack[];
}

interface PlaylistDropData {
  playlist: RekordboxPlaylist;
}

const PLAYLIST_DROP_PREFIX = "rekordbox-playlist-drop:";

const isPlaylistDrop = (id: UniqueIdentifier) =>
  String(id).startsWith(PLAYLIST_DROP_PREFIX);

/** A playlist node under the pointer wins; otherwise the nearest row, but only
 *  while the pointer is over something droppable at all. */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const onPlaylist = hits.filter((h) => isPlaylistDrop(h.id));
  if (onPlaylist.length > 0) return onPlaylist;
  if (hits.length === 0) return [];
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (c) => !isPlaylistDrop(c.id),
    ),
  });
};

/**
 * Drag-and-drop scope for the Rekordbox view: rows dropped on a sidebar
 * playlist are added to it, rows dropped on another row (sortable mode) are
 * moved there. Uses dnd-kit because Tauri intercepts HTML5 drag and drop.
 */
export function RekordboxPlaylistDndProvider({
  onAdd,
  onReorder,
  children,
}: {
  onAdd: (playlist: RekordboxPlaylist, tracks: RekordboxTrack[]) => void;
  /** Ids are the entry ids of the dragged row and the row it was dropped on. */
  onReorder: (activeId: string, overId: string) => void;
  children: React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [active, setActive] = useState<RekordboxRowDragData | null>(null);

  function handleDragStart(e: DragStartEvent) {
    setActive(
      (e.active.data.current as RekordboxRowDragData | undefined) ?? null,
    );
  }

  function handleDragEnd(e: DragEndEvent) {
    setActive(null);
    const source = e.active.data.current as RekordboxRowDragData | undefined;
    if (!source || !e.over) return;
    const target = e.over.data.current as PlaylistDropData | undefined;
    if (isPlaylistDrop(e.over.id) && target) {
      onAdd(target.playlist, source.tracks);
    } else if (e.over.id !== e.active.id) {
      onReorder(String(e.active.id), String(e.over.id));
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActive(null)}
    >
      {children}
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

/** Row that can be moved within the playlist and dropped onto other playlists.
 *  `id` must be the row's entry id. */
export function SortableRekordboxRow({
  id,
  data,
  children,
}: {
  id: string;
  data: RekordboxRowDragData;
  children: (drag: RowDrag) => React.ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, data });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children({ listeners, isDragging })}
    </div>
  );
}

/** Row that can only be dropped onto other playlists. */
export function DraggableRekordboxRow({
  id,
  data,
  children,
}: {
  id: string;
  data: RekordboxRowDragData;
  children: (drag: RowDrag) => React.ReactNode;
}) {
  const { listeners, setNodeRef, isDragging } = useDraggable({ id, data });
  return <div ref={setNodeRef}>{children({ listeners, isDragging })}</div>;
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
