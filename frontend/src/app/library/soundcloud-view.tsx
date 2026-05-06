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

import { AutoHideTabLabel } from "@/components/auto-hide-tab-label";
import { ColumnVisibilityMenu } from "@/components/columns/column-visibility-menu";
import { useCommand } from "@/components/command-palette";
import {
  CreatePlaylistDialog,
  MAX_TRACKS,
} from "@/components/create-playlist-dialog";
import { FiltersToolbar } from "@/components/filters/filters-toolbar";
import { GroupBar } from "@/components/group-bar";
import { useTopBar } from "@/components/layout/top-bar-context";
import { LIKES_COLUMN_DEFS, LikesTable } from "@/components/likes-table";
import { LogoSpinner } from "@/components/logo-spinner";
import { ProfileGroupDialog } from "@/components/profile-group-dialog";
import { SoundcloudBatchAnalyzeButton } from "@/components/soundcloud-batch-analyze-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserSearch } from "@/components/user-search";
import { api } from "@/lib/api";
import { useColumnPrefs } from "@/lib/columns/use-column-prefs";
import type { FilterSchemaResponse } from "@/lib/filters/schema";
import { useFilterSchema } from "@/lib/filters/use-filter-schema";
import { useFilterState } from "@/lib/filters/use-filter-state";
import { usePlayer } from "@/lib/player-context";
import {
  profileGroupsApi,
  TRANSIENT_GROUP_ID,
  type ProfileGroup,
  type ProfileGroupMember,
} from "@/lib/profile-groups";
import type { SCTrack } from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

import { LibraryTitle } from "./library-title";
import {
  LIKES_NODE_ID,
  LikesTreePanel,
  MIXES_GROUP_ID,
  mixNodeId,
  playlistNodeId,
  PLAYLISTS_GROUP_ID,
  REPOSTS_NODE_ID,
} from "./likes-tree-panel";
import { useCombinedPlaylistsTracks } from "./use-combined-playlists-tracks";
import { useGroupLikes } from "./use-group-likes";
import { useGroupReposts } from "./use-group-reposts";
import { useLikes } from "./use-likes";
import {
  filterStateToLikesOptions,
  makeLikesFilterPredicate,
  useLikesFilter,
} from "./use-likes-filter";
import { usePlaylistTracks } from "./use-playlist-tracks";
import { useReposts } from "./use-reposts";
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

