"use client";

import {
  Compass,
  Heart,
  ListPlus,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ColumnVisibilityMenu } from "@/components/columns/column-visibility-menu";
import { useCommand } from "@/components/command-palette";
import {
  CreatePlaylistDialog,
  MAX_TRACKS,
} from "@/components/create-playlist-dialog";
import { FiltersToolbar } from "@/components/filters/filters-toolbar";
import { useTopBar } from "@/components/layout/top-bar-context";
import { LIKES_COLUMN_DEFS, LikesTable } from "@/components/likes-table";
import { LogoSpinner } from "@/components/logo-spinner";
import { SoundcloudBatchAnalyzeButton } from "@/components/soundcloud-batch-analyze-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserCard } from "@/components/user-card";
import { UserSearch } from "@/components/user-search";
import { api } from "@/lib/api";
import { useColumnPrefs } from "@/lib/columns/use-column-prefs";
import type { FilterSchemaResponse } from "@/lib/filters/schema";
import { useFilterSchema } from "@/lib/filters/use-filter-schema";
import { useFilterState } from "@/lib/filters/use-filter-state";
import { usePlayer } from "@/lib/player-context";
import * as soundcloud from "@/lib/soundcloud";
import type { SCTrack, SCUser } from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

import { LibraryTitle } from "./library-title";
import {
  LIKES_NODE_ID,
  LikesTreePanel,
  MIXES_GROUP_ID,
  mixNodeId,
  playlistNodeId,
  PLAYLISTS_GROUP_ID,
} from "./likes-tree-panel";
import { useCombinedPlaylistsTracks } from "./use-combined-playlists-tracks";
import { useLikes } from "./use-likes";
import {
  filterStateToLikesOptions,
  makeLikesFilterPredicate,
  useLikesFilter,
} from "./use-likes-filter";
import { usePlaylistTracks } from "./use-playlist-tracks";
import { useSoundcloudTrackSearch } from "./use-soundcloud-track-search";
import { useSystemPlaylistTracks } from "./use-system-playlist-tracks";
import { useSystemPlaylists } from "./use-system-playlists";
import { useUserPlaylists } from "./use-user-playlists";

/** Hide attributes that don't apply to the current tab/context. */
function filterSchemaForTab(
  schema: FilterSchemaResponse,
  tab: string,
  hasCollection: boolean,
  nodeId: string | null,
): FilterSchemaResponse {
  // On the "me" tab, the Likes node *is* the user's likes — excluding
  // your own likes from that list would always empty it. Everywhere else
  // (Mixes, Playlists, Discover, Search) the filter is useful.
  const onLikesNode = tab === "me" && nodeId === LIKES_NODE_ID;
  return {
    ...schema,
    attributes: schema.attributes.filter((a) => {
      if (a.id === "exclude_my_likes") return !onLikesNode;
      if (a.id === "in_collection") return hasCollection;
      return true;
    }),
  };
}

function extractId(track: SCTrack): number | undefined {
  if (!track.urn) return undefined;
  const parts = track.urn.split(":");
  return parseInt(parts[parts.length - 1], 10) || undefined;
}

