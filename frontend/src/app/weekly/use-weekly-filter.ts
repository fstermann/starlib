import { useMemo } from "react";

import type { FilterState } from "@/lib/filters/schema";
import type { SCTrack } from "@/lib/soundcloud";

export interface WeeklyFilterOptions {
  search: string;
  genres: string[];
  minDuration: number | null;
  maxDuration: number | null;
  trackType: "track" | "set" | null;
  excludeSeen: boolean;
  inCollection: boolean | null;
  excludeOwnLikes: boolean;
}

/** Translate a schema-driven FilterState into the legacy WeeklyFilterOptions
 *  shape so the existing `makeWeeklyFilterPredicate` can still be reused. */
export function filterStateToWeeklyOptions(
  state: FilterState,
): WeeklyFilterOptions {
  const duration = (state.duration as
    | [number | null, number | null]
    | undefined) ?? [null, null];
  const trackTypes = (state.track_type as string[] | undefined) ?? [];
  const trackType =
    trackTypes.length === 1 &&
    (trackTypes[0] === "track" || trackTypes[0] === "set")
      ? (trackTypes[0] as "track" | "set")
      : null;
  return {
    search: (state.search as string | undefined) ?? "",
    genres: (state.genre as string[] | undefined) ?? [],
    minDuration: duration[0],
    maxDuration: duration[1],
    trackType,
    // Default is EXCLUDE; user opts into including previously-added tracks.
    excludeSeen: state.include_seen !== true,
    inCollection:
      state.in_collection === true
        ? true
        : state.in_collection === false
          ? false
          : null,
    // Default is EXCLUDE; user opts into including their own liked tracks.
    excludeOwnLikes: state.include_own_likes !== true,
  };
}

interface UseWeeklyFilterResult {
  filteredTracks: SCTrack[];
  availableGenres: string[];
}

function extractId(track: SCTrack): number | undefined {
  if (!track.urn) return undefined;
  const parts = track.urn.split(":");
  return parseInt(parts[parts.length - 1], 10) || undefined;
}

/**
 * Builds a pure predicate that applies the filter options to a single track.
 * Use this when you need to filter tracks outside of `useWeeklyFilter` (e.g.
 * counting filtered tracks per playlist for the tree view).
 */
export function makeWeeklyFilterPredicate(
  options: WeeklyFilterOptions,
  seenTrackIds?: Set<number>,
  collectionIds?: Set<number>,
  likedTrackIds?: Set<number>,
): (track: SCTrack) => boolean {
  const searchLower = options.search.toLowerCase().trim();
  return (track) => {
    if (searchLower) {
      const title = (track.title ?? "").toLowerCase();
      const artist = (track.user?.username ?? "").toLowerCase();
      if (!title.includes(searchLower) && !artist.includes(searchLower))
        return false;
    }
    if (options.genres.length > 0) {
      if (!track.genre || !options.genres.includes(track.genre)) return false;
    }
    if (track.duration != null) {
      const durationSec = track.duration / 1000;
      if (options.minDuration != null && durationSec < options.minDuration)
        return false;
      if (options.maxDuration != null && durationSec > options.maxDuration)
        return false;
      if (options.trackType === "track" && durationSec >= 720) return false;
      if (options.trackType === "set" && durationSec < 720) return false;
    }
    if (options.excludeSeen && seenTrackIds) {
      const id = extractId(track);
      if (id && seenTrackIds.has(id)) return false;
    }
    if (options.inCollection !== null && collectionIds) {
      const id = extractId(track);
      const isInCollection = id != null && collectionIds.has(id);
      if (options.inCollection && !isInCollection) return false;
      if (!options.inCollection && isInCollection) return false;
    }
    if (options.excludeOwnLikes && likedTrackIds) {
      const id = extractId(track);
      if (id && likedTrackIds.has(id)) return false;
    }
    return true;
  };
}

export function useWeeklyFilter(
  tracks: SCTrack[],
  options: WeeklyFilterOptions,
  seenTrackIds?: Set<number>,
  collectionIds?: Set<number>,
  likedTrackIds?: Set<number>,
): UseWeeklyFilterResult {
  const availableGenres = useMemo(() => {
    const genreSet = new Set<string>();
    for (const track of tracks) {
      if (track.genre) genreSet.add(track.genre);
    }
    return [...genreSet].sort((a, b) => a.localeCompare(b));
  }, [tracks]);

  const filteredTracks = useMemo(() => {
    const predicate = makeWeeklyFilterPredicate(
      options,
      seenTrackIds,
      collectionIds,
      likedTrackIds,
    );
    return tracks.filter(predicate);
  }, [tracks, options, seenTrackIds, collectionIds, likedTrackIds]);

  return { filteredTracks, availableGenres };
}
