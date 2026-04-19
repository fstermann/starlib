"use client";

import {
  ArrowUp,
  Download,
  Eraser,
  Image as ImageIcon,
  PencilLine,
  Settings2,
  XCircle,
} from "lucide-react";
import { useQueryState } from "nuqs";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CollectionTable,
  FILESYSTEM_COLUMN_DEFS,
} from "@/components/collection-table";
import { ColumnVisibilityMenu } from "@/components/columns/column-visibility-menu";
import { FiltersToolbar } from "@/components/filters/filters-toolbar";
import { SoundCloudLogo } from "@/components/icons/soundcloud-logo";
import { useTopBar } from "@/components/layout/top-bar-context";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  api,
  type FileInfo,
  type FolderConfig,
  type FolderRulesetBinding,
  type Ruleset,
  type TrackBrowse,
  type TreeNode,
} from "@/lib/api";
import { useColumnPrefs } from "@/lib/columns/use-column-prefs";
import { useFilterSchema } from "@/lib/filters/use-filter-schema";
import { useFilterState } from "@/lib/filters/use-filter-state";
import { usePlayer } from "@/lib/player-context";
import { searchParams } from "@/lib/search-params";
import { useResizable } from "@/lib/use-resizable";
import { cn } from "@/lib/utils";

import { FilesystemTreePanel } from "./filesystem-tree-panel";
import { LibraryTitle } from "./library-title";
import { TrackEditor, type AutoActions } from "./track-editor";

