'use client';

import { useState, useCallback, useEffect } from 'react';
import * as soundcloud from '@/lib/soundcloud';
import type { SCTrack } from '@/lib/soundcloud';

export interface UseSoundCloudSearchReturn {
  scQuery: string;
  setScQuery: (q: string) => void;
  scResults: SCTrack[];
  setScResults: (r: SCTrack[]) => void;
  scSearching: boolean;
  scQueryPending: boolean;
  setScQueryPending: (p: boolean) => void;
  selectedScTrack: SCTrack | null;
  setSelectedScTrack: (t: SCTrack | null) => void;
  handleScSearch: () => Promise<void>;
  handleScTrackSelect: (track: SCTrack) => void;
}

export function useSoundCloudSearch(
  scPanelOpen: boolean,
  setError: (err: string | null) => void,
): UseSoundCloudSearchReturn {
  const [scQuery, setScQuery] = useState('');
  const [scResults, setScResults] = useState<SCTrack[]>([]);
  const [scSearching, setScSearching] = useState(false);
  const [scQueryPending, setScQueryPending] = useState(false);
  const [selectedScTrack, setSelectedScTrack] = useState<SCTrack | null>(null);

  const handleScSearch = useCallback(async () => {
    if (!scQuery.trim()) return;

    const isUrl = /^https?:\/\/(www\.)?soundcloud\.com\//i.test(scQuery.trim());

    try {
      setScSearching(true);
      setError(null);
      if (isUrl) {
        const result = await soundcloud.resolveUrl(scQuery.trim());
        if (result && 'title' in result) {
          setScResults([result as SCTrack]);
          setSelectedScTrack(result as SCTrack);
        } else {
          setScResults([]);
          setSelectedScTrack(null);
          setError('URL did not resolve to a track');
        }
      } else {
        const tracks = await soundcloud.searchTracks(scQuery);
        setScResults(tracks);
        setSelectedScTrack(tracks.length > 0 ? tracks[0] : null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SoundCloud search failed');
      setScQueryPending(false);
    } finally {
      setScSearching(false);
    }
  }, [scQuery, setError]);

  const handleScTrackSelect = useCallback((track: SCTrack) => {
    setSelectedScTrack(track);
  }, []);

  // Auto-search when query changes (debounced)
  useEffect(() => {
    if (!scQuery.trim() || !scPanelOpen) {
      setScResults([]);
      setSelectedScTrack(null);
      setScQueryPending(false);
      return;
    }

    setScQueryPending(true);
    const timeoutId = setTimeout(() => {
      handleScSearch();
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [scQuery, scPanelOpen, handleScSearch]);

  return {
    scQuery,
    setScQuery,
    scResults,
    setScResults,
    scSearching,
    scQueryPending,
    setScQueryPending,
    selectedScTrack,
    setSelectedScTrack,
    handleScSearch,
    handleScTrackSelect,
  };
}
