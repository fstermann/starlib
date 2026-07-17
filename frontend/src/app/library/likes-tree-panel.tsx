"use client";

import {
  AudioLines,
  Heart,
  ListMusic,
  Repeat2,
  Sparkles,
  User,
} from "lucide-react";
import { useMemo } from "react";

import { PlaylistNodeMenu } from "@/components/playlist-node-menu";
import { TreeView } from "@/components/tree/tree-view";
import type { SourceProfile } from "@/lib/profile-groups";
import type { SCPlaylist } from "@/lib/soundcloud";

import type { SystemPlaylistSummary } from "./use-system-playlists";

export const LIKES_NODE_ID = "likes";
export const REPOSTS_NODE_ID = "reposts";
export const TRACKS_NODE_ID = "tracks";
export const PLAYLISTS_GROUP_ID = "playlists";
export const MIXES_GROUP_ID = "mixes";
export const playlistNodeId = (urn: string) => `pl:${urn}`;
export const mixNodeId = (urn: string) => `mix:${urn}`;
export const memberNodeId = (userUrn: string) => `member:${userUrn}`;

export type LikesTreeNodeKind =
  | "root"
  | "likes"
  | "reposts"
  | "tracks"
  | "group"
  | "member"
  | "playlist"
  | "mix";

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
  /** Filtered count for the Reposts node. */
  repostsCount: number;
  /** Filtered count for the Tracks node (uploads by the user/group). */
  tracksCount: number;
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
  /**
   * Per-member playlist breakdown. When provided AND has 2+ members the
   * "Playlists" group is rendered with a member-folder layer (one folder
   * per profile) so a multi-profile group on Discover can browse each
   * member's playlists. Falls through to the flat `playlists` list when
   * absent or single-member. */
  playlistsByMember?: Array<{ source: SourceProfile; playlists: SCPlaylist[] }>;
  /** When true, right-clicking a playlist node offers rename/delete. Only pass
   *  for the user's own playlists (the "me" tab). */
  editable?: boolean;
  /** Called after a playlist is deleted, so the caller can navigate away if it
   *  was the one being viewed. */
  onPlaylistDeleted?: (urn: string) => void;
}

export function LikesTreePanel({
  playlists,
  selectedId,
  onSelect,
  storageKey,
  likesCount,
  repostsCount,
  tracksCount,
  combinedCount,
  perPlaylistFilteredCount,
  mixes,
  perMixFilteredCount,
  showMixes,
  playlistsByMember,
  editable,
  onPlaylistDeleted,
}: LikesTreePanelProps) {
  const tree = useMemo<LikesTreeNode>(() => {
    const toPlaylistNode = (pl: SCPlaylist, idx: number): LikesTreeNode => {
      const urn = pl.urn;
      const filtered = urn ? perPlaylistFilteredCount.get(urn) : undefined;
      return {
        id: playlistNodeId(urn ?? pl.title ?? `idx:${idx}`),
        name: (pl.title ?? "Untitled").trim() || "Untitled",
        children: [],
        kind: "playlist",
        trackCount: filtered ?? pl.track_count,
        playlist: pl,
      };
    };

    const useMemberLayer =
      playlistsByMember != null && playlistsByMember.length >= 2;
    const playlistNodes: LikesTreeNode[] = useMemberLayer
      ? playlistsByMember!.map((m) => ({
          id: memberNodeId(m.source.user_urn),
          name: m.source.username || m.source.user_urn,
          kind: "member",
          children: m.playlists.map(toPlaylistNode),
          trackCount: m.playlists.length || undefined,
        }))
      : playlists.map(toPlaylistNode);

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
      {
        id: REPOSTS_NODE_ID,
        name: "Reposts",
        children: [],
        kind: "reposts",
        trackCount: repostsCount,
      },
      {
        id: TRACKS_NODE_ID,
        name: "Tracks",
        children: [],
        kind: "tracks",
        trackCount: tracksCount,
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
    repostsCount,
    tracksCount,
    combinedCount,
    perPlaylistFilteredCount,
    mixes,
    perMixFilteredCount,
    showMixes,
    playlistsByMember,
  ]);

  return (
    <TreeView<LikesTreeNode>
      tree={tree}
      selectedId={selectedId}
      onSelect={onSelect}
      storageKey={storageKey}
      hideRoot
      wrapNode={
        editable
          ? (node, row) =>
              node.kind === "playlist" && node.playlist?.urn ? (
                <PlaylistNodeMenu
                  playlist={node.playlist}
                  onDeleted={onPlaylistDeleted}
                >
                  {row}
                </PlaylistNodeMenu>
              ) : (
                row
              )
          : undefined
      }
      renderIcon={(node) => {
        if (node.kind === "likes") {
          return <Heart className="text-muted-foreground size-3.5 shrink-0" />;
        }
        if (node.kind === "reposts") {
          return (
            <Repeat2 className="text-muted-foreground size-3.5 shrink-0" />
          );
        }
        if (node.kind === "tracks") {
          return (
            <AudioLines className="text-muted-foreground size-3.5 shrink-0" />
          );
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
        if (node.kind === "member") {
          return <User className="text-muted-foreground size-3.5 shrink-0" />;
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
