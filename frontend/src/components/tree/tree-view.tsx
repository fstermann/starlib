"use client";

import { useResizable } from "@/lib/use-resizable";
import { cn } from "@/lib/utils";

import { TreeNodeItem } from "./tree-node";
import type { TreeNodeShape, TreeViewProps } from "./types";
import { useTreeExpansion } from "./use-tree-expansion";

export function TreeView<N extends TreeNodeShape<N>>({
  tree,
  selectedId,
  onSelect,
  renderIcon,
  renderBadge,
  wrapNode,
  footer,
  storageKey,
  width,
  emptyState,
  hideRoot,
}: TreeViewProps<N>) {
  const {
    width: panelWidth,
    isAnimating,
    handleResizeStart,
    handleDoubleClick,
  } = useResizable({
    defaultWidth: width?.default ?? 240,
    minWidth: width?.min ?? 140,
    maxWidth: width?.max ?? 480,
    storageKey: width?.storageKey ?? "tree-panel-width",
  });

  const { expanded, toggle } = useTreeExpansion(tree, selectedId, storageKey);

  return (
    <div
      className={cn(
        "border-border relative flex min-h-0 shrink-0 flex-col border-r",
        isAnimating && "transition-[width] duration-200 ease-out",
      )}
      style={{ width: `${panelWidth}px` }}
    >
      <div className="flex-1 overflow-y-auto p-2">
        {tree ? (
          hideRoot ? (
            tree.children.map((child) => (
              <TreeNodeItem<N>
                key={child.id}
                node={child}
                depth={0}
                selectedId={selectedId}
                expanded={expanded}
                onSelect={onSelect}
                onToggleExpand={toggle}
                renderIcon={renderIcon}
                renderBadge={renderBadge}
                wrapNode={wrapNode}
              />
            ))
          ) : (
            <TreeNodeItem<N>
              node={tree}
              depth={0}
              selectedId={selectedId}
              expanded={expanded}
              onSelect={onSelect}
              onToggleExpand={toggle}
              renderIcon={renderIcon}
              renderBadge={renderBadge}
              wrapNode={wrapNode}
            />
          )
        ) : (
          (emptyState ?? (
            <div className="text-muted-foreground text-xs">Loading...</div>
          ))
        )}
      </div>
      {footer}
      <div
        className="hover:bg-brand-soft active:bg-brand-soft absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize transition-colors duration-150 hover:delay-150 hover:duration-300"
        onMouseDown={handleResizeStart}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  );
}
