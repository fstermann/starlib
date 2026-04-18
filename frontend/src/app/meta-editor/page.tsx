'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { api, type FileInfo, type FolderConfig, type TreeNode, type TrackBrowse, type Ruleset, type FolderRulesetBinding } from '@/lib/api';
import { useResizable } from '@/lib/use-resizable';
import { cn } from '@/lib/utils';
import { useQueryState } from 'nuqs';
import { searchParams } from '@/lib/search-params';
import { usePlayer } from '@/lib/player-context';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { CollectionFilterBar } from '@/components/collection-filter-bar';
import { CollectionTable } from '@/components/collection-table';
import { TreePanel } from '@/components/tree-panel';
import { useTopBar } from '@/components/layout/top-bar-context';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Settings2,
  Image,
  Download,
  Eraser,
  ArrowUp,
  XCircle,
  PencilLine,
  FolderTree,
} from 'lucide-react';
import { TrackEditor, type AutoActions } from './track-editor';
import { SoundCloudLogo } from '@/components/icons/soundcloud-logo';
import { Button } from '@/components/ui/button';

function MetaEditorContent() {
  // Selected tree node (absolute folder path). Empty string = not yet loaded.
  const [selectedNodeId, setSelectedNodeId] = useQueryState('nodeId', searchParams.nodeId);

  // Tree data
  const [tree, setTree] = useState<TreeNode | null>(null);

  // Folder shortcuts (from config) shown as quick-access buttons in the header
  const [folderShortcuts, setFolderShortcuts] = useState<FolderConfig[]>([
    { name: 'prepare', label: 'Prepare', visible: true, order: 0 },
    { name: 'collection', label: 'Collection', visible: true, order: 1 },
    { name: 'cleaned', label: 'Cleaned', visible: true, order: 2 },
  ]);

  // Root folder path (needed to resolve folder shortcuts to tree node IDs)
  const [rootFolder, setRootFolder] = useState<string>('');

  // Per-path rulesets (direct bindings only — inheritance is resolved below)
  const [folderRulesets, setFolderRulesets] = useState<Record<string, FolderRulesetBinding>>({});

  // All rulesets (for context menu)
  const [allRulesets, setAllRulesets] = useState<Ruleset[]>([]);

  // Load tree, folder config, root folder, and rulesets on mount
  useEffect(() => {
    api.getFolderTree().then((t) => {
      setTree(t);
      setRootFolder(t.id);
      // Default to root if no node selected
      if (!selectedNodeId) {
        setSelectedNodeId(t.id);
      }
    }).catch(() => {});

    function loadFolders() {
      api.getFoldersConfig().then((c) => {
        const visible = c.folders
          .filter((f) => f.visible)
          .sort((a, b) => a.order - b.order);
        if (visible.length > 0) setFolderShortcuts(visible);
      }).catch(() => {});
    }
    loadFolders();
    window.addEventListener("folders-config-changed", loadFolders);

    api.getAllFolderRulesets()
      .then((data) => setFolderRulesets(data.folder_rulesets))
      .catch(() => {});

    api.getRulesets()
      .then((data) => setAllRulesets(data.rulesets))
      .catch(() => {});

    return () => window.removeEventListener("folders-config-changed", loadFolders);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve active ruleset for the selected node, walking ancestors for recursive bindings
  const [activeRuleset, setActiveRuleset] = useState<Ruleset | null>(null);
  const currentRulesetId = (() => {
    if (!selectedNodeId) return null;
    const own = folderRulesets[selectedNodeId];
    if (own) return own.ruleset_id;
    const parts = selectedNodeId.replace(/\/+$/, '').split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join('/') || '/';
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

  // Handle folder shortcut click — find the tree node ID and select it
  const handleFolderShortcut = useCallback((folderName: string) => {
    if (!rootFolder) return;
    const nodeId = `${rootFolder}/${folderName}`;
    handleTreeSelect(nodeId);
  }, [rootFolder, handleTreeSelect]);

  // Handle ruleset assignment from tree context menu
  const handleSetRuleset = useCallback(async (
    path: string,
    rulesetId: string | null,
    recursive: boolean,
  ) => {
    if (rulesetId) {
      await api.setFolderRuleset(path, rulesetId, recursive);
    } else {
      await api.deleteFolderRuleset(path);
    }
    // Refresh the mapping
    const data = await api.getAllFolderRulesets();
    setFolderRulesets(data.folder_rulesets);
  }, []);

  // Track selection
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);

  // Shared pending field edits per file
  const [pendingFieldEdits, setPendingFieldEdits] = useState<Map<string, Record<string, string>>>(new Map());

  // Editor panel visibility
  const [editorOpen, setEditorOpen] = useState(false);

  // Table refresh signal
  const [refreshToken, setRefreshToken] = useState(0);

  // Reload the folder tree whenever something changes (save, finalize, etc.)
  // so folder track counts stay in sync.
  useEffect(() => {
    if (refreshToken === 0) return; // initial mount already loads the tree
    api.getFolderTree().then(setTree).catch(() => {});
  }, [refreshToken]);

  // Track items for next-track selection
  const [tableItems, setTableItems] = useState<TrackBrowse[]>([]);
  const tableItemsRef = useRef<TrackBrowse[]>([]);

  // Totals for filter bar
  const [tableTotal, setTableTotal] = useState(0);
  const [tableCacheLoading, setTableCacheLoading] = useState(false);

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

  // Clear player when navigating away
  useEffect(() => {
    return () => { player.stop(); };
  }, []);

  const selectNextTrack = useCallback((currentFilePath: string) => {
    const items = tableItemsRef.current;
    const idx = items.findIndex(item => item.file_path === currentFilePath);
    const remaining = items.filter(item => item.file_path !== currentFilePath);
    const next = remaining.length > 0
      ? (items[idx + 1] ?? remaining[0])
      : null;
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
    storageKey: 'editor-panel-width',
    direction: 'left',
  });

  // Derive folderMode from selectedNodeId for backward compat with TrackEditor
  const folderMode = (() => {
    if (!selectedNodeId || !rootFolder) return 'prepare';
    const rel = selectedNodeId.replace(rootFolder + '/', '');
    // If the path is a direct child of root, use it as mode
    if (!rel.includes('/') && rel !== selectedNodeId) return rel;
    // Otherwise find the first matching folder shortcut
    const shortcut = folderShortcuts.find((f) => selectedNodeId.startsWith(`${rootFolder}/${f.name}`));
    return shortcut?.name ?? 'prepare';
  })();

  // Which shortcut is active?
  const activeShortcut = (() => {
    if (!selectedNodeId || !rootFolder) return '';
    const shortcut = folderShortcuts.find((f) => `${rootFolder}/${f.name}` === selectedNodeId);
    return shortcut?.name ?? '';
  })();

  useTopBar({
    title: (
      <>
        <span>Meta Editor</span>
        <div className="w-px h-5 bg-border/50 shrink-0 mx-1" />
        <div className="flex items-center gap-2">
          {/* Source switcher (disabled placeholder) */}
          <Select value="filesystem" disabled>
            <SelectTrigger className="h-7 w-auto gap-1.5 text-[10px] font-medium tracking-widest uppercase px-3">
              <FolderTree className="size-3" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="filesystem">Filesystem</SelectItem>
            </SelectContent>
          </Select>

          {/* Folder shortcuts */}
          <div className="flex items-center gap-0.5">
            {folderShortcuts.map((folder) => (
              <Button
                key={folder.name}
                variant={activeShortcut === folder.name ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-3 text-[10px] font-medium tracking-widest uppercase cursor-pointer"
                onClick={() => handleFolderShortcut(folder.name)}
              >
                {folder.label}
              </Button>
            ))}
          </div>
        </div>
      </>
    ),
    actions: (
          <div className="flex items-center gap-1">
            {selectedFile && !editorOpen && (
              <button
                onClick={() => setEditorOpen(true)}
                className="cursor-pointer size-6 flex items-center justify-center rounded-md transition-colors hover:bg-accent/50 text-muted-foreground hover:text-foreground"
                title="Open editor"
              >
                <PencilLine className="size-3.5" />
              </button>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <button className="cursor-pointer size-6 flex items-center justify-center rounded-md transition-colors hover:bg-accent/50 text-muted-foreground hover:text-foreground">
                  <Settings2 className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-52" align="end">
                <div className="space-y-3">
                  <h4 className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">Auto-Actions</h4>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Checkbox id="auto-artwork" checked={autoActions.autoCopyArtwork} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoCopyArtwork: v as boolean })} />
                      <label htmlFor="auto-artwork" className="text-xs cursor-pointer flex items-center gap-1.5"><Image className="size-3 text-muted-foreground" />Artwork</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="auto-metadata" checked={autoActions.autoCopyMetadata} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoCopyMetadata: v as boolean })} />
                      <label htmlFor="auto-metadata" className="text-xs cursor-pointer flex items-center gap-1.5"><Download className="size-3 text-muted-foreground" />Metadata</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="auto-clean" checked={autoActions.autoClean} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoClean: v as boolean })} />
                      <label htmlFor="auto-clean" className="text-xs cursor-pointer flex items-center gap-1.5"><Eraser className="size-3 text-muted-foreground" />Clean</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="auto-titelize" checked={autoActions.autoTitelize} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoTitelize: v as boolean })} />
                      <label htmlFor="auto-titelize" className="text-xs cursor-pointer flex items-center gap-1.5"><ArrowUp className="size-3 text-muted-foreground" />Titelize</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="auto-remove-mix" checked={autoActions.autoRemoveOriginalMix} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoRemoveOriginalMix: v as boolean })} />
                      <label htmlFor="auto-remove-mix" className="text-xs cursor-pointer flex items-center gap-1.5"><XCircle className="size-3 text-muted-foreground" />Remove &quot;Original Mix&quot;</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="auto-sc-apply" checked={autoActions.autoApplyScResults} onCheckedChange={(v) => setAutoActions({ ...autoActions, autoApplyScResults: v as boolean })} />
                      <label htmlFor="auto-sc-apply" className="text-xs cursor-pointer flex items-center gap-1.5"><SoundCloudLogo className="size-3 text-muted-foreground" />Auto-apply SC results</label>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        ),
  });

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Main content: tree | table+filters | editor */}
      <div className="flex flex-1 min-h-0">
        {/* Tree panel */}
        <TreePanel
          tree={tree}
          selectedId={selectedNodeId ?? ''}
          onSelect={handleTreeSelect}
          folderRulesets={folderRulesets}
          rulesets={allRulesets}
          onSetRuleset={handleSetRuleset}
        />

        {/* Table + editor split */}
        <div className="flex flex-1 min-h-0 min-w-0">
          {/* Center: filter + table */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <CollectionFilterBar
              mode={folderMode}
              folderPath={selectedNodeId ?? undefined}
              total={tableTotal}
              cacheLoading={tableCacheLoading}
            />
            <CollectionTable
              mode={folderMode}
              folderPath={selectedNodeId ?? undefined}
              refreshToken={refreshToken}
              selectedFilePath={editorOpen ? selectedFile?.file_path : undefined}
              onItemsChange={useCallback((items: TrackBrowse[]) => { setTableItems(items); tableItemsRef.current = items; }, [])}
              onSelect={handleTableSelect}
              onTotalChange={(t, cl) => { setTableTotal(t); setTableCacheLoading(cl); }}
              onEditSaved={() => setRefreshToken(t => t + 1)}
              activeRuleset={activeRuleset}
              folderRulesets={folderRulesets}
              rulesets={allRulesets}
              autoApplyScResults={autoActions.autoApplyScResults}
              pendingFieldEdits={pendingFieldEdits}
              setPendingFieldEdits={setPendingFieldEdits}
            />
          </div>
          {/* Right: editor panel */}
          {showEditor && (
            <div
              className={cn(
                'relative shrink-0 flex flex-col bg-card border-l border-border/50 shadow-[-6px_0_16px_-4px_rgba(0,0,0,0.15)] dark:shadow-[-6px_0_16px_-4px_rgba(0,0,0,0.4)] z-10 overflow-hidden',
                editorResize.isAnimating && 'transition-[width] duration-200 ease-out',
              )}
              style={{ width: `${editorResize.width}px` }}
            >
              <TrackEditor
                selectedFile={selectedFile}
                folderMode={folderMode}
                folderRulesetId={effectiveRulesetId}
                autoActions={autoActions}
                onTableRefresh={() => setRefreshToken(t => t + 1)}
                onClose={() => setEditorOpen(false)}
                onFileChange={setSelectedFile}
                onSelectNext={selectNextTrack}
                pendingFieldEdits={pendingFieldEdits}
                setPendingFieldEdits={setPendingFieldEdits}
              />
              {/* Resize handle */}
              <div
                className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors duration-150 hover:duration-300 hover:delay-300 z-10"
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

export default function MetaEditorPage() {
  return (
    <Suspense>
      <MetaEditorContent />
    </Suspense>
  );
}
