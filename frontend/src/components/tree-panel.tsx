"use client";

import {
  Check,
  ChevronRight,
  Folder,
  FolderOpen,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { TreePanelMiniPlayer } from "@/components/tree-panel-mini-player";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { FolderRulesetBinding, Ruleset, TreeNode } from "@/lib/api";
import { useResizable } from "@/lib/use-resizable";
import { cn } from "@/lib/utils";

interface TreePanelProps {
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
  /** Storage key for persisting expanded state. */
  storageKey?: string;
}

interface ResolvedBinding {
  ruleset_id: string | null;
  recursive: boolean;
  source_path: string;
  /** True when this node has its own binding; false when inherited from an ancestor. */
  own: boolean;
}

const STORAGE_PREFIX = "tree-panel-expanded";

function resolveBinding(
  path: string,
  bindings: Record<string, FolderRulesetBinding>,
): ResolvedBinding | null {
  const own = bindings[path];
  if (own) {
    return { ...own, source_path: path, own: true };
  }
  const parts = path.replace(/\/+$/, "").split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join("/") || "/";
    const b = bindings[ancestor];
    if (b && b.recursive) {
      return { ...b, source_path: ancestor, own: false };
    }
  }
  return null;
}

export function TreePanel({
  tree,
  selectedId,
  onSelect,
  folderRulesets,
  rulesets,
  onSetRuleset,
  storageKey = "filesystem",
}: TreePanelProps) {
  const fullStorageKey = `${STORAGE_PREFIX}:${storageKey}`;

  const { width, isAnimating, handleResizeStart, handleDoubleClick } =
    useResizable({
      defaultWidth: 240,
      minWidth: 140,
      maxWidth: 480,
      storageKey: "tree-panel-width",
    });

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(fullStorageKey);
      return stored ? new Set(JSON.parse(stored)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  // Persist expanded state
  useEffect(() => {
    try {
      localStorage.setItem(fullStorageKey, JSON.stringify([...expanded]));
    } catch {
      // ignore
    }
  }, [expanded, fullStorageKey]);

  // Auto-expand ancestors of the selected node
  // TODO: refactor — derive expanded set via useMemo(selectedId, tree) instead of setState-in-effect
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!tree || !selectedId) return;
    const ancestors = findAncestors(tree, selectedId);
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ancestors) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tree, selectedId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggleExpand = useCallback((nodeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const resolveFor = useMemo(
    () => (path: string) => resolveBinding(path, folderRulesets),
    [folderRulesets],
  );

  if (!tree) {
    return (
      <div
        className="border-border relative shrink-0 border-r p-3"
        style={{ width: `${width}px` }}
      >
        <div className="text-muted-foreground text-xs">Loading...</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "border-border relative flex min-h-0 shrink-0 flex-col border-r",
        isAnimating && "transition-[width] duration-200 ease-out",
      )}
      style={{ width: `${width}px` }}
    >
      <div className="flex-1 overflow-y-auto p-2">
        <TreeNodeItem
          node={tree}
          depth={0}
          selectedId={selectedId}
          expanded={expanded}
          onSelect={onSelect}
          onToggleExpand={toggleExpand}
          resolveFor={resolveFor}
          rulesets={rulesets}
          onSetRuleset={onSetRuleset}
        />
      </div>
      <TreePanelMiniPlayer />
      {/* Resize handle */}
      <div
        className="hover:bg-brand-soft active:bg-brand-soft absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize transition-colors duration-150 hover:delay-150 hover:duration-300"
        onMouseDown={handleResizeStart}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  );
}

interface TreeNodeItemProps {
  node: TreeNode;
  depth: number;
  selectedId: string;
  expanded: Set<string>;
  onSelect: (nodeId: string) => void;
  onToggleExpand: (nodeId: string) => void;
  resolveFor: (path: string) => ResolvedBinding | null;
  rulesets: Ruleset[];
  onSetRuleset: (
    path: string,
    rulesetId: string | null,
    recursive: boolean,
  ) => void;
}

function TreeNodeItem({
  node,
  depth,
  selectedId,
  expanded,
  onSelect,
  onToggleExpand,
  resolveFor,
  rulesets,
  onSetRuleset,
}: TreeNodeItemProps) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  const isSelected = node.id === selectedId;
  const resolved = resolveFor(node.id);
  const ruleset = resolved?.ruleset_id
    ? rulesets.find((r) => r.id === resolved.ruleset_id)
    : undefined;

  // Indicator label used in the tooltip
  const indicatorTooltip = ruleset
    ? resolved!.own
      ? resolved!.recursive
        ? `Ruleset: ${ruleset.name} (applies to this folder and sub-folders)`
        : `Ruleset: ${ruleset.name}`
      : `Ruleset: ${ruleset.name} (inherited from ${resolved!.source_path})`
    : null;

  // Current direct-binding state for this node (used by the context menu)
  const ownBinding = resolved?.own ? resolved : null;
  const currentRulesetId = ownBinding?.ruleset_id ?? null;
  const currentRecursive = ownBinding?.recursive ?? false;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className={cn(
              "group flex w-full cursor-pointer items-center gap-1 rounded-sm px-2 py-1 text-left text-xs transition-colors",
              isSelected
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent",
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => onSelect(node.id)}
          >
            {hasChildren ? (
              <span
                className="flex size-4 shrink-0 items-center justify-center"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(node.id);
                }}
              >
                <ChevronRight
                  className={cn(
                    "size-3 transition-transform duration-150",
                    isExpanded && "rotate-90",
                  )}
                />
              </span>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen className="text-muted-foreground size-3.5 shrink-0" />
            ) : (
              <Folder className="text-muted-foreground size-3.5 shrink-0" />
            )}
            <span className="flex-1 truncate">{node.name}</span>
            {ruleset && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex shrink-0 items-center">
                    <Workflow
                      className={cn(
                        "size-3",
                        resolved!.own ? "text-primary" : "text-primary",
                      )}
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
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
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
      {hasChildren && isExpanded && (
        <>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expanded={expanded}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              resolveFor={resolveFor}
              rulesets={rulesets}
              onSetRuleset={onSetRuleset}
            />
          ))}
        </>
      )}
    </>
  );
}

/** Find all ancestor node IDs leading to the target. */
function findAncestors(root: TreeNode, targetId: string): string[] {
  const path: string[] = [];

  function walk(node: TreeNode): boolean {
    if (node.id === targetId) return true;
    for (const child of node.children) {
      if (walk(child)) {
        path.push(node.id);
        return true;
      }
    }
    return false;
  }

  walk(root);
  return path;
}
