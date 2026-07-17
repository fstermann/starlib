"use client";

import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ListMusic, X } from "lucide-react";
import { useState } from "react";

import { CoverPlayButton } from "@/components/cover-play-button";
import { MarqueeText } from "@/components/marquee-text";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { cn } from "@/lib/utils";

/** Artwork for a queue row: prefer the track's own art (SoundCloud CDN), fall
 * back to the local `/artwork` endpoint for filesystem tracks, and let
 * CoverPlayButton render its music-note glyph when neither applies. */
function artworkFor(track: PlayerTrack): string | undefined {
  if (track.artworkUrl) return track.artworkUrl;
  if (track.filePath.startsWith("soundcloud:")) return undefined;
  return api.getArtworkUrl(track.filePath);
}

function trackTitle(track: PlayerTrack): string {
  return track.title ?? track.fileName;
}

/**
 * A single upcoming-track row: drag handle, artwork, title/artist, remove
 * button. The whole row (outside the handle and remove button) is a click
 * target that jumps playback to this entry. `index` is the entry's absolute
 * position in the full queue; `id` is that index as a string (dnd-kit ids).
 */
function UpcomingRow({
  id,
  track,
  onJump,
  onRemove,
}: {
  id: string;
  track: PlayerTrack;
  onJump: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    // A DragOverlay clone follows the pointer, so the source slot just dims to
    // a gap — the shuffle of the other rows still animates via `transition`.
    opacity: isDragging ? 0 : undefined,
  };
  const title = trackTitle(track);

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="queue-item"
      data-queue-index={id}
      className="group/qrow hover:bg-surface-3 flex items-center gap-2 rounded-md px-1 py-1"
    >
      <button
        type="button"
        aria-label="Reorder track"
        className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      <CoverPlayButton
        artworkUrl={artworkFor(track)}
        isCurrent={false}
        onStartPlay={onJump}
        label={title}
      />
      <button
        type="button"
        onClick={onJump}
        className="min-w-0 flex-1 cursor-pointer text-left"
        title={title}
      >
        <MarqueeText
          text={title}
          className="text-foreground text-xs font-medium"
        />
        {track.artist && (
          <div className="text-muted-foreground text-2xs truncate">
            {track.artist}
          </div>
        )}
      </button>
      <button
        type="button"
        onClick={onRemove}
        data-testid="queue-item-remove"
        aria-label={`Remove ${title} from queue`}
        className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover/qrow:opacity-100 focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** The floating clone rendered under the pointer while a row is dragged. A
 * static mirror of UpcomingRow's layout — no interactive controls. */
function DragRow({ track }: { track: PlayerTrack }) {
  const title = trackTitle(track);
  return (
    <div className="bg-surface-3 flex items-center gap-2 rounded-md px-1 py-1 shadow-lg">
      <span className="text-muted-foreground flex size-5 shrink-0 items-center justify-center">
        <GripVertical className="size-3.5" />
      </span>
      <CoverPlayButton
        artworkUrl={artworkFor(track)}
        isCurrent={false}
        label={title}
      />
      <div className="min-w-0 flex-1">
        <MarqueeText
          text={title}
          className="text-foreground text-xs font-medium"
        />
        {track.artist && (
          <div className="text-muted-foreground text-2xs truncate">
            {track.artist}
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact, non-draggable row for the "Now playing" track. */
function NowPlayingRow({ track }: { track: PlayerTrack }) {
  const title = trackTitle(track);
  return (
    <div
      data-testid="queue-now-playing"
      className="flex items-center gap-2 rounded-md px-1 py-1"
    >
      <CoverPlayButton artworkUrl={artworkFor(track)} isCurrent label={title} />
      <div className="min-w-0 flex-1">
        <MarqueeText
          text={title}
          className="text-primary text-xs font-medium"
        />
        {track.artist && (
          <div className="text-muted-foreground text-2xs truncate">
            {track.artist}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Queue Preview: a player-bar trigger that opens a right-side sheet listing
 * the now-playing track and the upcoming queue. Upcoming rows are drag-
 * reorderable, removable, and click-to-play. Reorder/remove reuse the player
 * context's `replaceUpcoming` (which swaps the tail after the current index).
 */
export function QueuePanel() {
  const { queue, queueIndex, currentTrack, jumpTo, replaceUpcoming } =
    usePlayer();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Everything after the current entry, tagged with its absolute queue index.
  const upcoming = queue
    .slice(queueIndex + 1)
    .map((track, i) => ({ track, index: queueIndex + 1 + i }));
  const ids = upcoming.map((u) => String(u.index));
  const activeTrack =
    activeId != null
      ? (upcoming.find((u) => String(u.index) === activeId)?.track ?? null)
      : null;

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const tail = upcoming.map((u) => u.track);
    const [moved] = tail.splice(from, 1);
    tail.splice(to, 0, moved);
    replaceUpcoming(tail);
  }

  function handleRemove(absoluteIndex: number) {
    const tail = upcoming
      .filter((u) => u.index !== absoluteIndex)
      .map((u) => u.track);
    replaceUpcoming(tail);
  }

  const hasQueue = queueIndex >= 0 && !!currentTrack;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="queue-trigger"
          disabled={!hasQueue}
          className={cn(
            "text-muted-foreground hover:text-foreground hover:bg-surface-3 flex size-6 cursor-pointer items-center justify-center rounded-full transition-colors",
            !hasQueue && "cursor-not-allowed opacity-40 hover:bg-transparent",
          )}
          title="Queue"
          aria-label="Show queue"
        >
          <ListMusic className="size-3.5" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="right"
        data-testid="queue-panel"
        className="w-80 max-w-[90vw] gap-0"
      >
        <SheetHeader>
          <SheetTitle>Queue</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-1 px-4 pt-2 pb-4">
            {currentTrack && (
              <>
                <div className="text-muted-foreground text-2xs px-1 pt-1 pb-1 tracking-wider uppercase">
                  Now playing
                </div>
                <NowPlayingRow track={currentTrack} />
              </>
            )}
            <div className="text-muted-foreground text-2xs px-1 pt-3 pb-1 tracking-wider uppercase">
              Next up
            </div>
            {upcoming.length === 0 ? (
              <div className="text-muted-foreground px-1 py-2 text-xs">
                Nothing queued next.
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(e: DragStartEvent) =>
                  setActiveId(String(e.active.id))
                }
                onDragEnd={handleDragEnd}
                onDragCancel={() => setActiveId(null)}
              >
                <SortableContext
                  items={ids}
                  strategy={verticalListSortingStrategy}
                >
                  {upcoming.map((u) => (
                    <UpcomingRow
                      key={u.index}
                      id={String(u.index)}
                      track={u.track}
                      onJump={() => jumpTo(u.index)}
                      onRemove={() => handleRemove(u.index)}
                    />
                  ))}
                </SortableContext>
                <DragOverlay>
                  {activeTrack ? <DragRow track={activeTrack} /> : null}
                </DragOverlay>
              </DndContext>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
