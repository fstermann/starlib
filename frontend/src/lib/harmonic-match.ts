/**
 * Harmonic matching on the Camelot wheel, aware of pitch from tempo changes.
 *
 * Two tracks beatmatched without key lock both play at the same tempo, so the
 * candidate sounds `12·log2(sourceBpm / candidateBpm)` semitones away from its
 * own key relative to the source. The master tempo shifts both equally and
 * cancels out of the comparison; it only changes the absolute keys heard.
 */

export type KeyRule =
  | "same"
  | "adjacent"
  | "relative"
  | "diagonal"
  | "boost2"
  | "semitone"
  | "parallel";

/** Rules in order of how safe the mix is; the first match wins. */
export const KEY_RULES: { id: KeyRule; label: string; hint: string }[] = [
  { id: "same", label: "Same", hint: "Same key" },
  { id: "adjacent", label: "±1", hint: "One step on the wheel (a fifth)" },
  { id: "relative", label: "A↔B", hint: "Relative major/minor, same number" },
  {
    id: "diagonal",
    label: "Diagonal",
    hint: "A → B +1 or B → A −1, a mood shift",
  },
  { id: "boost2", label: "±2", hint: "Two steps on the wheel (a whole tone)" },
  {
    id: "semitone",
    label: "±7",
    hint: "Seven steps on the wheel (a semitone)",
  },
  {
    id: "parallel",
    label: "Parallel",
    hint: "A → B +3 or B → A −3, e.g. Am to A",
  },
];

export const DEFAULT_KEY_RULES: KeyRule[] = [
  "same",
  "adjacent",
  "relative",
  "diagonal",
];

/** A relative pitch further than this from a whole semitone sounds detuned. */
export const DETUNE_LIMIT_SEMITONES = 0.25;

interface Camelot {
  num: number;
  minor: boolean;
}

const CAMELOT_RE = /^\s*(\d{1,2})\s*([AB])\s*$/i;
const STANDARD_RE = /^\s*([A-G])([#b]?)\s*(m|min|minor|maj|major)?\s*$/i;
const PITCH_CLASS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Parse a Camelot code (`8A`) or a key name (`Am`, `F#`, `Dbmin`). */
export function toCamelot(key: string | null | undefined): Camelot | null {
  if (!key) return null;
  const cam = key.match(CAMELOT_RE);
  if (cam) {
    const num = Number(cam[1]);
    if (num < 1 || num > 12) return null;
    return { num, minor: cam[2].toUpperCase() === "A" };
  }
  const std = key.match(STANDARD_RE);
  if (!std) return null;
  const accidental = std[2] === "#" ? 1 : std[2] === "b" ? -1 : 0;
  const pc = (PITCH_CLASS[std[1].toUpperCase()] + accidental + 12) % 12;
  const quality = std[3]?.toLowerCase() ?? "";
  const minor = quality === "m" || quality.startsWith("min");
  // A step of +7 semitones is +1 on the wheel; 1A is Ab minor, 1B is B major.
  const num = ((((pc - (minor ? 8 : 11)) * 7) % 12) + 12) % 12;
  return { num: num + 1, minor };
}

/** Steps from `a` to `b` around the wheel, in −5..+6. */
function wheelSteps(a: number, b: number): number {
  const d = (((b - a) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

/** The safest rule relating `source` to `candidate`, or null if none does. */
export function keyRelation(
  source: Camelot,
  candidate: Camelot,
): KeyRule | null {
  const steps = wheelSteps(source.num, candidate.num);
  if (source.minor === candidate.minor) {
    if (steps === 0) return "same";
    if (Math.abs(steps) === 1) return "adjacent";
    if (Math.abs(steps) === 2) return "boost2";
    // ±7 on the wheel is ∓5 once folded into −5..+6.
    if (Math.abs(steps) === 5) return "semitone";
    return null;
  }
  if (steps === 0) return "relative";
  if (steps === (source.minor ? 1 : -1)) return "diagonal";
  if (steps === (source.minor ? 3 : -3)) return "parallel";
  return null;
}

export interface HarmonicMatch {
  rule: KeyRule;
  /** Whole semitones the candidate sounds shifted relative to the source. */
  shift: number;
  /** Distance of the relative pitch from a whole semitone, in semitones. */
  detune: number;
}

/**
 * Match a candidate against the source once both play at the same tempo.
 * With `keyLock`, tempo changes leave the key alone. Returns null when either
 * key can't be parsed or no rule relates them.
 */
export function harmonicMatch(
  source: { key: string | null; bpm: number | null },
  candidate: { key: string | null; bpm: number | null },
  keyLock: boolean,
): HarmonicMatch | null {
  const src = toCamelot(source.key);
  const cand = toCamelot(candidate.key);
  if (!src || !cand) return null;
  const exact = source.bpm ? tempoShift(candidate.bpm, source.bpm, keyLock) : 0;
  const shift = Math.round(exact);
  const heard = {
    num: ((((cand.num - 1 + 7 * shift) % 12) + 12) % 12) + 1,
    minor: cand.minor,
  };
  const rule = keyRelation(src, heard);
  if (!rule) return null;
  return { rule, shift, detune: Math.abs(exact - shift) };
}

/** Exact semitones a track at `bpm` shifts when played at `refBpm`. */
export function tempoShift(
  bpm: number | null,
  refBpm: number,
  keyLock: boolean,
): number {
  if (keyLock || !bpm || refBpm <= 0) return 0;
  return 12 * Math.log2(refBpm / bpm);
}
