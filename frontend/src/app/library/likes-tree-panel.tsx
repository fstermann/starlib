"use client";

import { Heart, ListMusic, Sparkles } from "lucide-react";
import { useMemo } from "react";

import { TreeView } from "@/components/tree/tree-view";
import type { SCPlaylist } from "@/lib/soundcloud";

import type { SystemPlaylistSummary } from "./use-system-playlists";

export const LIKES_NODE_ID = "likes";
export const PLAYLISTS_GROUP_ID = "playlists";
export const MIXES_GROUP_ID = "mixes";
export const playlistNodeId = (urn: string) => `pl:${urn}`;
export const mixNodeId = (urn: string) => `mix:${urn}`;

export type LikesTreeNodeKind = "root" | "likes" | "group" | "playlist" | "mix";

export interface LikesTreeNode {
  id: string;
  name: string;
  children: LikesTreeNode[];
  kind: LikesTreeNodeKind;
  trackCount?: number;
  playlist?: SCPlaylist;
  mix?: SystemPlaylistSummary;
}

interface LikesTreePanelProps {
  playlists: SCPlaylist[];
  selectedId: string;
  onSelect: (id: string) => void;
  storageKey: string;
  /** Filtered count for the Likes node. */
  likesCount: number;
  /** Filtered count for the "Playlists" aggregate group (tracks across all). */
  combinedCount: number;
  /**
   * Filtered count per playlist (keyed by urn). Only the currently-loaded
   * playlist will have an entry; others fall back to the playlist's reported
   * track_count.
   */
  perPlaylistFilteredCount: Map<string, number>;
  /** System playlists ("Mixes"). */
  mixes?: SystemPlaylistSummary[];
  /** Filtered count for the currently-selected mix, if loaded. */
  perMixFilteredCount?: Map<string, number>;
  /**
   * Whether the Mixes feature should be rendered at all. Pass `true` on the
   * "me" tab even when the user hasn't connected yet — the group row will
   * appear empty and the content pane shows a reconnect CTA. Pass `false`
   * on the Discover tab where mixes don't apply (per-user playlists only).
   */
  showMixes?: boolean;
}

export function LikesTreePanel({
  playlists,
  selectedId,
  onSelect,
  storageKey,
  likesCount,
  combinedCount,
  perPlaylistFilteredCount,
  mixes,
  perMixFilteredCount,
  showMixes,
}: LikesTreePanelProps) {
  const tree = useMemo<LikesTreeNode>(() => {
    const playlistNodes: LikesTreeNode[] = playlists.map((pl, idx) => {
      const urn = pl.urn;
      const filtered = urn ? perPlaylistFilteredCount.get(urn) : undefined;
      return {
        id: playlistNodeId(urn ?? pl.title ?? `idx:${idx}`),
        name: (pl.title ?? "Untitled").trim() || "Untitled",
        children: [],
        kind: "playlist",
        // Use filtered count when we have loaded tracks; fall back to the
        // playlist's self-reported size.
        trackCount: filtered ?? pl.track_count,
        playlist: pl,
      };
    });

    const mixNodes: LikesTreeNode[] = (mixes ?? []).map((m) => ({
      id: mixNodeId(m.urn),
      name: m.title,
      children: [],
      kind: "mix",
      trackCount: perMixFilteredCount?.get(m.urn) ?? m.track_count,
      mix: m,
    }));

    const children: LikesTreeNode[] = [
      {
        id: LIKES_NODE_ID,
        name: "Likes",
        children: [],
        kind: "likes",
        trackCount: likesCount,
      },
    ];
    // Always surface Mixes on tabs where it applies. When the user hasn't
    // connected yet we still render the group (empty) so the CTA in the
    // right-hand pane is reachable — hiding it would leave users who
    // never auto-captured the cookie with no way to trigger a reconnect.
    if (showMixes) {
      children.push({
        id: MIXES_GROUP_ID,
        name: "Mixes",
        children: mixNodes,
        kind: "group",
      });
    }
    children.push({
      id: PLAYLISTS_GROUP_ID,
      name: "Playlists",
      children: playlistNodes,
      kind: "group",
      trackCount: combinedCount || undefined,
    });

    return {
      id: "root",
      name: "Library",
      kind: "root",
      children,
    };
  }, [
    playlists,
    likesCount,
    combinedCount,
    perPlaylistFilteredCount,
    mixes,
    perMixFilteredCount,
    showMixes,
  ]);

  return (
    <TreeView<LikesTreeNode>
      tree={tree}
      selectedId={selectedId}
      onSelect={onSelect}
      storageKey={storageKey}
      hideRoot
      renderIcon={(node) => {
        if (node.kind === "likes") {
          return <Heart className="text-muted-foreground size-3.5 shrink-0" />;
        }
        // Match group headers (Mixes/Playlists) to the icon used by their
        // children so the sidebar reads cohesively even when collapsed.
        if (node.kind === "playlist" || node.id === PLAYLISTS_GROUP_ID) {
          return (
            <ListMusic className="text-muted-foreground size-3.5 shrink-0" />
          );
        }
        if (node.kind === "mix" || node.id === MIXES_GROUP_ID) {
          return (
            <Sparkles className="text-muted-foreground size-3.5 shrink-0" />
          );
        }
        return null;
      }}
      renderBadge={(node) =>
        typeof node.trackCount === "number" && node.trackCount > 0 ? (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {node.trackCount}
          </span>
        ) : null
      }
    />
  );
}
