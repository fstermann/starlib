"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Eraser,
  MoveRight,
  Music,
  PencilLine,
  Workflow,
} from "lucide-react";
import { useQueryState } from "nuqs";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { serializeComment } from "@/app/library/utils";
import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";
import { LogoSpinner } from "@/components/logo-spinner";
import { MiniWaveform } from "@/components/mini-waveform";
import { RULE_ICON_COLORS, RULE_ICONS } from "@/components/rulesets/rule-card";
import { RulesetPreview } from "@/components/rulesets/ruleset-preview";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  type RuleType,
  type TrackBrowse,
  type TrackInfoUpdateRequest,
} from "@/lib/api";
import { usePlayer } from "@/lib/player-context";
import { searchParams } from "@/lib/search-params";
import { soundCloudSource } from "@/lib/sources/soundcloud";
import type { SourceMetadata, SourceTrack } from "@/lib/sources/types";
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

/** Fields shown in edit mode. `virtual` fields are not API fields — they're used for title composition. */
// Fixed widths so columns keep their shape when the left grid cell narrows
// (e.g. editor panel open) — horizontal scroll handles overflow instead.
const EDITABLE_FIELDS: { key: EditableField; label: string; width: string }[] =
  [
    { key: "title", label: "Title", width: "w-64" },
    { key: "artist", label: "Artist", width: "w-48" },
    { key: "genre", label: "Genre", width: "w-28" },
    { key: "bpm", label: "BPM", width: "w-14" },
    { key: "key", label: "Key", width: "w-14" },
    { key: "remixer", label: "Remixer", width: "w-32" },
    { key: "original_artist", label: "Orig. Artist", width: "w-28" },
    { key: "mix_name", label: "Mix", width: "w-20" },
    { key: "release_date", label: "Release", width: "w-24" },
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
  autoApplyScResults?: boolean;
  /** Shared pending field edits per file (keyed by file_path). Lifted to the
   * page so the single-track editor and the batch table stay in sync. */
  pendingFieldEdits: Map<string, Record<string, string>>;
  setPendingFieldEdits: React.Dispatch<
    React.SetStateAction<Map<string, Record<string, string>>>
  >;
}

