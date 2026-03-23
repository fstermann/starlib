'use client';

import { useState, useEffect, useRef } from 'react';

export interface FrequencyBand {
  low: number;
  mid: number;
  high: number;
}

const FFT_SIZE = 1024;

// Precomputed Hann window
const hann = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

function fftMagnitudes(mono: Float32Array, offset: number, len: number): Float64Array {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let k = 0; k < FFT_SIZE; k++) {
    const idx = offset + k;
    re[k] = idx < len ? mono[idx] * hann[k] : 0;
  }

  // Cooley-Tukey in-place radix-2 FFT
  const n = FFT_SIZE;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len2 = 2; len2 <= n; len2 <<= 1) {
    const ang = (-2 * Math.PI) / len2;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len2) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < len2 >> 1; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const half = i + k + (len2 >> 1);
        const vRe = re[half] * cRe - im[half] * cIm;
        const vIm = re[half] * cIm + im[half] * cRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[half] = uRe - vRe; im[half] = uIm - vIm;
        const nr = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe; cRe = nr;
      }
    }
  }

  const mags = new Float64Array(FFT_SIZE / 2);
  for (let k = 0; k < FFT_SIZE / 2; k++) {
    mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return mags;
}

const CHUNK = 100; // bars processed before yielding to the browser

export function useFrequencyBands(audioBuffer: AudioBuffer | null, numBars = 300) {
  const [bands, setBands] = useState<FrequencyBand[] | null>(null);
  const [isComputing, setIsComputing] = useState(false);
  const cancelledRef = useRef(false);
  const lastBufferRef = useRef<AudioBuffer | null>(null);

  useEffect(() => {
    if (!audioBuffer) {
      setBands(null);
      setIsComputing(false);
      return;
    }

    if (audioBuffer === lastBufferRef.current) return;
    lastBufferRef.current = audioBuffer;

    cancelledRef.current = false;
    setBands(null);
    setIsComputing(true);

    const run = async () => {
      // Mix to mono
      const numCh = audioBuffer.numberOfChannels;
      const len = audioBuffer.length;
      const mono = new Float32Array(len);
      for (let c = 0; c < numCh; c++) {
        const ch = audioBuffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += ch[i];
      }
      if (numCh > 1) for (let i = 0; i < len; i++) mono[i] /= numCh;

      const sampleRate = audioBuffer.sampleRate;
      const binHz = sampleRate / FFT_SIZE;
      const lowEnd = Math.max(1, Math.round(250 / binHz));
      const midEnd = Math.round(4000 / binHz);
      const halfFFT = FFT_SIZE / 2;
      const samplesPerBar = len / numBars;

      const raw: FrequencyBand[] = [];

      for (let bar = 0; bar < numBars; bar++) {
        if (cancelledRef.current) return;

        const mags = fftMagnitudes(mono, Math.floor(bar * samplesPerBar), len);
        let low = 0, mid = 0, high = 0;
        for (let k = 1; k < halfFFT; k++) {
          if (k <= lowEnd) low += mags[k];
          else if (k <= midEnd) mid += mags[k];
          else high += mags[k];
        }
        raw.push({
          low: low / lowEnd,
          mid: mid / (midEnd - lowEnd),
          high: high / (halfFFT - midEnd),
        });

        // Yield to the browser every CHUNK bars to stay non-blocking
        if (bar % CHUNK === CHUNK - 1) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }

      if (cancelledRef.current) return;

      const maxLow = raw.reduce((m, b) => Math.max(m, b.low), 0) || 1;
      const maxMid = raw.reduce((m, b) => Math.max(m, b.mid), 0) || 1;
      const maxHigh = raw.reduce((m, b) => Math.max(m, b.high), 0) || 1;

      setBands(raw.map(b => ({
        low: b.low / maxLow,
        mid: b.mid / maxMid,
        high: b.high / maxHigh,
      })));
      setIsComputing(false);
    };

    run().catch(() => setIsComputing(false));

    return () => { cancelledRef.current = true; };
  }, [audioBuffer, numBars]);

  return { bands, isComputing };
}
