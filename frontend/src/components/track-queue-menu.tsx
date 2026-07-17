"use client";

import { CornerDownRight, ListPlus } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * Right-click wrapper that adds "Play next" and "Add to queue" to a track row.
 * The parent supplies the actions (each view builds its own PlayerTrack and
 * calls the player context), so this component stays presentation-only.
 * `disabled` greys the items out for rows that can't be played (e.g. an
 * unresolved Rekordbox track). `extraItems`, when given, renders below a
 * separator (the SoundCloud playlist actions).
 */
export function TrackQueueMenu({
  onPlayNext,
  onAddToQueue,
  disabled = false,
  extraItems,
  children,
}: {
  onPlayNext: () => void;
  onAddToQueue: () => void;
  disabled?: boolean;
  extraItems?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem
          data-testid="queue-play-next"
          disabled={disabled}
          onSelect={onPlayNext}
          className="text-xs"
        >
          <CornerDownRight className="size-3.5" />
          Play next
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="queue-add"
          disabled={disabled}
          onSelect={onAddToQueue}
          className="text-xs"
        >
          <ListPlus className="size-3.5" />
          Add to queue
        </ContextMenuItem>
        {extraItems && (
          <>
            <ContextMenuSeparator />
            {extraItems}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
