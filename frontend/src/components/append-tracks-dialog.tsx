"use client";

import { ListPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  addTracksToPlaylist,
  type SCPlaylist,
  type SCTrack,
} from "@/lib/soundcloud";

interface AppendTracksDialogProps {
  newTracks: SCTrack[];
  existingPlaylist: SCPlaylist;
  trigger?: React.ReactNode;
  onAppended?: () => void;
}

function formatTotalDuration(tracks: SCTrack[]): string {
  const totalMs = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const totalMin = Math.floor(totalMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function AppendTracksDialog({
  newTracks,
  existingPlaylist,
  trigger,
  onAppended,
}: AppendTracksDialogProps) {
  const [open, setOpen] = useState(false);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playlistUrn = existingPlaylist.urn;
  const existingTrackCount =
    existingPlaylist.tracks?.length ??
    ((existingPlaylist as Record<string, unknown>).track_count as number) ??
    0;
  const playlistUrl = (existingPlaylist as Record<string, unknown>)
    .permalink_url as string | undefined;

  const newUrns = newTracks
    .map((t) => t.urn)
    .filter((urn): urn is string => urn != null);

  async function handleAppend() {
    if (!playlistUrn || newUrns.length === 0) return;
    setAppending(true);
    setError(null);
    try {
      // Build the full track list: existing URNs + new URNs
      const existingUrns = (existingPlaylist.tracks ?? [])
        .map((t) => t.urn)
        .filter((urn): urn is string => urn != null);
      const updatedPlaylist = await addTracksToPlaylist(playlistUrn, [
        ...existingUrns,
        ...newUrns,
      ]);
      const url = (updatedPlaylist as Record<string, unknown>).permalink_url as
        | string
        | undefined;
      onAppended?.();
      setOpen(false);
      toast.success(
        `${newTracks.length} track${newTracks.length !== 1 ? "s" : ""} appended to "${existingPlaylist.title}"`,
        {
          action:
            (url ?? playlistUrl)
              ? {
                  label: "Open",
                  onClick: () => window.open(url ?? playlistUrl, "_blank"),
                }
              : undefined,
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to append tracks");
    } finally {
      setAppending(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <ListPlus className="mr-1.5 size-3" />
            Append {newTracks.length} tracks
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Append to Existing Playlist</DialogTitle>
          <DialogDescription>{existingPlaylist.title}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-sm">
          <div className="text-muted-foreground flex items-center justify-between">
            <span>Existing tracks</span>
            <span className="text-foreground font-medium tabular-nums">
              {existingTrackCount}
            </span>
          </div>
          <div className="text-muted-foreground flex items-center justify-between">
            <span>New tracks to append</span>
            <span className="text-success font-medium tabular-nums">
              +{newTracks.length} · {formatTotalDuration(newTracks)}
            </span>
          </div>
          <div className="border-border text-muted-foreground flex items-center justify-between border-t pt-3">
            <span>Total after append</span>
            <span className="text-foreground font-medium tabular-nums">
              {existingTrackCount + newTracks.length}
            </span>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            onClick={handleAppend}
            disabled={appending || newUrns.length === 0}
          >
            {appending
              ? "Appending…"
              : `Append ${newTracks.length} track${newTracks.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
