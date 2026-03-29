'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQueryState } from 'nuqs';
import { useLikes } from './use-likes';
import { useLikesFilter } from './use-likes-filter';
import { LikesFilterBar } from '@/components/likes-filter-bar';
import { LikesTable } from '@/components/likes-table';
import { UserSearch } from '@/components/user-search';
import { UserCard } from '@/components/user-card';
import { CreatePlaylistDialog } from '@/components/create-playlist-dialog';
import { LogoSpinner } from '@/components/logo-spinner';
import type { SCUser, SCTrack } from '@/lib/soundcloud';

function extractId(track: SCTrack): number | undefined {
  if (!track.urn) return undefined;
  const parts = track.urn.split(':');
  return parseInt(parts[parts.length - 1], 10) || undefined;
}

export default function LikeExplorerPage() {
  const [tab, setTab] = useQueryState('tab', { defaultValue: 'me' });

  // User search state (Explore tab)
  const [selectedUser, setSelectedUser] = useState<SCUser | null>(null);

  // Determine which user to fetch likes for
  const exploreUrn = selectedUser?.urn ?? null;
  const myLikes = useLikes('me');
  const exploreLikes = useLikes(tab === 'explore' ? exploreUrn : null);

  const activeLikes = tab === 'me' ? myLikes : exploreLikes;

  // My liked track IDs for "exclude my likes" filter
  const myLikedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const track of myLikes.tracks) {
      const id = extractId(track);
      if (id) ids.add(id);
    }
    return ids;
  }, [myLikes.tracks]);

  // Filter state
  const [search, setSearch] = useState('');
  const [genres, setGenres] = useState<string[]>([]);
  const [minDuration, setMinDuration] = useState<number | null>(null);
  const [maxDuration, setMaxDuration] = useState<number | null>(null);
  const [excludeMyLikes, setExcludeMyLikes] = useState(false);

  const { filteredTracks, availableGenres } = useLikesFilter(
    activeLikes.tracks,
    { search, genres, minDuration, maxDuration, excludeMyLikes },
    tab === 'explore' ? myLikedIds : undefined,
  );

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllFiltered = useCallback(() => {
    const ids = new Set<number>();
    for (const track of filteredTracks) {
      const id = extractId(track);
      if (id) ids.add(id);
    }
    setSelectedIds(ids);
  }, [filteredTracks]);

  const deselectAll = useCallback(() => setSelectedIds(new Set()), []);

  // Reset selection when switching tabs
  useEffect(() => {
    setSelectedIds(new Set());
    setSearch('');
    setGenres([]);
    setMinDuration(null);
    setMaxDuration(null);
    setExcludeMyLikes(false);
  }, [tab]);

  // Selected tracks for playlist creation
  const selectedTracks = useMemo(
    () => activeLikes.tracks.filter((t) => {
      const id = extractId(t);
      return id != null && selectedIds.has(id);
    }),
    [activeLikes.tracks, selectedIds],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4 space-y-4">
        <h1 className="text-lg font-bold tracking-tight">Like Explorer</h1>

        {/* Tab switcher */}
        <div className="flex gap-1 p-0.5 bg-muted rounded-lg w-fit">
          <button
            className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              tab === 'me' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab('me')}
          >
            My Likes
          </button>
          <button
            className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              tab === 'explore' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setTab('explore')}
          >
            Explore
          </button>
        </div>

        {/* Explore tab: user search / selected user */}
        {tab === 'explore' && (
          <div>
            {selectedUser ? (
              <UserCard user={selectedUser} onClear={() => setSelectedUser(null)} />
            ) : (
              <UserSearch onSelect={setSelectedUser} />
            )}
          </div>
        )}

        {/* Filter bar (show when we have tracks or are loading) */}
        {(activeLikes.tracks.length > 0 || activeLikes.loading) && (
          <LikesFilterBar
            search={search}
            onSearchChange={setSearch}
            genres={genres}
            onGenresChange={setGenres}
            availableGenres={availableGenres}
            minDuration={minDuration}
            maxDuration={maxDuration}
            onMinDurationChange={setMinDuration}
            onMaxDurationChange={setMaxDuration}
            excludeMyLikes={excludeMyLikes}
            onExcludeMyLikesChange={setExcludeMyLikes}
            showExcludeMyLikes={tab === 'explore'}
            filteredCount={filteredTracks.length}
            totalCount={activeLikes.tracks.length}
            loading={activeLikes.loading}
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 relative">
        {activeLikes.loading && activeLikes.tracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <LogoSpinner className="size-16" />
            <p className="text-sm text-muted-foreground">Loading tracks…</p>
          </div>
        ) : activeLikes.error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <p className="text-sm text-destructive">{activeLikes.error}</p>
            <button className="text-xs text-primary underline cursor-pointer" onClick={activeLikes.reload}>
              Retry
            </button>
          </div>
        ) : tab === 'explore' && !selectedUser ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Search for a user to explore their likes</p>
          </div>
        ) : activeLikes.tracks.length === 0 && !activeLikes.loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">No liked tracks found</p>
          </div>
        ) : (
          <LikesTable
            tracks={filteredTracks}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        )}

        {/* Loading progress overlay */}
        {activeLikes.loading && activeLikes.tracks.length > 0 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-card border border-border/50 shadow-lg">
            <LogoSpinner className="size-4" />
            <span className="text-xs text-muted-foreground">
              Loading… {activeLikes.loaded} tracks
            </span>
          </div>
        )}
      </div>

      {/* Floating action bar */}
      {selectedIds.size > 0 && (
        <div className="shrink-0 border-t border-border bg-card px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {selectedIds.size} track{selectedIds.size !== 1 ? 's' : ''} selected
            </span>
            <button className="text-xs text-primary underline cursor-pointer" onClick={selectAllFiltered}>
              Select all filtered ({filteredTracks.length})
            </button>
            <button className="text-xs text-muted-foreground underline cursor-pointer" onClick={deselectAll}>
              Deselect all
            </button>
          </div>
          <CreatePlaylistDialog tracks={selectedTracks} />
        </div>
      )}
    </div>
  );
}