export function FilesystemView() {
  // Selected tree node (absolute folder path). Empty string = not yet loaded.
  const [selectedNodeId, setSelectedNodeId] = useQueryState(
    "nodeId",
    searchParams.nodeId,
  );

  // Tree data
  const [tree, setTree] = useState<TreeNode | null>(null);

  // Folder shortcuts (from config) shown as quick-access buttons in the header
  const [folderShortcuts, setFolderShortcuts] = useState<FolderConfig[]>([
    { name: "prepare", label: "Prepare", visible: true, order: 0 },
    { name: "collection", label: "Collection", visible: true, order: 1 },
    { name: "cleaned", label: "Cleaned", visible: true, order: 2 },
  ]);

  // Root folder path (needed to resolve folder shortcuts to tree node IDs)
  const [rootFolder, setRootFolder] = useState<string>("");

  // Per-path rulesets (direct bindings only — inheritance is resolved below)
  const [folderRulesets, setFolderRulesets] = useState<
    Record<string, FolderRulesetBinding>
  >({});

  // All rulesets (for context menu)
  const [allRulesets, setAllRulesets] = useState<Ruleset[]>([]);

  // Load tree, folder config, root folder, and rulesets on mount
  useEffect(() => {
    let cancelled = false;
    api
      .getFolderTree()
      .then((t) => {
        if (cancelled) return;
        setTree(t);
        setRootFolder(t.id);
        // Default to root if no node selected
        if (!selectedNodeId) {
          setSelectedNodeId(t.id);
        }
      })
      .catch(() => {});

    function loadFolders() {
      api
        .getFoldersConfig()
        .then((c) => {
          if (cancelled) return;
          const visible = c.folders
            .filter((f) => f.visible)
            .sort((a, b) => a.order - b.order);
          if (visible.length > 0) setFolderShortcuts(visible);
        })
        .catch(() => {});
    }
    loadFolders();
    window.addEventListener("folders-config-changed", loadFolders);

    api
      .getAllFolderRulesets()
      .then((data) => {
        if (!cancelled) setFolderRulesets(data.folder_rulesets);
      })
      .catch(() => {});

    api
      .getRulesets()
      .then((data) => {
        if (!cancelled) setAllRulesets(data.rulesets);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      window.removeEventListener("folders-config-changed", loadFolders);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve active ruleset for the selected node, walking ancestors for recursive bindings
  const [activeRuleset, setActiveRuleset] = useState<Ruleset | null>(null);
  const currentRulesetId = (() => {
    if (!selectedNodeId) return null;
    const own = folderRulesets[selectedNodeId];
    if (own) return own.ruleset_id;
    const parts = selectedNodeId.replace(/\/+$/, "").split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join("/") || "/";
      const b = folderRulesets[ancestor];
      if (b && b.recursive) return b.ruleset_id;
    }
    return null;
  })();

  const effectiveRulesetId = currentRulesetId;

  useEffect(() => {
    if (effectiveRulesetId) {
      const found = allRulesets.find((r) => r.id === effectiveRulesetId);
      setActiveRuleset(found ?? null);
    } else {
      setActiveRuleset(null);
    }
  }, [effectiveRulesetId, allRulesets]);

  // Handle tree node selection
  const handleTreeSelect = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedFile(null);
    setEditorOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle ruleset assignment from tree context menu
  const handleSetRuleset = useCallback(
    async (path: string, rulesetId: string | null, recursive: boolean) => {
      if (rulesetId) {
        await api.setFolderRuleset(path, rulesetId, recursive);
      } else {
        await api.deleteFolderRuleset(path);
      }
      // Refresh the mapping
      const data = await api.getAllFolderRulesets();
      setFolderRulesets(data.folder_rulesets);
    },
    [],
  );

  // Persist shortcut changes to settings. Also migrates legacy rows where an
  // absolute path was written into `name` (pre-`path`-field): moves the path
  // into `path` and replaces `name` with the basename.
  const saveShortcuts = useCallback(async (next: FolderConfig[]) => {
    const normalized = next.map((f, i) => {
      const base = { ...f, order: i };
      if (!base.path && base.name.startsWith("/")) {
        const basename = base.name.split("/").filter(Boolean).pop() ?? "folder";
        return { ...base, name: basename, path: base.name };
      }
      return base;
    });
    await api.updateFoldersConfig({ folders: normalized });
    setFolderShortcuts(normalized.filter((f) => f.visible));
    window.dispatchEvent(new CustomEvent("folders-config-changed"));
  }, []);

  const handleTogglePin = useCallback(
    async (path: string, label: string, pinned: boolean) => {
      const current = (await api.getFoldersConfig()).folders;
      const pathOf = (f: FolderConfig) => {
        if (f.path) return f.path;
        if (f.name.startsWith("/")) return f.name;
        return `${rootFolder}/${f.name}`;
      };
      const existingIdx = current.findIndex((f) => pathOf(f) === path);

      let next: FolderConfig[];
      if (pinned) {
        if (existingIdx >= 0) {
          next = current.map((f, i) =>
            i === existingIdx ? { ...f, visible: true } : f,
          );
        } else {
          // New pin. `name` is the basename, disambiguated on collision so the
          // stable id stays unique. `path` is the authoritative field.
          const basename = path.split("/").filter(Boolean).pop() ?? "folder";
          const taken = new Set(current.map((f) => f.name));
          let name = basename;
          let i = 2;
          while (taken.has(name)) name = `${basename}-${i++}`;
          next = [
            ...current,
            { name, label, visible: true, order: current.length, path },
          ];
        }
      } else {
        if (existingIdx < 0) return;
        next = current.map((f, i) =>
          i === existingIdx ? { ...f, visible: false } : f,
        );
      }
      await saveShortcuts(next);
    },
    [rootFolder, saveShortcuts],
  );

  const handleReorderShortcuts = useCallback(
    async (ids: string[]) => {
      const current = (await api.getFoldersConfig()).folders;
      const idOf = (f: FolderConfig) => f.path ?? f.name;
      const byId = new Map(current.map((f) => [idOf(f), f]));
      const visibleOrdered = ids
        .map((id) => byId.get(id))
        .filter((f): f is FolderConfig => !!f);
      const hidden = current.filter((f) => !ids.includes(idOf(f)));
      await saveShortcuts([...visibleOrdered, ...hidden]);
    },
    [saveShortcuts],
  );

  const handleRenameShortcut = useCallback(
    async (id: string, label: string) => {
      const current = (await api.getFoldersConfig()).folders;
      const idOf = (f: FolderConfig) => f.path ?? f.name;
      const next = current.map((f) => (idOf(f) === id ? { ...f, label } : f));
      await saveShortcuts(next);
    },
    [saveShortcuts],
  );

  // Track selection
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);

  // Shared pending field edits per file
  const [pendingFieldEdits, setPendingFieldEdits] = useState<
    Map<string, Record<string, string>>
  >(new Map());

  // Editor panel visibility
  const [editorOpen, setEditorOpen] = useState(false);

  // Table refresh signal
  const [refreshToken, setRefreshToken] = useState(0);

  // Reload the folder tree whenever something changes (save, finalize, etc.)
  // so folder track counts stay in sync.
  useEffect(() => {
    if (refreshToken === 0) return; // initial mount already loads the tree
    api
      .getFolderTree()
      .then(setTree)
      .catch(() => {});
  }, [refreshToken]);

  // Track items for next-track selection
  const tableItemsRef = useRef<TrackBrowse[]>([]);

  // Totals for filter bar
  const [tableTotal, setTableTotal] = useState(0);
  const [tableCacheLoading, setTableCacheLoading] = useState(false);
  const handleTotalChange = useCallback((t: number, cl: boolean) => {
    setTableTotal(t);
    setTableCacheLoading(cl);
  }, []);
  const handleItemsChange = useCallback((items: TrackBrowse[]) => {
    tableItemsRef.current = items;
  }, []);

  // Column visibility prefs (persisted per view)
  const columnPrefs = useColumnPrefs(
    "library.filesystem",
    FILESYSTEM_COLUMN_DEFS,
  );

  // Auto-action settings
  const [autoActions, setAutoActions] = useState<AutoActions>({
    autoCopyArtwork: true,
    autoCopyMetadata: true,
    autoClean: true,
    autoTitelize: false,
    autoRemoveOriginalMix: true,
    autoApplyScResults: true,
  });

  const player = usePlayer();

  // Reset editor state when selected node changes
  useEffect(() => {
    setSelectedFile(null);
    setEditorOpen(false);
    player.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  // Clear player when navigating away. Runs the cleanup once on unmount;
  // capturing the mount-time `player` is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => player.stop(), []);

  const selectNextTrack = useCallback((currentFilePath: string) => {
    const items = tableItemsRef.current;
    const idx = items.findIndex((item) => item.file_path === currentFilePath);
    const remaining = items.filter(
      (item) => item.file_path !== currentFilePath,
    );
    const next = remaining.length > 0 ? (items[idx + 1] ?? remaining[0]) : null;
    if (next) {
      const file: FileInfo = {
        file_path: next.file_path,
        file_name: next.file_name,
        file_size: next.file_size,
        file_format: next.file_format,
        has_artwork: next.has_artwork,
      };
      setSelectedFile(file);
      setEditorOpen(true);
    } else {
      setEditorOpen(false);
    }
  }, []);

  const handleTableSelect = (item: TrackBrowse) => {
    if (editorOpen && selectedFile?.file_path === item.file_path) {
      setEditorOpen(false);
      return;
    }
    const file: FileInfo = {
      file_path: item.file_path,
      file_name: item.file_name,
      file_size: item.file_size,
      file_format: item.file_format,
      has_artwork: item.has_artwork,
    };
    setSelectedFile(file);
    setEditorOpen(true);
  };

  const showEditor = editorOpen && selectedFile;

  const editorResize = useResizable({
    defaultWidth: 480,
    minWidth: 320,
    maxWidth: 800,
    storageKey: "editor-panel-width",
    direction: "left",
  });

  // Derive folderMode from selectedNodeId for backward compat with TrackEditor
  const folderMode = (() => {
    if (!selectedNodeId || !rootFolder) return "prepare";
    const rel = selectedNodeId.replace(rootFolder + "/", "");
    // If the path is a direct child of root, use it as mode
    if (!rel.includes("/") && rel !== selectedNodeId) return rel;
    // Otherwise find the first matching folder shortcut
    const shortcut = folderShortcuts.find((f) =>
      selectedNodeId.startsWith(`${rootFolder}/${f.name}`),
    );
    return shortcut?.name ?? "prepare";
  })();

  useTopBar({
    title: <LibraryTitle />,
    actions: (
      <div className="flex items-center gap-1">
        {selectedFile && !editorOpen && (
          <button
            onClick={() => setEditorOpen(true)}
            className="hover:bg-accent text-muted-foreground hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
            title="Open editor"
          >
            <PencilLine className="size-3.5" />
          </button>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <button className="hover:bg-accent text-muted-foreground hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors">
              <Settings2 className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-52" align="end">
            <div className="space-y-3">
              <h4 className="text-muted-foreground text-xs font-bold tracking-widest uppercase">
                Auto-Actions
              </h4>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="auto-artwork"
                    checked={autoActions.autoCopyArtwork}
                    onCheckedChange={(v) =>
                      setAutoActions({
                        ...autoActions,
                        autoCopyArtwork: v as boolean,
                      })
                    }
                  />
                  <label
                    htmlFor="auto-artwork"
                    className="flex cursor-pointer items-center gap-1.5 text-xs"
                  >
                    <ImageIcon className="text-muted-foreground size-3" />
                    Artwork
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="auto-metadata"
                    checked={autoActions.autoCopyMetadata}
                    onCheckedChange={(v) =>
                      setAutoActions({
                        ...autoActions,
                        autoCopyMetadata: v as boolean,
                      })
                    }
                  />
                  <label
                    htmlFor="auto-metadata"
                    className="flex cursor-pointer items-center gap-1.5 text-xs"
                  >
                    <Download className="text-muted-foreground size-3" />
                    Metadata
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="auto-clean"
                    checked={autoActions.autoClean}
                    onCheckedChange={(v) =>
                      setAutoActions({
                        ...autoActions,
                        autoClean: v as boolean,
                      })
                    }
                  />
                  <label
                    htmlFor="auto-clean"
                    className="flex cursor-pointer items-center gap-1.5 text-xs"
                  >
                    <Eraser className="text-muted-foreground size-3" />
                    Clean
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="auto-titelize"
                    checked={autoActions.autoTitelize}
                    onCheckedChange={(v) =>
                      setAutoActions({
                        ...autoActions,
                        autoTitelize: v as boolean,
                      })
                    }
                  />
                  <label
                    htmlFor="auto-titelize"
                    className="flex cursor-pointer items-center gap-1.5 text-xs"
                  >
                    <ArrowUp className="text-muted-foreground size-3" />
                    Titelize
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="auto-remove-mix"
                    checked={autoActions.autoRemoveOriginalMix}
                    onCheckedChange={(v) =>
                      setAutoActions({
                        ...autoActions,
                        autoRemoveOriginalMix: v as boolean,
                      })
                    }
                  />
                  <label
                    htmlFor="auto-remove-mix"
                    className="flex cursor-pointer items-center gap-1.5 text-xs"
                  >
                    <XCircle className="text-muted-foreground size-3" />
                    Remove &quot;Original Mix&quot;
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="auto-sc-apply"
                    checked={autoActions.autoApplyScResults}
                    onCheckedChange={(v) =>
                      setAutoActions({
                        ...autoActions,
                        autoApplyScResults: v as boolean,
                      })
                    }
                  />
                  <label
                    htmlFor="auto-sc-apply"
                    className="flex cursor-pointer items-center gap-1.5 text-xs"
                  >
                    <SoundCloudLogo className="text-muted-foreground size-3" />
                    Auto-apply SC results
                  </label>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    ),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Main content: tree | table+filters | editor */}
      <div className="flex min-h-0 flex-1">
        {/* Tree panel */}
        <FilesystemTreePanel
          tree={tree}
          selectedId={selectedNodeId ?? ""}
          onSelect={handleTreeSelect}
          folderRulesets={folderRulesets}
          rulesets={allRulesets}
          onSetRuleset={handleSetRuleset}
          shortcuts={folderShortcuts}
          rootFolder={rootFolder}
          onTogglePin={handleTogglePin}
          onReorderShortcuts={handleReorderShortcuts}
          onRenameShortcut={handleRenameShortcut}
        />

        {/* Table + editor split */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Center: filter + table */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <FilesystemFiltersToolbar
              mode={folderMode}
              folderPath={selectedNodeId ?? undefined}
              filtered={tableTotal}
              total={findNodeTrackCount(tree, selectedNodeId) ?? tableTotal}
              cacheLoading={tableCacheLoading}
              actions={
                <ColumnVisibilityMenu
                  columns={FILESYSTEM_COLUMN_DEFS}
                  isVisible={columnPrefs.isVisible}
                  setHidden={columnPrefs.setHidden}
                  onResetVisibility={columnPrefs.resetVisibility}
                  onResetOrder={columnPrefs.resetOrder}
                  onResetWidths={columnPrefs.resetWidths}
                  className="text-muted-foreground h-7 gap-1.5 text-xs"
                />
              }
            />
            <CollectionTable
              mode={folderMode}
              folderPath={selectedNodeId ?? undefined}
              refreshToken={refreshToken}
              selectedFilePath={
                editorOpen ? selectedFile?.file_path : undefined
              }
              onItemsChange={handleItemsChange}
              onSelect={handleTableSelect}
              onTotalChange={handleTotalChange}
              onEditSaved={() => setRefreshToken((t) => t + 1)}
              activeRuleset={activeRuleset}
              folderRulesets={folderRulesets}
              rulesets={allRulesets}
              autoApplyScResults={autoActions.autoApplyScResults}
              pendingFieldEdits={pendingFieldEdits}
              setPendingFieldEdits={setPendingFieldEdits}
              isColumnVisible={columnPrefs.isVisible}
              columnOrder={columnPrefs.prefs.order}
              onColumnOrderChange={columnPrefs.setOrder}
              columnWidths={columnPrefs.prefs.widths}
              onColumnWidthChange={columnPrefs.setWidth}
              onColumnWidthReset={columnPrefs.resetWidth}
            />
          </div>
          {/* Right: editor panel */}
          {showEditor && (
            <div
              className={cn(
                "bg-card border-border relative z-10 flex shrink-0 flex-col overflow-hidden border-l shadow-[-6px_0_16px_-4px_rgba(0,0,0,0.15)] dark:shadow-[-6px_0_16px_-4px_rgba(0,0,0,0.4)]",
                editorResize.isAnimating &&
                  "transition-[width] duration-200 ease-out",
              )}
              style={{ width: `${editorResize.width}px` }}
            >
              <TrackEditor
                selectedFile={selectedFile}
                folderRulesetId={effectiveRulesetId}
                autoActions={autoActions}
                onTableRefresh={() => setRefreshToken((t) => t + 1)}
                onClose={() => setEditorOpen(false)}
                onFileChange={setSelectedFile}
                onSelectNext={selectNextTrack}
                pendingFieldEdits={pendingFieldEdits}
                setPendingFieldEdits={setPendingFieldEdits}
              />
              {/* Resize handle */}
              <div
                className="hover:bg-brand-soft active:bg-brand-soft absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors duration-150 hover:delay-300 hover:duration-300"
                onMouseDown={editorResize.handleResizeStart}
                onDoubleClick={editorResize.handleDoubleClick}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Filesystem filter toolbar. Owns the URL-backed filter state and fetches a
 * conditioned filter schema (dependent counts + BPM range) from the backend.
 * Renders the shared <FiltersToolbar> with filesystem-specific inputs.
 */
/** Only render "loading…" if the active state persists > delayMs. */
function DelayedLoading({
  active,
  delayMs = 500,
}: {
  active: boolean;
  delayMs?: number;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setShow(true), delayMs);
    return () => {
      clearTimeout(t);
      setShow(false);
    };
  }, [active, delayMs]);
  if (!show) return null;
  return <span className="text-muted-foreground">loading…</span>;
}

function findNodeTrackCount(
  root: TreeNode | null,
  nodeId: string | null,
): number | null {
  if (!root || !nodeId) return null;
  const stack: TreeNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === nodeId) return node.track_count;
    for (const c of node.children) stack.push(c);
  }
  return null;
}

function FilesystemFiltersToolbar({
  mode,
  folderPath,
  filtered,
  total,
  cacheLoading,
  actions,
}: {
  mode: string;
  folderPath: string | undefined;
  filtered: number;
  total: number;
  cacheLoading: boolean;
  actions?: React.ReactNode;
}) {
  // Seed schema: enumerates every attribute this source supports. Needed so
  // useFilterState binds URL parsers upfront (before the backend responds with
  // actual options/counts). The backend response enriches options & ranges.
  const seedSchema = useMemo(
    () => ({
      source: "filesystem",
      attributes: [
        { id: "search", label: "Search", kind: "text" as const },
        { id: "genre", label: "Genre", kind: "enum" as const, options: [] },
        {
          id: "key",
          label: "Key",
          kind: "enum" as const,
          options: [],
          sortHint: "camelot" as const,
        },
        {
          id: "bpm",
          label: "BPM",
          kind: "range" as const,
          min: 0,
          max: 0,
          step: 1,
        },
      ],
    }),
    [],
  );

  const { state, set, clearAll } = useFilterState(seedSchema);
  const { schema: fetchedSchema, loading } = useFilterSchema({
    source: "filesystem",
    mode,
    folderPath,
    state,
  });

  const schema = fetchedSchema ?? seedSchema;

  return (
    <FiltersToolbar
      schema={schema}
      state={state}
      onChange={set}
      onClearAll={clearAll}
      filtered={filtered}
      total={total}
      actions={actions}
      trailing={<DelayedLoading active={cacheLoading || loading} />}
    />
  );
}
