import { useMemo } from 'react';

export function useWaveformPeaks(audioBuffer: AudioBuffer | null, numBars = 300) {
  const peaks = useMemo<number[] | null>(() => {
    if (!audioBuffer) return null;

    // Mix all channels down to mono
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < numChannels; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += ch[i];
    }
    if (numChannels > 1) {
      for (let i = 0; i < length; i++) mono[i] /= numChannels;
    }

    const samplesPerBar = length / numBars;
    const result = new Array<number>(numBars);
    let maxVal = 0;

    for (let i = 0; i < numBars; i++) {
      const start = Math.floor(i * samplesPerBar);
      const end = Math.min(Math.floor((i + 1) * samplesPerBar), length);
      let peak = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(mono[j]);
        if (abs > peak) peak = abs;
      }
      result[i] = peak;
      if (peak > maxVal) maxVal = peak;
    }

    // Normalize to [0, 1]
    if (maxVal > 0) {
      for (let i = 0; i < numBars; i++) result[i] /= maxVal;
    }

    return result;
  }, [audioBuffer, numBars]);

  return { peaks, isReady: peaks !== null };
}
