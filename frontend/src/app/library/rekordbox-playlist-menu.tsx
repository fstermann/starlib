"use client";

import { FolderPlus, ListPlus, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
  ContextMenuSeparator,
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
  createRekordboxPlaylist,
  deleteRekordboxPlaylist,
  renameRekordboxPlaylist,
  type RekordboxPlaylist,
} from "./use-rekordbox";

/**
 * Right-click wrapper for a node in the local Rekordbox tree: "New playlist"
 * and "New folder" (inside a folder, next to a playlist, or at the top level
 * for the Collection node, whose `playlist` is null), "Rename", and "Delete"
 * (confirm).
 */
export function RekordboxPlaylistMenu({
  playlist,
  onCreated,
  onRenamed,
  onDeleted,
  children,
}: {
  playlist: RekordboxPlaylist | null;
  onCreated: (playlist: RekordboxPlaylist) => void;
  onRenamed: (playlist: RekordboxPlaylist) => void;
  onDeleted: (playlistId: string) => void;
  children: React.ReactNode;
}) {
  const [naming, setNaming] = useState<
    "new-playlist" | "new-folder" | "rename" | null
  >(null);
  const [name, setName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const parentId = playlist?.is_folder
    ? playlist.id
    : (playlist?.parent_id ?? null);

  const kind = playlist?.is_folder ? "folder" : "playlist";
  const dialogTitle =
    naming === "new-folder"
      ? "New folder"
      : naming === "new-playlist"
        ? "New playlist"
        : `Rename ${kind}`;

  function startNaming(next: NonNullable<typeof naming>) {
    setName(next === "rename" ? (playlist?.name ?? "") : "");
    setNaming(next);
  }

  async function handleSubmitName() {
    const trimmed = name.trim();
    if (!naming || !trimmed) return;
    if (naming === "rename" && (!playlist || trimmed === playlist.name)) {
      setNaming(null);
      return;
    }
    setBusy(true);
    try {
      if (naming === "rename" && playlist) {
        const renamed = await renameRekordboxPlaylist(playlist.id, trimmed);
        onRenamed(renamed);
        toast.success(`Renamed to "${renamed.name}"`);
      } else {
        const created = await createRekordboxPlaylist(
          trimmed,
          parentId,
          naming === "new-folder",
        );
        onCreated(created);
        toast.success(`Created "${created.name}"`);
      }
      setNaming(null);
    } catch (e) {
      toast.error(
        naming === "rename"
          ? `Couldn't rename ${kind}`
          : `Couldn't create ${naming === "new-folder" ? "folder" : "playlist"}`,
        { description: e instanceof Error ? e.message : undefined },
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!playlist) return;
    setBusy(true);
    try {
      await deleteRekordboxPlaylist(playlist.id);
      setDeleteOpen(false);
      onDeleted(playlist.id);
      toast.success(`Deleted "${playlist.name}"`);
    } catch (e) {
      toast.error(`Couldn't delete "${playlist.name}"`, {
        description: e instanceof Error ? e.message : undefined,
      });
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
            data-testid="rekordbox-new-playlist"
            className="text-xs"
            onSelect={() => startNaming("new-playlist")}
          >
            <ListPlus className="size-3.5" />
            New playlist
          </ContextMenuItem>
          <ContextMenuItem
            data-testid="rekordbox-new-folder"
            className="text-xs"
            onSelect={() => startNaming("new-folder")}
          >
            <FolderPlus className="size-3.5" />
            New folder
          </ContextMenuItem>
          {playlist && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                data-testid="rekordbox-rename-playlist"
                className="text-xs"
                onSelect={() => startNaming("rename")}
              >
                <Pencil className="size-3.5" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="rekordbox-delete-playlist"
                variant="destructive"
                className="text-xs"
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-3.5" />
                Delete
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog
        open={naming !== null}
        onOpenChange={(open) => !open && setNaming(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="rekordbox-playlist-name">Name</Label>
            <Input
              id="rekordbox-playlist-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitName();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button onClick={handleSubmitName} disabled={busy || !name.trim()}>
              {naming === "rename"
                ? busy
                  ? "Saving…"
                  : "Save"
                : busy
                  ? "Creating…"
                  : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {playlist && (
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{playlist.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                {playlist.is_folder
                  ? "This deletes the folder and every playlist inside it from Rekordbox."
                  : "This deletes the playlist from Rekordbox."}{" "}
                The tracks stay in your collection.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid="rekordbox-delete-playlist-confirm"
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
      )}
    </>
  );
}
