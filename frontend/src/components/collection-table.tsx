"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Eraser,
  Music,
  PencilLine,
  Workflow,
} from "lucide-react";
import {
  parseAsArrayOf,
  parseAsInteger,
  parseAsString,
  useQueryState,
} from "nuqs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { serializeComment } from "@/app/library/utils";
import {
  SortableColumnHeader,
  SortableHeaderCell,
} from "@/components/columns/sortable-columns";
import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";
import { LogoSpinner } from "@/components/logo-spinner";
import { MiniWaveform } from "@/components/mini-waveform";
import { RulesetPreview } from "@/components/rulesets/ruleset-preview";
import { Spinner } from "@/components/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  api,
  type BatchUpdateItem,
  type BrowseParams,
  type FolderRulesetBinding,
  type RequiredAttribute,
  type Ruleset,
  type TrackBrowse,
  type TrackInfoUpdateRequest,
} from "@/lib/api";
import { usePlayer } from "@/lib/player-context";
import { searchParams } from "@/lib/search-params";
import { soundCloudSource } from "@/lib/sources/soundcloud";
import { parseRemix, removeMix } from "@/lib/string-utils";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const EDIT_ROW_HEIGHT = 40;

type SortBy = NonNullable<BrowseParams["sort_by"]>;
type SortOrder = "asc" | "desc";

type EditableField =
  | "title"
  | "artist"
  | "genre"
  | "bpm"
  | "key"
  | "release_date"
  | "remixer"
  | "original_artist"
  | "mix_name";

/** Field key universe for the column system. Editable keys map to track
 * metadata fields; "folder" + "soundcloud_linked" are read-only columns. */
type FieldKey = EditableField | "folder" | "soundcloud_linked";

/** Fields shown in the table — editable or read-only. Order here is the
 * default render order; user reorders persist via the column-prefs store.
 * Fixed widths so columns keep their shape when the left grid cell narrows
 * (e.g. editor panel open) — horizontal scroll handles overflow instead. */
const COLUMN_FIELDS: {
  key: FieldKey;
  label: string;
  defaultWidth: number;
  editable: boolean;
}[] = [
  { key: "folder", label: "Folder", defaultWidth: 96, editable: false },
  {
    key: "soundcloud_linked",
    label: "SC",
    defaultWidth: 36,
    editable: false,
  },
  { key: "title", label: "Title", defaultWidth: 256, editable: true },
  { key: "artist", label: "Artist", defaultWidth: 192, editable: true },
  { key: "genre", label: "Genre", defaultWidth: 112, editable: true },
  { key: "bpm", label: "BPM", defaultWidth: 56, editable: true },
  { key: "key", label: "Key", defaultWidth: 56, editable: true },
  { key: "remixer", label: "Remixer", defaultWidth: 128, editable: true },
  {
    key: "original_artist",
    label: "Orig. Artist",
    defaultWidth: 112,
    editable: true,
  },
  { key: "mix_name", label: "Mix", defaultWidth: 80, editable: true },
  { key: "release_date", label: "Release", defaultWidth: 96, editable: true },
];

type ResolvedField = (typeof COLUMN_FIELDS)[number] & { width: number };

export const FILESYSTEM_COLUMN_DEFS: import("@/lib/columns/types").ColumnDef[] =
  [
    { id: "folder", header: "Folder" },
    { id: "soundcloud_linked", header: "SoundCloud" },
    { id: "title", header: "Title", required: true },
    { id: "artist", header: "Artist" },
    { id: "genre", header: "Genre" },
    { id: "bpm", header: "BPM" },
    { id: "key", header: "Key" },
    { id: "remixer", header: "Remixer" },
    { id: "original_artist", header: "Orig. Artist" },
    { id: "mix_name", header: "Mix" },
    { id: "release_date", header: "Release" },
  ];

/** Fields not stored in the API — remix composition helpers (not remixer itself, which is a real field) */

interface CollectionTableProps {
  mode: string;
  /** When set, browse by absolute folder path (recursive) instead of mode. */
  folderPath?: string;
  scrollToFilePath?: string;
  selectedFilePath?: string;
  onSelect?: (item: TrackBrowse) => void;
  onTotalChange?: (total: number, cacheLoading: boolean) => void;
  onItemsChange?: (items: TrackBrowse[]) => void;
  refreshToken?: number;
  onEditSaved?: () => void;
  /** Ruleset bound via the tree / folder context. Used for batch actions,
   * toolbar display, and the sticky action column width. */
  activeRuleset?: Ruleset | null;
  /** All folder bindings and all rulesets — used to resolve the effective
   * ruleset per-track so the apply-rules button works across folders, not
   * only when the tree cursor is on the bound folder. */
  folderRulesets?: Record<string, FolderRulesetBinding>;
  rulesets?: Ruleset[];
  /** Shared pending field edits per file (keyed by file_path). Lifted to the
   * page so the single-track editor and the batch table stay in sync. */
  pendingFieldEdits: Map<string, Record<string, string>>;
  setPendingFieldEdits: React.Dispatch<
    React.SetStateAction<Map<string, Record<string, string>>>
  >;
  /** Per-column visibility. When omitted, every column renders. */
  isColumnVisible?: (id: string) => boolean;
  /** Column order by id. When omitted, defs' natural order is used. */
  columnOrder?: string[];
  /** Persist a new column order (called after a drag). */
  onColumnOrderChange?: (ids: string[]) => void;
  /** User-resized widths (px) by column id. Missing = use default. */
  columnWidths?: Record<string, number>;
  /** Persist a width on resize commit. */
  onColumnWidthChange?: (id: string, width: number) => void;
  /** Reset a single column's width to its default (double-click handle). */
  onColumnWidthReset?: (id: string) => void;
}

/** Sortable fields mapped to COLUMN_FIELDS keys where applicable */
const SORTABLE_FIELDS: Partial<Record<FieldKey, SortBy>> = {
  folder: "folder",
  title: "title",
  artist: "artist",
  genre: "genre",
  bpm: "bpm",
  key: "key",
  release_date: "release_date",
};

