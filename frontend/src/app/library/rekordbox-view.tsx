"use client";

import { Folder, HardDrive, Sparkles, Usb } from "lucide-react";
import { useQueryState } from "nuqs";
import { useCallback, useMemo, useState } from "react";

import { ColumnVisibilityMenu } from "@/components/columns/column-visibility-menu";
import { CoverPlayButton } from "@/components/cover-play-button";
import { FiltersToolbar } from "@/components/filters/filters-toolbar";
import { RekordboxLogo } from "@/components/icons/rekordbox-logo";
import {
  useReloadHandler,
  useTopBar,
} from "@/components/layout/top-bar-context";
import { LogoSpinner } from "@/components/logo-spinner";
import { RekordboxWaveform } from "@/components/rekordbox-waveform";
import {
  TrackTable,
  type ResolvedColumn,
  type TrackTableColumn,
} from "@/components/track-table/track-table";
import { TreeView } from "@/components/tree/tree-view";
import type { TreeNodeShape } from "@/components/tree/types";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { semitonesFromBpmRatio, transposeCamelot } from "@/lib/camelot";
import type { ColumnDef } from "@/lib/columns/types";
import { useColumnPrefs } from "@/lib/columns/use-column-prefs";
import {
  applyRekordboxFilters,
  buildRekordboxSchema,
} from "@/lib/filters/rekordbox-adapter";
import { useFilterState } from "@/lib/filters/use-filter-state";
import { usePlayer, type PlayerTrack } from "@/lib/player-context";
import { cn } from "@/lib/utils";

