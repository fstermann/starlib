import type { FilterSchemaResponse } from "@/lib/filters/schema";
import type { SCTrack } from "@/lib/soundcloud";

export interface SoundcloudSchemaInputs {
  tracks: SCTrack[];
}

/**
 * Computes a FilterSchemaResponse directly from the in-browser SCTrack list.
 * This is the client-side counterpart to the backend filesystem adapter —
 * same shape, same consumer code.
 *
 * Counts are NOT dependent on current filter state (the backend version is).
 * We can add dependent counts later by re-running the schema builder against
 * the already-filtered track list.
 */
export function buildSoundcloudSchema(
  inputs: SoundcloudSchemaInputs,
): FilterSchemaResponse {
  const { tracks } = inputs;

  const genreCounts: Record<string, number> = {};
  let durationMin = Infinity;
  let durationMax = -Infinity;
  let hasDuration = false;
  // Same 12-minute heuristic as the weekly view — keeps the track/set
  // split consistent wherever users toggle it.
  const trackTypeCounts: Record<string, number> = { track: 0, set: 0 };

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
  }

  const genres = Object.keys(genreCounts).sort((a, b) => a.localeCompare(b));

  return {
    source: "soundcloud",
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
      { id: "in_collection", label: "In collection", kind: "bool" },
      { id: "exclude_my_likes", label: "Exclude my likes", kind: "bool" },
    ],
  };
}
