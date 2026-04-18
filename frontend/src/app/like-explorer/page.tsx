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

import { useLikes } from "./use-likes";
import { useLikesFilter } from "./use-likes-filter";

function extractId(track: SCTrack): number | undefined {
  if (!track.urn) return undefined;
  const parts = track.urn.split(":");
  return parseInt(parts[parts.length - 1], 10) || undefined;
}

export default function LikeExplorerPage() {
  const [tab, setTab] = useQueryState("tab", { defaultValue: "me" });

  // User search state (Explore tab)
  const [selectedUser, setSelectedUser] = useState<SCUser | null>(null);

  // Determine which user to fetch likes for
  const exploreUrn = selectedUser?.urn ?? null;
  const myLikes = useLikes("me");
  const exploreLikes = useLikes(tab === "explore" ? exploreUrn : null);

  const activeLikes = tab === "me" ? myLikes : exploreLikes;

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
      .catch(() => {}); // non-critical — column just stays empty
  }, []);

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

      <LikeTabView
        key={tab}
        tab={tab}
        activeLikes={activeLikes}
        myLikedIds={myLikedIds}
        collectionIds={collectionIds}
        hasSelectedUser={selectedUser != null}
      />
    </div>
  );
}

type LikeTabViewProps = {
  tab: string;
  activeLikes: ReturnType<typeof useLikes>;
  myLikedIds: Set<number>;
  collectionIds: Set<number>;
  hasSelectedUser: boolean;
};

function LikeTabView({
  tab,
  activeLikes,
  myLikedIds,
  collectionIds,
  hasSelectedUser,
}: LikeTabViewProps) {
  // Filter state — resets on tab switch via `key={tab}` on this component.
  const [search, setSearch] = useState("");
  const [genres, setGenres] = useState<string[]>([]);
  const [minDuration, setMinDuration] = useState<number | null>(null);
  const [maxDuration, setMaxDuration] = useState<number | null>(null);
  const [excludeMyLikes, setExcludeMyLikes] = useState(false);
  const [inCollection, setInCollection] = useState<boolean | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { filteredTracks, availableGenres } = useLikesFilter(
    activeLikes.tracks,
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
      activeLikes.tracks.filter((t) => {
        const id = extractId(t);
        return id != null && selectedIds.has(id);
      }),
    [activeLikes.tracks, selectedIds],
  );

  return (
    <>
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
          showExcludeMyLikes={tab === "explore"}
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
        {activeLikes.loading && activeLikes.tracks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <LogoSpinner className="size-16" />
            <p className="text-muted-foreground text-sm">Loading tracks…</p>
          </div>
        ) : activeLikes.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-destructive text-sm">{activeLikes.error}</p>
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
        ) : activeLikes.tracks.length === 0 && !activeLikes.loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">
              No liked tracks found
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

        {activeLikes.loading && activeLikes.tracks.length > 0 && (
          <div className="bg-card border-border absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1.5 shadow-lg">
            <LogoSpinner className="size-4" />
            <span className="text-muted-foreground text-xs">
              Loading… {activeLikes.loaded} tracks
            </span>
          </div>
        )}
      </div>
    </>
  );
}