/** Sortable fields mapped to EDITABLE_FIELDS keys where applicable */
const SORTABLE_FIELDS: Partial<Record<EditableField, SortBy>> = {
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

function canFinalizeItem(
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

/* ─── Row ─── */

type ScStatus = "idle" | "searching" | "found" | "not-found";

interface ScData {
  results: SourceTrack[];
  selectedIndex: number;
  meta: SourceMetadata;
}

interface EditRowProps {
  item: TrackBrowse;
  isSelected: boolean;
  isCurrent: boolean;
  changes: Partial<Record<EditableField, string>>;
  hasChanges: boolean;
  scStatus?: ScStatus;
  scData?: ScData;
  onToggleSelect: (shiftKey: boolean) => void;
  onFieldChange: (field: EditableField, value: string) => void;
  onApplyScField: (field: EditableField, value: string) => void;
  onApplyAllScFields: () => void;
  onSelectScTrack: (index: number) => void;
  onSearchSc: () => void;
  onSelect: () => void;
  onSaveRow: () => void;
  onFinalize: () => void;
  savingRow: boolean;
  justSaved: boolean;
  pendingArtworkB64?: string;
  hasScLink?: boolean;
  scLinkChanged?: boolean;
  activeRuleset?: Ruleset | null;
  /** When set, show a Folder column with the path relative to this root. */
  folderPath?: string;
}

function ScFieldRow({
  label,
  scValue,
  currentValue,
  onApply,
}: {
  label: string;
  scValue?: string;
  currentValue: string;
  onApply: () => void;
}) {
  if (!scValue || scValue === currentValue) return null;
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span className="text-muted-foreground w-14 shrink-0">{label}</span>
      <span className="text-foreground flex-1 truncate">{scValue}</span>
      <button
        className="text-primary hover:bg-brand-soft shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 text-xs font-medium transition-colors"
        onClick={onApply}
      >
        Apply
      </button>
    </div>
  );
}

function EditRow({
  item,
  isSelected,
  isCurrent,
  changes,
  hasChanges,
  scStatus,
  scData,
  onToggleSelect,
  onFieldChange,
  onApplyScField,
  onApplyAllScFields,
  onSelectScTrack,
  onSearchSc,
  onSelect,
  onSaveRow,
  onFinalize,
  savingRow,
  justSaved,
  pendingArtworkB64,
  hasScLink,
  scLinkChanged,
  activeRuleset,
  folderPath,
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

  const required = activeRuleset?.required_attributes ?? [];
  const missingForFinalize = getMissingAttributes(item, required);
  const canFinalize = missingForFinalize.length === 0;

  // Row hover is tracked in React so framer-motion can react to it.
  // Delayed so scrolling past rows doesn't flash the pill on every row.
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const scTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scOpenViaContextRef = useRef(false);

  // Pill visibility + shape:
  //   - hidden: no state, no hover → nothing rendered
  //   - compact: one icon summarising the most relevant action
  //   - full: all three icons, shown on hover, selection, current-playing
  const hasScSignal = !!scStatus || scLinkChanged;
  const pillActive = hasChanges || isSelected || isCurrent || hasScSignal;
  const showPill = pillActive || isHovered;
  const showFull = isHovered || isSelected || isCurrent;

  // Priority: unsaved changes > SC activity > ready-to-finalize > fallback save.
  const primaryKey: "save" | "sc" | "apply" = hasChanges
    ? "save"
    : hasScSignal
      ? "sc"
      : canFinalize && activeRuleset?.rules.length
        ? "apply"
        : "save";

  return (
    <div
      role="row"
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "group/row border-border relative flex h-10 items-center gap-1.5 border-b pr-0 pl-3 transition-colors",
        isCurrent && "bg-[var(--brand-soft)]",
        isSelected && !isCurrent && "bg-[var(--surface-3)]",
        !isCurrent && !isSelected && "hover:bg-[var(--surface-3)]",
        justSaved && "saved-pulse",
      )}
      onMouseEnter={() => {
        if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
        // Pill already visible (compact) → expand to full immediately.
        // Otherwise wait briefly so scroll-pasts don't flash the pill.
        if (pillActive) setIsHovered(true);
        else
          hoverTimerRef.current = window.setTimeout(
            () => setIsHovered(true),
            180,
          );
      }}
      onMouseLeave={() => {
        if (hoverTimerRef.current) {
          window.clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
        setIsHovered(false);
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
        />
      </div>

      {/* File name — click to open single editor */}
      <span
        data-file-path={item.file_path}
        className="text-muted-foreground hover:text-foreground w-48 shrink-0 cursor-pointer truncate text-xs transition-colors"
        title={item.file_name}
        onClick={onSelect}
      >
        {item.file_name}
      </span>

      {/* Folder column (only in tree/path mode) */}
      {folderPath && (
        <span
          className="text-muted-foreground w-36 shrink-0 truncate text-xs"
          title={item.folder ?? ""}
        >
          {item.folder && folderPath
            ? item.folder.startsWith(folderPath)
              ? item.folder.slice(folderPath.length + 1) || "."
              : item.folder
            : "—"}
        </span>
      )}

      {/* Editable fields */}
      {EDITABLE_FIELDS.map((f) => (
        <div key={f.key} className={`${f.width} min-w-0 shrink-0`}>
          <input
            className={`placeholder:text-text-subtle h-7 w-full rounded border bg-transparent px-1.5 text-xs transition-colors outline-none ${isChanged(f.key) ? "border-warning/70 bg-warning/5" : "hover:border-border border-transparent"} focus:border-ring focus:ring-ring/50 focus:ring-1`}
            value={getValue(f.key)}
            onChange={(e) => onFieldChange(f.key, e.target.value)}
            placeholder={f.label}
          />
        </div>
      ))}

      {/* Added date (read-only) */}
      <span className="text-muted-foreground w-20 shrink-0 text-xs tabular-nums">
        {item.mtime
          ? new Date(item.mtime * 1000).toISOString().slice(0, 10)
          : "—"}
      </span>

      {/* Per-row actions — floating pill. The sticky wrapper is 0-wide so it
          never contributes to row layout; the inner element is absolutely
          positioned and overlays whatever is beneath. */}
      {(() => {
        const saveBtn = (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                    hasChanges
                      ? "text-primary bg-brand-soft hover:bg-brand-soft cursor-pointer"
                      : "text-muted-foreground cursor-default",
                  )}
                  disabled={!hasChanges || savingRow}
                  onClick={onSaveRow}
                >
                  {savingRow ? (
                    <LogoSpinner className="size-3.5" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {hasChanges ? "Save this track" : "No changes"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );

        const applyBtn = activeRuleset?.rules.length ? (
          <TooltipProvider delayDuration={400} disableHoverableContent>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                    canFinalize
                      ? "text-primary bg-primary/10 hover:bg-primary/20 cursor-pointer"
                      : "text-muted-foreground cursor-default",
                  )}
                  disabled={!canFinalize}
                  onClick={onFinalize}
                >
                  <Workflow className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="left"
                sideOffset={6}
                showArrow={false}
                className="bg-popover text-popover-foreground max-w-64 border p-0"
              >
                <RulesetPreview
                  ruleset={activeRuleset}
                  missingRequired={canFinalize ? undefined : missingForFinalize}
                />
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null;

        const scBtn = (
          <Popover>
            <PopoverTrigger asChild>
              <button
                ref={scTriggerRef}
                className={cn(
                  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
                  scLinkChanged ? "ring-primary/40 ring-1" : "",
                  scStatus === "searching" || hasScLink || scStatus === "found"
                    ? "text-primary bg-brand-soft hover:bg-brand-soft"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent",
                )}
                onClick={(e) => {
                  if (scOpenViaContextRef.current) {
                    scOpenViaContextRef.current = false;
                    return;
                  }
                  if (!scStatus) {
                    e.preventDefault();
                    onSearchSc();
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  scOpenViaContextRef.current = true;
                  scTriggerRef.current?.click();
                }}
                title={
                  scStatus === "searching"
                    ? "Searching SoundCloud..."
                    : hasScLink
                      ? "SoundCloud linked"
                      : scStatus === "found"
                        ? "SoundCloud match found"
                        : scStatus === "not-found"
                          ? "No SoundCloud match"
                          : "Search SoundCloud"
                }
              >
                {scStatus === "searching" ? (
                  <LogoSpinner className="size-3.5" />
                ) : (
                  <SoundCloudLogo
                    className={cn(
                      "size-3.5",
                      scStatus === "not-found" && !hasScLink
                        ? "opacity-50"
                        : "",
                    )}
                  />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-80 p-3"
              align="end"
              side="left"
              collisionPadding={16}
            >
              {scStatus === "searching" && (
                <div className="text-muted-foreground flex items-center gap-2 text-xs">
                  <LogoSpinner className="size-3" /> Searching...
                </div>
              )}
              {scStatus === "not-found" && (
                <p className="text-muted-foreground text-xs">
                  No SoundCloud results found.
                </p>
              )}
              {!scStatus && (
                <div className="flex flex-col gap-2">
                  <p className="text-muted-foreground text-xs">
                    No SoundCloud search yet.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={onSearchSc}
                  >
                    <SoundCloudLogo className="size-3" />
                    Search SoundCloud
                  </Button>
                </div>
              )}
              {scData &&
                scStatus === "found" &&
                (() => {
                  const selected = scData.results[scData.selectedIndex];
                  return (
                    <div className="space-y-3">
                      {/* Result selector */}
                      <Select
                        value={String(scData.selectedIndex)}
                        onValueChange={(v) => onSelectScTrack(parseInt(v, 10))}
                      >
                        <SelectTrigger className="h-7 w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" className="max-w-64">
                          {scData.results.map((r, i) => (
                            <SelectItem
                              key={r.id}
                              value={String(i)}
                              className="text-xs"
                            >
                              <span className="truncate">
                                {r.title ?? "Untitled"} —{" "}
                                {r.username ?? "Unknown"}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Selected track info + artwork */}
                      {selected && (
                        <div className="flex items-center gap-3">
                          {selected.artwork_url && (
                            <img
                              src={selected.artwork_url}
                              alt=""
                              className="border-border size-12 shrink-0 rounded-md border object-cover"
                            />
                          )}
                          <div className="text-muted-foreground min-w-0 flex-1 text-xs">
                            <p className="text-foreground truncate text-sm font-medium">
                              {selected.title}
                            </p>
                            <p className="truncate">{selected.username}</p>
                          </div>
                        </div>
                      )}

                      {/* Per-field apply */}
                      {(() => {
                        const scRemix = scData.meta.title
                          ? parseRemix(scData.meta.title)
                          : null;
                        return (
                          <div className="border-border space-y-0.5 border-t pt-2">
                            <ScFieldRow
                              label="Title"
                              scValue={scData.meta.title}
                              currentValue={getValue("title")}
                              onApply={() =>
                                onApplyScField("title", scData.meta.title ?? "")
                              }
                            />
                            <ScFieldRow
                              label="Artist"
                              scValue={scData.meta.artist}
                              currentValue={getValue("artist")}
                              onApply={() =>
                                onApplyScField(
                                  "artist",
                                  scData.meta.artist ?? "",
                                )
                              }
                            />
                            <ScFieldRow
                              label="Genre"
                              scValue={scData.meta.genre}
                              currentValue={getValue("genre")}
                              onApply={() =>
                                onApplyScField("genre", scData.meta.genre ?? "")
                              }
                            />
                            <ScFieldRow
                              label="Date"
                              scValue={scData.meta.release_date}
                              currentValue={getValue("release_date")}
                              onApply={() =>
                                onApplyScField(
                                  "release_date",
                                  scData.meta.release_date ?? "",
                                )
                              }
                            />
                            {scRemix && (
                              <>
                                <ScFieldRow
                                  label="Remixer"
                                  scValue={scRemix.remixer}
                                  currentValue={getValue("remixer")}
                                  onApply={() =>
                                    onApplyScField("remixer", scRemix.remixer)
                                  }
                                />
                                <ScFieldRow
                                  label="Mix"
                                  scValue={scRemix.mixName}
                                  currentValue={getValue("mix_name")}
                                  onApply={() =>
                                    onApplyScField("mix_name", scRemix.mixName)
                                  }
                                />
                                <ScFieldRow
                                  label="Orig. Art."
                                  scValue={scData.meta.artist}
                                  currentValue={getValue("original_artist")}
                                  onApply={() =>
                                    onApplyScField(
                                      "original_artist",
                                      scData.meta.artist ?? "",
                                    )
                                  }
                                />
                              </>
                            )}
                          </div>
                        );
                      })()}

                      {/* Apply all */}
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-1 h-7 w-full gap-1.5 text-xs"
                        onClick={onApplyAllScFields}
                      >
                        <ArrowDown className="size-3" />
                        Apply all fields
                      </Button>
                    </div>
                  );
                })()}
            </PopoverContent>
          </Popover>
        );

        const primaryBtn =
          primaryKey === "apply" && applyBtn
            ? applyBtn
            : primaryKey === "sc"
              ? scBtn
              : saveBtn;

        return (
          <div
            className={cn(
              "sticky right-0 ml-auto h-full w-0 shrink-0 transition-opacity duration-150 ease-out",
              !showPill && "pointer-events-none opacity-0",
            )}
          >
            <motion.div
              layout
              whileHover={{ scale: 1.15 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
              className={cn(
                "border-border bg-card absolute top-1/2 right-3 flex origin-right -translate-y-1/2 items-center gap-1 rounded-md border shadow-[var(--shadow-2)]",
                showFull ? "p-1" : "p-0.5 [&_button]:size-6 [&_svg]:size-3",
              )}
            >
              {showFull ? (
                <>
                  {saveBtn}
                  {applyBtn}
                  {scBtn}
                </>
              ) : (
                primaryBtn
              )}
            </motion.div>
          </div>
        );
      })()}
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
  autoApplyScResults,
  pendingFieldEdits,
  setPendingFieldEdits,
}: CollectionTableProps) {
  const [sortBy, setSortBy] = useQueryState("sort", searchParams.sort);
  const [sortOrder, setSortOrder] = useQueryState("order", searchParams.order);
  const [search] = useQueryState("search", searchParams.search);
  const [genres] = useQueryState("genres", searchParams.genres);
  const [keys] = useQueryState("keys", searchParams.keys);
  const [bpmMin] = useQueryState("bpmMin", searchParams.bpmMin);
  const [bpmMax] = useQueryState("bpmMax", searchParams.bpmMax);
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

  const { load } = usePlayer();

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
  const [savingRows, setSavingRows] = useState<Set<string>>(new Set());
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

  // SoundCloud auto-fill
  const [scAutoFill, setScAutoFill] = useState(false);
  const [scStatuses, setScStatuses] = useState<Map<string, ScStatus>>(
    new Map(),
  );
  const [scDataMap, setScDataMap] = useState<Map<string, ScData>>(new Map());
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
      sortBy,
      sortOrder,
      onItemsChange,
      onTotalChange,
    ],
  );

  // Reload on mode / folderPath / filter / sort change
  const filtersKey = `${mode}|${folderPath ?? ""}|${search}|${genres.join(",")}|${keys.join(",")}|${bpmMin}|${bpmMax}|${sortBy}|${sortOrder}`;
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
    });
    onSelect?.(item);
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
      setScStatuses((prev) => new Map(prev).set(item.file_path, "searching"));

      const query = removeMix(
        item.file_name
          .replace(/\.(mp3|aiff|wav)$/i, "")
          .replace(/_/g, " ")
          .replace(/\[.*?\]/g, "")
          .trim(),
      );

      if (!query) {
        setScStatuses((prev) => new Map(prev).set(item.file_path, "not-found"));
        return;
      }

      try {
        const results = await soundCloudSource.searchTracks(query);

        if (results.length === 0) {
          setScStatuses((prev) =>
            new Map(prev).set(item.file_path, "not-found"),
          );
          return;
        }

        const meta = soundCloudSource.extractMetadata(results[0]);
        setScStatuses((prev) => new Map(prev).set(item.file_path, "found"));
        setScDataMap((prev) =>
          new Map(prev).set(item.file_path, {
            results,
            selectedIndex: 0,
            meta,
          }),
        );

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
        setScStatuses((prev) => new Map(prev).set(item.file_path, "not-found"));
      }
    },
    [setChanges],
  );

  // Per-row SC search — respects autoApplyScResults config
  const handleSearchSc = useCallback(
    (filePath: string) => {
      const item = items.find((i) => i.file_path === filePath);
      if (!item) return;
      scProcessedRef.current.add(filePath);
      searchScForItem(item, autoApplyScResults ?? false);
    },
    [items, searchScForItem, autoApplyScResults],
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

  // SC: select a different result for a row
  const handleSelectScTrack = useCallback(
    (filePath: string, index: number) => {
      setScDataMap((prev) => {
        const data = prev.get(filePath);
        if (!data) return prev;
        const next = new Map(prev);
        const selectedTrack = data.results[index];
        const meta = selectedTrack
          ? soundCloudSource.extractMetadata(selectedTrack)
          : data.meta;
        next.set(filePath, { ...data, selectedIndex: index, meta });
        // Update pending SC link if already set
        if (meta.source_id && pendingScLinks.has(filePath)) {
          const comment = serializeComment(
            meta.source_id,
            meta.source_permalink ?? "",
          );
          setPendingScLinks((p) => new Map(p).set(filePath, comment));
        }
        return next;
      });
    },
    [pendingScLinks],
  );

  // SC: apply a single field from the SC match — also sets SC link
  const handleApplyScField = useCallback(
    (filePath: string, field: EditableField, value: string) => {
      if (value) updateField(filePath, field, value);
      // Set SC link when applying any field
      const data = scDataMap.get(filePath);
      if (data?.meta.source_id) {
        const comment = serializeComment(
          data.meta.source_id,
          data.meta.source_permalink ?? "",
        );
        setPendingScLinks((prev) => new Map(prev).set(filePath, comment));
      }
    },
    [updateField, scDataMap],
  );

  // SC: apply all available fields from the SC match + set SC link
  const handleApplyAllScFields = useCallback(
    (filePath: string) => {
      const data = scDataMap.get(filePath);
      if (!data) return;
      const { meta } = data;
      if (meta.title) updateField(filePath, "title", meta.title);
      if (meta.artist) updateField(filePath, "artist", meta.artist);
      if (meta.genre) updateField(filePath, "genre", meta.genre);
      if (meta.release_date)
        updateField(filePath, "release_date", meta.release_date);
      if (meta.title) {
        const remix = parseRemix(meta.title);
        if (remix) {
          updateField(filePath, "remixer", remix.remixer);
          updateField(filePath, "mix_name", remix.mixName);
          if (meta.artist)
            updateField(filePath, "original_artist", meta.artist);
        }
      }
      // Set SC link
      if (meta.source_id) {
        const comment = serializeComment(
          meta.source_id,
          meta.source_permalink ?? "",
        );
        setPendingScLinks((prev) => new Map(prev).set(filePath, comment));
      }
    },
    [scDataMap, updateField],
  );

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

  // Per-row save
  const handleSaveRow = useCallback(
    async (filePath: string) => {
      const fileChanges = changes.get(filePath);
      const artworkB64 = pendingArtwork.get(filePath);
      const scComment = pendingScLinks.get(filePath);
      if (!fileChanges && !artworkB64 && !scComment) return;

      setSavingRows((prev) => new Set(prev).add(filePath));

      const updates = buildUpdates(fileChanges ?? {}, artworkB64, scComment);

      try {
        const result = await api.batchUpdateTrackInfo([
          { file_path: filePath, updates },
        ]);
        if (result.results[0]?.success) {
          toast.success(
            `Updated ${items.find((i) => i.file_path === filePath)?.file_name ?? "track"}`,
          );
          setChanges((prev) => {
            const next = new Map(prev);
            next.delete(filePath);
            return next;
          });
          setPendingArtwork((prev) => {
            const next = new Map(prev);
            next.delete(filePath);
            return next;
          });
          setPendingScLinks((prev) => {
            const next = new Map(prev);
            next.delete(filePath);
            return next;
          });
          triggerSavePulse(filePath);
          onEditSaved?.();
        } else {
          toast.error(result.results[0]?.message ?? "Save failed");
        }
      } catch {
        toast.error("Save failed");
      } finally {
        setSavingRows((prev) => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
      }
    },
    [
      changes,
      pendingArtwork,
      items,
      onEditSaved,
      triggerSavePulse,
      buildUpdates,
      pendingScLinks,
      setChanges,
    ],
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

  const renderStepsToast = useCallback(
    (
      trackName: string,
      steps: { type: string; status: string; message: string }[],
    ) => (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{trackName}</span>
        {steps.length > 0 && (
          <div className="mt-0.5 flex flex-col gap-0.5">
            {steps.map((step, i) => {
              const Icon = RULE_ICONS[step.type as RuleType] ?? MoveRight;
              const color =
                RULE_ICON_COLORS[step.type as RuleType] ??
                "text-muted-foreground";
              return (
                <div
                  key={i}
                  className="text-muted-foreground flex items-center gap-1.5 text-xs"
                >
                  <Icon
                    className={`size-3 shrink-0 ${step.status === "skipped" ? "opacity-30" : color}`}
                  />
                  <span
                    className={
                      step.status === "skipped" ? "line-through opacity-50" : ""
                    }
                  >
                    {step.message}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    ),
    [],
  );

  const handleFinalizeRow = useCallback(
    async (filePath: string) => {
      const item = items.find((i) => i.file_path === filePath);
      const name = item?.title || item?.file_name || filePath;
      const toastId = toast.loading(`Applying rules to "${name}"…`);
      try {
        const result = await api.finalizeTrack(filePath, {});
        toast.success(renderStepsToast(name, result.steps ?? []), {
          id: toastId,
        });
        onEditSaved?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to apply rules",
          { id: toastId },
        );
      }
    },
    [items, onEditSaved, renderStepsToast],
  );

  const runFinalizeSelected = useCallback(
    async (paths: string[]) => {
      const toastId = toast.loading(
        `Applying rules to ${paths.length} track${paths.length !== 1 ? "s" : ""}…`,
      );
      let succeeded = 0;
      let failed = 0;
      for (const fp of paths) {
        try {
          await api.finalizeTrack(fp, {});
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
    },
    [onEditSaved],
  );

  /** For a candidate track, determine if it has a resolvable ruleset and
   * whether all required attributes are satisfied under THAT ruleset. */
  const isTrackFinalizable = useCallback(
    (item: TrackBrowse): { ruleset: Ruleset | null; eligible: boolean } => {
      const rs =
        resolveRulesetForFile(item.file_path, folderRulesets, rulesets) ??
        activeRuleset ??
        null;
      if (!rs || rs.rules.length === 0) return { ruleset: rs, eligible: false };
      return {
        ruleset: rs,
        eligible: canFinalizeItem(item, rs.required_attributes),
      };
    },
    [folderRulesets, rulesets, activeRuleset],
  );

  const handleFinalizeSelected = useCallback(() => {
    const candidates =
      selectedPaths.size > 0
        ? items.filter((i) => selectedPaths.has(i.file_path))
        : items;
    const resolved = candidates.map((i) => ({
      item: i,
      ...isTrackFinalizable(i),
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
          void runFinalizeSelected(paths);
        },
      });
      return;
    }
    void runFinalizeSelected(paths);
  }, [selectedPaths, items, isTrackFinalizable, runFinalizeSelected]);

  const finalizeEligibleCount = (
    selectedPaths.size > 0
      ? items.filter((i) => selectedPaths.has(i.file_path))
      : items
  ).filter((i) => isTrackFinalizable(i).eligible).length;

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
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {selectedPaths.size > 0
            ? `${selectedPaths.size} selected`
            : `${items.length} tracks`}
        </span>

        <div className="bg-border mx-1 h-4 w-px" />

        {/* Batch actions */}
        <Select value={batchField} onValueChange={setBatchField}>
          <SelectTrigger className="h-7 w-20 text-xs">
            <SelectValue placeholder="Field" />
          </SelectTrigger>
          <SelectContent>
            {EDITABLE_FIELDS.map((f) => (
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
                    finalizeEligibleCount > 0
                      ? "text-primary hover:bg-primary/10 hover:text-primary"
                      : "text-muted-foreground",
                  )}
                  disabled={finalizeEligibleCount === 0}
                  onClick={handleFinalizeSelected}
                >
                  <Workflow className="size-3.5" />
                  <span className="max-w-[140px] overflow-hidden whitespace-nowrap opacity-100 @max-[760px]/toolbar:max-w-0 @max-[760px]/toolbar:opacity-0">
                    Apply rules
                    {finalizeEligibleCount > 0
                      ? ` (${finalizeEligibleCount})`
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
                    Each track is finalized under the ruleset bound to its
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
              setScStatuses(new Map());
              setScDataMap(new Map());
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
            {/* File name header */}
            <button
              className="hover:text-foreground flex w-48 shrink-0 cursor-pointer items-center gap-0.5 transition-colors"
              onClick={() => handleSort("file_name")}
            >
              File
              <SortIcon col="file_name" sortBy={sortBy} sortOrder={sortOrder} />
            </button>
            {/* Folder header (only in tree/path mode) */}
            {folderPath && <span className="w-36 shrink-0">Folder</span>}
            {/* Field headers — sortable where applicable */}
            {EDITABLE_FIELDS.map((f) => {
              const sortKey = SORTABLE_FIELDS[f.key];
              return sortKey ? (
                <button
                  key={f.key}
                  className={`${f.width} hover:text-foreground flex min-w-0 shrink-0 cursor-pointer items-center gap-0.5 transition-colors`}
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
                <span key={f.key} className={`${f.width} min-w-0 shrink-0`}>
                  {f.label}
                </span>
              );
            })}
            {/* Added date header — sortable by mtime */}
            <button
              className="hover:text-foreground flex w-20 shrink-0 cursor-pointer items-center gap-0.5 transition-colors"
              onClick={() => handleSort("mtime")}
            >
              Added
              <SortIcon col="mtime" sortBy={sortBy} sortOrder={sortOrder} />
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
                      transition: "transform 320ms cubic-bezier(0.2, 0, 0, 1)",
                      willChange: "transform",
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
                        scStatus={scStatuses.get(item.file_path)}
                        scData={scDataMap.get(item.file_path)}
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
                        onApplyScField={(field, value) =>
                          handleApplyScField(item.file_path, field, value)
                        }
                        onApplyAllScFields={() =>
                          handleApplyAllScFields(item.file_path)
                        }
                        onSelectScTrack={(index) =>
                          handleSelectScTrack(item.file_path, index)
                        }
                        onSearchSc={() => handleSearchSc(item.file_path)}
                        onSelect={() => handleSelect(item)}
                        onSaveRow={() => handleSaveRow(item.file_path)}
                        onFinalize={() => handleFinalizeRow(item.file_path)}
                        savingRow={savingRows.has(item.file_path)}
                        justSaved={pulseRows.has(item.file_path)}
                        pendingArtworkB64={pendingArtwork.get(item.file_path)}
                        hasScLink={
                          !!item.soundcloud_id ||
                          pendingScLinks.has(item.file_path)
                        }
                        scLinkChanged={pendingScLinks.has(item.file_path)}
                        activeRuleset={
                          resolveRulesetForFile(
                            item.file_path,
                            folderRulesets,
                            rulesets,
                          ) ?? activeRuleset
                        }
                        folderPath={folderPath}
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
