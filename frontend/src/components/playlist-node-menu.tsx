"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { mutateCachedUserPlaylists } from "@/app/library/use-user-playlists";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deletePlaylist,
  renamePlaylist,
  type SCPlaylist,
} from "@/lib/soundcloud";

/**
 * Right-click wrapper for one of the user's own playlist nodes in the sidebar:
 * "Rename" (inline dialog) and "Delete" (confirm). Both write to SoundCloud,
 * then refresh every mounted playlist list via reloadUserPlaylists. `onDeleted`
 * lets the caller navigate away if the deleted playlist was being viewed.
 */
export function PlaylistNodeMenu({
  playlist,
  onDeleted,
  children,
}: {
  playlist: SCPlaylist;
  onDeleted?: (urn: string) => void;
  children: React.ReactNode;
}) {
  const urn = playlist.urn;
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(playlist.title ?? "");
  const [busy, setBusy] = useState(false);

  async function handleRename() {
    const next = title.trim();
    if (!urn || !next) return;
    if (next === (playlist.title ?? "")) {
      setRenameOpen(false);
      return;
    }
    setBusy(true);
    try {
      await renamePlaylist(urn, next);
      mutateCachedUserPlaylists("me", (pls) =>
        pls.map((p) => (p.urn === urn ? { ...p, title: next } : p)),
      );
      setRenameOpen(false);
      toast.success(`Renamed to "${next}"`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to rename playlist",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!urn) return;
    setBusy(true);
    try {
      await deletePlaylist(urn);
      mutateCachedUserPlaylists("me", (pls) =>
        pls.filter((p) => p.urn !== urn),
      );
      setDeleteOpen(false);
      onDeleted?.(urn);
      toast.success(`Deleted "${playlist.title ?? "playlist"}"`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete playlist",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem
            data-testid="playlist-rename"
            className="text-xs"
            onSelect={() => {
              setTitle(playlist.title ?? "");
              setRenameOpen(true);
            }}
          >
            <Pencil className="size-3.5" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            data-testid="playlist-delete"
            variant="destructive"
            className="text-xs"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-3.5" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename playlist</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="rename-playlist-title">Title</Label>
            <Input
              id="rename-playlist-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button onClick={handleRename} disabled={busy || !title.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{playlist.title ?? "playlist"}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the playlist on SoundCloud. The tracks
              themselves are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="playlist-delete-confirm"
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
