'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';

export interface BeatAnalysis {
  bpm: number;
  beats: number[];
  downbeats: number[];
}

// Module-level cache — persists across re-mounts for the same file path.
const cache = new Map<string, BeatAnalysis>();

export function useBeatAnalysis(filePath: string | null) {
  const [data, setData] = useState<BeatAnalysis | null>(
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
      .analyzeBeats(filePath)
      .then((result) => {
        if (controller.signal.aborted) return;
        cache.set(filePath, result);
        setData(result);
        setIsLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('Beat analysis failed:', err);
        setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [filePath]);

  return { beatData: data, isAnalysing: isLoading };
}
