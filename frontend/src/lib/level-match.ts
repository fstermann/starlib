/**
 * Gain in dB for each set so they all play at the quietest one's integrated
 * loudness. Turning the louder ones down, never the quieter up, can't clip.
 * Unmeasured sets stay at 0 dB.
 */
export function levelMatchGainsDb(lufs: Array<number | null>): number[] {
  const known = lufs.filter((l): l is number => l != null);
  if (known.length === 0) return lufs.map(() => 0);
  const quietest = Math.min(...known);
  return lufs.map((l) => (l == null ? 0 : quietest - l));
}
