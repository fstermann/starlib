"use client";

import { Check, ListMusic, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchAllPlaylistTracks } from "@/app/library/use-playlist-tracks";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import type { SCPlaylist } from "@/lib/soundcloud";

export type AddToPlaylistResult = "added" | "exists" | "error";

/**
 * Resolve which of `playlists` already contain *every* target track. Only runs
 * while `active` (the submenu is open) to avoid fetching every playlist's
 * tracks for every rendered row. SoundCloud has no reverse "playlists
 * containing track X" endpoint, so this reads each playlist's track list
 * (cached per-urn, shared with the playlist navigation view).
 */
function usePlaylistMembership(
  trackUrns: string[],
  playlists: SCPlaylist[],
  active: boolean,
) {
  const [memberUrns, setMemberUrns] = useState<Set<string>>(new Set());
  const key = trackUrns.join("|");

  useEffect(() => {
    if (!active || trackUrns.length === 0 || playlists.length === 0) return;
    let cancelled = false;
    Promise.all(
      playlists.map(async (pl) => {
        if (!pl.urn) return null;
        try {
          const tracks = await fetchAllPlaylistTracks(pl.urn);
          const has = new Set(tracks.map((t) => t.urn));
          return trackUrns.every((u) => has.has(u)) ? pl.urn : null;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setMemberUrns(new Set(results.filter((u): u is string => u != null)));
    });
    return () => {
      cancelled = true;
    };
    // trackUrns is captured via its joined `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, playlists]);

  return memberUrns;
}

/**
 * "Add to playlist ▸" context-menu submenu listing the user's own SoundCloud
 * playlists. Acts on `trackUrns` — the current checkbox selection when the
 * right-clicked row is part of it, otherwise just that row; the trigger shows
 * the count. Playlists already containing every target track show a check and
 * are disabled; selecting an eligible one calls `onAdd` (which owns the network
 * write and toast). The submenu stays open on select so the spinner and the
 * flip-to-checked feedback are visible.
 */
export function TrackPlaylistSubmenu({
  trackUrns,
  playlists,
  loading,
  onAdd,
}: {
  trackUrns: string[];
  playlists: SCPlaylist[];
  loading: boolean;
  onAdd: (playlist: SCPlaylist) => Promise<AddToPlaylistResult>;
}) {
  const [open, setOpen] = useState(false);
  const memberUrns = usePlaylistMembership(trackUrns, playlists, open);
  // Playlists this selection was just added to — reflected immediately without
  // waiting for a re-fetch. Reset when the target set changes.
  const [optimistic, setOptimistic] = useState<Set<string>>(new Set());
  const [pendingUrn, setPendingUrn] = useState<string | null>(null);
  const key = trackUrns.join("|");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset optimistic adds when the target set changes
    setOptimistic(new Set());
  }, [key]);

  const count = trackUrns.length;
  const isMember = (urn?: string) =>
    !!urn && (memberUrns.has(urn) || optimistic.has(urn));

  async function handleSelect(playlist: SCPlaylist) {
    const urn = playlist.urn;
    if (!urn || pendingUrn || isMember(urn)) return;
    setPendingUrn(urn);
    const result = await onAdd(playlist);
    if (result === "added" || result === "exists") {
      setOptimistic((prev) => new Set(prev).add(urn));
    }
    setPendingUrn(null);
  }

  return (
    <ContextMenuSub onOpenChange={setOpen}>
      <ContextMenuSubTrigger
        data-testid="playlist-add-trigger"
        className="gap-2 text-xs"
      >
        <ListMusic className="size-3.5" />
        {count > 1 ? `Add to playlist (${count})` : "Add to playlist"}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-72 w-56 overflow-y-auto">
        {loading ? (
          <ContextMenuItem disabled className="text-xs">
            Loading playlists…
          </ContextMenuItem>
        ) : playlists.length === 0 ? (
          <ContextMenuItem disabled className="text-xs">
            No playlists
          </ContextMenuItem>
        ) : (
          playlists.map((playlist) => {
            const member = isMember(playlist.urn);
            return (
              <ContextMenuItem
                key={playlist.urn}
                data-testid="playlist-add-item"
                data-member={member ? "true" : undefined}
                disabled={member || pendingUrn != null}
                onSelect={(e) => {
                  // Keep the menu open for spinner + checked feedback.
                  e.preventDefault();
                  handleSelect(playlist);
                }}
                className="text-xs"
              >
                {pendingUrn === playlist.urn ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : member ? (
                  <Check className="size-3.5 text-[var(--brand)]" />
                ) : (
                  <ListMusic className="size-3.5" />
                )}
                <span className="truncate">{playlist.title}</span>
              </ContextMenuItem>
            );
          })
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
