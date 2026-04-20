"use client";

import {
  CheckCircle2,
  ExternalLink,
  ListPlus,
  RotateCcw,
  Save,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { WeekGroup } from "@/app/weekly/use-weekly-groups";
import { AppendTracksDialog } from "@/components/append-tracks-dialog";
import { CreatePlaylistDialog } from "@/components/create-playlist-dialog";
import { LikesTable } from "@/components/likes-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  addTracksToPlaylist,
  type SCPlaylist,
  type SCTrack,
} from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

interface WeeklyGroupCardProps {
  group: WeekGroup;
  filteredTracks: SCTrack[];
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onRangeSelect: (ids: number[]) => void;
  onSelectAll: (ids: number[]) => void;
  onDeselectAll: (ids: number[]) => void;
  collectionIds?: Set<number>;
  existingPlaylist?: SCPlaylist;
  playlistDescription: string;
  onPlaylistsReload?: () => void;
  trackType?: "track" | "set" | null;
}

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function getTotalDuration(tracks: SCTrack[]): number {
  return tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
}

export function WeeklyGroupCard({
  group,
  filteredTracks,
  selectedIds,
  onToggleSelect,
  onRangeSelect,
  onSelectAll,
  onDeselectAll,
  collectionIds,
  existingPlaylist,
  playlistDescription,
  onPlaylistsReload,
  trackType,
}: WeeklyGroupCardProps) {
  const [showOnlyNew, setShowOnlyNew] = useState<boolean | null>(null);
  // User-defined track order override. When non-null, displayTracks is
  // rearranged to match. Reset when the underlying playlist/feed changes.
  const [orderedUrns, setOrderedUrns] = useState<string[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  // URN order currently rendered by LikesTable (after its internal sort).
  // Updated via onVisibleOrderChange. This is what gets saved.
  const [visibleOrder, setVisibleOrder] = useState<string[]>([]);

  // URNs already in the existing playlist
  const existingUrns = useMemo(() => {
    const set = new Set<string>();
    for (const t of existingPlaylist?.tracks ?? []) {
      if (t.urn) set.add(t.urn);
    }
    return set;
  }, [existingPlaylist]);

  // Tracks from this week's feed that are not yet in the existing playlist.
  // Use group.tracks (raw, before filters) so excludeSeen doesn't hide them,
  // but still apply the trackType filter.
  const newTracks = useMemo(() => {
    const SET_THRESHOLD = 720_000;
    return group.tracks.filter((t) => {
      if (!t.urn || existingUrns.has(t.urn)) return false;
      if (trackType === "track") return (t.duration ?? 0) < SET_THRESHOLD;
      if (trackType === "set") return (t.duration ?? 0) >= SET_THRESHOLD;
      return true;
    });
  }, [group.tracks, existingUrns, trackType]);

  // Merged display: the playlist's stored order (source of truth) followed by
  // any new feed tracks not yet in the playlist, sorted newest first.
  const baseDisplayTracks = useMemo(() => {
    if (!existingPlaylist) return filteredTracks;
    const SET_THRESHOLD = 720_000;
    const existingFiltered = (existingPlaylist.tracks ?? []).filter((t) => {
      if (trackType === "track") return (t.duration ?? 0) < SET_THRESHOLD;
      if (trackType === "set") return (t.duration ?? 0) >= SET_THRESHOLD;
      return true;
    });
    const newSorted = [...newTracks].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });
    return [...existingFiltered, ...newSorted];
  }, [existingPlaylist, newTracks, filteredTracks, trackType]);

  // Apply user reorder override, keeping any tracks not in the override appended.
  const displayTracks = useMemo(() => {
    if (!orderedUrns) return baseDisplayTracks;
    const byUrn = new Map<string, SCTrack>();
    for (const t of baseDisplayTracks) {
      if (t.urn) byUrn.set(t.urn, t);
    }
    const out: SCTrack[] = [];
    const consumed = new Set<string>();
    for (const urn of orderedUrns) {
      const t = byUrn.get(urn);
      if (t) {
        out.push(t);
        consumed.add(urn);
      }
    }
    for (const t of baseDisplayTracks) {
      if (!t.urn || !consumed.has(t.urn)) out.push(t);
    }
    return out;
  }, [baseDisplayTracks, orderedUrns]);

  // Reset any pending reorder when the underlying list identity changes.
  const baseKey = useMemo(
    () => baseDisplayTracks.map((t) => t.urn ?? "").join("|"),
    [baseDisplayTracks],
  );
  useEffect(() => {
    setOrderedUrns(null);
  }, [baseKey]);

  const newTrackUrns = useMemo(
    () =>
      existingPlaylist
        ? new Set(newTracks.map((t) => t.urn).filter((u): u is string => !!u))
        : undefined,
    [existingPlaylist, newTracks],
  );

  const groupSelectedCount = displayTracks.filter((t) => {
    if (!t.urn) return false;
    const parts = t.urn.split(":");
    const id = parseInt(parts[parts.length - 1], 10);
    return selectedIds.has(id);
  }).length;

  const allGroupIds = displayTracks
    .map((t) => {
      if (!t.urn) return 0;
      const parts = t.urn.split(":");
      return parseInt(parts[parts.length - 1], 10) || 0;
    })
    .filter(Boolean);

  const handleSelectAll = useCallback(
    () => onSelectAll(allGroupIds),
    [onSelectAll, allGroupIds],
  );
  const handleDeselectAll = useCallback(
    () => onDeselectAll(allGroupIds),
    [onDeselectAll, allGroupIds],
  );

  const selectedTracks = filteredTracks.filter((t) => {
    if (!t.urn) return false;
    const parts = t.urn.split(":");
    const id = parseInt(parts[parts.length - 1], 10);
    return selectedIds.has(id);
  });

  // Tracks used when creating a new playlist. Respect the user's selection if
  // any; otherwise use the order the table is currently showing (sort + drag).
  const tracksForPlaylist = useMemo(() => {
    if (selectedTracks.length > 0) return selectedTracks;
    if (visibleOrder.length > 0) {
      const byUrn = new Map<string, SCTrack>();
      for (const t of displayTracks) if (t.urn) byUrn.set(t.urn, t);
      const ordered: SCTrack[] = [];
      for (const urn of visibleOrder) {
        const t = byUrn.get(urn);
        if (t) ordered.push(t);
      }
      if (ordered.length > 0) return ordered;
    }
    return filteredTracks;
  }, [selectedTracks, visibleOrder, displayTracks, filteredTracks]);

  // The playlist's existing track order (source of truth we'd be overwriting).
  const existingPlaylistUrnOrder = useMemo(() => {
    if (!existingPlaylist) return [] as string[];
    return (existingPlaylist.tracks ?? [])
      .map((t) => t.urn)
      .filter((u): u is string => !!u);
  }, [existingPlaylist]);

  // URN list we'd send if the user hits Update playlist: whatever the table
  // currently shows (sorted + any drag reorder), falling back to the computed
  // display order while the callback hasn't reported yet.
  const saveUrnOrder = useMemo(() => {
    if (visibleOrder.length > 0) return visibleOrder;
    return displayTracks.map((t) => t.urn).filter((u): u is string => !!u);
  }, [visibleOrder, displayTracks]);

  const orderChanged =
    existingPlaylistUrnOrder.length !== saveUrnOrder.length ||
    existingPlaylistUrnOrder.some((urn, i) => urn !== saveUrnOrder[i]);

  const handleReorderTracks = useCallback(
    (newOrder: string[]) => {
      // The callback receives the new order of *visible* urns only. Splice
      // that order back into the full display list so hidden tracks keep
      // their relative positions.
      const visibleSet = new Set(newOrder);
      const fullCurrent = displayTracks
        .map((t) => t.urn)
        .filter((u): u is string => !!u);
      const it = newOrder[Symbol.iterator]();
      const next: string[] = [];
      for (const urn of fullCurrent) {
        if (visibleSet.has(urn)) {
          const { value } = it.next();
          if (value) next.push(value);
        } else {
          next.push(urn);
        }
      }
      setOrderedUrns(next);
    },
    [displayTracks],
  );

  const handleResetOrder = useCallback(() => setOrderedUrns(null), []);

  const handleSaveOrder = useCallback(async () => {
    if (!existingPlaylist?.urn) return;
    setSavingOrder(true);
    try {
      await addTracksToPlaylist(existingPlaylist.urn, saveUrnOrder);
      toast.success(`Order saved to "${existingPlaylist.title}"`);
      setOrderedUrns(null);
      onPlaylistsReload?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update playlist order",
      );
    } finally {
      setSavingOrder(false);
    }
  }, [existingPlaylist, saveUrnOrder, onPlaylistsReload]);
  const totalDuration = getTotalDuration(displayTracks);
  const playlistUrl = existingPlaylist
    ? ((existingPlaylist as Record<string, unknown>).permalink_url as
        | string
        | undefined)
    : undefined;
  const existingTrackCount =
    existingPlaylist?.tracks?.length ??
    ((existingPlaylist as Record<string, unknown> | undefined)?.track_count as
      | number
      | undefined) ??
    0;

  // Show append button when: current week, playlist exists, and there are new tracks
  const canAppend =
    group.isCurrent && !!existingPlaylist && newTracks.length > 0;

  const visibleTracks =
    showOnlyNew === true && newTrackUrns
      ? displayTracks.filter((t) => t.urn && newTrackUrns.has(t.urn))
      : showOnlyNew === false && newTrackUrns
        ? displayTracks.filter((t) => !t.urn || !newTrackUrns.has(t.urn))
        : displayTracks;

  // Parse label into structured parts: title, date range, CW
  const labelParts = (() => {
    const dashIdx = group.label.indexOf(" — ");
    if (dashIdx === -1) return { title: group.label, dateRange: "", cw: "" };
    const title = group.label.slice(0, dashIdx);
    const rest = group.label.slice(dashIdx + 3);
    const dotIdx = rest.indexOf(" · ");
    if (dotIdx === -1) return { title, dateRange: rest, cw: "" };
    return {
      title,
      dateRange: rest.slice(0, dotIdx),
      cw: rest.slice(dotIdx + 3),
    };
  })();

  const trackCountLabel = existingPlaylist
    ? newTracks.length > 0
      ? `${displayTracks.length} tracks (${newTracks.length} new)`
      : `${displayTracks.length} track${displayTracks.length !== 1 ? "s" : ""}`
    : `${filteredTracks.length} track${filteredTracks.length !== 1 ? "s" : ""}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex h-10 items-center gap-2 px-3 select-none">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {labelParts.title}
        </span>

        {/* Table-like fixed columns — always rendered so every row aligns */}
        <div className="flex w-20 shrink-0 justify-center">
          {group.isCurrent && (
            <Badge variant="default" className="h-4 px-1.5 text-xs">
              Current Week
            </Badge>
          )}
        </div>
        <span className="text-muted-foreground hidden w-36 shrink-0 text-center text-xs tabular-nums sm:block">
          {labelParts.dateRange}
        </span>
        <span className="text-muted-foreground hidden w-12 shrink-0 text-xs tabular-nums sm:block">
          {labelParts.cw}
        </span>

        <div className="flex shrink-0 items-center gap-2">
          {existingPlaylist && (
            <a
              href={playlistUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(!playlistUrl && "pointer-events-none")}
            >
              <Badge
                variant="secondary"
                className="hover:bg-secondary/70 h-4 cursor-pointer gap-1 px-1.5 text-xs transition-colors"
              >
                <CheckCircle2 className="text-success size-2.5" />
                Playlist exists ({existingTrackCount})
                {playlistUrl && <ExternalLink className="size-2.5" />}
              </Badge>
            </a>
          )}
          {canAppend && (
            <Badge
              variant="outline"
              className={cn(
                "h-4 cursor-pointer px-1.5 text-xs transition-colors",
                showOnlyNew === true
                  ? "bg-success/15 text-success border-success/60 hover:bg-success/25"
                  : showOnlyNew === false
                    ? "text-muted-foreground border-border hover:border-border"
                    : "text-success border-success/40 hover:bg-success/10",
              )}
              onClick={() =>
                setShowOnlyNew((v) =>
                  v === null ? true : v === true ? false : null,
                )
              }
            >
              +{newTracks.length} new
            </Badge>
          )}
          <span className="text-muted-foreground text-xs tabular-nums">
            {trackCountLabel} · {formatDuration(totalDuration)}
            {groupSelectedCount > 0 && ` · ${groupSelectedCount} selected`}
          </span>

          {orderChanged && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleResetOrder}
              disabled={savingOrder}
              className="text-muted-foreground hover:text-foreground h-6 gap-1 px-2 text-xs"
            >
              <RotateCcw className="size-3" />
              Reset
            </Button>
          )}
          {existingPlaylist && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleSaveOrder}
              disabled={
                savingOrder || (!orderChanged && newTracks.length === 0)
              }
              title={
                orderChanged && newTracks.length > 0
                  ? `Save reorder and append ${newTracks.length} new track${newTracks.length !== 1 ? "s" : ""}`
                  : orderChanged
                    ? "Save the new track order to SoundCloud"
                    : newTracks.length > 0
                      ? `Append ${newTracks.length} new track${newTracks.length !== 1 ? "s" : ""} to the playlist`
                      : "Reorder tracks or wait for new tracks"
              }
              className="text-primary hover:bg-brand-soft hover:text-primary h-6 gap-1 px-2 text-xs disabled:opacity-40"
            >
              <Save className="size-3" />
              {savingOrder
                ? "Saving…"
                : newTracks.length > 0 && !orderChanged
                  ? `Append ${newTracks.length}`
                  : "Update playlist"}
            </Button>
          )}

          {canAppend ? (
            <AppendTracksDialog
              newTracks={newTracks}
              existingPlaylist={existingPlaylist!}
              onAppended={onPlaylistsReload}
              trigger={
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-success hover:bg-success/10 hover:text-success h-6 gap-1 px-2 text-xs"
                >
                  <ListPlus className="size-3" />
                  Append {newTracks.length}
                </Button>
              }
            />
          ) : !existingPlaylist ? (
            <CreatePlaylistDialog
              tracks={tracksForPlaylist}
              defaultTitle={group.playlistTitle}
              defaultDescription={playlistDescription}
              onCreated={onPlaylistsReload}
              trigger={
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-primary hover:bg-brand-soft hover:text-primary h-6 gap-1 px-2 text-xs"
                >
                  <ListPlus className="size-3" />
                  {selectedTracks.length > 0
                    ? `Create (${selectedTracks.length})`
                    : "Create playlist"}
                </Button>
              }
            />
          ) : null}
        </div>
      </div>

      {/* Track table */}
      <div className="min-h-0 flex-1">
        <LikesTable
          tracks={visibleTracks}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onRangeSelect={onRangeSelect}
          onSelectAll={handleSelectAll}
          onDeselectAll={handleDeselectAll}
          collectionIds={collectionIds}
          newTrackUrns={newTrackUrns}
          onReorderTracks={handleReorderTracks}
          onVisibleOrderChange={setVisibleOrder}
        />
      </div>
    </div>
  );
}
