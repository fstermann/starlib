'use client';

import { useState, useCallback, useEffect } from 'react';
import type { MusicSource, SourceTrack } from '@/lib/sources/types';

export interface UseSourceSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  results: SourceTrack[];
  setResults: (r: SourceTrack[]) => void;
  searching: boolean;
  queryPending: boolean;
  setQueryPending: (p: boolean) => void;
  selectedTrack: SourceTrack | null;
  setSelectedTrack: (t: SourceTrack | null) => void;
  handleSearch: () => Promise<void>;
  handleTrackSelect: (track: SourceTrack) => void;
}

export function useSourceSearch(
  source: MusicSource,
  panelOpen: boolean,
  setError: (err: string | null) => void,
): UseSourceSearchReturn {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SourceTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [queryPending, setQueryPending] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<SourceTrack | null>(null);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    const isUrl = /^https?:\/\//i.test(query.trim());

    try {
      setSearching(true);
      setError(null);

      if (isUrl) {
        const result = await source.resolveUrl(query.trim());
        if (result) {
          setResults([result]);
          setSelectedTrack(result);
        } else {
          setResults([]);
          setSelectedTrack(null);
          setError('URL did not resolve to a track');
        }
      } else {
        const tracks = await source.searchTracks(query);
        setResults(tracks);
        setSelectedTrack(tracks.length > 0 ? tracks[0] : null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `${source.name} search failed`);
      setQueryPending(false);
    } finally {
      setSearching(false);
    }
  }, [query, source, setError]);

  const handleTrackSelect = useCallback((track: SourceTrack) => {
    setSelectedTrack(track);
  }, []);

  // Auto-search when query changes (debounced 500 ms)
  useEffect(() => {
    if (!query.trim() || !panelOpen) {
      setResults([]);
      setSelectedTrack(null);
      setQueryPending(false);
      return;
    }

    setQueryPending(true);
    const id = setTimeout(() => {
      handleSearch();
    }, 500);

    return () => clearTimeout(id);
  }, [query, panelOpen, handleSearch]);

  return {
    query,
    setQuery,
    results,
    setResults,
    searching,
    queryPending,
    setQueryPending,
    selectedTrack,
    setSelectedTrack,
    handleSearch,
    handleTrackSelect,
  };
}
