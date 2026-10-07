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

const PITCH_CLASS: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

/**
 * Parse SoundCloud's ``key_signature`` (``"A:min"``, ``"Db:maj"``) into a
 * standard name (``"Am"``, ``"Db"``) and its Camelot code (``"8A"``, ``"3B"``).
 * Returns ``null`` for anything else.
 */
export function keyFromSoundcloud(
  signature: string | null | undefined,
): { name: string; camelot: string } | null {
  const m = signature?.trim().match(/^([A-G][#b]?):(maj|min)$/);
  if (!m) return null;
  const pc = PITCH_CLASS[m[1]];
  const minor = m[2] === "min";
  // A step of +7 semitones is +1 on the wheel; 1A is Ab minor, 1B is B major.
  const num = ((((pc - (minor ? 8 : 11)) * 7) % 12) + 12) % 12;
  return {
    name: minor ? `${m[1]}m` : m[1],
    camelot: `${num + 1}${minor ? "A" : "B"}`,
  };
}

/** Pitch-class names in SoundCloud's spelling (flats for black keys). */
const NOTE_NAMES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];

/** Standard key name (``"Am"``, ``"Db"``) for a Camelot code (``"8A"``,
 *  ``"3B"``). Returns ``null`` for anything else. */
export function keyNameFromCamelot(camelot: string): string | null {
  const m = camelot.match(CAMELOT_RE);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (num < 1 || num > 12) return null;
  const minor = m[2].toUpperCase() === "A";
  const pc = ((num - 1) * 7 + (minor ? 8 : 11)) % 12;
  return minor ? `${NOTE_NAMES[pc]}m` : NOTE_NAMES[pc];
}

/** Position on the Camelot wheel (1A, 1B, 2A, …) for sorting; unparseable
 *  signatures sort last. Finite so rank differences never go NaN. */
export function soundcloudKeyRank(
  signature: string | null | undefined,
): number {
  const key = keyFromSoundcloud(signature);
  if (!key) return 99;
  const num = parseInt(key.camelot, 10);
  return num * 2 + (key.camelot.endsWith("A") ? 0 : 1);
}