import { LibraryTitle } from "./library-title";
import {
  useRekordboxDevices,
  useRekordboxPlaylists,
  useRekordboxPlaylistTracks,
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

function buildTree(playlists: RekordboxPlaylist[]): RbTreeNode {
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
 * shows the transposed Camelot key in brand-green next to (or in place of)
 * the original. Falls back to the raw key for non-Camelot strings.
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
  const shouldShift = pitchEnabled && bpm != null && bpm > 0 && targetBpm > 0;
  const semitones = shouldShift ? semitonesFromBpmRatio(targetBpm / bpm) : 0;
  const shifted =
    semitones !== 0 ? transposeCamelot(keyValue, semitones) : null;

  if (!shifted)
    return <span className="text-muted-foreground">{keyValue}</span>;
  return (
    <span
      className="font-medium text-[var(--brand)]"
      title={`Pitched: ${keyValue} → ${shifted} (${semitones > 0 ? "+" : ""}${semitones} st)`}
    >
      {shifted}
    </span>
  );
}

function toPlayerTrack(t: RekordboxTrack, device: string): PlayerTrack | null {
  if (!t.file_path) return null;
  const usb = !!device;
  return {
    filePath: t.file_path,
    fileName: t.file_path.split("/").pop() ?? t.title,
    title: t.title,
    artist: t.artist ?? undefined,
    bpm: t.bpm ?? null,
    rekordboxId: t.has_waveform ? t.id : undefined,
    rekordboxDevice: usb ? device : undefined,
    // USB tracks live on the device, not under the local root — stream them
    // through the device-scoped audio endpoint instead of the local file path.
    streamUrl: usb ? api.getRekordboxUsbAudioUrl(t.id, device) : undefined,
  };
}

// Columns shared by the TrackTable header + body. Intentionally unsortable —
// Rekordbox playlist order is meaningful (especially for smart playlists +
// hand-curated sets), so we leave the order untouched and only allow filters.
const REKORDBOX_COLUMNS: TrackTableColumn[] = [
  { id: "title", header: "Title", required: true, defaultWidth: 256 },
  { id: "artist", header: "Artist", defaultWidth: 192 },
  { id: "genre", header: "Genre", defaultWidth: 112 },
  {
    id: "bpm",
    header: "BPM",
    defaultWidth: 56,
    className: "text-right tabular-nums",
  },
  { id: "key", header: "Key", defaultWidth: 56 },
  {
    id: "duration",
    header: "Length",
    defaultWidth: 72,
    className: "text-right tabular-nums",
  },
  {
    id: "date_added",
    header: "Added",
    defaultWidth: 96,
    className: "tabular-nums",
  },
  {
    id: "release_date",
    header: "Released",
    defaultWidth: 96,
    className: "tabular-nums",
  },
  { id: "soundcloud_id", header: "SoundCloud", defaultWidth: 96 },
];

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

  const devices = useRekordboxDevices().data.devices;
  const status = useRekordboxStatus(deviceId);
  const enabled = status.data.available;

  const {
    data,
    loading,
    error,
    refetch: refetchPlaylists,
  } = useRekordboxPlaylists(enabled, deviceId);
  const tracksResp = useRekordboxPlaylistTracks(selectedId || null, deviceId);

  const changeDevice = useCallback(
    (value: string) => {
      setSelectedId(""); // playlists differ per source — clear the selection
      setDevice(value === LOCAL_DEVICE ? "" : value);
    },
    [setDevice, setSelectedId],
  );

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

  useTopBar({ title: <LibraryTitle>{devicePicker}</LibraryTitle> });

  useReloadHandler(() => {
    refetchPlaylists();
    tracksResp.refetch();
  });
  const player = usePlayer();
  const { pitchEnabled, targetBpm } = player;

  const tree = useMemo(() => buildTree(data.playlists), [data.playlists]);
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

  const columnPrefs = useColumnPrefs(
    "library.rekordbox",
    REKORDBOX_COLUMN_DEFS,
  );

  // Row selection (no batch actions yet — kept for parity with the other
  // library views). Keyed by track id; duplicate playlist entries of the
  // same track select together.
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

  const toggleSelect = useCallback(
    (index: number, shiftKey: boolean) => {
      setSelection((prev) => {
        const ids = new Set(prev.ids);
        if (shiftKey && prev.anchor != null) {
          const [a, b] =
            prev.anchor < index ? [prev.anchor, index] : [index, prev.anchor];
          for (let i = a; i <= b; i++) {
            const id = filteredTracks[i]?.id;
            if (id) ids.add(id);
          }
        } else {
          const id = filteredTracks[index]?.id;
          if (id) {
            if (ids.has(id)) ids.delete(id);
            else ids.add(id);
          }
        }
        return { ids, anchor: index };
      });
    },
    [filteredTracks],
  );

  const handleStartPlay = useCallback(
    (index: number, startRatio?: number) => {
      const queue = filteredTracks
        .map((t) => toPlayerTrack(t, device))
        .filter((t): t is PlayerTrack => t !== null);
      if (queue.length === 0) return;
      // Map the table index back to the queue (skips entries without a file).
      const playableIdx =
        filteredTracks.slice(0, index + 1).filter((t) => t.file_path).length -
        1;
      if (playableIdx < 0) return;
      player.playQueue(queue, playableIdx, startRatio);
    },
    [filteredTracks, player, device],
  );

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
    const pl = data.playlists.find((p) => p.id === nodeId);
    if (!pl || pl.is_folder) return;
    setSelectedId(nodeId);
  }

  return (
    <div className="flex min-h-0 flex-1">
      <TreeView<RbTreeNode>
        tree={tree}
        selectedId={selectedId || ""}
        onSelect={handleSelectNode}
        hideRoot
        storageKey="rekordbox-tree"
        width={{ storageKey: "rekordbox-tree-width" }}
        renderIcon={(node) => {
          if (node.pl?.is_folder)
            return <Folder className="size-3.5 shrink-0" />;
          if (node.pl?.is_smart)
            return <Sparkles className="text-primary size-3.5 shrink-0" />;
          return <RekordboxLogo className="size-3.5 shrink-0" />;
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
        {!selectedId || !selectedPl ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Pick a playlist to view its tracks
          </div>
        ) : tracksResp.loading && tracksResp.data.tracks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <LogoSpinner className="size-10" />
            {selectedPl.is_smart && (
              <p className="text-muted-foreground text-xs">
                Evaluating smart playlist…
              </p>
            )}
          </div>
        ) : tracksResp.error ? (
          <p className="text-destructive p-4 text-sm">{tracksResp.error}</p>
        ) : tracksResp.data.tracks.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">
            This playlist is empty
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
                <ColumnVisibilityMenu
                  columns={REKORDBOX_COLUMN_DEFS}
                  isVisible={columnPrefs.isVisible}
                  setHidden={columnPrefs.setHidden}
                  onResetVisibility={columnPrefs.resetVisibility}
                  onResetOrder={columnPrefs.resetOrder}
                  onResetWidths={columnPrefs.resetWidths}
                  className="text-muted-foreground h-7 gap-1.5 text-xs"
                />
              }
            />

            <TrackTable<RekordboxTrack>
              items={filteredTracks}
              columns={REKORDBOX_COLUMNS}
              estimateRowSize={40}
              // Rekordbox playlists can intentionally contain the same track
              // at multiple positions, so include the index in the key to keep
              // it unique. Index alone is stable here because filters preserve
              // order and switching playlists remounts the table.
              getItemKey={(index, item) => `${index}-${item?.id ?? ""}`}
              sortBy={null}
              sortOrder="asc"
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
                        filteredTracks.every((t) => selectedIds.has(t.id))
                          ? true
                          : filteredTracks.some((t) => selectedIds.has(t.id))
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(checked) =>
                        setSelection({
                          ids: checked
                            ? new Set(filteredTracks.map((t) => t.id))
                            : new Set(),
                          anchor: null,
                        })
                      }
                      aria-label="Select all"
                      className="size-3.5 cursor-pointer"
                    />
                  </div>
                  <div className="size-7 shrink-0" aria-hidden />
                  <div className="h-8 w-24 shrink-0" aria-hidden />
                </>
              )}
              renderRow={({ item, index, visibleColumns }) => {
                if (!item) return null;
                const t = item;
                const playable = !!t.file_path;
                const isCurrent =
                  player.currentTrack?.filePath === t.file_path && playable;
                const isSelected = selectedIds.has(t.id);
                return (
                  // Clicking anywhere on the row starts playback; the cover's
                  // play button is the keyboard/AT-accessible control, so the
                  // row stays a plain div (no nested-button ARIA).
                  <div
                    onClick={() => playable && handleStartPlay(index)}
                    title={
                      playable
                        ? undefined
                        : "Missing local file — not playable from Rekordbox"
                    }
                    className={cn(
                      "group border-border flex h-10 items-center gap-1.5 border-b pr-0 pl-3 text-xs transition-colors select-none",
                      playable
                        ? "cursor-pointer hover:bg-[var(--surface-3)]"
                        : "text-muted-foreground/60 cursor-default",
                      isCurrent && "bg-[var(--brand-soft)]",
                      isSelected && !isCurrent && "bg-[var(--surface-3)]",
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
                        playable ? () => handleStartPlay(index) : undefined
                      }
                      label={t.title}
                    />
                    <div className="flex h-10 w-24 shrink-0 items-center">
                      {t.has_waveform ? (
                        <RekordboxWaveform
                          trackId={t.id}
                          device={deviceId ?? undefined}
                          track={playable ? toPlayerTrack(t, device) : null}
                          onStartPlay={
                            playable
                              ? (startRatio) =>
                                  handleStartPlay(index, startRatio)
                              : undefined
                          }
                          width={96}
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
                );
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
