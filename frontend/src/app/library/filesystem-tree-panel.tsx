"use client";

import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  GripVertical,
  Pencil,
  Pin,
  PinOff,
  Workflow,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { TreePanelMiniPlayer } from "@/components/tree-panel-mini-player";
import { TreeView } from "@/components/tree/tree-view";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  FolderConfig,
  FolderRulesetBinding,
  Ruleset,
  TreeNode,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface FilesystemTreePanelProps {
  tree: TreeNode | null;
  selectedId: string;
  onSelect: (nodeId: string) => void;
  /** Map of absolute folder path → direct binding (no inheritance applied). */
  folderRulesets: Record<string, FolderRulesetBinding>;
  /** All available rulesets (for the context menu). */
  rulesets: Ruleset[];
  /** Called when the user assigns/removes a ruleset via context menu. */
  onSetRuleset: (
    path: string,
    rulesetId: string | null,
    recursive: boolean,
  ) => void;
  /** Pinned folder shortcuts (configured in settings). Rendered above the tree. */
  shortcuts: FolderConfig[];
  /** Root folder path — used to resolve legacy `{name}` shortcuts to a path. */
  rootFolder: string;
  /** Pin/unpin an absolute folder path. */
  onTogglePin: (path: string, label: string, pinned: boolean) => void;
  /** Persist a new shortcut order. `ids` are shortcut stable ids (`path ?? name`). */
  onReorderShortcuts: (ids: string[]) => void;
  /** Rename a shortcut's label. `id` is the shortcut's stable id. */
  onRenameShortcut: (id: string, label: string) => void;
  /** Storage key for persisting expanded state. */
  storageKey?: string;
}

interface ResolvedBinding {
  ruleset_id: string | null;
  recursive: boolean;
  source_path: string;
  own: boolean;
}

function resolveBinding(
  path: string,
  bindings: Record<string, FolderRulesetBinding>,
): ResolvedBinding | null {
  const own = bindings[path];
  if (own) return { ...own, source_path: path, own: true };
  const parts = path.replace(/\/+$/, "").split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join("/") || "/";
    const b = bindings[ancestor];
    if (b && b.recursive) return { ...b, source_path: ancestor, own: false };
  }
  return null;
}

function effectivePath(f: FolderConfig, rootFolder: string): string {
  if (f.path) return f.path;
  // Legacy rows that stored an absolute path in `name` (before the `path` field
  // existed) — treat them as already-absolute instead of concatenating.
  if (f.name.startsWith("/")) return f.name;
  return `${rootFolder}/${f.name}`;
}

function shortcutId(f: FolderConfig): string {
  return f.path ?? f.name;
}

/** Human-readable path, shortened to ~/... when under the root. */
function displayPath(absPath: string, rootFolder: string): string {
  if (!rootFolder) return absPath;
  const prefix = rootFolder.replace(/\/+$/, "");
  if (absPath === prefix) return "/";
  if (absPath.startsWith(prefix + "/")) return absPath.slice(prefix.length + 1);
  return absPath;
}

// ─── Sortable shortcut row ──────────────────────────────────────────────────────

