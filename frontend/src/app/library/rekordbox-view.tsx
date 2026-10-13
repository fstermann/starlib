"use client";

import {
  Blend,
  Folder,
  HardDrive,
  Library,
  ListMusic,
  ListPlus,
  Sparkles,
  Trash2,
  TriangleAlert,
  Unplug,
  Usb,
} from "lucide-react";
import { useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { computePlaybackRate } from "@/components/bpm-pitcher";
import { ColumnVisibilityMenu } from "@/components/columns/column-visibility-menu";
import { ResizableHeaderCell } from "@/components/columns/sortable-columns";
import { CoverPlayButton } from "@/components/cover-play-button";
import { CreatePlaylistDialog } from "@/components/create-playlist-dialog";
import { FiltersToolbar } from "@/components/filters/filters-toolbar";
import { RekordboxLogo } from "@/components/icons/rekordbox-logo";
import {
  useReloadHandler,
  useTopBar,
} from "@/components/layout/top-bar-context";
import { LogoSpinner } from "@/components/logo-spinner";
import {
  MatchingTracksSheetOutlet,
  useMatchingTracks,
  useMatchingTracksPlaylist,
} from "@/components/matching-tracks/matching-tracks-provider";
import { RekordboxWaveform } from "@/components/rekordbox-waveform";
import { TrackQueueMenu } from "@/components/track-queue-menu";
import {
  TrackTable,
  useLeadColumnWidth,
  type ResolvedColumn,
  type TrackTableColumn,
} from "@/components/track-table/track-table";
import { TreeView } from "@/components/tree/tree-view";
import type { TreeNodeShape } from "@/components/tree/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { camelotKeyRank, transposeCamelot } from "@/lib/camelot";
import type { ColumnDef } from "@/lib/columns/types";
import { useColumnPrefs } from "@/lib/columns/use-column-prefs";
import {
  applyRekordboxFilters,
  buildRekordboxSchema,
} from "@/lib/filters/rekordbox-adapter";
import { useFilterState } from "@/lib/filters/use-filter-state";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import type { SCTrack } from "@/lib/soundcloud";
import { ROW_DENSITY_STYLES, useRowDensity } from "@/lib/use-row-density";
import { cn } from "@/lib/utils";
import {
  keySemitonesForRate,
  semitonesFloatForRate,
} from "@/lib/waveform-detail";

import { LibraryTitle } from "./library-title";
import {
  DraggableRekordboxRow,
  RekordboxPlaylistDndProvider,
  RekordboxPlaylistDropTarget,
  RekordboxTableDropTarget,
  type InsertTarget,
} from "./rekordbox-playlist-dnd";
import { RekordboxPlaylistMenu } from "./rekordbox-playlist-menu";
import {
  addRekordboxPlaylistTracks,
  COLLECTION_ID,
  rekordboxPlayerTrack,
  removeRekordboxPlaylistEntries,
  reorderRekordboxPlaylist,
  useRekordboxCollection,
  useRekordboxDevices,
  useRekordboxPlaylists,
  useRekordboxPlaylistTracks,
  useRekordboxRunning,
  useRekordboxStatus,
  type RekordboxPlaylist,
  type RekordboxTrack,
} from "./use-rekordbox";

// Sentinel select value for the local Rekordbox install (Radix Select forbids
// an empty-string item value).
const LOCAL_DEVICE = "__local__";

// ─── Tree node shape ────────────────────────────────────────────────────────

interface RbTreeNode extends TreeNodeShape<RbTreeNode> {
  id: string;
  name: string;
  children: RbTreeNode[];
  pl: RekordboxPlaylist | null;
}

const ROOT_NODE_ID = "__rb_root__";

function buildTree(
  playlists: RekordboxPlaylist[],
  withCollection: boolean,
): RbTreeNode {
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
  if (withCollection) {
    root.children.unshift({
      id: COLLECTION_ID,
      name: "Collection",
      children: [],
      pl: null,
    });
  }
  return root;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Format an ISO date string (YYYY-MM-DD) as the user's locale short date. */
function formatDate(value: string | null): string {
  if (!value) return "—";
  // Rekordbox stores YYYY-MM-DD strings. Parse defensively so we don't crash
  // on the occasional year-only ("2018") or empty ("") field.
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(value);
  if (!m) return value;
  const [, y, mo, d] = m;
  if (!mo) return y;
  if (!d) return `${y}-${mo}`;
  return `${y}-${mo}-${d}`;
}

/**
 * Key column cell. When the pitcher is active and the track's BPM is known,
 * shows the transposed Camelot key in brand-green; hovering it shows the
 * original key and the pitch change. Falls back to the raw key for non-Camelot
 * strings.
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
  const rate = computePlaybackRate(pitchEnabled, bpm, targetBpm);
  const semitones = keySemitonesForRate(rate);
  const shifted =
    semitones !== 0 ? transposeCamelot(keyValue, semitones) : null;

  if (!shifted)
    return <span className="text-muted-foreground">{keyValue}</span>;
  const sign = (n: number) => (n > 0 ? "+" : "");
  const pitchPercent = (rate - 1) * 100;
  const semitonesFloat = semitonesFloatForRate(rate);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="rekordbox-pitched-key"
          className="font-medium text-[var(--brand)]"
        >
          {shifted}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="tabular-nums">
        Original key {keyValue} · {sign(pitchPercent)}
        {pitchPercent.toFixed(1)}% ({sign(semitonesFloat)}
        {semitonesFloat.toFixed(1)} st)
      </TooltipContent>
    </Tooltip>
  );
}

// Columns shared by the TrackTable header + body. Every column sorts by its
// own id. Sorting only reorders the display; the playlist order is untouched.
const REKORDBOX_COLUMNS: TrackTableColumn[] = [
  {
    id: "title",
    header: "Title",
    sortKey: "title",
    required: true,
    defaultWidth: 256,
  },
  { id: "artist", header: "Artist", sortKey: "artist", defaultWidth: 192 },
  { id: "genre", header: "Genre", sortKey: "genre", defaultWidth: 112 },
  {
    id: "bpm",
    header: "BPM",
    sortKey: "bpm",
    defaultWidth: 56,
    className: "text-right tabular-nums",
  },
  { id: "key", header: "Key", sortKey: "key", defaultWidth: 56 },
  {
    id: "duration",
    header: "Length",
    sortKey: "duration",
    defaultWidth: 72,
    className: "text-right tabular-nums",
  },
  {
    id: "date_added",
    header: "Added",
    sortKey: "date_added",
    defaultWidth: 96,
    className: "tabular-nums",
  },
  {
    id: "release_date",
    header: "Released",
    sortKey: "release_date",
    defaultWidth: 96,
    className: "tabular-nums",
  },
  {
    id: "soundcloud_id",
    header: "SoundCloud",
    sortKey: "soundcloud_id",
    defaultWidth: 96,
  },
];

/** `order` with the `moving` entries taken out and put back at `target`,
 *  keeping their order. Null when `target` is itself being moved. */
function placeEntries(
  order: string[],
  moving: string[],
  target: InsertTarget,
): string[] | null {
  const rest = order.filter((id) => !moving.includes(id));
  if (target.entryId === null) return [...rest, ...moving];
  const anchor = rest.indexOf(target.entryId);
  if (anchor < 0) return null;
  const at = anchor + (target.after ? 1 : 0);
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** Selection key: the playlist entry when there is one, else the track. */
const rowKey = (t: RekordboxTrack) => t.entry_id ?? t.id;

type SortValue = string | number | null;

/** Sort value per column. A Camelot key sorts by wheel position; any other
 *  key notation sorts as text after the Camelot keys. */
const SORT_ACCESSORS: Record<string, (t: RekordboxTrack) => SortValue> = {
  title: (t) => t.title || null,
  artist: (t) => t.artist,
  genre: (t) => t.genre,
  bpm: (t) => t.bpm,
  key: (t) => (t.key ? (camelotKeyRank(t.key) ?? t.key) : null),
  duration: (t) => t.duration_seconds,
  date_added: (t) => t.date_added || null,
  release_date: (t) => t.release_date || null,
  soundcloud_id: (t) => t.soundcloud_id,
};

/** Compares sort values: numbers before text, missing values last. */
function compareSortValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a.localeCompare(b);
}

function sortTracks(
  tracks: RekordboxTrack[],
  sortBy: string,
  order: "asc" | "desc",
): RekordboxTrack[] {
  const accessor = SORT_ACCESSORS[sortBy];
  if (!accessor) return tracks;
  const dir = order === "asc" ? 1 : -1;
  return [...tracks].sort((x, y) => {
    const a = accessor(x);
    const b = accessor(y);
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    return dir * compareSortValues(a, b);
  });
}

const WAVEFORM_COLUMN_ID = "waveform";
const WAVEFORM_DEFAULT_WIDTH = 96;

const REKORDBOX_COLUMN_DEFS: ColumnDef[] = REKORDBOX_COLUMNS.map((c) => ({
  id: c.id,
  header: c.header,
  required: c.required,
}));

// ─── View ───────────────────────────────────────────────────────────────────

export function RekordboxView() {
  // "" = local install; otherwise a mounted USB export's device id.
  const [device, setDevice] = useQueryState("device", { defaultValue: "" });
  const [selectedId, setSelectedId] = useQueryState("playlist", {
    defaultValue: "",
  });
  const deviceId = device || null;
  const isLocal = !device;
  const isCollection = selectedId === COLLECTION_ID;
  const [ejecting, setEjecting] = useState(false);

  // Poll the device list so an unplug/eject is noticed without a manual reload.
  const devicesState = useRekordboxDevices(4000);
  const devices = devicesState.data.devices;
  const status = useRekordboxStatus(deviceId);
  const enabled = status.data.available;

  const {
    data,
    loading,
    error,
    refetch: refetchPlaylists,
    setData: setPlaylistsData,
  } = useRekordboxPlaylists(enabled, deviceId);
  const playlistTracks = useRekordboxPlaylistTracks(
    selectedId && !isCollection ? selectedId : null,
    deviceId,
  );
  const collectionTracks = useRekordboxCollection(
    enabled && isCollection,
    deviceId,
  );
  const tracksResp = isCollection ? collectionTracks : playlistTracks;
  const running = useRekordboxRunning(isLocal && enabled, 5000).data.running;

  const changeDevice = useCallback(
    (value: string) => {
      setSelectedId(""); // playlists differ per source — clear the selection
      setDevice(value === LOCAL_DEVICE ? "" : value);
    },
    [setDevice, setSelectedId],
  );

  const deviceMounted = !!device && devices.some((d) => d.id === device);

  // Auto-recover when the selected USB device disappears (unplugged/ejected):
  // fall back to the local install and drop the now-unplayable playlist.
  useEffect(() => {
    if (!device || !devicesState.loaded || deviceMounted) return;
    setDevice("");
    setSelectedId("");
    toast(`${device.split("/").pop() || "USB device"} disconnected`);
  }, [device, deviceMounted, devicesState.loaded, setDevice, setSelectedId]);

  const handleEject = useCallback(async () => {
    const label = devices.find((d) => d.id === device)?.label ?? "USB device";
    setEjecting(true);
    try {
      await api.ejectRekordboxUsb(device);
      setSelectedId("");
      setDevice("");
      devicesState.refetch();
      toast.success(`Ejected ${label}`);
    } catch (e) {
      toast.error(`Couldn't eject ${label}`, {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setEjecting(false);
    }
  }, [device, devices, devicesState, setDevice, setSelectedId]);

  // Only surface the picker when there's actually a USB export to switch to.
  const devicePicker =
    devices.length > 0 ? (
      <Select value={device || LOCAL_DEVICE} onValueChange={changeDevice}>
        <SelectTrigger size="sm" className="h-7 w-44 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LOCAL_DEVICE} className="text-xs">
            <HardDrive className="size-3.5" />
            Local install
          </SelectItem>
          {devices.map((d) => (
            <SelectItem key={d.id} value={d.id} className="text-xs">
              <Usb className="size-3.5" />
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  const topBarExtras =
    devicePicker || deviceMounted ? (
      <div className="flex items-center gap-1">
        {devicePicker}
        {deviceMounted && (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-7"
            onClick={handleEject}
            disabled={ejecting}
            title="Eject USB"
            aria-label="Eject USB"
          >
            <Unplug className="size-3.5" />
          </Button>
        )}
      </div>
    ) : null;

  useTopBar({ title: <LibraryTitle>{topBarExtras}</LibraryTitle> });

  useReloadHandler(() => {
    refetchPlaylists();
    tracksResp.refetch();
  });
  const player = usePlayer();
  const { pitchEnabled, targetBpm } = player;

  const tree = useMemo(
    () =>
      buildTree(
        data.playlists,
        !error && (data.playlists.length > 0 || !loading),
      ),
    [data.playlists, error, loading],
  );
  const selectedPl = useMemo(
    () => data.playlists.find((p) => p.id === selectedId) ?? null,
    [data.playlists, selectedId],
  );

  // Filter schema is rebuilt whenever the loaded track set changes. URL-backed
  // filter state via useFilterState — same as filesystem/SC views.
  const schema = useMemo(
    () => buildRekordboxSchema({ tracks: tracksResp.data.tracks }),
    [tracksResp.data.tracks],
  );
  const {
    state: filterState,
    set: setFilter,
    clearAll,
  } = useFilterState(schema);

  const filteredTracks = useMemo(
    () => applyRekordboxFilters(tracksResp.data.tracks, filterState),
    [tracksResp.data.tracks, filterState],
  );

  // Display-only sort; not persisted, and never written to the playlist.
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const displayTracks = useMemo(
    () =>
      sortBy ? sortTracks(filteredTracks, sortBy, sortOrder) : filteredTracks,
    [filteredTracks, sortBy, sortOrder],
  );

  function handleSort(key: string) {
    if (key !== sortBy) {
      setSortBy(key);
      setSortOrder("asc");
    } else if (sortOrder === "asc") {
      setSortOrder("desc");
    } else {
      setSortBy(null);
      setSortOrder("asc");
    }
  }

  const columnPrefs = useColumnPrefs(
    "library.rekordbox",
    REKORDBOX_COLUMN_DEFS,
  );
  const waveformColumn = useLeadColumnWidth(
    WAVEFORM_COLUMN_ID,
    WAVEFORM_DEFAULT_WIDTH,
    columnPrefs.prefs.widths,
    columnPrefs.setWidth,
    columnPrefs.resetWidth,
  );
  const rowDensity = ROW_DENSITY_STYLES[useRowDensity()];

  // Row selection, scoping the SoundCloud playlist export. Keyed by playlist
  // entry, so each copy of a track repeated in a playlist selects on its own.
  const [selection, setSelection] = useState<{
    ids: Set<string>;
    /** Last-clicked row index — the shift-select range anchor. */
    anchor: number | null;
  }>({ ids: new Set(), anchor: null });
  const selectedIds = selection.ids;
  // Reset selection when switching playlists — adjust-during-render instead
  // of an effect so the cleared state never paints.
  const [prevPlaylistId, setPrevPlaylistId] = useState(selectedId);
  if (prevPlaylistId !== selectedId) {
    setPrevPlaylistId(selectedId);
    setSelection({ ids: new Set(), anchor: null });
  }

  // Export the selection, or the whole filtered playlist when nothing is
  // selected. Tracks without a SoundCloud id can't be added and are skipped.
  const soundcloudTracks = useMemo(() => {
    const source =
      selectedIds.size > 0
        ? filteredTracks.filter((t) => selectedIds.has(rowKey(t)))
        : filteredTracks;
    const seen = new Set<number>();
    const out: SCTrack[] = [];
    for (const t of source) {
      if (t.soundcloud_id == null || seen.has(t.soundcloud_id)) continue;
      seen.add(t.soundcloud_id);
      out.push({
        urn: `soundcloud:tracks:${t.soundcloud_id}`,
        duration: (t.duration_seconds ?? 0) * 1000,
      } as SCTrack);
    }
    return out;
  }, [filteredTracks, selectedIds]);

  const toggleSelect = useCallback(
    (index: number, shiftKey: boolean) => {
      setSelection((prev) => {
        const ids = new Set(prev.ids);
        if (shiftKey && prev.anchor != null) {
          const [a, b] =
            prev.anchor < index ? [prev.anchor, index] : [index, prev.anchor];
          for (let i = a; i <= b; i++) {
            const t = displayTracks[i];
            if (t) ids.add(rowKey(t));
          }
        } else {
          const t = displayTracks[index];
          const id = t && rowKey(t);
          if (id) {
            if (ids.has(id)) ids.delete(id);
            else ids.add(id);
          }
        }
        return { ids, anchor: index };
      });
    },
    [displayTracks],
  );

  const handleStartPlay = useCallback(
    (index: number, startRatio?: number) => {
      const queue = displayTracks
        .map((t) => rekordboxPlayerTrack(t, device))
        .filter((t): t is PlayerTrack => t !== null);
      if (queue.length === 0) return;
      // Map the table index back to the queue (skips entries without a file).
      const playableIdx =
        displayTracks.slice(0, index + 1).filter((t) => t.file_path).length - 1;
      if (playableIdx < 0) return;
      player.playQueue(queue, playableIdx, startRatio);
    },
    [displayTracks, player, device],
  );

  // Only regular playlists of the local install can be edited; USB exports
  // are read-only, smart playlists are defined by their rules.
  const isEditable = (pl: RekordboxPlaylist | null): pl is RekordboxPlaylist =>
    isLocal && !!pl && !pl.is_folder && !pl.is_smart;
  const editable = isEditable(selectedPl);
  const allTracks = tracksResp.data.tracks;
  // Positions are only meaningful on the unfiltered, unsorted list.
  const reorderable =
    editable &&
    !sortBy &&
    filteredTracks.length === allTracks.length &&
    allTracks.every((t) => t.entry_id);
  const matchingTracks = useMatchingTracks();
  // Latest adder, so the registered playlist only changes with its tracks.
  const addToCurrentRef = useRef<(tracks: RekordboxTrack[]) => void>(() => {});
  useEffect(() => {
    addToCurrentRef.current = (tracks) => {
      if (selectedPl) void handleAddToPlaylist(selectedPl, tracks, true);
    };
  });
  const matchingPlaylist = useMemo(
    () =>
      selectedPl
        ? {
            id: selectedPl.id,
            name: selectedPl.name,
            device: deviceId,
            tracks: allTracks,
            onAdd: editable
              ? (tracks: RekordboxTrack[]) => addToCurrentRef.current(tracks)
              : undefined,
          }
        : null,
    [selectedPl, deviceId, allTracks, editable],
  );
  useMatchingTracksPlaylist(matchingPlaylist);

  const addTargets = data.playlists
    .filter((pl) => isEditable(pl) && pl.id !== selectedId)
    .sort((a, b) => a.name.localeCompare(b.name));

  /** The tracks a row action applies to: the selection when the row is part
   *  of it, otherwise just the row. */
  const rowTargets = (t: RekordboxTrack) =>
    selectedIds.has(rowKey(t))
      ? filteredTracks.filter((x) => selectedIds.has(rowKey(x)))
      : [t];

  const editFailed = (e: unknown) =>
    toast.error("Couldn't save playlist", {
      description: e instanceof Error ? e.message : undefined,
    });

  async function handleAddToPlaylist(
    playlist: RekordboxPlaylist,
    tracks: RekordboxTrack[],
    isOpenPlaylist = false,
  ) {
    const trackIds = [...new Set(tracks.map((t) => t.id))];
    try {
      const result = await addRekordboxPlaylistTracks(playlist.id, trackIds);
      if (isOpenPlaylist) tracksResp.setData(result);
    } catch (e) {
      editFailed(e);
      return;
    }
    refetchPlaylists();
    toast.success(
      `Added ${trackIds.length === 1 ? "1 track" : `${trackIds.length} tracks`} to ${playlist.name}`,
    );
  }

  async function handleRemove(tracks: RekordboxTrack[]) {
    const playlistId = selectedId;
    const before = tracksResp.data.tracks;
    const entryIds = tracks
      .map((t) => t.entry_id)
      .filter((id): id is string => !!id);
    try {
      tracksResp.setData(
        await removeRekordboxPlaylistEntries(playlistId, entryIds),
      );
    } catch (e) {
      editFailed(e);
      return;
    }
    setSelection({ ids: new Set(), anchor: null });
    refetchPlaylists();
    toast.success(
      `Removed ${entryIds.length === 1 ? "1 track" : `${entryIds.length} tracks`}`,
      {
        action: {
          label: "Undo",
          onClick: () =>
            void handleUndoRemove(playlistId, before, new Set(entryIds)),
        },
      },
    );
  }

  /** Re-adds removed entries (they come back with new entry ids, appended),
   *  then restores the order from before the removal. */
  async function handleUndoRemove(
    playlistId: string,
    before: RekordboxTrack[],
    removedIds: Set<string>,
  ) {
    const restored = before.filter(
      (t) => t.entry_id && removedIds.has(t.entry_id),
    );
    try {
      const { tracks } = await addRekordboxPlaylistTracks(
        playlistId,
        restored.map((t) => t.id),
      );
      const newIds = tracks.slice(-restored.length).map((t) => t.entry_id);
      const replacement = new Map(
        restored.map((t, i) => [t.entry_id, newIds[i]]),
      );
      await reorderRekordboxPlaylist(
        playlistId,
        before.map(
          (t) => (replacement.get(t.entry_id) ?? t.entry_id) as string,
        ),
      );
    } catch (e) {
      editFailed(e);
    }
    tracksResp.refetch();
    refetchPlaylists();
  }

  function handlePlaylistCreated(playlist: RekordboxPlaylist) {
    setPlaylistsData({ playlists: [...data.playlists, playlist] });
    refetchPlaylists();
    if (!playlist.is_folder) setSelectedId(playlist.id);
  }

  function handlePlaylistRenamed(playlist: RekordboxPlaylist) {
    setPlaylistsData({
      playlists: data.playlists.map((p) =>
        p.id === playlist.id ? { ...p, name: playlist.name } : p,
      ),
    });
    refetchPlaylists();
  }

  function handlePlaylistDeleted(playlistId: string) {
    // Leave the open playlist if it was deleted, or inside a deleted folder.
    const byId = new Map(data.playlists.map((p) => [p.id, p]));
    for (let p = byId.get(selectedId); p; p = byId.get(p.parent_id ?? "")) {
      if (p.id === playlistId) {
        setSelectedId("");
        break;
      }
    }
    refetchPlaylists();
  }

  /** Puts `tracks` at `target` in the open playlist. A track already in it is
   *  moved (its first entry), anything else is added. */
  async function handleInsert(tracks: RekordboxTrack[], target: InsertTarget) {
    const playlistId = selectedId;
    const before = tracksResp.data.tracks;
    const toAdd = tracks.filter((t) => !before.some((b) => b.id === t.id));
    try {
      const list = toAdd.length
        ? (
            await addRekordboxPlaylistTracks(
              playlistId,
              toAdd.map((t) => t.id),
            )
          ).tracks
        : before;
      const added = list.slice(list.length - toAdd.length);
      const moving = tracks
        .map(
          (t) =>
            (toAdd.includes(t)
              ? added.find((a) => a.id === t.id)
              : list.find((l) => l.id === t.id)
            )?.entry_id,
        )
        .filter((id): id is string => !!id);
      const ids = list.map((t) => t.entry_id as string);
      const order = placeEntries(ids, moving, target);
      tracksResp.setData(
        order && order.some((id, i) => id !== ids[i])
          ? await reorderRekordboxPlaylist(playlistId, order)
          : { tracks: list },
      );
    } catch (e) {
      editFailed(e);
      tracksResp.refetch();
      return;
    }
    refetchPlaylists();
    if (toAdd.length > 0)
      toast.success(
        `Added ${toAdd.length === 1 ? "1 track" : `${toAdd.length} tracks`} to ${selectedPl?.name ?? "playlist"}`,
      );
  }

  /** Moves dragged rows (the selection when the dragged row is part of it)
   *  to `target`, keeping their order. */
  async function handleMove(entryIds: string[], target: InsertTarget) {
    const previous = tracksResp.data;
    const ids = previous.tracks.map((t) => t.entry_id as string);
    const order = placeEntries(ids, entryIds, target);
    if (!order || order.every((id, i) => id === ids[i])) return;
    const byId = new Map(previous.tracks.map((t) => [t.entry_id, t]));
    tracksResp.setData({ tracks: order.map((id) => byId.get(id)!) });
    try {
      tracksResp.setData(await reorderRekordboxPlaylist(selectedId, order));
    } catch (e) {
      tracksResp.setData(previous);
      editFailed(e);
    }
  }

  // Cell contents only — wrapping div owns width + truncation so a resize
  // immediately reflows the text. Inner styling stays minimal (color/weight).
  const renderCell = useCallback(
    (col: ResolvedColumn, t: RekordboxTrack, isCurrent: boolean) => {
      switch (col.id) {
        case "title":
          return (
            <span className={cn("font-medium", isCurrent && "text-primary")}>
              {t.title || "—"}
            </span>
          );
        case "artist":
          return (
            <span className="text-muted-foreground">{t.artist ?? "—"}</span>
          );
        case "genre":
          return (
            <span className="text-muted-foreground">{t.genre ?? "—"}</span>
          );
        case "bpm":
          return (
            <span className="text-muted-foreground">
              {t.bpm?.toFixed(1) ?? "—"}
            </span>
          );
        case "key":
          return (
            <KeyCell
              keyValue={t.key}
              bpm={t.bpm}
              pitchEnabled={pitchEnabled}
              targetBpm={targetBpm}
            />
          );
        case "duration":
          return (
            <span className="text-muted-foreground">
              {formatDuration(t.duration_seconds)}
            </span>
          );
        case "date_added":
          return (
            <span className="text-muted-foreground">
              {formatDate(t.date_added)}
            </span>
          );
        case "release_date":
          return (
            <span className="text-muted-foreground">
              {formatDate(t.release_date)}
            </span>
          );
        case "soundcloud_id":
          return (
            <span className="text-muted-foreground">
              {t.soundcloud_id ?? "—"}
            </span>
          );
        default:
          return null;
      }
    },
    [pitchEnabled, targetBpm],
  );

  const viewName = isCollection ? "Collection" : selectedPl?.name;

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
        <RekordboxLogo className="text-muted-foreground size-8" />
        <p className="text-foreground text-sm font-medium">
          {device
            ? "Couldn't read this USB export"
            : "Rekordbox isn't available"}
        </p>
        <p className="text-muted-foreground max-w-sm text-sm">
          {status.data.reason ??
            (device
              ? "Could not open the export database on this device."
              : "Could not open the Rekordbox master database on this machine.")}
        </p>
      </div>
    );
  }

  function handleSelectNode(nodeId: string) {
    if (nodeId === ROOT_NODE_ID) return;
    if (nodeId === COLLECTION_ID) {
      setSelectedId(nodeId);
      return;
    }
    const pl = data.playlists.find((p) => p.id === nodeId);
    if (!pl || pl.is_folder) return;
    setSelectedId(nodeId);
  }

  return (
    <RekordboxPlaylistDndProvider
      onAdd={handleAddToPlaylist}
      onMove={handleMove}
      onInsert={handleInsert}
    >
      <MatchingTracksSheetOutlet />
      <div className="flex min-h-0 flex-1">
        <TreeView<RbTreeNode>
          tree={tree}
          selectedId={selectedId || ""}
          onSelect={handleSelectNode}
          hideRoot
          storageKey="rekordbox-tree"
          width={{ storageKey: "rekordbox-tree-width" }}
          renderIcon={(node) => {
            if (node.id === COLLECTION_ID)
              return <Library className="size-3.5 shrink-0" />;
            if (node.pl?.is_folder)
              return <Folder className="size-3.5 shrink-0" />;
            if (node.pl?.is_smart)
              return <Sparkles className="text-primary size-3.5 shrink-0" />;
            return <RekordboxLogo className="size-3.5 shrink-0" />;
          }}
          wrapNode={(node, row) => {
            if (!isLocal) return row;
            const withMenu = (
              <RekordboxPlaylistMenu
                playlist={node.pl}
                onCreated={handlePlaylistCreated}
                onRenamed={handlePlaylistRenamed}
                onDeleted={handlePlaylistDeleted}
              >
                {row}
              </RekordboxPlaylistMenu>
            );
            return isEditable(node.pl) && node.pl.id !== selectedId ? (
              <RekordboxPlaylistDropTarget playlist={node.pl}>
                {withMenu}
              </RekordboxPlaylistDropTarget>
            ) : (
              withMenu
            );
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
          {running && (
            <div
              data-testid="rekordbox-running-notice"
              className="border-border flex items-center gap-2 border-b bg-[var(--surface-2)] px-3 py-1.5 text-xs text-[var(--text-muted)]"
            >
              <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning)]" />
              Rekordbox is open. Close it to save playlist changes.
            </div>
          )}
          {!viewName ? (
            <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
              Pick a playlist to view its tracks
            </div>
          ) : tracksResp.loading && tracksResp.data.tracks.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <LogoSpinner className="size-10" />
              {(isCollection || selectedPl?.is_smart) && (
                <p className="text-muted-foreground text-xs">
                  {isCollection
                    ? "Loading collection…"
                    : "Evaluating smart playlist…"}
                </p>
              )}
            </div>
          ) : tracksResp.error ? (
            <p className="text-destructive p-4 text-sm">{tracksResp.error}</p>
          ) : tracksResp.data.tracks.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">
              {isCollection
                ? "Your collection is empty"
                : "This playlist is empty"}
            </p>
          ) : (
            <div
              className="flex min-h-0 flex-1 flex-col"
              data-testid="rekordbox-tracks"
            >
              <FiltersToolbar
                schema={schema}
                state={filterState}
                onChange={setFilter}
                onClearAll={clearAll}
                filtered={filteredTracks.length}
                total={tracksResp.data.tracks.length}
                actions={
                  <>
                    <CreatePlaylistDialog
                      tracks={soundcloudTracks}
                      defaultTitle={viewName}
                      trigger={
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground h-7 gap-1.5 text-xs"
                          disabled={soundcloudTracks.length === 0}
                          title={
                            soundcloudTracks.length === 0
                              ? "No tracks with a SoundCloud id"
                              : undefined
                          }
                        >
                          <ListPlus className="size-3.5" />
                          SoundCloud playlist ({soundcloudTracks.length})
                        </Button>
                      }
                    />
                    <ColumnVisibilityMenu
                      columns={REKORDBOX_COLUMN_DEFS}
                      isVisible={columnPrefs.isVisible}
                      setHidden={columnPrefs.setHidden}
                      onResetVisibility={columnPrefs.resetVisibility}
                      onResetOrder={columnPrefs.resetOrder}
                      onResetWidths={columnPrefs.resetWidths}
                      className="text-muted-foreground h-7 gap-1.5 text-xs"
                    />
                  </>
                }
              />

              <RekordboxTableDropTarget disabled={!editable}>
                <TrackTable<RekordboxTrack>
                  items={displayTracks}
                  columns={REKORDBOX_COLUMNS}
                  estimateRowSize={rowDensity.height}
                  // A playlist can hold the same track more than once, so rows key
                  // by entry; elsewhere the index keeps repeated tracks unique.
                  getItemKey={(index, item) =>
                    item?.entry_id ?? `${index}-${item?.id ?? ""}`
                  }
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={handleSort}
                  columnOrder={columnPrefs.prefs.order}
                  onColumnOrderChange={columnPrefs.setOrder}
                  columnWidths={columnPrefs.prefs.widths}
                  onColumnWidthChange={columnPrefs.setWidth}
                  onColumnWidthReset={columnPrefs.resetWidth}
                  isColumnVisible={columnPrefs.isVisible}
                  renderHeaderLead={() => (
                    <>
                      <div className="flex w-6 shrink-0 items-center justify-center">
                        <Checkbox
                          checked={
                            filteredTracks.length > 0 &&
                            filteredTracks.every((t) =>
                              selectedIds.has(rowKey(t)),
                            )
                              ? true
                              : filteredTracks.some((t) =>
                                    selectedIds.has(rowKey(t)),
                                  )
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={(checked) =>
                            setSelection({
                              ids: checked
                                ? new Set(filteredTracks.map(rowKey))
                                : new Set(),
                              anchor: null,
                            })
                          }
                          aria-label="Select all"
                          className="size-3.5 cursor-pointer"
                        />
                      </div>
                      <div
                        className={cn("shrink-0", rowDensity.spacer)}
                        aria-hidden
                      />
                      <ResizableHeaderCell {...waveformColumn} />
                    </>
                  )}
                  renderRow={({ item, index, visibleColumns }) => {
                    if (!item) return null;
                    const t = item;
                    const playable = !!t.file_path;
                    const isCurrent =
                      player.activeTrack?.filePath === t.file_path && playable;
                    const isSelected = selectedIds.has(rowKey(t));
                    const targets = rowTargets(t);
                    const count = targets.length;
                    const renderRowBody = (
                      dragListeners?: React.DOMAttributes<HTMLDivElement>,
                      isDragging = false,
                    ) => (
                      // Clicking anywhere on the row starts playback; the cover's
                      // play button is the keyboard/AT-accessible control, so the
                      // row stays a plain div (no nested-button ARIA).
                      <TrackQueueMenu
                        disabled={!playable}
                        onPlayNext={() => {
                          const pt = rekordboxPlayerTrack(t, device);
                          if (pt) player.playNext(pt);
                        }}
                        onAddToQueue={() => {
                          const pt = rekordboxPlayerTrack(t, device);
                          if (pt) player.enqueue(pt);
                        }}
                        extraItems={
                          <>
                            <ContextMenuItem
                              data-testid="rekordbox-matching-tracks"
                              className="text-xs"
                              onSelect={() =>
                                matchingTracks.openFor({
                                  track: t,
                                  device: deviceId,
                                })
                              }
                            >
                              <Blend className="size-3.5" />
                              Show matching tracks
                            </ContextMenuItem>
                            {isLocal && (
                              <>
                                <ContextMenuSub>
                                  <ContextMenuSubTrigger
                                    data-testid="rekordbox-add-to-playlist"
                                    className="gap-2 text-xs"
                                  >
                                    <ListMusic className="size-3.5" />
                                    {count > 1
                                      ? `Add to playlist (${count})`
                                      : "Add to playlist"}
                                  </ContextMenuSubTrigger>
                                  <ContextMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                                    {addTargets.length === 0 ? (
                                      <ContextMenuItem
                                        disabled
                                        className="text-xs"
                                      >
                                        No other playlists
                                      </ContextMenuItem>
                                    ) : (
                                      addTargets.map((pl) => (
                                        <ContextMenuItem
                                          key={pl.id}
                                          className="text-xs"
                                          onSelect={() =>
                                            handleAddToPlaylist(pl, targets)
                                          }
                                        >
                                          {pl.name}
                                        </ContextMenuItem>
                                      ))
                                    )}
                                  </ContextMenuSubContent>
                                </ContextMenuSub>
                                {editable && (
                                  <ContextMenuItem
                                    data-testid="rekordbox-remove-from-playlist"
                                    className="text-xs"
                                    onSelect={() => handleRemove(targets)}
                                  >
                                    <Trash2 className="size-3.5" />
                                    {count > 1
                                      ? `Remove from playlist (${count})`
                                      : "Remove from playlist"}
                                  </ContextMenuItem>
                                )}
                              </>
                            )}
                          </>
                        }
                      >
                        <div
                          {...dragListeners}
                          onClick={() => playable && handleStartPlay(index)}
                          title={
                            playable
                              ? undefined
                              : "Missing local file — not playable from Rekordbox"
                          }
                          className={cn(
                            "group border-border flex items-center gap-1.5 border-b pr-0 pl-3 text-xs transition-colors select-none",
                            rowDensity.row,
                            playable
                              ? "cursor-pointer hover:bg-[var(--surface-3)]"
                              : "text-muted-foreground/60 cursor-default",
                            isCurrent && "bg-[var(--brand-soft)]",
                            isSelected && !isCurrent && "bg-[var(--surface-3)]",
                            isDragging && "opacity-40",
                          )}
                        >
                          <div
                            className="flex w-6 shrink-0 cursor-pointer items-center justify-center self-stretch"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSelect(index, e.shiftKey);
                            }}
                          >
                            <Checkbox
                              checked={isSelected}
                              tabIndex={-1}
                              className="pointer-events-none size-3.5"
                            />
                          </div>
                          <CoverPlayButton
                            artworkUrl={
                              t.has_artwork
                                ? api.getRekordboxArtworkUrl(
                                    t.id,
                                    true,
                                    deviceId ?? undefined,
                                  )
                                : null
                            }
                            isCurrent={isCurrent}
                            onStartPlay={
                              playable
                                ? () => handleStartPlay(index)
                                : undefined
                            }
                            label={t.title}
                            className={rowDensity.cover}
                          />
                          <div
                            className="flex h-full shrink-0 items-center"
                            style={{ width: waveformColumn.width }}
                          >
                            {t.has_waveform ? (
                              <RekordboxWaveform
                                trackId={t.id}
                                device={deviceId ?? undefined}
                                track={
                                  playable
                                    ? rekordboxPlayerTrack(t, device)
                                    : null
                                }
                                onStartPlay={
                                  playable
                                    ? (startRatio) =>
                                        handleStartPlay(index, startRatio)
                                    : undefined
                                }
                                width={waveformColumn.width}
                                height={20}
                              />
                            ) : null}
                          </div>
                          {visibleColumns.map((col) => (
                            <div
                              key={col.id}
                              // truncate lives on the same element as the explicit
                              // width so resizes reflow the ellipsis immediately —
                              // an inner span with `truncate` doesn't always pick
                              // up the new available width on a numeric style
                              // change.
                              className={cn(
                                "min-w-0 shrink-0 truncate",
                                col.className,
                              )}
                              style={{ width: col.width }}
                            >
                              {renderCell(col, t, isCurrent)}
                            </div>
                          ))}
                        </div>
                      </TrackQueueMenu>
                    );
                    if (!isLocal) return renderRowBody();
                    return (
                      <DraggableRekordboxRow
                        id={`rekordbox-row:${t.entry_id ?? index}`}
                        entryId={reorderable ? t.entry_id : null}
                        data={{ tracks: targets }}
                      >
                        {({ listeners, isDragging }) =>
                          renderRowBody(listeners, isDragging)
                        }
                      </DraggableRekordboxRow>
                    );
                  }}
                />
              </RekordboxTableDropTarget>
            </div>
          )}
        </div>
      </div>
    </RekordboxPlaylistDndProvider>
  );
}
