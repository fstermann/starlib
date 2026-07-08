"use client";

import { Disc3, Folder, Sparkles } from "lucide-react";
import { useQueryState } from "nuqs";
import { useMemo } from "react";

import { useTopBar } from "@/components/layout/top-bar-context";
import { LogoSpinner } from "@/components/logo-spinner";
import { TreeView } from "@/components/tree/tree-view";
import type { TreeNodeShape } from "@/components/tree/types";
import { semitonesFromBpmRatio, transposeCamelot } from "@/lib/camelot";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { cn } from "@/lib/utils";

import { LibraryTitle } from "./library-title";
import {
  useRekordboxPlaylists,
  useRekordboxPlaylistTracks,
  useRekordboxStatus,
  type RekordboxPlaylist,
  type RekordboxTrack,
} from "./use-rekordbox";

// ─── Tree node shape ────────────────────────────────────────────────────────

interface RbTreeNode extends TreeNodeShape<RbTreeNode> {
  id: string;
  name: string;
  children: RbTreeNode[];
  pl: RekordboxPlaylist | null;
}

const ROOT_NODE_ID = "__rb_root__";

function buildTree(playlists: RekordboxPlaylist[]): RbTreeNode {
  const byId = new Map<string, RbTreeNode>();
  for (const pl of playlists) {
    byId.set(pl.id, { id: pl.id, name: pl.name, children: [], pl });
  }
  const root: RbTreeNode = {
    id: ROOT_NODE_ID,
    name: "Rekordbox",
    children: [],
    pl: null,
  };
  for (const node of byId.values()) {
    const parent = node.pl?.parent_id ? byId.get(node.pl.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else root.children.push(node);
  }
  const sortRec = (nodes: RbTreeNode[]) => {
    nodes.sort((a, b) => {
      const aFolder = !!a.pl?.is_folder;
      const bFolder = !!b.pl?.is_folder;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(root.children);
  return root;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Key column cell. When the pitcher is active and the track's BPM is known,
 * shows the transposed Camelot key in brand-green next to (or in place of)
 * the original. Falls back to the raw key for non-Camelot strings.
 */
function KeyCell({
  keyValue,
  bpm,
  pitchEnabled,
  targetBpm,
}: {
  keyValue: string | null;
  bpm: number | null;
  pitchEnabled: boolean;
  targetBpm: number;
}) {
  if (!keyValue) return <span className="text-muted-foreground">—</span>;
  const shouldShift = pitchEnabled && bpm != null && bpm > 0 && targetBpm > 0;
  const semitones = shouldShift ? semitonesFromBpmRatio(targetBpm / bpm) : 0;
  const shifted =
    semitones !== 0 ? transposeCamelot(keyValue, semitones) : null;

  if (!shifted)
    return <span className="text-muted-foreground">{keyValue}</span>;
  return (
    <span
      className="font-medium text-[var(--brand)]"
      title={`Pitched: ${keyValue} → ${shifted} (${semitones > 0 ? "+" : ""}${semitones} st)`}
    >
      {shifted}
    </span>
  );
}

function toPlayerTrack(t: RekordboxTrack): PlayerTrack | null {
  if (!t.file_path) return null;
  return {
    filePath: t.file_path,
    fileName: t.file_path.split("/").pop() ?? t.title,
    title: t.title,
    artist: t.artist ?? undefined,
    bpm: t.bpm ?? null,
  };
}

// Grid: title | artist | genre | bpm | key | length | sc
const COLS =
  "minmax(0,2.2fr) minmax(0,1.6fr) minmax(0,1fr) 64px 56px 72px 80px";

// ─── View ───────────────────────────────────────────────────────────────────

export function RekordboxView() {
  useTopBar({ title: <LibraryTitle /> });

  const status = useRekordboxStatus();
  const enabled = status.data.available;

  const { data, loading, error } = useRekordboxPlaylists(enabled);
  const [selectedId, setSelectedId] = useQueryState("playlist", {
    defaultValue: "",
  });
  const tracks = useRekordboxPlaylistTracks(selectedId || null);
  const player = usePlayer();
  const { pitchEnabled, targetBpm } = player;

  const tree = useMemo(() => buildTree(data.playlists), [data.playlists]);
  const selectedPl = useMemo(
    () => data.playlists.find((p) => p.id === selectedId) ?? null,
    [data.playlists, selectedId],
  );

  if (status.loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <LogoSpinner className="size-16" />
      </div>
    );
  }

  if (!status.data.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Disc3 className="text-muted-foreground size-8" />
        <p className="text-foreground text-sm font-medium">
          Rekordbox isn&apos;t available
        </p>
        <p className="text-muted-foreground max-w-sm text-sm">
          {status.data.reason ??
            "Could not open the Rekordbox master database on this machine."}
        </p>
      </div>
    );
  }

  function handleSelectNode(nodeId: string) {
    if (nodeId === ROOT_NODE_ID) return;
    const pl = data.playlists.find((p) => p.id === nodeId);
    if (!pl || pl.is_folder) return;
    setSelectedId(nodeId);
  }

  function handlePlayRow(index: number) {
    const queue = tracks.data.tracks
      .map(toPlayerTrack)
      .filter((t): t is PlayerTrack => t !== null);
    if (queue.length === 0) return;
    // Map the table index back to the queue (skips entries without a file).
    const playableIdx =
      tracks.data.tracks.slice(0, index + 1).filter((t) => t.file_path).length -
      1;
    if (playableIdx < 0) return;
    player.playQueue(queue, playableIdx);
  }

  return (
    <div className="flex min-h-0 flex-1">
      <TreeView<RbTreeNode>
        tree={tree}
        selectedId={selectedId || ""}
        onSelect={handleSelectNode}
        hideRoot
        storageKey="rekordbox-tree"
        width={{ storageKey: "rekordbox-tree-width" }}
        renderIcon={(node) => {
          if (node.pl?.is_folder)
            return <Folder className="size-3.5 shrink-0" />;
          if (node.pl?.is_smart)
            return <Sparkles className="text-primary size-3.5 shrink-0" />;
          return <Disc3 className="size-3.5 shrink-0" />;
        }}
        renderBadge={(node) =>
          node.pl && !node.pl.is_folder ? (
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {node.pl.track_count}
            </span>
          ) : null
        }
        emptyState={
          loading ? (
            <div className="flex h-32 items-center justify-center">
              <LogoSpinner className="size-6" />
            </div>
          ) : error ? (
            <p className="text-destructive p-3 text-xs">{error}</p>
          ) : (
            <p className="text-muted-foreground p-3 text-xs">No playlists</p>
          )
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedId || !selectedPl ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Pick a playlist to view its tracks
          </div>
        ) : tracks.loading && tracks.data.tracks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <LogoSpinner className="size-10" />
            {selectedPl.is_smart && (
              <p className="text-muted-foreground text-xs">
                Evaluating smart playlist…
              </p>
            )}
          </div>
        ) : tracks.error ? (
          <p className="text-destructive p-4 text-sm">{tracks.error}</p>
        ) : tracks.data.tracks.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">
            This playlist is empty
          </p>
        ) : (
          <div
            className="flex min-h-0 flex-1 flex-col"
            data-testid="rekordbox-tracks"
          >
            {/* Header */}
            <div
              className="border-border text-muted-foreground sticky top-0 z-10 grid items-center gap-2 border-b px-3 py-1.5 text-[11px] font-medium tracking-wider uppercase"
              style={{ gridTemplateColumns: COLS }}
            >
              <span>Title</span>
              <span>Artist</span>
              <span>Genre</span>
              <span className="text-right">BPM</span>
              <span>Key</span>
              <span className="text-right">Length</span>
              <span>SoundCloud</span>
            </div>

            {/* Rows */}
            <div className="flex-1 overflow-y-auto">
              {tracks.data.tracks.map((t, idx) => {
                const playable = !!t.file_path;
                const isCurrent =
                  player.currentTrack?.filePath === t.file_path && playable;
                return (
                  <div
                    key={`${idx}-${t.id}`}
                    role="button"
                    tabIndex={playable ? 0 : -1}
                    onClick={() => playable && handlePlayRow(idx)}
                    onKeyDown={(e) => {
                      if (!playable) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handlePlayRow(idx);
                      }
                    }}
                    aria-label={`Play ${t.title}`}
                    title={
                      playable
                        ? undefined
                        : "Missing local file — not playable from Rekordbox"
                    }
                    className={cn(
                      "group border-border grid h-10 items-center gap-2 border-b px-3 text-xs transition-colors select-none",
                      playable
                        ? "cursor-pointer hover:bg-[var(--surface-3)]"
                        : "text-muted-foreground/60 cursor-default",
                      isCurrent && "bg-[var(--brand-soft)]",
                    )}
                    style={{ gridTemplateColumns: COLS }}
                  >
                    <span
                      className={cn(
                        "truncate font-medium",
                        isCurrent && "text-primary",
                      )}
                    >
                      {t.title || "—"}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {t.artist ?? "—"}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {t.genre ?? "—"}
                    </span>
                    <span className="text-muted-foreground text-right tabular-nums">
                      {t.bpm?.toFixed(1) ?? "—"}
                    </span>
                    <KeyCell
                      keyValue={t.key}
                      bpm={t.bpm}
                      pitchEnabled={pitchEnabled}
                      targetBpm={targetBpm}
                    />
                    <span className="text-muted-foreground text-right tabular-nums">
                      {formatDuration(t.duration_seconds)}
                    </span>
                    <span className="text-muted-foreground truncate tabular-nums">
                      {t.soundcloud_id ?? "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
