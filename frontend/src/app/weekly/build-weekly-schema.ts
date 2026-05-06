import type { FilterSchemaResponse } from "@/lib/filters/schema";
import type { SCTrack } from "@/lib/soundcloud";

export interface WeeklySchemaInputs {
  tracks: SCTrack[];
  hasCollection: boolean;
}

/**
 * Builds the weekly filter schema: same shape as the library soundcloud
 * adapter plus a `track_type` enum and the weekly-specific bools
 * (`exclude_seen`, `exclude_own_likes`).
 *
 * `track_type` is modelled as an enum with options ["track", "set"]; the
 * adapter in `use-weekly-filter.ts` collapses a single-item selection back to
 * the legacy nullable enum. Selecting both (or none) disables the filter.
 */
export function buildWeeklySchema(
  inputs: WeeklySchemaInputs,
): FilterSchemaResponse {
  const { tracks, hasCollection } = inputs;

  const genreCounts: Record<string, number> = {};
  let durationMin = Infinity;
  let durationMax = -Infinity;
  let hasDuration = false;
  const trackTypeCounts: Record<string, number> = { track: 0, set: 0 };
  const releaseTypeCounts: Record<string, number> = { release: 0, repost: 0 };

  for (const t of tracks) {
    if (t.genre) genreCounts[t.genre] = (genreCounts[t.genre] ?? 0) + 1;
    if (t.duration != null) {
      const s = t.duration / 1000;
      if (s < durationMin) durationMin = s;
      if (s > durationMax) durationMax = s;
      hasDuration = true;
      if (s < 720) trackTypeCounts.track += 1;
      else trackTypeCounts.set += 1;
    }
    if (t.isRepost) releaseTypeCounts.repost += 1;
    else releaseTypeCounts.release += 1;
  }

  const genres = Object.keys(genreCounts).sort((a, b) => a.localeCompare(b));

  return {
    source: "weekly",
    attributes: [
      { id: "search", label: "Search", kind: "text" },
      {
        id: "genre",
        label: "Genre",
        kind: "enum",
        options: genres,
        counts: genreCounts,
      },
      ...(hasDuration
        ? [
            {
              id: "duration",
              label: "Duration",
              kind: "range" as const,
              min: Math.floor(durationMin),
              max: Math.ceil(durationMax),
              step: 15,
              formatHint: "duration" as const,
            },
          ]
        : []),
      {
        id: "track_type",
        label: "Type",
        kind: "enum",
        options: ["track", "set"],
        counts: trackTypeCounts,
      },
      {
        id: "release_type",
        label: "Source",
        kind: "enum",
        options: ["release", "repost"],
        counts: releaseTypeCounts,
      },
      { id: "include_seen", label: "Include previously added", kind: "bool" },
      {
        id: "include_own_likes",
        label: "Include my liked tracks",
        kind: "bool",
      },
      ...(hasCollection
        ? [
            {
              id: "in_collection",
              label: "In collection",
              kind: "bool" as const,
            },
          ]
        : []),
    ],
  };
}
