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
  /** null = any; "track" = shorter than SET_THRESHOLD_SECONDS; "set" = at or above. */
  trackType: "track" | "set" | null;
}

// A SoundCloud item is modelled as a "set" (DJ mix, podcast, compilation)
// rather than a "track" when its duration crosses this threshold. Same 12
// minute cutoff the weekly view uses — keeps semantics consistent across
// filter surfaces and avoids needing a real `kind` field on the API.
const SET_THRESHOLD_SECONDS = 720;

/** Translate a schema-driven FilterState into the legacy LikesFilterOptions
 *  shape so the existing `makeLikesFilterPredicate` can still be reused
 *  verbatim. Keeps weekly/ and other callers compatible. */
export function filterStateToLikesOptions(
  state: FilterState,
): LikesFilterOptions {
  const duration = (state.duration as
    [number | null, number | null] | undefined) ?? [null, null];
  // track_type is modelled as a multi-select enum with options ["track",
  // "set"]. A single-item selection means "only this type"; picking both
  // (or neither) is equivalent to no filter and collapses to null.
  const trackTypes = (state.track_type as string[] | undefined) ?? [];
  const trackType: "track" | "set" | null =
    trackTypes.length === 1 &&
    (trackTypes[0] === "track" || trackTypes[0] === "set")
      ? (trackTypes[0] as "track" | "set")
      : null;
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
    trackType,
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
    if (options.trackType && track.duration != null) {
      const isSet = track.duration / 1000 >= SET_THRESHOLD_SECONDS;
      if (options.trackType === "set" && !isSet) return false;
      if (options.trackType === "track" && isSet) return false;
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
