import { useMemo } from 'react';
import type { SCTrack } from '@/lib/soundcloud';

interface UseLikesFilterOptions {
  search: string;
  genres: string[];
  minDuration: number | null;
  maxDuration: number | null;
  excludeMyLikes: boolean;
}

interface UseLikesFilterResult {
  filteredTracks: SCTrack[];
  availableGenres: string[];
}

function extractId(track: SCTrack): number | undefined {
  if (!track.urn) return undefined;
  const parts = track.urn.split(':');
  return parseInt(parts[parts.length - 1], 10) || undefined;
}

export function useLikesFilter(
  tracks: SCTrack[],
  options: UseLikesFilterOptions,
  myLikedIds?: Set<number>,
): UseLikesFilterResult {
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
      // Search filter
      if (searchLower) {
        const title = (track.title ?? '').toLowerCase();
        const artist = (track.user?.username ?? '').toLowerCase();
        if (!title.includes(searchLower) && !artist.includes(searchLower)) return false;
      }

      // Genre filter
      if (options.genres.length > 0) {
        if (!track.genre || !options.genres.includes(track.genre)) return false;
      }

      // Duration filters (track.duration is in milliseconds)
      if (track.duration != null) {
        const durationSec = track.duration / 1000;
        if (options.minDuration != null && durationSec < options.minDuration) return false;
        if (options.maxDuration != null && durationSec > options.maxDuration) return false;
      }

      // Exclude my likes
      if (options.excludeMyLikes && myLikedIds) {
        const id = extractId(track);
        if (id && myLikedIds.has(id)) return false;
      }

      return true;
    });
  }, [tracks, options.search, options.genres, options.minDuration, options.maxDuration, options.excludeMyLikes, myLikedIds]);

  return { filteredTracks, availableGenres };
}
