import { useEffect, useState } from 'react';
import { getMyPlaylists, type SCPlaylist } from '@/lib/soundcloud';

interface UseWeeklyPlaylistsResult {
  playlists: SCPlaylist[];
  seenTrackIds: Set<number>;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function isWeeklyPlaylist(playlist: SCPlaylist): boolean {
  return (playlist.title ?? '').toLowerCase().includes('weekly favorites');
}

function extractId(urn: string | undefined): number | null {
  if (!urn) return null;
  const parts = urn.split(':');
  const id = parseInt(parts[parts.length - 1], 10);
  return isNaN(id) ? null : id;
}

export function useWeeklyPlaylists(): UseWeeklyPlaylistsResult {
  const [playlists, setPlaylists] = useState<SCPlaylist[]>([]);
  const [seenTrackIds, setSeenTrackIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const allPlaylists: SCPlaylist[] = [];
        let nextHref: string | undefined = undefined;

        do {
          const page = await getMyPlaylists(50, nextHref);
          const batch = page.collection ?? [];
          allPlaylists.push(...batch);
          nextHref = page.next_href ?? undefined;
        } while (nextHref && !cancelled);

        if (cancelled) return;

        const weekly = allPlaylists.filter(isWeeklyPlaylist);

        const ids = new Set<number>();
        for (const playlist of weekly) {
          for (const track of playlist.tracks ?? []) {
            const id = extractId(track.urn);
            if (id != null) ids.add(id);
          }
        }

        setPlaylists(weekly);
        setSeenTrackIds(ids);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load playlists');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [reloadKey]);

  return { playlists, seenTrackIds, loading, error, reload };
}
