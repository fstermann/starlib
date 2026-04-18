"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ListPlus,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { WeekGroup } from "@/app/weekly/use-weekly-groups";
import { AppendTracksDialog } from "@/components/append-tracks-dialog";
import { CreatePlaylistDialog } from "@/components/create-playlist-dialog";
import { LikesTable } from "@/components/likes-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SCPlaylist, SCTrack } from "@/lib/soundcloud";
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
  defaultExpanded?: boolean;
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
  defaultExpanded = false,
  playlistDescription,
  onPlaylistsReload,
  trackType,
}: WeeklyGroupCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showOnlyNew, setShowOnlyNew] = useState<boolean | null>(null);

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

  // Merged display: all tracks (existing + new) sorted newest first by created_at
  const displayTracks = useMemo(() => {
    if (!existingPlaylist) return filteredTracks;
    const SET_THRESHOLD = 720_000;
    const existingFiltered = (existingPlaylist.tracks ?? []).filter((t) => {
      if (trackType === "track") return (t.duration ?? 0) < SET_THRESHOLD;
      if (trackType === "set") return (t.duration ?? 0) >= SET_THRESHOLD;
      return true;
    });
    const merged = [...existingFiltered, ...newTracks];
    return merged.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });
  }, [existingPlaylist, newTracks, filteredTracks, trackType]);

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

  const tracksForPlaylist =
    selectedTracks.length > 0 ? selectedTracks : filteredTracks;
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
    <div
      className={cn(
        "border-border overflow-hidden rounded-lg border",
        group.isCurrent && "border-primary/50",
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "hover:bg-muted flex h-10 cursor-pointer items-center gap-2 px-3 transition-colors select-none",
          group.isCurrent && "bg-brand-soft",
        )}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
        )}

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
              onClick={(e) => e.stopPropagation()}
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
              onClick={(e) => {
                e.stopPropagation();
                setShowOnlyNew((v) =>
                  v === null ? true : v === true ? false : null,
                );
              }}
            >
              +{newTracks.length} new
            </Badge>
          )}
          <span className="text-muted-foreground text-xs tabular-nums">
            {trackCountLabel} · {formatDuration(totalDuration)}
            {groupSelectedCount > 0 && ` · ${groupSelectedCount} selected`}
          </span>

          {expanded &&
            (canAppend ? (
              <AppendTracksDialog
                newTracks={newTracks}
                existingPlaylist={existingPlaylist!}
                onAppended={onPlaylistsReload}
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-success hover:bg-success/10 hover:text-success h-6 gap-1 px-2 text-xs"
                    onClick={(e) => e.stopPropagation()}
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
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ListPlus className="size-3" />
                    {selectedTracks.length > 0
                      ? `Create (${selectedTracks.length})`
                      : "Create playlist"}
                  </Button>
                }
              />
            ) : null)}
        </div>
      </div>

      {/* Track table */}
      {expanded && (
        <div
          className="border-border border-t"
          style={{ height: Math.min(visibleTracks.length * 48 + 32, 420) }}
        >
          <LikesTable
            tracks={visibleTracks}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
            onRangeSelect={onRangeSelect}
            onSelectAll={handleSelectAll}
            onDeselectAll={handleDeselectAll}
            collectionIds={collectionIds}
            newTrackUrns={newTrackUrns}
          />
        </div>
      )}
    </div>
  );
}
