/**
 * Row-key helpers shared by the tracklist's render loop and its derived
 * lookups. Persisted tracks key by DB id; live ``DerivedRun`` entries
 * (mid-scan, before any ``analyser_tracks`` row exists) fall back to
 * start+title.
 *
 * Keeping this in one place matters: the per-row play state broke once
 * because the render keyed rows by id while the next-start lookup keyed
 * them by ``start_s-shazam_id`` — every lookup missed, the fallback
 * span became infinite, and pressing set-play flipped *all* rows to
 * Pause.
 */

interface RowKeyable {
  start_s: number;
  title: string;
}

export function rowKeyOf(t: RowKeyable & { id?: number }): string {
  return "id" in t && t.id != null ? String(t.id) : `${t.start_s}-${t.title}`;
}

/** Map each row's key to the start of the next row (sorted by start).
 *  The last row maps to +Infinity. Used to decide which single row the
 *  set playhead is currently inside. */
export function computeNextStarts(
  tracks: Array<RowKeyable & { id?: number }>,
): Map<string, number> {
  const sorted = [...tracks].sort((a, b) => a.start_s - b.start_s);
  const m = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    m.set(
      rowKeyOf(sorted[i]),
      sorted[i + 1]?.start_s ?? Number.POSITIVE_INFINITY,
    );
  }
  return m;
}
