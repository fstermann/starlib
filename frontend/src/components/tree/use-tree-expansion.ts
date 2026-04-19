import { useCallback, useEffect, useMemo, useState } from "react";

import type { TreeNodeShape } from "./types";

const STORAGE_PREFIX = "tree-panel-expanded";

export function useTreeExpansion<N extends TreeNodeShape<N>>(
  tree: N | null,
  selectedId: string,
  storageKey: string,
) {
  const fullKey = `${STORAGE_PREFIX}:${storageKey}`;

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(fullKey);
      return stored ? new Set(JSON.parse(stored)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(fullKey, JSON.stringify([...expanded]));
    } catch {
      // ignore
    }
  }, [expanded, fullKey]);

  // Ancestors of the selected node are always shown expanded (derived, not stored).
  const expandedSet = useMemo(() => {
    if (!tree || !selectedId) return expanded;
    const ancestors = findAncestors(tree, selectedId);
    if (ancestors.length === 0) return expanded;
    const next = new Set(expanded);
    for (const id of ancestors) next.add(id);
    return next;
  }, [expanded, tree, selectedId]);

  const toggle = useCallback((nodeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  return { expanded: expandedSet, toggle };
}

function findAncestors<N extends TreeNodeShape<N>>(
  root: N,
  targetId: string,
): string[] {
  const path: string[] = [];

  function walk(node: N): boolean {
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
