"use client";

import { Heart, ListMusic } from "lucide-react";
import { useMemo } from "react";

import { TreeView } from "@/components/tree/tree-view";
import type { SCPlaylist } from "@/lib/soundcloud";

export const LIKES_NODE_ID = "likes";
export const PLAYLISTS_GROUP_ID = "playlists";
export const playlistNodeId = (urn: string) => `pl:${urn}`;

export type LikesTreeNodeKind = "root" | "likes" | "group" | "playlist";

export interface LikesTreeNode {
  id: string;
  name: string;
  children: LikesTreeNode[];
  kind: LikesTreeNodeKind;
  trackCount?: number;
  playlist?: SCPlaylist;
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
}

export function LikesTreePanel({
  playlists,
  selectedId,
  onSelect,
  storageKey,
  likesCount,
  combinedCount,
  perPlaylistFilteredCount,
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

    return {
      id: "root",
      name: "Library",
      kind: "root",
      children: [
        {
          id: LIKES_NODE_ID,
          name: "Likes",
          children: [],
          kind: "likes",
          trackCount: likesCount,
        },
        {
          id: PLAYLISTS_GROUP_ID,
          name: "Playlists",
          children: playlistNodes,
          kind: "group",
          trackCount: combinedCount || undefined,
        },
      ],
    };
  }, [playlists, likesCount, combinedCount, perPlaylistFilteredCount]);

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
        if (node.kind === "playlist") {
          return (
            <ListMusic className="text-muted-foreground size-3.5 shrink-0" />
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
