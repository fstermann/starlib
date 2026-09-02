/**
 * Camelot-wheel utilities.
 *
 * Camelot notation: ``1A..12A`` (minor) and ``1B..12B`` (major). One semitone
 * up = +7 positions mod 12 on the same letter (circle of fifths). One semitone
 * down = -7 (≡ +5) positions mod 12.
 */

const CAMELOT_RE = /^(\d{1,2})([AB])$/;

/**
 * Approximate semitone shift implied by a pitch ratio.
 *
 * ``ratio = targetBpm / currentBpm``. Returns an integer number of semitones
 * (nearest). Returns 0 for ratios that don't shift by a full semitone.
 */
export function semitonesFromBpmRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.round(12 * Math.log2(ratio));
}

/**
 * Transpose a Camelot key by ``semitones``. Returns ``null`` if the input
 * isn't a recognized Camelot string — callers should fall back to the
 * original value in that case.
 */
export function transposeCamelot(
  key: string,
  semitones: number,
): string | null {
  if (!key) return null;
  const m = key.match(CAMELOT_RE);
  if (!m) return null;
  if (semitones === 0) return key.toUpperCase();
  const num = parseInt(m[1], 10);
  const letter = m[2].toUpperCase();
  // Camelot positions are 1-based on a 12-cycle. +1 semitone == +7 positions.
  const shifted = ((((num - 1 + 7 * semitones) % 12) + 12) % 12) + 1;
  return `${shifted}${letter}`;
}