const EMPTY_TRACKS: SCTrack[] = [];

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

  // ProfileGroup state (Discover tab). The active group can be a saved
  // group (looked up by `?group=<id>`) or a transient single-member group
  // built when the user picks a profile via UserSearch but hasn't saved.
  const [activeGroupId, setActiveGroupId] = useQueryState("group", {
    defaultValue: "",
  });
  const [savedGroups, setSavedGroups] = useState<ProfileGroup[]>([]);
  const [transientGroup, setTransientGroup] = useState<{
    id: string;
    name: string;
    members: ProfileGroupMember[];
  } | null>(null);
  const [groupDialogState, setGroupDialogState] = useState<{
    open: boolean;
    initial: { id: string; name: string; members: ProfileGroupMember[] };
  }>({ open: false, initial: { id: "", name: "", members: [] } });

  // Track search state (Search tab)
  const [searchQuery, setSearchQuery] = useQueryState("q", {
    defaultValue: "",
  });
  // Autoplay: when a track URN is present, the first search result matching
  // this URN is auto-played once. Consumed from the palette "open + play" flow.
  const [playUrn, setPlayUrn] = useQueryState("play", { defaultValue: "" });
  const player = usePlayer();

  // Load saved groups on mount.
  useEffect(() => {
    profileGroupsApi
      .list()
      .then((resp) => setSavedGroups(resp.groups))
      .catch(() => {});
  }, []);

  const activeGroup = useMemo<{
    id: string;
    name: string;
    members: ProfileGroupMember[];
  } | null>(() => {
    if (transientGroup) return transientGroup;
    if (!activeGroupId) return null;
    const found = savedGroups.find((g) => g.id === activeGroupId);
    if (!found) return null;
    return {
      id: found.id ?? "",
      name: found.name,
      members: found.members ?? [],
    };
  }, [transientGroup, activeGroupId, savedGroups]);

  // Group-of-one preserves today's "browse one profile's playlists" UX.
  // Multi-member groups disable the per-profile playlists feature in v1.
  const activeUrn: string | "me" | null =
    tab === "me"
      ? "me"
      : tab === "discover" && activeGroup?.members.length === 1
        ? (activeGroup.members[0]?.user_urn ?? null)
        : null;

  const myLikes = useLikes("me");
  const myReposts = useReposts("me");
  const groupLikes = useGroupLikes(tab === "discover" ? activeGroup : null);
  const groupReposts = useGroupReposts(tab === "discover" ? activeGroup : null);
  const trackSearch = useSoundcloudTrackSearch(
    tab === "search" ? searchQuery : "",
  );
  // Adapt useGroupLikes shape to the activeLikes contract used downstream.
  const discoverLikes = useMemo(
    () => ({
      tracks: groupLikes.tracks as unknown as SCTrack[],
      loading: groupLikes.loading,
      hasMore: false,
      loaded: groupLikes.tracks.length,
      error: groupLikes.error,
      reload: () => {
        /* per-member cache lives in soundcloud lib; reload is a no-op v1. */
      },
    }),
    [groupLikes.tracks, groupLikes.loading, groupLikes.error],
  );
  const discoverReposts = useMemo(
    () => ({
      tracks: groupReposts.tracks as unknown as SCTrack[],
      loading: groupReposts.loading,
      hasMore: false,
      loaded: groupReposts.tracks.length,
      error: groupReposts.error,
      reload: () => {
        /* per-member cache; reload is a no-op v1. */
      },
    }),
    [groupReposts.tracks, groupReposts.loading, groupReposts.error],
  );
  const activeLikes =
    tab === "me" ? myLikes : tab === "discover" ? discoverLikes : trackSearch;
  const activeReposts =
    tab === "me" ? myReposts : tab === "discover" ? discoverReposts : null;

  // Autoplay the requested track once search results arrive.
  useEffect(() => {
    if (!playUrn || tab !== "search") return;
    const match = trackSearch.tracks.find((t) => t.urn === playUrn);
    if (!match) {
      console.info("[autoplay] waiting for search results matching", playUrn);
      return;
    }
    const trackIdPart = playUrn.split(":").pop();
    const trackId = trackIdPart ? Number(trackIdPart) : NaN;
    if (!trackId || Number.isNaN(trackId)) {
      console.warn("[autoplay] bad trackId from urn", playUrn);
      setPlayUrn("");
      return;
    }
    console.info("[autoplay] starting", { trackId, title: match.title });
    let cancelled = false;
    (async () => {
      try {
        const { url } = await api.getSoundcloudStreamUrl(trackId);
        if (cancelled) {
          console.info("[autoplay] cancelled before play (deps changed)");
          return;
        }
        console.info("[autoplay] stream url resolved, calling player.play");
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
      } catch (err) {
        console.warn("[autoplay] failed", err);
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
  const isRepostsView = nodeId === REPOSTS_NODE_ID;

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

  const filterOptions = useMemo(() => {
    const opts = filterStateToLikesOptions(filterState);
    // On the Likes node the "exclude my likes" filter would always empty
    // the list — hide it from the toolbar (see `filterSchemaForTab`) AND
    // neutralize any leftover state from the URL/filter history so it
    // doesn't silently apply when the toggle is no longer visible.
    if (tab === "me" && nodeId === LIKES_NODE_ID) {
      opts.excludeMyLikes = false;
    }
    return opts;
  }, [filterState, tab, nodeId]);

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
  const repostsCount = useMemo(
    () => (activeReposts?.tracks ?? []).filter(filterPredicate).length,
    [activeReposts, filterPredicate],
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
            aria-label="My Library"
            className="group h-7 cursor-pointer gap-0 px-2 text-xs"
          >
            <AutoHideTabLabel
              icon={Heart}
              label="My Library"
              active={tab === "me"}
            />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="discover"
            aria-label="Discover"
            className="group h-7 cursor-pointer gap-0 px-2 text-xs"
          >
            <AutoHideTabLabel
              icon={Compass}
              label="Discover"
              active={tab === "discover"}
            />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="search"
            aria-label="Search"
            className="group h-7 cursor-pointer gap-0 px-2 text-xs"
          >
            <AutoHideTabLabel
              icon={Search}
              label="Search"
              active={tab === "search"}
            />
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

  const viewingUser = tab === "discover" && !activeGroup;
  const hideTreePanel = viewingUser || tab === "search";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Discover tab: profile-group bar / user search */}
      {tab === "discover" && (
        <div className="border-border space-y-2 border-b px-4 py-2">
          {activeGroup && (
            <GroupBar
              group={activeGroup}
              savedGroups={savedGroups}
              onPick={(id) => {
                setTransientGroup(null);
                setActiveGroupId(id);
              }}
              onNew={() => {
                setGroupDialogState({
                  open: true,
                  initial: { id: "", name: "", members: [] },
                });
              }}
              onManage={() => {
                setGroupDialogState({
                  open: true,
                  initial: {
                    id:
                      activeGroup.id === TRANSIENT_GROUP_ID
                        ? ""
                        : activeGroup.id,
                    name: activeGroup.name,
                    members: activeGroup.members,
                  },
                });
              }}
              onClear={() => {
                setTransientGroup(null);
                setActiveGroupId("");
              }}
            />
          )}
          {/* Saved-group picker on the empty Discover state — without it
              there's no way to re-open a previously saved group when none
              is active. Hidden once a group is loaded since the GroupBar's
              own dropdown handles switching from there. */}
          {!activeGroup && savedGroups.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid="saved-groups-picker"
            >
              <span className="text-muted-foreground text-xs">Your groups</span>
              {savedGroups.map((g) => (
                <Button
                  key={g.id ?? g.name}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setActiveGroupId(g.id ?? "")}
                  data-testid={`saved-groups-pick-${g.id ?? ""}`}
                >
                  {g.name}
                  <span className="text-muted-foreground ml-1.5 tabular-nums">
                    {g.members?.length ?? 0}
                  </span>
                </Button>
              ))}
            </div>
          )}
          {/* No group → search is the primary entry point. Transient group →
              search stays inline so the user can add more members without
              opening the manage dialog. Saved groups are edited via Manage. */}
          {(!activeGroup || activeGroup.id === TRANSIENT_GROUP_ID) && (
            <UserSearch
              onSelect={(u) => {
                if (!u) return;
                const member: ProfileGroupMember = {
                  user_urn: u.urn ?? "",
                  permalink: u.permalink ?? "",
                  username: u.username ?? "",
                  avatar_url: u.avatar_url ?? null,
                };
                if (!member.user_urn) return;
                setTransientGroup((prev) => {
                  if (!prev) {
                    return {
                      id: TRANSIENT_GROUP_ID,
                      name: "",
                      members: [member],
                    };
                  }
                  if (
                    prev.members.some((m) => m.user_urn === member.user_urn)
                  ) {
                    return prev;
                  }
                  return { ...prev, members: [...prev.members, member] };
                });
                setActiveGroupId("");
              }}
            />
          )}
        </div>
      )}

      <ProfileGroupDialog
        group={groupDialogState.initial}
        open={groupDialogState.open}
        onOpenChange={(open) => setGroupDialogState((s) => ({ ...s, open }))}
        onSaved={(saved) => {
          setSavedGroups((prev) => {
            const without = prev.filter((g) => g.id !== saved.id);
            return [...without, saved];
          });
          setTransientGroup(null);
          setActiveGroupId(saved.id ?? "");
        }}
        onDeleted={() => {
          const removedId = groupDialogState.initial.id;
          setSavedGroups((prev) => prev.filter((g) => g.id !== removedId));
          if (activeGroupId === removedId) setActiveGroupId("");
        }}
      />

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
            repostsCount={repostsCount}
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
            activeReposts={activeReposts}
            playlistTracks={playlistTracks}
            combinedPlaylistTracks={combinedPlaylistTracks}
            mixTracks={mixTracks}
            nodeId={nodeId ?? LIKES_NODE_ID}
            isPlaylistView={isPlaylistView}
            isAllPlaylistsView={isAllPlaylistsView}
            isMixView={isMixView}
            isMixesGroupView={isMixesGroupView}
            isRepostsView={isRepostsView}
            mixesAvailable={mixesAvailable}
            myLikedIds={myLikedIds}
            collectionIds={collectionIds}
            hasSelectedUser={activeGroup != null}
            showSourceColumn={
              tab === "discover" && (activeGroup?.members.length ?? 0) >= 2
            }
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
  activeReposts: ReturnType<typeof useLikes> | null;
  playlistTracks: ReturnType<typeof usePlaylistTracks>;
  combinedPlaylistTracks: ReturnType<typeof useCombinedPlaylistsTracks>;
  mixTracks: ReturnType<typeof useSystemPlaylistTracks>;
  nodeId: string;
  isPlaylistView: boolean;
  isAllPlaylistsView: boolean;
  isMixView: boolean;
  isMixesGroupView: boolean;
  isRepostsView: boolean;
  mixesAvailable: boolean;
  myLikedIds: Set<number>;
  collectionIds: Set<number>;
  hasSelectedUser: boolean;
  showSourceColumn: boolean;
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
  activeReposts,
  playlistTracks,
  combinedPlaylistTracks,
  mixTracks,
  nodeId,
  isPlaylistView,
  isAllPlaylistsView,
  isMixView,
  isMixesGroupView,
  isRepostsView,
  mixesAvailable,
  myLikedIds,
  collectionIds,
  hasSelectedUser,
  showSourceColumn,
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
        : isRepostsView
          ? (activeReposts?.tracks ?? EMPTY_TRACKS)
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
        : isRepostsView
          ? (activeReposts?.loading ?? false)
          : activeLikes.loading;
  const error = isMixView
    ? mixTracks.error
    : isPlaylistView
      ? playlistTracks.error
      : isAllPlaylistsView
        ? combinedPlaylistTracks.error
        : isRepostsView
          ? (activeReposts?.error ?? null)
          : activeLikes.error;
  const loadedCount = isMixView
    ? mixTracks.tracks.length
    : isPlaylistView
      ? playlistTracks.tracks.length
      : isAllPlaylistsView
        ? combinedPlaylistTracks.tracks.length
        : isRepostsView
          ? (activeReposts?.loaded ?? 0)
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

  const reloadActiveLikes =
    isRepostsView && activeReposts ? activeReposts.reload : activeLikes.reload;
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
              onClick={reloadActiveLikes}
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
                      : isRepostsView
                        ? "No reposted tracks found"
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
            isColumnVisible={(id) =>
              id === "source" ? showSourceColumn : columnPrefs.isVisible(id)
            }
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
