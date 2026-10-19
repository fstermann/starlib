/**
 * A single bell (peaking) EQ band: its response, and what it does to a set's
 * measured tonal balance. The filter is the RBJ cookbook peaking biquad, the
 * same one Web Audio's ``BiquadFilterNode`` runs, so the prediction matches
 * what plays.
 */

import type { BandLevel, LoudnessReport } from "./breakdown";

export interface BellEq {
  on: boolean;
  freqHz: number;
  gainDb: number;
  q: number;
}

type Spectrum = NonNullable<LoudnessReport["spectrum"]>;

// The spectrum's points are 1/6 octave wide: each spans 1/12 octave either side of its centre.
const HALF_STEP = 2 ** (1 / 12);

/** The band's gain at ``hz``, in dB, for a filter running at ``sampleRate``. */
export function bellGainDb(eq: BellEq, hz: number, sampleRate: number): number {
  if (!eq.on || eq.gainDb === 0) return 0;
  const a = 10 ** (eq.gainDb / 40);
  const w0 = (2 * Math.PI * eq.freqHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * eq.q);
  const cos = Math.cos(w0);
  const b = [1 + alpha * a, -2 * cos, 1 - alpha * a];
  const d = [1 + alpha / a, -2 * cos, 1 - alpha / a];
  const w = (2 * Math.PI * hz) / sampleRate;
  const magnitude = (c: number[]) =>
    Math.hypot(
      c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w),
      c[1] * Math.sin(w) + c[2] * Math.sin(2 * w),
    );
  return 20 * Math.log10(magnitude(b) / magnitude(d));
}

/**
 * The spectrum after the EQ, still relative to the whole range: boosting one
 * region lowers every other region's share a little.
 */
export function equalisedSpectrum(
  spectrum: Spectrum,
  eq: BellEq,
  sampleRate: number,
): Spectrum {
  const before = spectrum.level_db.map((db) => 10 ** (db / 10));
  const after = before.map(
    (p, i) =>
      p * 10 ** (bellGainDb(eq, spectrum.centres_hz[i], sampleRate) / 10),
  );
  const shift = 10 * Math.log10(sum(after) / sum(before));
  return {
    centres_hz: spectrum.centres_hz,
    level_db: spectrum.level_db.map(
      (db, i) =>
        db + bellGainDb(eq, spectrum.centres_hz[i], sampleRate) - shift,
    ),
  };
}

/** The measured band levels after the EQ, from how the EQ reshapes the spectrum within each band. */
export function equalisedBands(
  bands: BandLevel[],
  spectrum: Spectrum,
  eq: BellEq,
  sampleRate: number,
): BandLevel[] {
  const after = equalisedSpectrum(spectrum, eq, sampleRate);
  return bands.map((band) => ({
    ...band,
    level_db:
      band.level_db +
      10 *
        Math.log10(
          spanPower(after, band.low_hz, band.high_hz) /
            spanPower(spectrum, band.low_hz, band.high_hz),
        ),
  }));
}

/** Power of the spectrum between two frequencies, sharing each point by how much of it lies inside. */
function spanPower(spectrum: Spectrum, lowHz: number, highHz: number): number {
  return sum(
    spectrum.centres_hz.map((centre, i) => {
      const low = Math.max(centre / HALF_STEP, lowHz);
      const high = Math.min(centre * HALF_STEP, highHz);
      const inside =
        high > low ? Math.log(high / low) / Math.log(HALF_STEP ** 2) : 0;
      return inside * 10 ** (spectrum.level_db[i] / 10);
    }),
  );
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
