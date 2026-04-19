import type { ReactNode } from "react";

export type TreeNodeShape<N> = {
  id: string;
  name: string;
  children: N[];
};

export interface TreeViewProps<N extends TreeNodeShape<N>> {
  tree: N | null;
  selectedId: string;
  onSelect: (nodeId: string) => void;
  renderIcon?: (node: N, expanded: boolean) => ReactNode;
  renderBadge?: (node: N) => ReactNode;
  wrapNode?: (node: N, row: ReactNode) => ReactNode;
  footer?: ReactNode;
  storageKey: string;
  width?: { default?: number; min?: number; max?: number; storageKey?: string };
  emptyState?: ReactNode;
  /** Render only the root's children (root itself is hidden). */
  hideRoot?: boolean;
}
