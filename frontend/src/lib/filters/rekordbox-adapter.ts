import type { RekordboxTrack } from "@/app/library/use-rekordbox";
import type { FilterSchemaResponse } from "@/lib/filters/schema";

export interface RekordboxSchemaInputs {
  tracks: RekordboxTrack[];
}

/**
 * Build a FilterSchemaResponse from a loaded Rekordbox playlist. Mirrors the
 * shape produced by buildSoundcloudSchema and the backend filesystem adapter
 * so <FiltersToolbar> can consume it uniformly. Counts/ranges reflect the
 * tracks as-loaded (not the post-filter view) — same simplification as the
 * SC adapter.
 */
export function buildRekordboxSchema(
  inputs: RekordboxSchemaInputs,
): FilterSchemaResponse {
  const { tracks } = inputs;

  const genreCounts: Record<string, number> = {};
  const keyCounts: Record<string, number> = {};
  let bpmMin = Infinity;
  let bpmMax = -Infinity;
  let hasBpm = false;

  for (const t of tracks) {
    if (t.genre) genreCounts[t.genre] = (genreCounts[t.genre] ?? 0) + 1;
    if (t.key) keyCounts[t.key] = (keyCounts[t.key] ?? 0) + 1;
    if (t.bpm != null && t.bpm > 0) {
      if (t.bpm < bpmMin) bpmMin = t.bpm;
      if (t.bpm > bpmMax) bpmMax = t.bpm;
      hasBpm = true;
    }
  }

  const genres = Object.keys(genreCounts).sort((a, b) => a.localeCompare(b));
  const keys = Object.keys(keyCounts);

  return {
    source: "rekordbox",
    attributes: [
      { id: "search", label: "Search", kind: "text" },
      {
        id: "genre",
        label: "Genre",
        kind: "enum",
        options: genres,
        counts: genreCounts,
      },
      {
        id: "key",
        label: "Key",
        kind: "enum",
        options: keys,
        counts: keyCounts,
        sortHint: "camelot",
      },
      ...(hasBpm
        ? [
            {
              id: "bpm",
              label: "BPM",
              kind: "range" as const,
              min: Math.floor(bpmMin),
              max: Math.ceil(bpmMax),
              step: 1,
              formatHint: "bpm" as const,
            },
          ]
        : []),
    ],
  };
}

/**
 * Apply a filter state to a list of Rekordbox tracks. Preserves the original
 * order (Rekordbox playlist ordering is meaningful — this is why sort is
 * intentionally not exposed on the Rekordbox table).
 */
export function applyRekordboxFilters(
  tracks: RekordboxTrack[],
  state: Record<string, unknown>,
): RekordboxTrack[] {
  const search = ((state.search as string) ?? "").trim().toLowerCase();
  const genres = (state.genre as string[] | undefined) ?? [];
  const keys = (state.key as string[] | undefined) ?? [];
  const bpmRange = (state.bpm as
    | [number | null, number | null]
    | undefined) ?? [null, null];
  const [bpmLo, bpmHi] = bpmRange;

  return tracks.filter((t) => {
    if (search) {
      const hay =
        `${t.title ?? ""} ${t.artist ?? ""} ${t.genre ?? ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (genres.length && (!t.genre || !genres.includes(t.genre))) return false;
    if (keys.length && (!t.key || !keys.includes(t.key))) return false;
    if (bpmLo != null && (t.bpm == null || t.bpm < bpmLo)) return false;
    if (bpmHi != null && (t.bpm == null || t.bpm > bpmHi)) return false;
    return true;
  });
}
