'use client';

import { useState, useEffect } from 'react';

/**
 * Number of peak columns computed per second of audio.
 * 200/sec = one column every 5ms, giving ~3000 columns visible across an 8-bar
 * window at 128 BPM (~15s). This is enough for sub-pixel resolution at typical
 * canvas widths and provides smooth wave shapes without FFT overhead.
 */
export const TEXTURE_RATE = 200;

/** True waveform texture — stores positive max and negative min per column. */
export interface WaveformTexture {
  /** Positive peaks, normalised 0..1. */
  maxPeaks: Float32Array;
  /** Negative peaks, normalised -1..0. */
  minPeaks: Float32Array;
  /** Number of columns (same as maxPeaks.length). */
  length: number;
}

/**
 * Pre-compute a high-resolution true-waveform texture from an AudioBuffer.
 *
 * Returns per-column min/max peaks at TEXTURE_RATE columns per second,
 * producing the authentic asymmetric waveform shape (like Rekordbox).
 * Computation is deferred to the next macrotask so it does not block the
 * render that triggered the effect.
 */
export function useWaveformTexture(audioBuffer: AudioBuffer | null): WaveformTexture | null {
  const [texture, setTexture] = useState<WaveformTexture | null>(null);

  useEffect(() => {
    if (!audioBuffer) {
      setTexture(null);
      return;
    }

    let cancelled = false;

    // Defer so the current render frame completes before we do the heavy work.
    const id = setTimeout(() => {
      if (cancelled) return;

      const sr  = audioBuffer.sampleRate;
      const len = audioBuffer.length;
      const numCols  = Math.ceil((len / sr) * TEXTURE_RATE);
      const spCol    = len / numCols;

      // ── Mono mix ────────────────────────────────────────────────────────
      const numCh = audioBuffer.numberOfChannels;
      const mono  = new Float32Array(len);
      for (let c = 0; c < numCh; c++) {
        const ch = audioBuffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += ch[i];
      }
      if (numCh > 1) {
        const inv = 1 / numCh;
        for (let i = 0; i < len; i++) mono[i] *= inv;
      }

      // ── Min / Max per column ─────────────────────────────────────────────
      const maxPeaks = new Float32Array(numCols);
      const minPeaks = new Float32Array(numCols);
      let globalMax = 0;

      for (let col = 0; col < numCols; col++) {
        const start = Math.floor(col * spCol);
        const end   = Math.min(Math.floor((col + 1) * spCol), len);
        let colMax = 0;
        let colMin = 0;
        for (let i = start; i < end; i++) {
          const v = mono[i];
          if (v > colMax) colMax = v;
          if (v < colMin) colMin = v;
        }
        maxPeaks[col] = colMax;
        minPeaks[col] = colMin;
        const absMax = Math.max(colMax, -colMin);
        if (absMax > globalMax) globalMax = absMax;
      }

      // ── Normalise ────────────────────────────────────────────────────────
      if (globalMax > 0) {
        const inv = 1 / globalMax;
        for (let i = 0; i < numCols; i++) {
          maxPeaks[i] *= inv;  // 0..1
          minPeaks[i] *= inv;  // -1..0
        }
      }

      if (!cancelled) setTexture({ maxPeaks, minPeaks, length: numCols });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [audioBuffer]);

  return texture;
}
