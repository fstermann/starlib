'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { api, type FileInfo, type FolderConfig, type TrackBrowse } from '@/lib/api';
import { useQueryState } from 'nuqs';
import { searchParams } from '@/lib/search-params';
import { usePlayer } from '@/lib/player-context';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CollectionFilterBar } from '@/components/collection-filter-bar';
import { CollectionTable } from '@/components/collection-table';
import { PageHeader } from '@/components/page-header';
import {
  Settings2,
  Image,
  Download,
  Eraser,
  ArrowUp,
  XCircle,
  PencilLine,
} from 'lucide-react';
import { TrackEditor, type AutoActions } from './track-editor';

function MetaEditorContent() {
  const [folderMode, setFolderMode] = useQueryState('mode', searchParams.mode);

  // Folder tabs from config (falls back to defaults while loading)
  const [folderTabs, setFolderTabs] = useState<FolderConfig[]>([
    { name: 'prepare', label: 'Prepare', visible: true, order: 0, ruleset_id: null },
    { name: 'collection', label: 'Collection', visible: true, order: 1, ruleset_id: null },
    { name: 'cleaned', label: 'Cleaned', visible: true, order: 2, ruleset_id: null },
  ]);

  useEffect(() => {
    function loadFolders() {
      api.getFoldersConfig().then((c) => {
        const visible = c.folders
          .filter((f) => f.visible)
          .sort((a, b) => a.order - b.order);
        if (visible.length > 0) setFolderTabs(visible);
      }).catch(() => { /* keep defaults */ });
    }
    loadFolders();
    window.addEventListener("folders-config-changed", loadFolders);
    return () => window.removeEventListener("folders-config-changed", loadFolders);
  }, []);

  // Track selection
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);

  // Editor panel visibility
  const [editorOpen, setEditorOpen] = useState(false);

  // Table refresh signal
  const [refreshToken, setRefreshToken] = useState(0);

  // Track items for next-track selection
  const [tableItems, setTableItems] = useState<TrackBrowse[]>([]);
  const tableItemsRef = useRef<TrackBrowse[]>([]);

  // Totals for filter bar
  const [tableTotal, setTableTotal] = useState(0);
  const [tableCacheLoading, setTableCacheLoading] = useState(false);

  // Auto-action settings (shown in PageHeader, passed to TrackEditor)
  const [autoActions, setAutoActions] = useState<AutoActions>({
    autoCopyArtwork: true,
    autoCopyMetadata: true,
    autoClean: true,
    autoTitelize: false,
    autoRemoveOriginalMix: true,
  });

  const player = usePlayer();

  // Reset editor state when folder mode changes
  useEffect(() => {
    setSelectedFile(null);
    setEditorOpen(false);
    player.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderMode]);

  // Clear player when navigating away
  useEffect(() => {
    return () => { player.stop(); };
  }, []);

  const selectNextTrack = useCallback((currentFilePath: string) => {
    const items = tableItemsRef.current;
    const idx = items.findIndex(item => item.file_path === currentFilePath);
    // Pick the next item, wrapping to the first if at the end
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
    // Clicking the active track while editor is open → close
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

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <PageHeader
        title="Meta Editor"
        controls={
              <ToggleGroup
                type="single"
                variant="outline"
                value={folderMode}
                onValueChange={(v) => { if (v) setFolderMode(v); }}
                className="h-7"
              >
                {folderTabs.map((folder) => (
                  <ToggleGroupItem
                    key={folder.name}
                    value={folder.name}
                    className="h-7 px-3 text-[10px] font-medium tracking-widest uppercase cursor-pointer"
                  >
                    {folder.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            }
            actions={
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
                {editorOpen && (
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
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            }
          />

      {/* Horizontal split: table left (60%), editor right (40%) */}
      <div
        className="grid flex-1 min-h-0 transition-[grid-template-columns] duration-300 ease-out"
        style={{ gridTemplateColumns: editorOpen && selectedFile ? '3fr 2fr' : '1fr 0fr' }}
      >
        {/* Left: filter + table */}
        <div className="flex flex-col min-w-0 overflow-hidden">
          {/* Always-visible filter bar + browse table */}
          <CollectionFilterBar mode={folderMode} total={tableTotal} cacheLoading={tableCacheLoading} />
          <CollectionTable
            mode={folderMode}
            refreshToken={refreshToken}
            selectedFilePath={editorOpen ? selectedFile?.file_path : undefined}
            onItemsChange={useCallback((items: TrackBrowse[]) => { setTableItems(items); tableItemsRef.current = items; }, [])}
            onSelect={handleTableSelect}
            onTotalChange={(t, cl) => { setTableTotal(t); setTableCacheLoading(cl); }}
          />
        </div>
        {/* Right: editor panel */}
        <div className={`overflow-hidden min-w-0 flex flex-col bg-card${editorOpen && selectedFile ? ' border-l border-border/50' : ''}`}>
          {selectedFile && (
            <TrackEditor
              selectedFile={selectedFile}
              folderMode={folderMode}
              folderRulesetId={folderTabs.find((f) => f.name === folderMode)?.ruleset_id ?? null}
              autoActions={autoActions}
              onTableRefresh={() => setRefreshToken(t => t + 1)}
              onClose={() => setEditorOpen(false)}
              onFileChange={setSelectedFile}
              onSelectNext={selectNextTrack}
            />
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
