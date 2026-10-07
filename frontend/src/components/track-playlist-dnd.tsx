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
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { ListMusic } from "lucide-react";
import { useState } from "react";

import type { SCPlaylist, SCTrack } from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

/** What a dragged track row carries: the tracks it acts on (selection or the
 *  row itself) and the add action that owns the network write and toast. */
export interface TrackDragData {
  tracks: SCTrack[];
  onAdd: (playlist: SCPlaylist) => unknown;
}

/** Pins the overlay's top-left just below-right of the pointer. Without it the
 *  chip is placed relative to the full-width row and lands off-screen. */
const followCursor: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  const start = activatorEvent && getEventCoordinates(activatorEvent);
  if (!start || !draggingNodeRect) return transform;
  return {
    ...transform,
    x: transform.x + start.x - draggingNodeRect.left + 12,
    y: transform.y + start.y - draggingNodeRect.top + 12,
  };
};

interface PlaylistDropData {
  playlist: SCPlaylist;
}

/**
 * Drag-and-drop scope for dropping SoundCloud track rows onto playlist nodes.
 * Uses dnd-kit rather than HTML5 drag and drop, which Tauri's native
 * drag-drop handler intercepts on Windows.
 */
export function TrackPlaylistDndProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [active, setActive] = useState<TrackDragData | null>(null);

  function handleDragStart(e: DragStartEvent) {
    setActive((e.active.data.current as TrackDragData | undefined) ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActive(null);
    const source = e.active.data.current as TrackDragData | undefined;
    const target = e.over?.data.current as PlaylistDropData | undefined;
    if (source && target) source.onAdd(target.playlist);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActive(null)}
    >
      {children}
      <DragOverlay dropAnimation={null} modifiers={[followCursor]}>
        {active ? <TrackDragChip tracks={active.tracks} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function TrackDragChip({ tracks }: { tracks: SCTrack[] }) {
  return (
    <div
      data-testid="track-drag-overlay"
      className="border-border inline-flex max-w-64 items-center gap-2 rounded-md border bg-[var(--surface-4)] px-2.5 py-1.5 text-xs text-[var(--text)] shadow-[var(--shadow-2)]"
    >
      <ListMusic className="size-3.5 shrink-0 text-[var(--brand)]" />
      <span className="truncate">
        {tracks.length > 1
          ? `${tracks.length} tracks`
          : (tracks[0]?.title ?? "Track")}
      </span>
    </div>
  );
}

/** Makes a track row draggable onto playlist drop targets. Spread `listeners`
 *  on the row element and attach `setNodeRef` to its wrapper. */
export function useTrackDraggable(id: string, data: TrackDragData) {
  const { listeners, setNodeRef, isDragging } = useDraggable({ id, data });
  return { listeners, setNodeRef, isDragging };
}

/** Wraps a playlist node so dropped track rows are added to `playlist`. */
export function PlaylistDropTarget({
  playlist,
  children,
}: {
  playlist: SCPlaylist;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `playlist-drop:${playlist.urn}`,
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