export function SoundcloudView() {
  const [tab, setTab] = useQueryState("tab", { defaultValue: "me" });
  const [nodeId, setNodeId] = useQueryState("node", {
    defaultValue: LIKES_NODE_ID,
  });

  // User search state (Discover tab)
  const [selectedUser, setSelectedUser] = useState<SCUser | null>(null);
  const [userPermalink, setUserPermalink] = useQueryState("u", {
    defaultValue: "",
  });

  // Track search state (Search tab)
  const [searchQuery, setSearchQuery] = useQueryState("q", {
    defaultValue: "",
  });
  // Autoplay: when a track URN is present, the first search result matching
  // this URN is auto-played once. Consumed from the palette "open + play" flow.
  const [playUrn, setPlayUrn] = useQueryState("play", { defaultValue: "" });
  const player = usePlayer();

  // Hydrate selectedUser from ?u=permalink on mount or external nav.
  useEffect(() => {
    if (!userPermalink) return;
    if (selectedUser?.permalink === userPermalink) return;
    let cancelled = false;
    (async () => {
      const resolved = await soundcloud.resolveUrl(
        `https://soundcloud.com/${userPermalink}`,
      );
      if (cancelled) return;
      if (resolved && "username" in resolved && resolved.kind === "user") {
        setSelectedUser(resolved as SCUser);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userPermalink, selectedUser?.permalink]);

  // Which SoundCloud user we're currently viewing
  const activeUrn: string | "me" | null =
    tab === "me"
      ? "me"
      : tab === "discover"
        ? (selectedUser?.urn ?? null)
        : null;

  const myLikes = useLikes("me");
  const discoverLikes = useLikes(tab === "discover" ? activeUrn : null);
  const trackSearch = useSoundcloudTrackSearch(
    tab === "search" ? searchQuery : "",
  );
  const activeLikes =
    tab === "me" ? myLikes : tab === "discover" ? discoverLikes : trackSearch;

  // Autoplay the requested track once search results arrive.
  useEffect(() => {
    if (!playUrn || tab !== "search") return;
    const match = trackSearch.tracks.find((t) => t.urn === playUrn);
    if (!match) return;
    const trackIdPart = playUrn.split(":").pop();
    const trackId = trackIdPart ? Number(trackIdPart) : NaN;
    if (!trackId || Number.isNaN(trackId)) {
      setPlayUrn("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { url } = await api.getSoundcloudStreamUrl(trackId);
        if (cancelled) return;
        player.play({
          filePath: `soundcloud:${trackId}`,
          fileName: match.title ?? String(trackId),
          title: match.title ?? undefined,
          artist: match.user?.username ?? undefined,
          streamUrl: url,
          waveformUrl: match.waveform_url ?? undefined,
          streamRefreshKey: trackId,
          permalinkUrl: match.permalink_url ?? undefined,
          artworkUrl: match.artwork_url ?? undefined,
        });
      } catch {
        // swallow — user can hit play manually
      } finally {
        if (!cancelled) setPlayUrn("");
      }
    })();
    return () => {
      cancelled = true;
    };
    // player is stable (context singleton); intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playUrn, tab, trackSearch.tracks, setPlayUrn]);

  const { playlists } = useUserPlaylists(activeUrn);
  // Mixes (system playlists) are only personal — tab "me" only.
  const { playlists: mixes, available: mixesAvailable } = useSystemPlaylists(
    tab === "me",
  );

  // Selection mode
  const isPlaylistView = nodeId?.startsWith("pl:") ?? false;
  const isMixView = nodeId?.startsWith("mix:") ?? false;
  const isAllPlaylistsView = nodeId === PLAYLISTS_GROUP_ID;
  const isMixesGroupView = nodeId === MIXES_GROUP_ID;

  const selectedPlaylist = useMemo(() => {
    if (!isPlaylistView) return null;
    return (
      playlists.find((pl) => playlistNodeId(pl.urn ?? "") === nodeId) ?? null
    );
  }, [playlists, nodeId, isPlaylistView]);

  const selectedMix = useMemo(() => {
    if (!isMixView) return null;
    return mixes.find((m) => mixNodeId(m.urn) === nodeId) ?? null;
  }, [mixes, nodeId, isMixView]);

  const playlistTracks = usePlaylistTracks(
    isPlaylistView ? (selectedPlaylist?.urn ?? null) : null,
  );
  const mixTracks = useSystemPlaylistTracks(
    isMixView ? (selectedMix?.urn ?? null) : null,
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
  // Seed schema fixes the attribute set so URL parsers stay bound even when
  // the data-derived schema (options/counts) changes with track source.
  const seedSchema = useMemo<FilterSchemaResponse>(
    () => ({
      source: "soundcloud",
      attributes: [
        { id: "search", label: "Search", kind: "text" },
        { id: "genre", label: "Genre", kind: "enum", options: [] },
        {
          id: "duration",
          label: "Duration",
          kind: "range",
          min: 0,
          max: 0,
          step: 15,
          formatHint: "duration",
        },
        {
          id: "track_type",
          label: "Type",
          kind: "enum",
          options: ["track", "set"],
        },
        { id: "in_collection", label: "In collection", kind: "bool" },
        { id: "exclude_my_likes", label: "Exclude my likes", kind: "bool" },
      ],
    }),
    [],
  );

  const {
    state: filterState,
    set: setFilter,
    clearAll: clearFilters,
  } = useFilterState(seedSchema);

  const filterOptions = useMemo(
    () => filterStateToLikesOptions(filterState),
    [filterState],
  );

  // Always pass myLikedIds — the predicate only consults it when the
  // `excludeMyLikes` toggle is on, and we now surface that toggle on Mixes
  // and Playlists as well. Scoping the Set by tab silently no-op'd the
  // filter on those views.
  const filterPredicate = useMemo(
    () => makeLikesFilterPredicate(filterOptions, myLikedIds, collectionIds),
    [filterOptions, myLikedIds, collectionIds],
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

  const selectedMixCount = useMemo(
    () => mixTracks.tracks.filter(filterPredicate).length,
    [mixTracks.tracks, filterPredicate],
  );
  const perMixCount = useMemo(() => {
    const m = new Map<string, number>();
    if (selectedMix?.urn) m.set(selectedMix.urn, selectedMixCount);
    return m;
  }, [selectedMix?.urn, selectedMixCount]);

  useTopBar({
    title: (
      <LibraryTitle>
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
            My Library
          </ToggleGroupItem>
          <ToggleGroupItem
            value="discover"
            className="h-7 cursor-pointer gap-1.5 px-2 text-xs"
          >
            <Compass className="size-3.5" />
            Discover
          </ToggleGroupItem>
          <ToggleGroupItem
            value="search"
            className="h-7 cursor-pointer gap-1.5 px-2 text-xs"
          >
            <Search className="size-3.5" />
            Search
          </ToggleGroupItem>
        </ToggleGroup>
      </LibraryTitle>
    ),
  });

  const storageKey =
    tab === "me"
      ? "library:soundcloud:me"
      : tab === "discover"
        ? "library:soundcloud:discover"
        : "library:soundcloud:search";

  const viewingUser = tab === "discover" && !selectedUser;
  const hideTreePanel = viewingUser || tab === "search";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Discover tab: user search / selected user */}
      {tab === "discover" && (
        <div className="border-border border-b px-4 py-2">
          {selectedUser ? (
            <UserCard
              user={selectedUser}
              onClear={() => {
                setSelectedUser(null);
                setUserPermalink("");
              }}
            />
          ) : (
            <UserSearch
              onSelect={(u) => {
                if (!u) return;
                setSelectedUser(u);
                setUserPermalink(u.permalink ?? "");
              }}
            />
          )}
        </div>
      )}

      {/* Search tab: free-text SoundCloud track search */}
      {tab === "search" && (
        <div className="border-border border-b px-4 py-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search SoundCloud tracks or paste a track URL…"
              className="pl-9"
              autoFocus
            />
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {!hideTreePanel && (
          <LikesTreePanel
            playlists={playlists}
            selectedId={nodeId ?? LIKES_NODE_ID}
            onSelect={setNodeId}
            storageKey={storageKey}
            likesCount={likesCount}
            combinedCount={combinedCount}
            perPlaylistFilteredCount={perPlaylistCount}
            mixes={mixes}
            perMixFilteredCount={perMixCount}
            showMixes={tab === "me"}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <LikesView
            tab={tab}
            activeLikes={activeLikes}
            playlistTracks={playlistTracks}
            combinedPlaylistTracks={combinedPlaylistTracks}
            mixTracks={mixTracks}
            nodeId={nodeId ?? LIKES_NODE_ID}
            isPlaylistView={isPlaylistView}
            isAllPlaylistsView={isAllPlaylistsView}
            isMixView={isMixView}
            isMixesGroupView={isMixesGroupView}
            mixesAvailable={mixesAvailable}
            myLikedIds={myLikedIds}
            collectionIds={collectionIds}
            hasSelectedUser={selectedUser != null}
            searchQuery={searchQuery}
            seedSchema={seedSchema}
            filterState={filterState}
            onFilterChange={setFilter}
            onClearFilters={clearFilters}
            filterOptions={filterOptions}
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
  mixTracks: ReturnType<typeof useSystemPlaylistTracks>;
  nodeId: string;
  isPlaylistView: boolean;
  isAllPlaylistsView: boolean;
  isMixView: boolean;
  isMixesGroupView: boolean;
  mixesAvailable: boolean;
  myLikedIds: Set<number>;
  collectionIds: Set<number>;
  hasSelectedUser: boolean;
  searchQuery: string;

  seedSchema: FilterSchemaResponse;
  filterState: import("@/lib/filters/schema").FilterState;
  onFilterChange: (
    id: string,
    value: import("@/lib/filters/schema").FilterValue,
  ) => void;
  onClearFilters: () => void;
  filterOptions: import("./use-likes-filter").LikesFilterOptions;
}

function LikesView({
  tab,
  activeLikes,
  playlistTracks,
  combinedPlaylistTracks,
  mixTracks,
  nodeId,
  isPlaylistView,
  isAllPlaylistsView,
  isMixView,
  isMixesGroupView,
  mixesAvailable,
  myLikedIds,
  collectionIds,
  hasSelectedUser,
  searchQuery,
  seedSchema,
  filterState,
  onFilterChange,
  onClearFilters,
  filterOptions,
}: LikesViewProps) {
  // Selection state stays local — filters live at the page level.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [createPlaylistOpen, setCreatePlaylistOpen] = useState(false);

  const columnPrefs = useColumnPrefs("library.soundcloud", LIKES_COLUMN_DEFS);

  const sourceTracks = isMixView
    ? mixTracks.tracks
    : isPlaylistView
      ? playlistTracks.tracks
      : isAllPlaylistsView
        ? combinedPlaylistTracks.tracks
        : activeLikes.tracks;

  const { filteredTracks } = useLikesFilter(
    sourceTracks,
    filterOptions,
    myLikedIds,
    collectionIds,
  );

  // Data-derived schema: enriches the seed with genre options/counts and a
  // real duration range computed from the current sourceTracks.
  const { schema: enrichedSchema } = useFilterSchema({
    source: "soundcloud",
    tracks: sourceTracks,
  });
  const schema = useMemo<FilterSchemaResponse>(() => {
    if (!enrichedSchema) return seedSchema;
    // Replace seed attributes with enriched ones where available; append any
    // seed-only attributes the enriched adapter didn't emit (e.g. booleans).
    const byId = new Map(enrichedSchema.attributes.map((a) => [a.id, a]));
    return {
      source: "soundcloud",
      attributes: seedSchema.attributes.map((a) => byId.get(a.id) ?? a),
    };
  }, [seedSchema, enrichedSchema]);

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

  const loading = isMixView
    ? mixTracks.loading
    : isPlaylistView
      ? playlistTracks.loading
      : isAllPlaylistsView
        ? combinedPlaylistTracks.loading
        : activeLikes.loading;
  const error = isMixView
    ? mixTracks.error
    : isPlaylistView
      ? playlistTracks.error
      : isAllPlaylistsView
        ? combinedPlaylistTracks.error
        : activeLikes.error;
  const loadedCount = isMixView
    ? mixTracks.tracks.length
    : isPlaylistView
      ? playlistTracks.tracks.length
      : isAllPlaylistsView
        ? combinedPlaylistTracks.tracks.length
        : activeLikes.loaded;

  // Contextual palette commands — registered only while this view is mounted
  // and a selection/filter context applies.
  const openCreatePlaylist = useCallback(() => setCreatePlaylistOpen(true), []);
  useCommand({
    id: "sc:create-playlist-from-selection",
    label: `Create playlist from ${selectedIds.size} selected track${selectedIds.size === 1 ? "" : "s"}`,
    group: "Actions",
    icon: ListPlus,
    when: selectedIds.size > 0 && selectedIds.size <= MAX_TRACKS,
    run: useCallback(
      ({ close }: { close: () => void }) => {
        openCreatePlaylist();
        close();
      },
      [openCreatePlaylist],
    ),
  });

  const reloadActiveLikes = activeLikes.reload;
  useCommand({
    id: "sc:reload",
    label:
      tab === "search"
        ? "Re-run SoundCloud search"
        : "Reload SoundCloud library",
    group: "Actions",
    icon: RefreshCw,
    when: tab !== "search" || searchQuery.trim().length > 0,
    run: useCallback(
      ({ close }: { close: () => void }) => {
        reloadActiveLikes();
        close();
      },
      [reloadActiveLikes],
    ),
  });

  // Dedicated empty-state for the Mixes group itself. When the user hasn't
  // connected (or the captured cookie expired) we render a reconnect CTA
  // here so the feature is discoverable without being hidden outright.
  const showMixesGroupCta = isMixesGroupView;

  return (
    <>
      {!showMixesGroupCta && (sourceTracks.length > 0 || loading) && (
        <FiltersToolbar
          schema={filterSchemaForTab(
            schema,
            tab,
            collectionIds.size > 0,
            nodeId,
          )}
          state={filterState}
          onChange={onFilterChange}
          onClearAll={onClearFilters}
          filtered={filteredTracks.length}
          total={sourceTracks.length}
          actions={
            <>
              <SoundcloudBatchAnalyzeButton
                tracks={filteredTracks}
                className="text-muted-foreground h-7 gap-1.5 text-xs"
              />
              <ColumnVisibilityMenu
                columns={LIKES_COLUMN_DEFS}
                isVisible={columnPrefs.isVisible}
                setHidden={columnPrefs.setHidden}
                onResetVisibility={columnPrefs.resetVisibility}
                onResetOrder={columnPrefs.resetOrder}
                onResetWidths={columnPrefs.resetWidths}
                className="text-muted-foreground h-7 gap-1.5 text-xs"
              />
              {selectedIds.size > MAX_TRACKS ? (
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
              )}
            </>
          }
        />
      )}

      <div className="relative min-h-0 flex-1">
        {showMixesGroupCta ? (
          <MixesGroupPane available={mixesAvailable} />
        ) : loading && sourceTracks.length === 0 ? (
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
        ) : tab === "discover" && !hasSelectedUser ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">
              Search for a user to discover their library
            </p>
          </div>
        ) : tab === "search" && !searchQuery.trim() ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">
              Type to search SoundCloud tracks
            </p>
          </div>
        ) : sourceTracks.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">
              {isMixView
                ? "This mix is empty"
                : isPlaylistView
                  ? "This playlist is empty"
                  : isAllPlaylistsView
                    ? "No playlists"
                    : tab === "search"
                      ? "No tracks matched your search"
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
            likedIds={myLikedIds}
            isColumnVisible={columnPrefs.isVisible}
            columnOrder={columnPrefs.prefs.order}
            onColumnOrderChange={columnPrefs.setOrder}
            columnWidths={columnPrefs.prefs.widths}
            onColumnWidthChange={columnPrefs.setWidth}
            onColumnWidthReset={columnPrefs.resetWidth}
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

      {/* Headless controlled dialog for palette-triggered Create Playlist. */}
      <CreatePlaylistDialog
        tracks={selectedTracks}
        open={createPlaylistOpen}
        onOpenChange={setCreatePlaylistOpen}
      />
    </>
  );
}

/** Right-pane content for the "Mixes" tree group itself. Shown instead of
 * a track list — we either prompt the user to connect (so the api-v2
 * session cookie can be harvested) or ask them to pick a specific mix. */
function MixesGroupPane({ available }: { available: boolean }) {
  const router = useRouter();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Sparkles className="text-muted-foreground size-8" />
      {available ? (
        <p className="text-muted-foreground text-sm">
          Pick a mix from the sidebar to view its tracks.
        </p>
      ) : (
        <>
          <p className="text-foreground text-sm font-medium">
            Mixes aren&apos;t available yet
          </p>
          <p className="text-muted-foreground max-w-sm text-sm">
            Reconnect SoundCloud so Starlib can access your personalized
            playlists (Weekly Wave, Daily Drops, Your Mix&nbsp;1–10).
          </p>
          <Button
            size="sm"
            className="mt-1"
            onClick={() => router.push("/auth/login")}
          >
            Reconnect SoundCloud
          </Button>
        </>
      )}
    </div>
  );
}