function getMissingAttributes(
  item: TrackBrowse,
  required: RequiredAttribute[],
): RequiredAttribute[] {
  return required.filter((attr) => {
    if (attr === "artwork") return !item.has_artwork;
    const val = item[attr as keyof TrackBrowse];
    if (Array.isArray(val)) return val.length === 0;
    return val == null || val === "";
  });
}

function canApplyRulesToItem(
  item: TrackBrowse,
  required: RequiredAttribute[],
): boolean {
  return getMissingAttributes(item, required).length === 0;
}

/** Resolve the effective ruleset for a track based on the folder it lives in.
 * Walks the track's parent folders checking direct bindings and recursive
 * ancestor bindings — independent of whatever folder is selected in the tree. */
function resolveRulesetForFile(
  filePath: string,
  folderRulesets: Record<string, FolderRulesetBinding> | undefined,
  rulesets: Ruleset[] | undefined,
): Ruleset | null {
  if (!folderRulesets || !rulesets) return null;
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const parentPath = filePath.slice(0, lastSlash);
  const own = folderRulesets[parentPath];
  if (own) return rulesets.find((r) => r.id === own.ruleset_id) ?? null;
  const parts = parentPath.replace(/\/+$/, "").split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join("/") || "/";
    const b = folderRulesets[ancestor];
    if (b && b.recursive) {
      return rulesets.find((r) => r.id === b.ruleset_id) ?? null;
    }
  }
  return null;
}

function RulesetBadge({ ruleset }: { ruleset: Ruleset }) {
  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="border-primary/30 bg-primary/10 text-primary inline-flex cursor-default items-center gap-1 rounded border px-1.5 py-0.5 align-middle text-xs font-medium">
            <Workflow className="size-3" />
            {ruleset.name}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          sideOffset={6}
          showArrow={false}
          className="bg-popover text-popover-foreground max-w-64 border p-0"
        >
          <RulesetPreview ruleset={ruleset} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SortIcon({
  col,
  sortBy,
  sortOrder,
}: {
  col: SortBy;
  sortBy: SortBy;
  sortOrder: SortOrder;
}) {
  if (col !== sortBy) return <ChevronsUpDown className="size-3 opacity-30" />;
  return sortOrder === "asc" ? (
    <ChevronUp className="text-primary size-3" />
  ) : (
    <ChevronDown className="text-primary size-3" />
  );
}

/** Cell that displays as plain text. Click on a non-current row activates
 * it; click again (now that the row is current) enters edit mode. Enter/blur
 * commit; Escape reverts. */
function EditableCell({
  value,
  onCommit,
  onActivate,
  isCurrent,
  placeholder,
  isChanged,
  width,
}: {
  value: string;
  onCommit: (next: string) => void;
  onActivate: () => void;
  isCurrent: boolean;
  placeholder: string;
  isChanged: boolean;
  width: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <div
      className="min-w-0 shrink-0"
      style={{ width }}
      data-row-noselect
      onClick={() => {
        if (editing) return;
        if (isCurrent) {
          setDraft(value);
          setEditing(true);
        } else {
          onActivate();
        }
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            if (draft !== value) onCommit(draft);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          placeholder={placeholder}
          data-row-noselect
          className={`placeholder:text-text-subtle border-ring ring-ring/50 h-7 w-full rounded border bg-transparent px-1.5 text-xs ring-1 outline-none`}
        />
      ) : (
        <span
          title={value || placeholder}
          className={cn(
            "block h-7 truncate rounded border px-1.5 py-1 text-xs leading-5",
            isChanged
              ? "border-warning/70 bg-warning/5"
              : "group-hover/row:border-border border-transparent",
            !value && "text-text-subtle",
          )}
        >
          {value || placeholder}
        </span>
      )}
    </div>
  );
}

/* ─── Row ─── */

interface EditRowProps {
  item: TrackBrowse;
  isSelected: boolean;
  isCurrent: boolean;
  changes: Partial<Record<EditableField, string>>;
  hasChanges: boolean;
  onToggleSelect: (shiftKey: boolean) => void;
  onFieldChange: (field: EditableField, value: string) => void;
  onSelect: () => void;
  onStartPlay: () => void;
  justSaved: boolean;
  pendingArtworkB64?: string;
  /** True if track has a SoundCloud link (saved or pending). */
  isScLinked?: boolean;
  /** When set, show a Folder column with the path relative to this root. */
  folderPath?: string;
  /** Column defs filtered to only visible ones, in render order, with resolved widths. */
  visibleFields: ResolvedField[];
}

function EditRow({
  item,
  isSelected,
  isCurrent,
  changes,
  onToggleSelect,
  onFieldChange,
  onSelect,
  onStartPlay,
  justSaved,
  pendingArtworkB64,
  isScLinked,
  folderPath,
  visibleFields,
}: EditRowProps) {
  const artworkUrl = item.has_artwork
    ? api.getArtworkUrl(item.file_path)
    : pendingArtworkB64
      ? `data:image/jpeg;base64,${pendingArtworkB64}`
      : null;

  const getValue = (field: EditableField): string => {
    if (field in changes) return changes[field] ?? "";
    const val = item[field as keyof TrackBrowse];
    if (val == null) return "";
    if (Array.isArray(val)) return val.join(", ");
    return String(val);
  };

  const isChanged = (field: EditableField): boolean => field in changes;

  return (
    <div
      role="row"
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "group/row border-border relative flex h-10 cursor-pointer items-center gap-1.5 border-b pr-0 pl-3 transition-colors",
        isCurrent && "bg-[var(--brand-soft)]",
        isSelected && !isCurrent && "bg-[var(--surface-3)]",
        !isCurrent && !isSelected && "hover:bg-[var(--surface-3)]",
        justSaved && "saved-pulse",
      )}
      onClick={(e) => {
        // Row click only opens the single-track editor / player.
        // Multi-select is exclusively driven by the checkbox column.
        const t = e.target as HTMLElement;
        if (
          t.closest(
            'input, textarea, button, [role="menuitem"], [role="menuitemcheckbox"], [data-row-noselect]',
          )
        ) {
          return;
        }
        onSelect();
      }}
    >
      {isCurrent && (
        <span
          aria-hidden
          className="bg-primary absolute inset-y-0 left-0 w-0.5"
        />
      )}
      {/* Checkbox */}
      <div
        className="flex w-6 shrink-0 cursor-pointer items-center justify-center self-stretch"
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(e.shiftKey);
        }}
      >
        <Checkbox
          checked={isSelected}
          tabIndex={-1}
          className="cursor-pointer"
        />
      </div>

      {/* Artwork thumbnail */}
      <div
        className={`bg-muted flex size-7 shrink-0 items-center justify-center overflow-hidden rounded ring-1 ${pendingArtworkB64 ? "ring-primary/40" : "ring-transparent"}`}
      >
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            className="size-7 object-cover"
            loading="lazy"
          />
        ) : (
          <Music className="text-muted-foreground size-3" />
        )}
      </div>

      {/* Mini waveform (top-half) */}
      <div className="h-6 w-20 shrink-0">
        <MiniWaveform
          track={{
            filePath: item.file_path,
            fileName: item.file_name,
            title: item.title ?? undefined,
            artist: Array.isArray(item.artist)
              ? item.artist.join(", ")
              : (item.artist ?? undefined),
          }}
          halfHeight
          onStartPlay={onStartPlay}
        />
      </div>

      {/* Column cells — order driven by visibleFields (user-reorderable). */}
      {visibleFields.map((f) => {
        if (f.key === "folder") {
          return (
            <span
              key={f.key}
              className="text-muted-foreground min-w-0 shrink-0 truncate text-xs"
              style={{ width: f.width }}
              title={item.folder ?? ""}
            >
              {item.folder && folderPath
                ? item.folder.startsWith(folderPath)
                  ? item.folder.slice(folderPath.length + 1) || "."
                  : item.folder
                : "—"}
            </span>
          );
        }
        if (f.key === "soundcloud_linked") {
          return (
            <div
              key={f.key}
              className="flex shrink-0 items-center justify-center"
              style={{ width: f.width }}
              title={isScLinked ? "Linked to SoundCloud" : "Not linked"}
            >
              <SoundCloudLogo
                className={cn(
                  "size-3.5",
                  isScLinked ? "text-primary" : "text-muted-foreground/40",
                )}
              />
            </div>
          );
        }
        return (
          <EditableCell
            key={f.key}
            value={getValue(f.key as EditableField)}
            onCommit={(v) => onFieldChange(f.key as EditableField, v)}
            onActivate={onSelect}
            isCurrent={isCurrent}
            placeholder={f.label}
            isChanged={isChanged(f.key as EditableField)}
            width={f.width}
          />
        );
      })}

      {/* Added date (read-only) */}
      <span className="text-muted-foreground w-20 shrink-0 text-xs tabular-nums">
        {item.mtime
          ? new Date(item.mtime * 1000).toISOString().slice(0, 10)
          : "—"}
      </span>

      {/* File name — moved to the end; folder is more relevant in tree view */}
      <span
        data-file-path={item.file_path}
        className="text-muted-foreground w-32 shrink-0 truncate text-xs"
        title={item.file_name}
      >
        {item.file_name}
      </span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="border-border flex h-12 items-center gap-2 border-b px-3">
      <Skeleton className="size-6 rounded" />
      <Skeleton className="h-7 w-28" />
      <Skeleton className="size-8 rounded" />
      <div className="flex min-w-0 flex-[3] flex-col gap-1">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-2.5 w-1/2" />
      </div>
      <Skeleton className="h-3 flex-[2]" />
      <Skeleton className="h-3 w-28" />
      <Skeleton className="h-3 w-14" />
      <Skeleton className="h-3 w-14" />
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-3 w-14" />
    </div>
  );
}

