import { useMemo } from "react";

import type { FilterState } from "@/lib/filters/schema";
import type { SCTrack } from "@/lib/soundcloud";

export interface LikesFilterOptions {
  search: string;
  genres: string[];
  minDuration: number | null;
  maxDuration: number | null;
  excludeMyLikes: boolean;
  inCollection: boolean | null; // null = any, true = in collection, false = not in collection
}

/** Translate a schema-driven FilterState into the legacy LikesFilterOptions
 *  shape so the existing `makeLikesFilterPredicate` can still be reused
 *  verbatim. Keeps weekly/ and other callers compatible. */
export function filterStateToLikesOptions(
  state: FilterState,
): LikesFilterOptions {
  const duration = (state.duration as
    | [number | null, number | null]
    | undefined) ?? [null, null];
  return {
    search: (state.search as string | undefined) ?? "",
    genres: (state.genre as string[] | undefined) ?? [],
    minDuration: duration[0],
    maxDuration: duration[1],
    excludeMyLikes: state.exclude_my_likes === true,
    inCollection:
      state.in_collection === true
        ? true
        : state.in_collection === false
          ? false
          : null,
  };
}

type UseLikesFilterOptions = LikesFilterOptions;

interface UseLikesFilterResult {
  filteredTracks: SCTrack[];
  availableGenres: string[];
}

function extractId(track: SCTrack): number | undefined {
  if (!track.urn) return undefined;
  const parts = track.urn.split(":");
  return parseInt(parts[parts.length - 1], 10) || undefined;
}

/** Pure predicate for filtering a single track — use outside of the hook. */
export function makeLikesFilterPredicate(
  options: LikesFilterOptions,
  myLikedIds?: Set<number>,
  collectionIds?: Set<number>,
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
    }
    if (options.excludeMyLikes && myLikedIds) {
      const id = extractId(track);
      if (id && myLikedIds.has(id)) return false;
    }
    if (options.inCollection !== null && collectionIds) {
      const id = extractId(track);
      const isInCollection = id != null && collectionIds.has(id);
      if (options.inCollection && !isInCollection) return false;
      if (!options.inCollection && isInCollection) return false;
    }
    return true;
  };
}

export function useLikesFilter(
  tracks: SCTrack[],
  options: UseLikesFilterOptions,
  myLikedIds?: Set<number>,
  collectionIds?: Set<number>,
): UseLikesFilterResult {
  const availableGenres = useMemo(() => {
    const genreSet = new Set<string>();
    for (const track of tracks) {
      if (track.genre) genreSet.add(track.genre);
    }
    return [...genreSet].sort((a, b) => a.localeCompare(b));
  }, [tracks]);

  const filteredTracks = useMemo(() => {
    const predicate = makeLikesFilterPredicate(
      options,
      myLikedIds,
      collectionIds,
    );
    return tracks.filter(predicate);
  }, [tracks, options, myLikedIds, collectionIds]);

  return { filteredTracks, availableGenres };
}
