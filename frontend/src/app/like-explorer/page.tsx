"use client";

import { Compass, Heart, ListPlus } from "lucide-react";
import { useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CreatePlaylistDialog,
  MAX_TRACKS,
} from "@/components/create-playlist-dialog";
import { useTopBar } from "@/components/layout/top-bar-context";
import { LikesFilterBar } from "@/components/likes-filter-bar";
import { LikesTable } from "@/components/likes-table";
import { LogoSpinner } from "@/components/logo-spinner";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserCard } from "@/components/user-card";
import { UserSearch } from "@/components/user-search";
import { api } from "@/lib/api";
import type { SCTrack, SCUser } from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

import {
  LIKES_NODE_ID,
  LikesTreePanel,
  playlistNodeId,
  PLAYLISTS_GROUP_ID,
} from "./likes-tree-panel";
import { useCombinedPlaylistsTracks } from "./use-combined-playlists-tracks";
import { useLikes } from "./use-likes";
import {
  makeLikesFilterPredicate,
  useLikesFilter,
  type LikesFilterOptions,
} from "./use-likes-filter";
import { usePlaylistTracks } from "./use-playlist-tracks";
import { useUserPlaylists } from "./use-user-playlists";

function extractId(track: SCTrack): number | undefined {
  if (!track.urn) return undefined;
  const parts = track.urn.split(":");
  return parseInt(parts[parts.length - 1], 10) || undefined;
}

