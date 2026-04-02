'use client';

import { useState, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, ListPlus, ExternalLink, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LikesTable } from '@/components/likes-table';
import { CreatePlaylistDialog } from '@/components/create-playlist-dialog';
import { AppendTracksDialog } from '@/components/append-tracks-dialog';
import { cn } from '@/lib/utils';
import type { SCTrack, SCPlaylist } from '@/lib/soundcloud';
import type { WeekGroup } from '@/app/weekly/use-weekly-groups';

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
  trackType?: 'track' | 'set' | null;
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
      if (trackType === 'track') return (t.duration ?? 0) < SET_THRESHOLD;
      if (trackType === 'set') return (t.duration ?? 0) >= SET_THRESHOLD;
      return true;
    });
  }, [group.tracks, existingUrns, trackType]);

  // Merged display: all tracks (existing + new) sorted newest first by created_at
  const displayTracks = useMemo(() => {
    if (!existingPlaylist) return filteredTracks;
    const SET_THRESHOLD = 720_000;
    const existingFiltered = (existingPlaylist.tracks ?? []).filter((t) => {
      if (trackType === 'track') return (t.duration ?? 0) < SET_THRESHOLD;
      if (trackType === 'set') return (t.duration ?? 0) >= SET_THRESHOLD;
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
    () => (existingPlaylist ? new Set(newTracks.map((t) => t.urn).filter((u): u is string => !!u)) : undefined),
    [existingPlaylist, newTracks],
  );

  const groupSelectedCount = displayTracks.filter((t) => {
    if (!t.urn) return false;
    const parts = t.urn.split(':');
    const id = parseInt(parts[parts.length - 1], 10);
    return selectedIds.has(id);
  }).length;

  const allGroupIds = displayTracks.map((t) => {
    if (!t.urn) return 0;
    const parts = t.urn.split(':');
    return parseInt(parts[parts.length - 1], 10) || 0;
  }).filter(Boolean);

  const handleSelectAll = useCallback(() => onSelectAll(allGroupIds), [onSelectAll, allGroupIds]);
  const handleDeselectAll = useCallback(() => onDeselectAll(allGroupIds), [onDeselectAll, allGroupIds]);

  const selectedTracks = filteredTracks.filter((t) => {
    if (!t.urn) return false;
    const parts = t.urn.split(':');
    const id = parseInt(parts[parts.length - 1], 10);
    return selectedIds.has(id);
  });

  const tracksForPlaylist = selectedTracks.length > 0 ? selectedTracks : filteredTracks;
  const totalDuration = getTotalDuration(displayTracks);
  const playlistUrl = existingPlaylist
    ? (existingPlaylist as Record<string, unknown>).permalink_url as string | undefined
    : undefined;
  const existingTrackCount = existingPlaylist?.tracks?.length
    ?? (existingPlaylist as Record<string, unknown> | undefined)?.track_count as number | undefined
    ?? 0;

  // Show append button when: current week, playlist exists, and there are new tracks
  const canAppend = group.isCurrent && !!existingPlaylist && newTracks.length > 0;

  const visibleTracks = showOnlyNew === true && newTrackUrns
    ? displayTracks.filter((t) => t.urn && newTrackUrns.has(t.urn))
    : showOnlyNew === false && newTrackUrns
      ? displayTracks.filter((t) => !t.urn || !newTrackUrns.has(t.urn))
      : displayTracks;

  // Parse label into structured parts: title, date range, CW
  const labelParts = (() => {
    const dashIdx = group.label.indexOf(' — ');
    if (dashIdx === -1) return { title: group.label, dateRange: '', cw: '' };
    const title = group.label.slice(0, dashIdx);
    const rest = group.label.slice(dashIdx + 3);
    const dotIdx = rest.indexOf(' · ');
    if (dotIdx === -1) return { title, dateRange: rest, cw: '' };
    return { title, dateRange: rest.slice(0, dotIdx), cw: rest.slice(dotIdx + 3) };
  })();

  const trackCountLabel = existingPlaylist
    ? newTracks.length > 0
      ? `${displayTracks.length} tracks (${newTracks.length} new)`
      : `${displayTracks.length} track${displayTracks.length !== 1 ? 's' : ''}`
    : `${filteredTracks.length} track${filteredTracks.length !== 1 ? 's' : ''}`;

  return (
    <div className={cn(
      'border border-border/50 rounded-lg overflow-hidden',
      group.isCurrent && 'border-primary/50',
    )}>
      {/* Header */}
      <div
        className={cn(
          'flex items-center gap-2 px-3 h-10 cursor-pointer select-none hover:bg-muted/30 transition-colors',
          group.isCurrent && 'bg-primary/5',
        )}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded
          ? <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />}

        <span className="text-xs font-medium truncate flex-1 min-w-0">{labelParts.title}</span>

        {/* Table-like fixed columns — always rendered so every row aligns */}
        <div className="w-20 shrink-0 flex justify-center">
          {group.isCurrent && (
            <Badge variant="default" className="h-4 px-1.5 text-[10px]">Current Week</Badge>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0 w-36 text-center hidden sm:block tabular-nums">
          {labelParts.dateRange}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0 w-12 hidden sm:block tabular-nums">
          {labelParts.cw}
        </span>

        <div className="flex items-center gap-2 shrink-0">
          {existingPlaylist && (
            <a
              href={playlistUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={cn(!playlistUrl && 'pointer-events-none')}
            >
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] gap-1 cursor-pointer hover:bg-secondary/70 transition-colors">
                <CheckCircle2 className="size-2.5 text-green-500" />
                Playlist exists ({existingTrackCount})
                {playlistUrl && <ExternalLink className="size-2.5" />}
              </Badge>
            </a>
          )}
          {canAppend && (
            <Badge
              variant="outline"
              className={cn(
                'h-4 px-1.5 text-[10px] cursor-pointer transition-colors',
                showOnlyNew === true
                  ? 'bg-green-500/15 text-green-600 border-green-500/60 hover:bg-green-500/25'
                  : showOnlyNew === false
                    ? 'text-muted-foreground border-border/50 hover:border-border'
                    : 'text-green-600 border-green-500/40 hover:bg-green-500/10',
              )}
              onClick={(e) => { e.stopPropagation(); setShowOnlyNew((v) => v === null ? true : v === true ? false : null); }}
            >
              +{newTracks.length} new
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {trackCountLabel} · {formatDuration(totalDuration)}
            {groupSelectedCount > 0 && ` · ${groupSelectedCount} selected`}
          </span>

          {expanded && (
            canAppend ? (
              <AppendTracksDialog
                newTracks={newTracks}
                existingPlaylist={existingPlaylist!}
                onAppended={onPlaylistsReload}
                trigger={
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs px-2 gap-1 border-green-500/40 text-green-600 hover:text-green-600"
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
                    variant="outline"
                    className="h-6 text-xs px-2 gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ListPlus className="size-3" />
                    {selectedTracks.length > 0 ? `Create (${selectedTracks.length})` : 'Create playlist'}
                  </Button>
                }
              />
            ) : null
          )}
        </div>
      </div>

      {/* Track table */}
      {expanded && (
        <div className="border-t border-border/50" style={{ height: Math.min(visibleTracks.length * 48 + 32, 420) }}>
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