export function CollectionTable({
  mode,
  folderPath,
  scrollToFilePath,
  selectedFilePath,
  onSelect,
  onTotalChange,
  onItemsChange,
  refreshToken,
  onEditSaved,
  activeRuleset,
  folderRulesets,
  rulesets,
  pendingFieldEdits,
  setPendingFieldEdits,
  isColumnVisible,
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthChange,
  onColumnWidthReset,
}: CollectionTableProps) {
  const colVisible = useCallback(
    (id: string) => (isColumnVisible ? isColumnVisible(id) : true),
    [isColumnVisible],
  );
  const orderedFields = useMemo(() => {
    if (!columnOrder?.length) return COLUMN_FIELDS;
    const byId = new Map(COLUMN_FIELDS.map((f) => [f.key, f]));
    const seen = new Set<string>();
    const out: typeof COLUMN_FIELDS = [];
    for (const id of columnOrder) {
      const f = byId.get(id as FieldKey);
      if (f && !seen.has(id)) {
        out.push(f);
        seen.add(id);
      }
    }
    for (const f of COLUMN_FIELDS) {
      if (!seen.has(f.key)) out.push(f);
    }
    return out;
  }, [columnOrder]);
  // Live widths during an active resize drag. Overlays `columnWidths` until
  // the drag commits (pointer-up), which then persists via onColumnWidthChange.
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const visibleFields = useMemo<ResolvedField[]>(
    () =>
      orderedFields
        .filter((f) => f.key !== "folder" || !!folderPath)
        .filter((f) => colVisible(f.key))
        .map((f) => ({
          ...f,
          width: liveWidths[f.key] ?? columnWidths?.[f.key] ?? f.defaultWidth,
        })),
    [orderedFields, colVisible, columnWidths, liveWidths, folderPath],
  );
  const [sortBy, setSortBy] = useQueryState("sort", searchParams.sort);
  const [sortOrder, setSortOrder] = useQueryState("order", searchParams.order);
  // Filter state: URL-backed via the shared filter hook. Keys match attribute
  // ids from the filter schema (singular: genre, key).
  const [search] = useQueryState("search", parseAsString.withDefault(""));
  const [genres] = useQueryState(
    "genre",
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  const [keys] = useQueryState(
    "key",
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  const [bpmMin] = useQueryState("bpmMin", parseAsInteger);
  const [bpmMax] = useQueryState("bpmMax", parseAsInteger);
  // SoundCloud-link bool filter (writes "true" / "false" to the URL via the
  // shared filter hook; null = unset / show all).
  const [scLinkedRaw] = useQueryState("soundcloud_linked", parseAsString);
  const scLinked: boolean | undefined =
    scLinkedRaw === "true" ? true : scLinkedRaw === "false" ? false : undefined;
  const [items, setItems] = useState<TrackBrowse[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [cacheLoading, setCacheLoading] = useState(false);

  const loadingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const itemsRef = useRef<TrackBrowse[]>([]);

  const { playQueue, load } = usePlayer();

  const scrollParentRef = useRef<HTMLDivElement>(null);

  // Pending field edits live on the parent (page.tsx) so the single-track
  // editor and the table share state.  Aliased here so the rest of the file
  // keeps its existing `changes` / `setChanges` vocabulary.
  const changes = pendingFieldEdits as Map<
    string,
    Partial<Record<EditableField, string>>
  >;
  const setChanges = setPendingFieldEdits as unknown as React.Dispatch<
    React.SetStateAction<Map<string, Partial<Record<EditableField, string>>>>
  >;
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  // Disable batch Apply Rules while one is in flight (#375). Each job is a
  // long ffmpeg run — re-firing the button stacks them.
  const [applyingBatch, setApplyingBatch] = useState(false);
  const [pulseRows, setPulseRows] = useState<Set<string>>(new Set());
  const pulseTimersRef = useRef<Map<string, number>>(new Map());
  const triggerSavePulse = useCallback((filePath: string) => {
    setPulseRows((prev) => {
      const next = new Set(prev);
      next.add(filePath);
      return next;
    });
    const existing = pulseTimersRef.current.get(filePath);
    if (existing) window.clearTimeout(existing);
    const id = window.setTimeout(() => {
      setPulseRows((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      pulseTimersRef.current.delete(filePath);
    }, 900);
    pulseTimersRef.current.set(filePath, id);
  }, []);
  useEffect(() => {
    const timers = pulseTimersRef.current;
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      timers.clear();
    };
  }, []);
  const [batchField, setBatchField] = useState<string>("");
  const [batchValue, setBatchValue] = useState("");
  const lastSelectedIndexRef = useRef<number | null>(null);

  // Pending artwork (base64) per file — separate from field changes
  const [pendingArtwork, setPendingArtwork] = useState<Map<string, string>>(
    new Map(),
  );

  // Pending SC link (comment) changes per file: filePath -> serialized comment string
  const [pendingScLinks, setPendingScLinks] = useState<Map<string, string>>(
    new Map(),
  );
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: React.ReactNode;
    onConfirm: () => void;
  }>({ open: false, title: "", message: "", onConfirm: () => {} });

  // SoundCloud auto-fill (background only — surfaces via the SoundCloud
  // column once the link is persisted; no per-row search UI in the table).
  const [scAutoFill, setScAutoFill] = useState(false);
  const scProcessedRef = useRef<Set<string>>(new Set());

  const rowHeight = EDIT_ROW_HEIGHT;

  const virtualizer = useVirtualizer({
    count: total > 0 ? total : items.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const loadPage = useCallback(
    async (
      pageNum: number,
      reset: boolean,
      overrideSortBy?: SortBy,
      overrideSortOrder?: SortOrder,
    ) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);

      // Cancel any in-flight request so stale responses never overwrite current data
      abortRef.current?.abort(
        new DOMException("Request cancelled", "AbortError"),
      );
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const browseParams = {
          search: search || undefined,
          genres: genres.length ? genres : undefined,
          keys: keys.length ? keys : undefined,
          bpm_min: bpmMin ?? undefined,
          bpm_max: bpmMax ?? undefined,
          has_soundcloud_id: scLinked,
          sort_by: overrideSortBy ?? sortBy,
          sort_order: overrideSortOrder ?? sortOrder,
          page: pageNum,
          size: PAGE_SIZE,
        };
        const resp = folderPath
          ? await api.browsePath(
              folderPath,
              { ...browseParams, recursive: true },
              controller.signal,
            )
          : await api.browseFiles(mode, browseParams, controller.signal);
        const nextItems = reset
          ? resp.items
          : [...itemsRef.current, ...resp.items];
        itemsRef.current = nextItems;
        setItems(nextItems);
        onItemsChange?.(nextItems);
        setHasMore(pageNum < resp.pages);
        setPage(pageNum);
        setTotal(resp.total);
        setCacheLoading(resp.cacheLoading ?? false);
        onTotalChange?.(resp.total, resp.cacheLoading ?? false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      } finally {
        loadingRef.current = false;
        setLoading(false);
        setReloading(false);
      }
    },
    [
      mode,
      folderPath,
      search,
      genres,
      keys,
      bpmMin,
      bpmMax,
      scLinked,
      sortBy,
      sortOrder,
      onItemsChange,
      onTotalChange,
    ],
  );

  // Reload on mode / folderPath / filter / sort change
  const filtersKey = `${mode}|${folderPath ?? ""}|${search}|${genres.join(",")}|${keys.join(",")}|${bpmMin}|${bpmMax}|${scLinked ?? ""}|${sortBy}|${sortOrder}`;
  useEffect(() => {
    // Cancel any in-flight request from the previous mode/filters
    abortRef.current?.abort(
      new DOMException("Request cancelled", "AbortError"),
    );
    abortRef.current = null;
    setReloading(true);
    setPage(1);
    // Reset guard so a mode switch always triggers a fresh load
    loadingRef.current = false;
    loadPage(1, true);
  }, [filtersKey, loadPage]);

  // Refresh without remount when refreshToken changes
  useEffect(() => {
    if (refreshToken === undefined) return;
    loadingRef.current = false;
    loadPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // Auto-refresh while cache is still loading (server is progressively reading files)
  useEffect(() => {
    if (!cacheLoading) return;
    const timer = setInterval(() => {
      loadPage(1, true);
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheLoading, filtersKey]);

  // Fetch next page when virtualizer reaches near the loaded boundary
  useEffect(() => {
    const virtualItems = virtualizer.getVirtualItems();
    if (!virtualItems.length || !hasMore || loading) return;
    const lastVirtualItem = virtualItems[virtualItems.length - 1];
    if (lastVirtualItem.index >= items.length - PAGE_SIZE / 2) {
      loadPage(page + 1, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualizer.getVirtualItems()]);

  // Scroll to a specific track when switching to view mode
  useEffect(() => {
    if (!scrollToFilePath || !items.length) return;
    const idx = items.findIndex((item) => item.file_path === scrollToFilePath);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: "center" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToFilePath, items.length]);

  function handleSort(col: SortBy) {
    if (col !== sortBy) {
      setSortBy(col);
      setSortOrder("asc");
    } else if (sortOrder === "asc") {
      setSortOrder("desc");
    } else {
      // Third click: reset to default (added date, newest first)
      setSortBy("mtime");
      setSortOrder("desc");
    }
  }

  function handleSelect(item: TrackBrowse) {
    load({
      filePath: item.file_path,
      fileName: item.file_name,
      title: item.title ?? undefined,
      artist: Array.isArray(item.artist)
        ? item.artist.join(", ")
        : (item.artist ?? undefined),
      bpm: item.bpm ?? null,
    });
    onSelect?.(item);
  }

  function handleStartPlay(index: number) {
    const queue = items.map((it) => ({
      filePath: it.file_path,
      fileName: it.file_name,
      title: it.title ?? undefined,
      artist: Array.isArray(it.artist)
        ? it.artist.join(", ")
        : (it.artist ?? undefined),
      bpm: it.bpm ?? null,
    }));
    playQueue(queue, index);
  }

  // Get the "original" value for a field — used for change detection
  const getOriginal = useCallback(
    (item: TrackBrowse | undefined, field: EditableField): string => {
      if (!item) return "";
      const val = item[field as keyof TrackBrowse];
      if (val == null) return "";
      if (Array.isArray(val)) return val.join(", ");
      return String(val);
    },
    [],
  );

  // Edit-mode helpers
  const updateField = useCallback(
    (filePath: string, field: EditableField, value: string) => {
      setChanges((prev) => {
        const next = new Map(prev);
        const fileChanges = { ...(next.get(filePath) ?? {}) };
        const item = items.find((i) => i.file_path === filePath);
        const original = getOriginal(item, field);
        if (value === original) {
          delete fileChanges[field];
          if (Object.keys(fileChanges).length === 0) {
            next.delete(filePath);
          } else {
            next.set(filePath, fileChanges);
          }
        } else {
          fileChanges[field] = value;
          next.set(filePath, fileChanges);
        }
        return next;
      });
    },
    [items, getOriginal, setChanges],
  );

  const applyBatchAction = useCallback(
    (field: EditableField, value: string) => {
      // Apply to selected items, or all items if none selected
      const targets =
        selectedPaths.size > 0
          ? items.filter((i) => selectedPaths.has(i.file_path))
          : items;

      setChanges((prev) => {
        const next = new Map(prev);
        for (const item of targets) {
          const original = getOriginal(item, field);
          const fileChanges = { ...(next.get(item.file_path) ?? {}) };
          if (value === original) {
            delete fileChanges[field];
            if (Object.keys(fileChanges).length === 0) {
              next.delete(item.file_path);
            } else {
              next.set(item.file_path, fileChanges);
            }
          } else {
            fileChanges[field] = value;
            next.set(item.file_path, fileChanges);
          }
        }
        return next;
      });
    },
    [items, selectedPaths, getOriginal, setChanges],
  );

  // Search SC for a single item. When applyResults=true, auto-fills empty fields + SC link.
  const searchScForItem = useCallback(
    async (item: TrackBrowse, applyResults: boolean) => {
      const query = removeMix(
        item.file_name
          .replace(/\.(mp3|aiff|wav)$/i, "")
          .replace(/_/g, " ")
          .replace(/\[.*?\]/g, "")
          .trim(),
      );

      if (!query) return;

      try {
        const results = await soundCloudSource.searchTracks(query);
        if (results.length === 0) return;

        const meta = soundCloudSource.extractMetadata(results[0]);

        if (!applyResults) return;

        // Fill only empty fields
        setChanges((prev) => {
          const next = new Map(prev);
          const fileChanges = { ...(next.get(item.file_path) ?? {}) };
          let changed = false;

          if (!item.title && !fileChanges.title && meta.title) {
            fileChanges.title = meta.title;
            changed = true;
          }
          if (!item.artist && !fileChanges.artist && meta.artist) {
            fileChanges.artist = meta.artist;
            changed = true;
          }
          if (!item.genre && !fileChanges.genre && meta.genre) {
            fileChanges.genre = meta.genre;
            changed = true;
          }
          if (
            !item.release_date &&
            !fileChanges.release_date &&
            meta.release_date
          ) {
            fileChanges.release_date = meta.release_date;
            changed = true;
          }

          // Fill remix fields from SC title if available
          if (meta.title) {
            const remix = parseRemix(meta.title);
            if (remix) {
              if (!fileChanges.remixer) {
                fileChanges.remixer = remix.remixer;
                changed = true;
              }
              if (!fileChanges.mix_name) {
                fileChanges.mix_name = remix.mixName;
                changed = true;
              }
              if (!fileChanges.original_artist && meta.artist) {
                fileChanges.original_artist = meta.artist;
                changed = true;
              }
            }
          }

          if (changed) {
            next.set(item.file_path, fileChanges);
          }
          return next;
        });

        // Set SC link if not already set
        if (!item.soundcloud_id && meta.source_id) {
          const comment = serializeComment(
            meta.source_id,
            meta.source_permalink ?? "",
          );
          setPendingScLinks((prev) =>
            new Map(prev).set(item.file_path, comment),
          );
        }

        // Fetch artwork if track doesn't have one
        if (!item.has_artwork && meta.artwork_url) {
          try {
            const blob = await api.proxyImage(meta.artwork_url);
            const reader = new FileReader();
            reader.onloadend = () => {
              const b64 = (reader.result as string).split(",")[1];
              if (b64) {
                setPendingArtwork((prev) =>
                  new Map(prev).set(item.file_path, b64),
                );
              }
            };
            reader.readAsDataURL(blob);
          } catch {
            // Artwork fetch failed — not critical
          }
        }
      } catch {
        // Search failed — silent; the SoundCloud column reflects the
        // persisted link state, not transient search errors.
      }
    },
    [setChanges],
  );

  // Batch SC auto-fill: search for all items sequentially
  useEffect(() => {
    if (!scAutoFill || items.length === 0) return;

    let cancelled = false;

    (async () => {
      for (const item of items) {
        if (cancelled) break;
        if (scProcessedRef.current.has(item.file_path)) continue;
        scProcessedRef.current.add(item.file_path);
        await searchScForItem(item, true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scAutoFill, items, searchScForItem]);

  // Build TrackInfoUpdateRequest from field changes + optional artwork/starlib link
  const buildUpdates = useCallback(
    (
      fileChanges: Partial<Record<EditableField, string>>,
      artworkB64?: string,
      scStarlib?: string,
    ): TrackInfoUpdateRequest => {
      const updates: TrackInfoUpdateRequest = {};
      for (const [field, value] of Object.entries(fileChanges)) {
        if (field === "bpm") {
          updates.bpm = value ? parseInt(value, 10) : undefined;
        } else if (field === "release_date") {
          updates.release_date = value || undefined;
        } else {
          (updates as Record<string, unknown>)[field] = value || undefined;
        }
      }
      if (artworkB64) {
        updates.artwork_data = artworkB64;
      }
      if (scStarlib) {
        updates.starlib_meta = scStarlib;
      }
      return updates;
    },
    [],
  );

  const handleSave = async () => {
    const allPaths = new Set([
      ...changes.keys(),
      ...pendingArtwork.keys(),
      ...pendingScLinks.keys(),
    ]);
    if (allPaths.size === 0) return;
    if (allPaths.size > 1) {
      setConfirmDialog({
        open: true,
        title: "Save all changes?",
        message: `Write changes to ${allPaths.size} files. This cannot be undone.`,
        onConfirm: () => {
          void runSave(allPaths);
        },
      });
      return;
    }
    await runSave(allPaths);
  };

  const runSave = async (allPaths: Set<string>) => {
    setSaving(true);

    const batchItems: BatchUpdateItem[] = [];
    for (const filePath of allPaths) {
      const fileChanges = changes.get(filePath);
      const artworkB64 = pendingArtwork.get(filePath);
      const scComment = pendingScLinks.get(filePath);
      const updates = buildUpdates(fileChanges ?? {}, artworkB64, scComment);
      batchItems.push({ file_path: filePath, updates });
    }

    try {
      const result = await api.batchUpdateTrackInfo(batchItems);
      result.results.forEach((r) => {
        if (r.success) triggerSavePulse(r.file_path);
      });
      const succeeded = result.results.filter((r) => r.success).length;
      const failed = result.results.filter((r) => !r.success).length;
      if (failed === 0) {
        toast.success(
          `Updated ${succeeded} track${succeeded !== 1 ? "s" : ""}`,
        );
      } else {
        toast.warning(`${succeeded} updated, ${failed} failed`);
      }
      setChanges(new Map());
      setPendingArtwork(new Map());
      setPendingScLinks(new Map());
      onEditSaved?.();
    } catch {
      toast.error("Batch update failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleSelect = useCallback(
    (filePath: string, index: number, shiftKey: boolean) => {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (shiftKey && lastSelectedIndexRef.current !== null) {
          const start = Math.min(lastSelectedIndexRef.current, index);
          const end = Math.max(lastSelectedIndexRef.current, index);
          for (let i = start; i <= end; i++) {
            if (items[i]) next.add(items[i].file_path);
          }
        } else {
          if (next.has(filePath)) {
            next.delete(filePath);
          } else {
            next.add(filePath);
          }
          lastSelectedIndexRef.current = index;
        }
        return next;
      });
    },
    [items],
  );

  const runApplyRules = useCallback(
    async (paths: string[]) => {
      const toastId = toast.loading(
        `Applying rules to ${paths.length} track${paths.length !== 1 ? "s" : ""}…`,
      );
      setApplyingBatch(true);
      let succeeded = 0;
      let failed = 0;
      try {
        for (const fp of paths) {
          try {
            await api.applyRules(fp);
            succeeded++;
          } catch {
            failed++;
          }
        }
        if (failed === 0) {
          toast.success(
            `Applied rules to ${succeeded} track${succeeded !== 1 ? "s" : ""}`,
            { id: toastId },
          );
        } else {
          toast.warning(`${succeeded} applied, ${failed} failed`, {
            id: toastId,
          });
        }
        onEditSaved?.();
      } finally {
        setApplyingBatch(false);
      }
    },
    [onEditSaved],
  );

  /** For a candidate track, determine if it has a resolvable ruleset and
   * whether all required attributes are satisfied under THAT ruleset. */
  const resolveApplyRulesEligibility = useCallback(
    (item: TrackBrowse): { ruleset: Ruleset | null; eligible: boolean } => {
      const rs =
        resolveRulesetForFile(item.file_path, folderRulesets, rulesets) ??
        activeRuleset ??
        null;
      if (!rs || rs.rules.length === 0) return { ruleset: rs, eligible: false };
      return {
        ruleset: rs,
        eligible: canApplyRulesToItem(item, rs.required_attributes),
      };
    },
    [folderRulesets, rulesets, activeRuleset],
  );

  const handleApplyRulesToSelected = useCallback(() => {
    const candidates =
      selectedPaths.size > 0
        ? items.filter((i) => selectedPaths.has(i.file_path))
        : items;
    const resolved = candidates.map((i) => ({
      item: i,
      ...resolveApplyRulesEligibility(i),
    }));
    const eligible = resolved.filter((r) => r.eligible);
    const skipped = candidates.length - eligible.length;
    if (eligible.length === 0) return;
    const paths = eligible.map((r) => r.item.file_path);
    const uniqueRulesets = Array.from(
      new Set(eligible.map((r) => r.ruleset?.id).filter(Boolean)),
    );
    const singleRuleset =
      uniqueRulesets.length === 1 ? (eligible[0]?.ruleset ?? null) : null;
    const skippedSuffix =
      skipped > 0
        ? ` (${skipped} skipped — missing required fields or no ruleset)`
        : "";
    if (paths.length > 1 || skipped > 0) {
      setConfirmDialog({
        open: true,
        title: "Apply rules?",
        message: (
          <>
            Apply{" "}
            {singleRuleset ? (
              <RulesetBadge ruleset={singleRuleset} />
            ) : uniqueRulesets.length > 1 ? (
              <span className="font-medium">
                {uniqueRulesets.length} rulesets
              </span>
            ) : (
              "rules"
            )}{" "}
            to {paths.length} track{paths.length !== 1 ? "s" : ""}
            {skippedSuffix}. This will rewrite tags and move files.
          </>
        ),
        onConfirm: () => {
          void runApplyRules(paths);
        },
      });
      return;
    }
    void runApplyRules(paths);
  }, [selectedPaths, items, resolveApplyRulesEligibility, runApplyRules]);

  const applyRulesEligibleCount = (
    selectedPaths.size > 0
      ? items.filter((i) => selectedPaths.has(i.file_path))
      : items
  ).filter((i) => resolveApplyRulesEligibility(i).eligible).length;

  const virtualItems = virtualizer.getVirtualItems();
  const allChangedPaths = new Set([
    ...changes.keys(),
    ...pendingArtwork.keys(),
    ...pendingScLinks.keys(),
  ]);
  const totalChanges = allChangedPaths.size;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AlertDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDialog.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDialog.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmDialog.onConfirm();
                setConfirmDialog((prev) => ({ ...prev, open: false }));
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Edit-mode toolbar */}
      {/* Toolbar */}
      <div className="border-border bg-muted @container/toolbar flex shrink-0 items-center gap-2 overflow-hidden border-b px-3 py-1.5">
        {selectedPaths.size > 0 && (
          <>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {selectedPaths.size} selected
            </span>
            <div className="bg-border mx-1 h-4 w-px" />
          </>
        )}

        {/* Batch actions */}
        <Select value={batchField} onValueChange={setBatchField}>
          <SelectTrigger className="h-7 w-20 text-xs">
            <SelectValue placeholder="Field" />
          </SelectTrigger>
          <SelectContent>
            {visibleFields.map((f) => (
              <SelectItem key={f.key} value={f.key} className="text-xs">
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="h-7 w-28 text-xs"
          placeholder="Value..."
          value={batchValue}
          onChange={(e) => setBatchValue(e.target.value)}
          disabled={!batchField}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={!batchField}
          onClick={() => {
            if (batchField) {
              applyBatchAction(batchField as EditableField, batchValue);
              setBatchValue("");
            }
          }}
        >
          <PencilLine className="size-3" />
          Set{selectedPaths.size > 0 ? ` (${selectedPaths.size})` : " all"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={!batchField}
          onClick={() => {
            if (batchField) {
              applyBatchAction(batchField as EditableField, "");
              setBatchValue("");
            }
          }}
        >
          <Eraser className="size-3" />
          Clear{selectedPaths.size > 0 ? ` (${selectedPaths.size})` : " all"}
        </Button>

        <div className="flex-1" />

        {totalChanges > 0 && (
          <>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {totalChanges} changed
            </span>
            <div className="bg-border mx-1 h-4 w-px shrink-0" />
          </>
        )}

        {/* Save all */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 @max-[760px]/toolbar:gap-0 @max-[760px]/toolbar:px-2",
            totalChanges > 0
              ? "text-primary hover:bg-brand-soft hover:text-primary"
              : "text-muted-foreground",
          )}
          disabled={totalChanges === 0 || saving}
          onClick={handleSave}
        >
          {saving ? (
            <LogoSpinner className="size-3.5" />
          ) : (
            <Check className="size-3.5" />
          )}
          <span className="max-w-[140px] overflow-hidden whitespace-nowrap opacity-100 @max-[760px]/toolbar:max-w-0 @max-[760px]/toolbar:opacity-0">
            Save all{totalChanges > 0 ? ` (${totalChanges})` : ""}
          </span>
        </Button>

        {/* Apply rules — visible when any bindings exist */}
        {activeRuleset?.rules.length ||
        (folderRulesets && Object.keys(folderRulesets).length > 0) ? (
          <TooltipProvider delayDuration={400} disableHoverableContent>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 gap-1.5 @max-[760px]/toolbar:gap-0 @max-[760px]/toolbar:px-2",
                    applyRulesEligibleCount > 0
                      ? "text-primary hover:bg-primary/10 hover:text-primary"
                      : "text-muted-foreground",
                  )}
                  disabled={applyRulesEligibleCount === 0 || applyingBatch}
                  data-applying={applyingBatch ? "true" : undefined}
                  onClick={handleApplyRulesToSelected}
                >
                  {applyingBatch ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Workflow className="size-3.5" />
                  )}
                  <span className="max-w-[140px] overflow-hidden whitespace-nowrap opacity-100 @max-[760px]/toolbar:max-w-0 @max-[760px]/toolbar:opacity-0">
                    {applyingBatch ? "Applying…" : "Apply rules"}
                    {!applyingBatch && applyRulesEligibleCount > 0
                      ? ` (${applyRulesEligibleCount})`
                      : ""}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                sideOffset={6}
                showArrow={false}
                className="bg-popover text-popover-foreground max-w-64 border p-0"
              >
                {activeRuleset?.rules.length ? (
                  <RulesetPreview ruleset={activeRuleset} />
                ) : (
                  <div className="text-muted-foreground px-3 py-2 text-xs">
                    Each track has rules applied under the ruleset bound to its
                    folder.
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}

        {/* SoundCloud auto-fill toggle */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 @max-[760px]/toolbar:gap-0 @max-[760px]/toolbar:px-2",
            scAutoFill
              ? "text-primary hover:bg-brand-soft hover:text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => {
            if (scAutoFill) {
              setScAutoFill(false);
            } else {
              scProcessedRef.current = new Set();
              setScAutoFill(true);
            }
          }}
        >
          <SoundCloudLogo className="size-3.5" />
          <span className="max-w-[140px] overflow-hidden whitespace-nowrap opacity-100 @max-[760px]/toolbar:max-w-0 @max-[760px]/toolbar:opacity-0">
            Auto-fill
          </span>
        </Button>
      </div>

      {/* Scrollable table area — single container owns both axes so the
          vertical scrollbar stays on the viewport edge even when the row
          content is wider than the viewport. */}
      <div
        ref={scrollParentRef}
        className={`min-h-0 flex-1 overflow-auto overscroll-contain transition-opacity duration-150 ${reloading ? "opacity-40" : "opacity-100"}`}
      >
        <div className="w-max min-w-full">
          {/* Header row — sticky to the top of the scroll container */}
          <div
            role="row"
            className="border-border text-muted-foreground sticky top-0 z-20 flex h-9 items-center gap-1.5 border-b bg-[var(--surface-2)] pr-0 pl-3 text-xs font-medium"
          >
            {/* Select all checkbox */}
            <div className="flex w-6 shrink-0 items-center justify-center">
              <Checkbox
                checked={
                  items.length > 0 &&
                  items.every((i) => selectedPaths.has(i.file_path))
                    ? true
                    : items.some((i) => selectedPaths.has(i.file_path))
                      ? "indeterminate"
                      : false
                }
                onCheckedChange={(checked) => {
                  if (checked) {
                    setSelectedPaths(new Set(items.map((i) => i.file_path)));
                  } else {
                    setSelectedPaths(new Set());
                  }
                }}
                aria-label="Select all"
                className="cursor-pointer"
              />
            </div>
            {/* Artwork spacer */}
            <div className="w-7 shrink-0" />
            {/* Waveform spacer */}
            <div className="w-20 shrink-0" />
            {/* Field headers — drag-reorderable; sortable where applicable.
                Folder participates here too (when in tree/path mode). */}
            <SortableColumnHeader
              ids={visibleFields.map((f) => f.key)}
              onOrderChange={(nextIds) => {
                if (!onColumnOrderChange) return;
                // Merge the reordered visible ids with any hidden ids so
                // hidden columns retain their relative position.
                const hidden = COLUMN_FIELDS.map((f) => f.key).filter(
                  (k) => !visibleFields.some((v) => v.key === k),
                );
                onColumnOrderChange([...nextIds, ...hidden]);
              }}
            >
              {visibleFields.map((f) => {
                const sortKey = SORTABLE_FIELDS[f.key];
                return (
                  <SortableHeaderCell
                    key={f.key}
                    id={f.key}
                    className="min-w-0 shrink-0"
                    style={{ width: f.width }}
                    onResize={(w, phase) => {
                      if (phase === "drag") {
                        setLiveWidths((p) => ({ ...p, [f.key]: w }));
                      } else {
                        onColumnWidthChange?.(f.key, w);
                        setLiveWidths((p) => {
                          const { [f.key]: _omit, ...rest } = p;
                          return rest;
                        });
                      }
                    }}
                    onResetWidth={() => onColumnWidthReset?.(f.key)}
                  >
                    {sortKey ? (
                      <button
                        className="hover:text-foreground flex w-full cursor-pointer items-center gap-0.5 transition-colors"
                        onClick={() => handleSort(sortKey)}
                      >
                        {f.label}
                        <SortIcon
                          col={sortKey}
                          sortBy={sortBy}
                          sortOrder={sortOrder}
                        />
                      </button>
                    ) : (
                      <span>{f.label}</span>
                    )}
                  </SortableHeaderCell>
                );
              })}
            </SortableColumnHeader>
            {/* Added date header — sortable by mtime */}
            <button
              className="hover:text-foreground flex w-20 shrink-0 cursor-pointer items-center gap-0.5 transition-colors"
              onClick={() => handleSort("mtime")}
            >
              Added
              <SortIcon col="mtime" sortBy={sortBy} sortOrder={sortOrder} />
            </button>
            {/* File name header — moved to the end */}
            <button
              className="hover:text-foreground flex w-32 shrink-0 cursor-pointer items-center gap-0.5 transition-colors"
              onClick={() => handleSort("file_name")}
            >
              File
              <SortIcon col="file_name" sortBy={sortBy} sortOrder={sortOrder} />
            </button>
          </div>

          {/* Virtualized row surface */}
          <div>
            {/* Total height for virtual scroll */}
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: "relative",
              }}
            >
              {virtualItems.map((virtualRow) => {
                const item = items[virtualRow.index];

                return (
                  <div
                    key={item?.file_path ?? virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {item ? (
                      <EditRow
                        item={item}
                        isSelected={selectedPaths.has(item.file_path)}
                        isCurrent={selectedFilePath === item.file_path}
                        changes={changes.get(item.file_path) ?? {}}
                        hasChanges={
                          changes.has(item.file_path) ||
                          pendingArtwork.has(item.file_path) ||
                          pendingScLinks.has(item.file_path)
                        }
                        onToggleSelect={(shiftKey) =>
                          toggleSelect(
                            item.file_path,
                            virtualRow.index,
                            shiftKey,
                          )
                        }
                        onFieldChange={(field, value) =>
                          updateField(item.file_path, field, value)
                        }
                        onSelect={() => handleSelect(item)}
                        onStartPlay={() => handleStartPlay(virtualRow.index)}
                        justSaved={pulseRows.has(item.file_path)}
                        pendingArtworkB64={pendingArtwork.get(item.file_path)}
                        isScLinked={
                          !!item.soundcloud_id ||
                          pendingScLinks.has(item.file_path)
                        }
                        folderPath={folderPath}
                        visibleFields={visibleFields}
                      />
                    ) : (
                      <SkeletonRow />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Loader at end */}
            {loading && hasMore && (
              <div className="text-muted-foreground flex items-center justify-center py-4 text-xs">
                Loading…
              </div>
            )}
          </div>
        </div>
        {/* min-w */}
      </div>
      {/* overflow-x-auto */}
    </div>
  );
}
