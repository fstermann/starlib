"use client";

import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { TreeNodeShape } from "./types";

interface TreeNodeItemProps<N extends TreeNodeShape<N>> {
  node: N;
  depth: number;
  selectedId: string;
  expanded: Set<string>;
  onSelect: (nodeId: string) => void;
  onToggleExpand: (nodeId: string) => void;
  renderIcon?: (node: N, expanded: boolean) => ReactNode;
  renderBadge?: (node: N) => ReactNode;
  wrapNode?: (node: N, row: ReactNode) => ReactNode;
}

export function TreeNodeItem<N extends TreeNodeShape<N>>({
  node,
  depth,
  selectedId,
  expanded,
  onSelect,
  onToggleExpand,
  renderIcon,
  renderBadge,
  wrapNode,
}: TreeNodeItemProps<N>) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  const isSelected = node.id === selectedId;

  const icon = renderIcon ? (
    renderIcon(node, isExpanded)
  ) : isExpanded ? (
    <FolderOpen className="text-muted-foreground size-3.5 shrink-0" />
  ) : (
    <Folder className="text-muted-foreground size-3.5 shrink-0" />
  );

  const row = (
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
      {icon}
      <span className="flex-1 truncate">{node.name}</span>
      {renderBadge?.(node)}
    </button>
  );

  return (
    <>
      {wrapNode ? wrapNode(node, row) : row}
      {hasChildren && isExpanded && (
        <>
          {node.children.map((child) => (
            <TreeNodeItem<N>
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expanded={expanded}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              renderIcon={renderIcon}
              renderBadge={renderBadge}
              wrapNode={wrapNode}
            />
          ))}
        </>
      )}
    </>
  );
}
