"use client";

import { Check, Workflow } from "lucide-react";
import { useMemo } from "react";

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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { FolderRulesetBinding, Ruleset, TreeNode } from "@/lib/api";
import { cn } from "@/lib/utils";

interface MetaEditorTreePanelProps {
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

export function MetaEditorTreePanel({
  tree,
  selectedId,
  onSelect,
  folderRulesets,
  rulesets,
  onSetRuleset,
  storageKey = "filesystem",
}: MetaEditorTreePanelProps) {
  const resolveFor = useMemo(
    () => (path: string) => resolveBinding(path, folderRulesets),
    [folderRulesets],
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

    return (
      <>
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

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
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
    );
  };

  return (
    <TreeView<TreeNode>
      tree={tree}
      selectedId={selectedId}
      onSelect={onSelect}
      renderBadge={renderBadge}
      wrapNode={wrapNode}
      footer={<TreePanelMiniPlayer />}
      storageKey={storageKey}
    />
  );
}
