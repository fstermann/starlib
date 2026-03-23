'use client';

import { useState, useEffect, useRef } from 'react';

// Module-level cache: avoids re-decoding the same file on re-mounts or toggling
const bufferCache = new Map<string, AudioBuffer>();

export function useAudioBuffer(audioUrl: string | null) {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!audioUrl) {
      setAudioBuffer(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const cached = bufferCache.get(audioUrl);
    if (cached) {
      setAudioBuffer(cached);
      setIsLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsLoading(true);
    setAudioBuffer(null);
    setError(null);

    (async () => {
      try {
        const res = await fetch(audioUrl, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        if (ctrl.signal.aborted) return;

        const audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        audioCtx.close();
        if (ctrl.signal.aborted) return;

        bufferCache.set(audioUrl, decoded);
        setAudioBuffer(decoded);
        setIsLoading(false);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Decode failed');
        setIsLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [audioUrl]);

  return { audioBuffer, isLoading, error };
}