function ShortcutRow({
  folder,
  rootFolder,
  isSelected,
  onSelect,
  onUnpin,
  onRename,
}: {
  folder: FolderConfig;
  rootFolder: string;
  isSelected: boolean;
  onSelect: (path: string) => void;
  onUnpin: () => void;
  onRename: (label: string) => void;
}) {
  const id = shortcutId(folder);
  const path = effectivePath(folder, rootFolder);
  const relPath = displayPath(path, rootFolder);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.label);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(folder.label);
    setEditing(true);
    // Focus after render
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function commit() {
    const next = draft.trim();
    if (next && next !== folder.label) onRename(next);
    setEditing(false);
  }

  function cancel() {
    setDraft(folder.label);
    setEditing(false);
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          className={cn(
            "group relative flex items-center gap-1 rounded-sm pr-1 transition-colors",
            isSelected
              ? "bg-brand-soft text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-accent",
            isDragging && "opacity-50",
          )}
        >
          <button
            {...attributes}
            {...listeners}
            tabIndex={-1}
            aria-label="Drag to reorder"
            className="flex size-4 shrink-0 cursor-grab items-center justify-center opacity-0 transition-opacity group-hover:opacity-60 active:cursor-grabbing"
          >
            <GripVertical className="size-3" />
          </button>

          {editing ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5">
              <Pin className="text-muted-foreground/70 size-3 shrink-0 -rotate-45" />
              <Input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  else if (e.key === "Escape") cancel();
                }}
                className="h-5 min-w-0 flex-1 px-1 py-0 text-xs"
              />
            </div>
          ) : (
            <button
              onClick={() => onSelect(path)}
              onDoubleClick={(e) => {
                e.preventDefault();
                startEdit();
              }}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 text-left text-xs"
            >
              <Pin
                className={cn(
                  "size-3 shrink-0 -rotate-45",
                  isSelected ? "text-primary" : "text-muted-foreground/70",
                )}
              />
              <span className="flex-1 truncate">{folder.label}</span>
            </button>
          )}

          {!editing && (
            <>
              <button
                onClick={startEdit}
                aria-label={`Rename ${folder.label}`}
                className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
              >
                <Pencil className="size-3" />
              </button>
              <button
                onClick={onUnpin}
                aria-label={`Unpin ${folder.label}`}
                className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
              >
                <PinOff className="size-3" />
              </button>
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" className="max-w-xs text-xs">
        <span className="font-mono break-all">{relPath}</span>
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Tree panel ────────────────────────────────────────────────────────────────

export function FilesystemTreePanel({
  tree,
  selectedId,
  onSelect,
  folderRulesets,
  rulesets,
  onSetRuleset,
  shortcuts,
  rootFolder,
  onTogglePin,
  onReorderShortcuts,
  onRenameShortcut,
  storageKey = "filesystem",
}: FilesystemTreePanelProps) {
  const resolveFor = useMemo(
    () => (path: string) => resolveBinding(path, folderRulesets),
    [folderRulesets],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const pinnedPaths = useMemo(
    () => new Set(shortcuts.map((s) => effectivePath(s, rootFolder))),
    [shortcuts, rootFolder],
  );

  const renderBadge = (node: TreeNode) => {
    const resolved = resolveFor(node.id);
    const ruleset = resolved?.ruleset_id
      ? rulesets.find((r) => r.id === resolved.ruleset_id)
      : undefined;

    const indicatorTooltip = ruleset
      ? resolved!.own
        ? resolved!.recursive
          ? `Ruleset: ${ruleset.name} (applies to this folder and sub-folders)`
          : `Ruleset: ${ruleset.name}`
        : `Ruleset: ${ruleset.name} (inherited from ${resolved!.source_path})`
      : null;

    const isPinned = pinnedPaths.has(node.id);

    return (
      <>
        {isPinned && (
          <Pin
            className="text-muted-foreground/60 size-2.5 shrink-0 -rotate-45"
            aria-label="Pinned as shortcut"
          />
        )}
        {ruleset && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 items-center">
                <Workflow
                  className="text-primary size-3"
                  {...(resolved!.own && resolved!.recursive
                    ? { strokeWidth: 2.5 }
                    : {})}
                />
                {resolved!.own && resolved!.recursive && (
                  <span className="text-primary ml-0.5 text-xs leading-none font-semibold">
                    R
                  </span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {indicatorTooltip}
            </TooltipContent>
          </Tooltip>
        )}
        {node.track_count > 0 && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {node.track_count}
          </span>
        )}
      </>
    );
  };

  const wrapNode = (node: TreeNode, row: React.ReactNode) => {
    const resolved = resolveFor(node.id);
    const ownBinding = resolved?.own ? resolved : null;
    const currentRulesetId = ownBinding?.ruleset_id ?? null;
    const currentRecursive = ownBinding?.recursive ?? false;

    const canPin = !!node.id && node.id !== rootFolder;
    const isPinned = pinnedPaths.has(node.id);

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem
            className="text-xs"
            disabled={!canPin}
            onSelect={(e) => {
              e.preventDefault();
              if (canPin) onTogglePin(node.id, node.name, !isPinned);
            }}
          >
            {isPinned ? (
              <PinOff className="mr-2 size-3.5" />
            ) : (
              <Pin className="mr-2 size-3.5 -rotate-45" />
            )}
            {isPinned ? "Remove shortcut" : "Pin as shortcut"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger className="text-xs">
              <Workflow className="mr-2 size-3.5" />
              Ruleset
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-56">
              <ContextMenuItem
                className="text-muted-foreground text-xs"
                disabled={!ownBinding}
                onSelect={(e) => {
                  e.preventDefault();
                  onSetRuleset(node.id, null, false);
                }}
              >
                None <span className="text-xs opacity-70">(use global)</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              {rulesets.map((r) => (
                <ContextMenuItem
                  key={r.id}
                  className="text-xs"
                  onSelect={(e) => {
                    e.preventDefault();
                    onSetRuleset(node.id, r.id, currentRecursive);
                  }}
                >
                  {r.name}
                  {currentRulesetId === r.id && (
                    <span className="text-primary ml-auto text-xs">Active</span>
                  )}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-xs"
                disabled={!currentRulesetId}
                onSelect={(e) => {
                  e.preventDefault();
                  onSetRuleset(node.id, currentRulesetId, !currentRecursive);
                }}
              >
                <span
                  className={cn(
                    "mr-2 inline-flex size-3.5 items-center justify-center rounded-[3px] border",
                    currentRecursive
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/40",
                  )}
                >
                  {currentRecursive && <Check className="size-2.5" />}
                </span>
                Apply to sub-folders
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = shortcuts.map(shortcutId);
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    onReorderShortcuts(arrayMove(ids, oldIdx, newIdx));
  }

  const header =
    rootFolder && shortcuts.length > 0 ? (
      <div className="border-border/60 mb-2 flex flex-col gap-0.5 border-b pb-2">
        <div className="text-muted-foreground px-2 pb-0.5 text-[10px] font-semibold tracking-wider uppercase">
          Pinned
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={shortcuts.map(shortcutId)}
            strategy={verticalListSortingStrategy}
          >
            {shortcuts.map((folder) => {
              const path = effectivePath(folder, rootFolder);
              return (
                <ShortcutRow
                  key={shortcutId(folder)}
                  folder={folder}
                  rootFolder={rootFolder}
                  isSelected={path === selectedId}
                  onSelect={onSelect}
                  onUnpin={() => onTogglePin(path, folder.label, false)}
                  onRename={(label) =>
                    onRenameShortcut(shortcutId(folder), label)
                  }
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
    ) : null;

  return (
    <TreeView<TreeNode>
      tree={tree}
      selectedId={selectedId}
      onSelect={onSelect}
      renderBadge={renderBadge}
      wrapNode={wrapNode}
      header={header}
      footer={<TreePanelMiniPlayer />}
      storageKey={storageKey}
    />
  );
}
