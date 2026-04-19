/**
 * Column definitions + persisted preferences shared by both the filesystem
 * and SoundCloud tables. A minimal shape for now — drag-reorder and resize
 * prefs (order[], widths{}) will slot in later without breaking callers.
 */

export interface ColumnDef {
  /** Stable id — also the persistence key. */
  id: string;
  /** Header label. */
  header: string;
  /** Whether the column is visible by default. Columns default to visible. */
  defaultVisible?: boolean;
  /** Mark columns the user should not be able to hide (e.g. a title column). */
  required?: boolean;
}

export interface ColumnPrefs {
  /** IDs of columns the user has explicitly hidden. */
  hidden: string[];
  /** User-chosen column order by id. Empty means "use the defs' natural order". */
  order: string[];
  /** User-resized column widths by id (pixels). Missing = use default. */
  widths: Record<string, number>;
}

export const emptyPrefs: ColumnPrefs = { hidden: [], order: [], widths: {} };

/**
 * Applies a user order to a column list. Unknown ids in `order` are ignored;
 * columns not in `order` are appended in their original position order. Keeps
 * the list stable when new columns are added to the defs.
 */
export function applyOrder<T extends { id: string }>(
  cols: T[],
  order: string[] | undefined,
): T[] {
  if (!order || !order.length) return cols;
  const byId = new Map(cols.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c && !seen.has(id)) {
      out.push(c);
      seen.add(id);
    }
  }
  for (const c of cols) {
    if (!seen.has(c.id)) out.push(c);
  }
  return out;
}

export function isColumnVisible(col: ColumnDef, prefs: ColumnPrefs): boolean {
  if (col.required) return true;
  if (prefs.hidden.includes(col.id)) return false;
  return col.defaultVisible !== false;
}
