import type { TreeNode } from '@/lib/api';

export type { TreeNode };

/**
 * A pluggable source of tree data for the FlatView.
 *
 * The filesystem source is built-in. Future sources (Rekordbox, Serato,
 * etc.) implement this same interface.
 */
export interface TreeSource {
  id: string;
  label: string;
  /** When true, the same track may appear under multiple nodes. */
  dedupTracks: boolean;
  /** Label for the path column in the track table. */
  pathColumnLabel: string;
  /** Load the tree structure from the backend. */
  loadTree(): Promise<TreeNode>;
}
