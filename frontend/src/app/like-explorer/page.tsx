'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQueryState } from 'nuqs';
import { useLikes } from './use-likes';
import { useLikesFilter } from './use-likes-filter';
import { LikesFilterBar } from '@/components/likes-filter-bar';
import { LikesTable } from '@/components/likes-table';
import { UserSearch } from '@/components/user-search';
import { UserCard } from '@/components/user-card';
import { CreatePlaylistDialog, MAX_TRACKS } from '@/components/create-playlist-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { PageHeader } from '@/components/page-header';
import { LogoSpinner } from '@/components/logo-spinner';
import { ListPlus } from 'lucide-react';
import { api } from '@/lib/api';
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

  // Collection SoundCloud IDs
  const [collectionIds, setCollectionIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    api.getCollectionSoundcloudIds()
      .then((ids) => setCollectionIds(new Set(ids)))
      .catch(() => {});  // non-critical — column just stays empty
  }, []);

  // Filter state
  const [search, setSearch] = useState('');
  const [genres, setGenres] = useState<string[]>([]);
  const [minDuration, setMinDuration] = useState<number | null>(null);
  const [maxDuration, setMaxDuration] = useState<number | null>(null);
  const [excludeMyLikes, setExcludeMyLikes] = useState(false);
  const [inCollection, setInCollection] = useState<boolean | null>(null);

  const { filteredTracks, availableGenres } = useLikesFilter(
    activeLikes.tracks,
    { search, genres, minDuration, maxDuration, excludeMyLikes, inCollection },
    tab === 'explore' ? myLikedIds : undefined,
    collectionIds,
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

  const selectRange = useCallback((ids: number[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  // Reset selection when switching tabs
  useEffect(() => {
    setSelectedIds(new Set());
    setSearch('');
    setGenres([]);
    setMinDuration(null);
    setMaxDuration(null);
    setExcludeMyLikes(false);
    setInCollection(null);
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
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <PageHeader
        title="Like Explorer"
        controls={
          <ToggleGroup
            type="single"
            variant="outline"
            value={tab}
            onValueChange={(v) => { if (v) setTab(v); }}
            className="h-7"
          >
            <ToggleGroupItem value="me" className="h-7 px-3 text-xs cursor-pointer">My Likes</ToggleGroupItem>
            <ToggleGroupItem value="explore" className="h-7 px-3 text-xs cursor-pointer">Explore</ToggleGroupItem>
          </ToggleGroup>
        }
      >
        {/* Explore tab: user search / selected user */}
        {tab === 'explore' && (
          <div className="px-4 py-2">
            {selectedUser ? (
              <UserCard user={selectedUser} onClear={() => setSelectedUser(null)} />
            ) : (
              <UserSearch onSelect={setSelectedUser} />
            )}
          </div>
        )}
      </PageHeader>

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
          inCollection={inCollection}
          onInCollectionChange={setInCollection}
          showInCollection={collectionIds.size > 0}
          filteredCount={filteredTracks.length}
          totalCount={activeLikes.tracks.length}
          loading={activeLikes.loading}
          selectedCount={selectedIds.size}
          actions={
            selectedIds.size > MAX_TRACKS ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button size="sm" className="h-7 text-xs" variant="default" disabled>
                      <ListPlus className="size-3.5 mr-1" />
                      Create Playlist
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Too many tracks selected — limit is {MAX_TRACKS}
                </TooltipContent>
              </Tooltip>
            ) : (
              <CreatePlaylistDialog tracks={selectedTracks} trigger={
                <Button size="sm" className="h-7 text-xs" variant={selectedIds.size > 0 ? "default" : "secondary"} disabled={selectedIds.size === 0}>
                  <ListPlus className="size-3.5 mr-1" />
                  Create Playlist
                </Button>
              } />
            )
          }
        />
      )}

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
            onRangeSelect={selectRange}
            onSelectAll={selectAllFiltered}
            onDeselectAll={deselectAll}
            collectionIds={collectionIds}
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
    </div>
  );
}