export default function LikeExplorerPage() {
  const [tab, setTab] = useQueryState("tab", { defaultValue: "me" });
  const [nodeId, setNodeId] = useQueryState("node", {
    defaultValue: LIKES_NODE_ID,
  });

  // User search state (Explore tab)
  const [selectedUser, setSelectedUser] = useState<SCUser | null>(null);

  // Which SoundCloud user we're currently viewing
  const activeUrn: string | "me" | null =
    tab === "me" ? "me" : (selectedUser?.urn ?? null);

  const myLikes = useLikes("me");
  const exploreLikes = useLikes(tab === "explore" ? activeUrn : null);
  const activeLikes = tab === "me" ? myLikes : exploreLikes;

  const { playlists } = useUserPlaylists(activeUrn);

  // Selection mode
  const isPlaylistView = nodeId?.startsWith("pl:") ?? false;
  const isAllPlaylistsView = nodeId === PLAYLISTS_GROUP_ID;

  const selectedPlaylist = useMemo(() => {
    if (!isPlaylistView) return null;
    return (
      playlists.find((pl) => playlistNodeId(pl.urn ?? "") === nodeId) ?? null
    );
  }, [playlists, nodeId, isPlaylistView]);

  const playlistTracks = usePlaylistTracks(
    isPlaylistView ? (selectedPlaylist?.urn ?? null) : null,
  );

  const allPlaylistUrns = useMemo(
    () =>
      playlists
        .map((pl) => pl.urn)
        .filter((u): u is string => typeof u === "string"),
    [playlists],
  );
  const combinedPlaylistTracks = useCombinedPlaylistsTracks(
    isAllPlaylistsView ? allPlaylistUrns : null,
  );

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
    api
      .getCollectionSoundcloudIds()
      .then((ids) => setCollectionIds(new Set(ids)))
      .catch(() => {});
  }, []);

  // Reset selection to Likes when the active user changes
  useEffect(() => {
    setNodeId(LIKES_NODE_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUrn]);

  // ----- Filter state (lifted so the tree can show filtered counts) -----
  const [search, setSearch] = useState("");
  const [genres, setGenres] = useState<string[]>([]);
  const [minDuration, setMinDuration] = useState<number | null>(null);
  const [maxDuration, setMaxDuration] = useState<number | null>(null);
  const [excludeMyLikes, setExcludeMyLikes] = useState(false);
  const [inCollection, setInCollection] = useState<boolean | null>(null);

  const filterOptions: LikesFilterOptions = useMemo(
    () => ({
      search,
      genres,
      minDuration,
      maxDuration,
      excludeMyLikes,
      inCollection,
    }),
    [search, genres, minDuration, maxDuration, excludeMyLikes, inCollection],
  );

  const filterPredicate = useMemo(
    () =>
      makeLikesFilterPredicate(
        filterOptions,
        tab === "explore" ? myLikedIds : undefined,
        collectionIds,
      ),
    [filterOptions, tab, myLikedIds, collectionIds],
  );

  // Filtered counts for tree nodes
  const likesCount = useMemo(
    () => activeLikes.tracks.filter(filterPredicate).length,
    [activeLikes.tracks, filterPredicate],
  );
  const combinedCount = useMemo(
    () => combinedPlaylistTracks.tracks.filter(filterPredicate).length,
    [combinedPlaylistTracks.tracks, filterPredicate],
  );
  // Filtered count for the selected playlist (we only have its tracks loaded).
  const selectedPlaylistCount = useMemo(
    () => playlistTracks.tracks.filter(filterPredicate).length,
    [playlistTracks.tracks, filterPredicate],
  );
  const perPlaylistCount = useMemo(() => {
    const m = new Map<string, number>();
    if (selectedPlaylist?.urn) {
      m.set(selectedPlaylist.urn, selectedPlaylistCount);
    }
    return m;
  }, [selectedPlaylist?.urn, selectedPlaylistCount]);

  useTopBar({
    title: (
      <>
        <span>Like Explorer</span>
        <div className="bg-border mx-1 h-5 w-px shrink-0" />
        <ToggleGroup
          type="single"
          variant="outline"
          value={tab}
          onValueChange={(v) => {
            if (v) setTab(v);
          }}
          className="h-7"
        >
          <ToggleGroupItem
            value="me"
            className="h-7 cursor-pointer gap-1.5 px-2 text-xs"
          >
            <Heart className="size-3.5" />
            My Likes
          </ToggleGroupItem>
          <ToggleGroupItem
            value="explore"
            className="h-7 cursor-pointer gap-1.5 px-2 text-xs"
          >
            <Compass className="size-3.5" />
            Explore
          </ToggleGroupItem>
        </ToggleGroup>
      </>
    ),
  });

  const storageKey =
    tab === "me" ? "like-explorer:me" : "like-explorer:explore";

  const viewingUser = tab === "explore" && !selectedUser;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Explore tab: user search / selected user */}
      {tab === "explore" && (
        <div className="border-border border-b px-4 py-2">
          {selectedUser ? (
            <UserCard
              user={selectedUser}
              onClear={() => setSelectedUser(null)}
            />
          ) : (
            <UserSearch onSelect={setSelectedUser} />
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {!viewingUser && (
          <LikesTreePanel
            playlists={playlists}
            selectedId={nodeId ?? LIKES_NODE_ID}
            onSelect={setNodeId}
            storageKey={storageKey}
            likesCount={likesCount}
            combinedCount={combinedCount}
            perPlaylistFilteredCount={perPlaylistCount}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <LikesView
            tab={tab}
            activeLikes={activeLikes}
            playlistTracks={playlistTracks}
            combinedPlaylistTracks={combinedPlaylistTracks}
            isPlaylistView={isPlaylistView}
            isAllPlaylistsView={isAllPlaylistsView}
            myLikedIds={myLikedIds}
            collectionIds={collectionIds}
            hasSelectedUser={selectedUser != null}
            search={search}
            onSearchChange={setSearch}
            genres={genres}
            onGenresChange={setGenres}
            minDuration={minDuration}
            onMinDurationChange={setMinDuration}
            maxDuration={maxDuration}
            onMaxDurationChange={setMaxDuration}
            excludeMyLikes={excludeMyLikes}
            onExcludeMyLikesChange={setExcludeMyLikes}
            inCollection={inCollection}
            onInCollectionChange={setInCollection}
          />
        </div>
      </div>
    </div>
  );
}

interface LikesViewProps {
  tab: string;
  activeLikes: ReturnType<typeof useLikes>;
  playlistTracks: ReturnType<typeof usePlaylistTracks>;
  combinedPlaylistTracks: ReturnType<typeof useCombinedPlaylistsTracks>;
  isPlaylistView: boolean;
  isAllPlaylistsView: boolean;
  myLikedIds: Set<number>;
  collectionIds: Set<number>;
  hasSelectedUser: boolean;

  // Filter state (lifted)
  search: string;
  onSearchChange: (v: string) => void;
  genres: string[];
  onGenresChange: (v: string[]) => void;
  minDuration: number | null;
  onMinDurationChange: (v: number | null) => void;
  maxDuration: number | null;
  onMaxDurationChange: (v: number | null) => void;
  excludeMyLikes: boolean;
  onExcludeMyLikesChange: (v: boolean) => void;
  inCollection: boolean | null;
  onInCollectionChange: (v: boolean | null) => void;
}

function LikesView({
  tab,
  activeLikes,
  playlistTracks,
  combinedPlaylistTracks,
  isPlaylistView,
  isAllPlaylistsView,
  myLikedIds,
  collectionIds,
  hasSelectedUser,
  search,
  onSearchChange,
  genres,
  onGenresChange,
  minDuration,
  onMinDurationChange,
  maxDuration,
  onMaxDurationChange,
  excludeMyLikes,
  onExcludeMyLikesChange,
  inCollection,
  onInCollectionChange,
}: LikesViewProps) {
  // Selection state stays local — filters live at the page level.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const sourceTracks = isPlaylistView
    ? playlistTracks.tracks
    : isAllPlaylistsView
      ? combinedPlaylistTracks.tracks
      : activeLikes.tracks;

  const { filteredTracks, availableGenres } = useLikesFilter(
    sourceTracks,
    { search, genres, minDuration, maxDuration, excludeMyLikes, inCollection },
    tab === "explore" ? myLikedIds : undefined,
    collectionIds,
  );

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

  const selectedTracks = useMemo(
    () =>
      sourceTracks.filter((t) => {
        const id = extractId(t);
        return id != null && selectedIds.has(id);
      }),
    [sourceTracks, selectedIds],
  );

  const loading = isPlaylistView
    ? playlistTracks.loading
    : isAllPlaylistsView
      ? combinedPlaylistTracks.loading
      : activeLikes.loading;
  const error = isPlaylistView
    ? playlistTracks.error
    : isAllPlaylistsView
      ? combinedPlaylistTracks.error
      : activeLikes.error;
  const loadedCount = isPlaylistView
    ? playlistTracks.tracks.length
    : isAllPlaylistsView
      ? combinedPlaylistTracks.tracks.length
      : activeLikes.loaded;

  return (
    <>
      {(sourceTracks.length > 0 || loading) && (
        <LikesFilterBar
          search={search}
          onSearchChange={onSearchChange}
          genres={genres}
          onGenresChange={onGenresChange}
          availableGenres={availableGenres}
          minDuration={minDuration}
          maxDuration={maxDuration}
          onMinDurationChange={onMinDurationChange}
          onMaxDurationChange={onMaxDurationChange}
          excludeMyLikes={excludeMyLikes}
          onExcludeMyLikesChange={onExcludeMyLikesChange}
          showExcludeMyLikes={tab === "explore"}
          inCollection={inCollection}
          onInCollectionChange={onInCollectionChange}
          showInCollection={collectionIds.size > 0}
          filteredCount={filteredTracks.length}
          totalCount={sourceTracks.length}
          loading={loading}
          selectedCount={selectedIds.size}
          actions={
            selectedIds.size > MAX_TRACKS ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground h-7 gap-1.5 text-xs"
                      disabled
                    >
                      <ListPlus className="size-3.5" />
                      Create Playlist
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Too many tracks selected — limit is {MAX_TRACKS}
                </TooltipContent>
              </Tooltip>
            ) : (
              <CreatePlaylistDialog
                tracks={selectedTracks}
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    className={cn(
                      "h-7 gap-1.5 text-xs",
                      selectedIds.size > 0
                        ? "text-primary hover:bg-brand-soft hover:text-primary"
                        : "text-muted-foreground",
                    )}
                    disabled={selectedIds.size === 0}
                  >
                    <ListPlus className="size-3.5" />
                    Create Playlist
                  </Button>
                }
              />
            )
          }
        />
      )}

      <div className="relative min-h-0 flex-1">
        {loading && sourceTracks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <LogoSpinner className="size-16" />
            <p className="text-muted-foreground text-sm">Loading tracks…</p>
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-destructive text-sm">{error}</p>
            <button
              className="text-primary cursor-pointer text-xs underline"
              onClick={activeLikes.reload}
            >
              Retry
            </button>
          </div>
        ) : tab === "explore" && !hasSelectedUser ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">
              Search for a user to explore their likes
            </p>
          </div>
        ) : sourceTracks.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">
              {isPlaylistView
                ? "This playlist is empty"
                : isAllPlaylistsView
                  ? "No playlists"
                  : "No liked tracks found"}
            </p>
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

        {loading && sourceTracks.length > 0 && (
          <div className="bg-card border-border absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1.5 shadow-lg">
            <LogoSpinner className="size-4" />
            <span className="text-muted-foreground text-xs">
              Loading… {loadedCount} tracks
            </span>
          </div>
        )}
      </div>
    </>
  );
}
