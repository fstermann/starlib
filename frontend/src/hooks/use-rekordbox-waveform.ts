'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';

export interface RekordboxEntry {
  height: number;
  r: number;
  g: number;
  b: number;
}

export interface RekordboxBeat {
  beat: number;
  tempo: number;
  time: number;
}

interface RekordboxWaveformData {
  entries: RekordboxEntry[];
  beats: RekordboxBeat[];
  found: boolean;
  source: string;
}

// Module-level cache so switching tracks doesn't re-fetch on remount.
const cache = new Map<string, RekordboxWaveformData>();

export function useRekordboxWaveform(filePath: string | null) {
  const [data, setData] = useState<RekordboxWaveformData | null>(
    filePath ? (cache.get(filePath) ?? null) : null
  );
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!filePath) {
      setData(null);
      setIsLoading(false);
      return;
    }

    const cached = cache.get(filePath);
    if (cached) {
      setData(cached);
      setIsLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setData(null);
    setIsLoading(true);

    api
      .getRekordboxWaveform(filePath)
      .then((result) => {
        if (controller.signal.aborted) return;
        cache.set(filePath, result);
        setData(result);
        setIsLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('Rekordbox waveform fetch failed:', err);
        setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [filePath]);

  return {
    rbEntries: data?.entries ?? null,
    rbBeats: data?.beats ?? null,
    rbFound: data?.found ?? false,
    rbSource: data?.source ?? 'none',
    isLoading,
  };
}
