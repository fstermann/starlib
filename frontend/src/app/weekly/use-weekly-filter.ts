import { useMemo } from 'react';
import type { SCTrack } from '@/lib/soundcloud';

export interface WeeklyFilterOptions {
  search: string;
  genres: string[];
  minDuration: number | null;
  maxDuration: number | null;
  trackType: 'track' | 'set' | null;
  excludeSeen: boolean;
  inCollection: boolean | null;
  excludeOwnLikes: boolean;
}

interface UseWeeklyFilterResult {
  filteredTracks: SCTrack[];
  availableGenres: string[];
}

function extractId(track: SCTrack): number | undefined {
  if (!track.urn) return undefined;
  const parts = track.urn.split(':');
  return parseInt(parts[parts.length - 1], 10) || undefined;
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
    const searchLower = options.search.toLowerCase().trim();
    return tracks.filter((track) => {
      if (searchLower) {
        const title = (track.title ?? '').toLowerCase();
        const artist = (track.user?.username ?? '').toLowerCase();
        if (!title.includes(searchLower) && !artist.includes(searchLower)) return false;
      }

      if (options.genres.length > 0) {
        if (!track.genre || !options.genres.includes(track.genre)) return false;
      }

      if (track.duration != null) {
        const durationSec = track.duration / 1000;
        if (options.minDuration != null && durationSec < options.minDuration) return false;
        if (options.maxDuration != null && durationSec > options.maxDuration) return false;
        if (options.trackType === 'track' && durationSec >= 720) return false;
        if (options.trackType === 'set' && durationSec < 720) return false;
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
    });
  }, [
    tracks,
    options.search,
    options.genres,
    options.minDuration,
    options.maxDuration,
    options.trackType,
    options.excludeSeen,
    seenTrackIds,
    options.inCollection,
    collectionIds,
    options.excludeOwnLikes,
    likedTrackIds,
  ]);

  return { filteredTracks, availableGenres };
}
