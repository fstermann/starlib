/**
 * Pure decoders and window math for the zoomed ("detail") waveform.
 *
 * The bottom player can zoom down to a few bars. At that scale the whole-track
 * preview waveforms (1200/400 columns) are far too coarse, so we decode the
 * high-resolution ANLZ detail waveforms (~150 columns/second) — PWV5 colour or
 * PWV3 monochrome — or, for local files, the backend's high-resolution ffmpeg
 * peaks. All three normalize to a {@link DetailWave}: per-column heights in
 * `[0, 1]`, optional packed RGB colours, and a columns-per-second rate so the
 * renderer can map playback time to a column.
 *
 * These functions are deliberately free of React/canvas so they can be unit
 * tested and reused by the row waveforms later.
 */

export interface DetailWave {
  /** Per-column amplitude, normalized to `[0, 1]`. */
  heights: Float32Array;
  /** Packed `0xRRGGBB` per column, or `null` to let the renderer theme it. */
  colors: Uint32Array | null;
  /** Columns per second — maps a time (s) to a fractional column index. */
  columnsPerSecond: number;
}

/** Rekordbox detail waveforms carry 150 columns per second. */
export const DETAIL_COLUMNS_PER_SECOND = 150;

/** Pack 8-bit R/G/B into a single `0xRRGGBB` number. */
function pack(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/** Format a packed `0xRRGGBB` colour as a CSS `rgb(...)` string. */
export function rgbCss(packed: number): string {
  return `rgb(${(packed >> 16) & 0xff}, ${(packed >> 8) & 0xff}, ${packed & 0xff})`;
}

/** Perceived luminance of a `#RRGGBB` colour (0–255). */
export function hexLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Black or white text, whichever reads on `hex`. */
export function textOn(hex: string): string {
  return hexLuminance(hex) > 150 ? "#000" : "#fff";
}

/** Hot-cue slot (1-based) to its rekordbox letter: 1 → "A". */
export function hotCueLetter(index: number | null | undefined): string {
  return index != null ? String.fromCharCode(64 + index) : "H";
}

/**
 * Rekordbox's "Colourful" hot-cue palette, per slot A–H (wrapping past H).
 * Local-install cues store no colour — Rekordbox applies the scheme by slot —
 * so we tint each hot cue by its slot; an explicit colour (e.g. a USB export's
 * ANLZ RGB) always wins. Values sampled from Rekordbox's own hot-cue pads.
 */
const HOT_CUE_PALETTE = [
  "#eb4b71", // A
  "#62aad7", // B
  "#8cbf52", // C
  "#a274f7", // D
  "#68cf78", // E
  "#d16b32", // F
  "#3a59f6", // G
  "#c0b039", // H
];
/** Neutral marker colour for memory cues (they aren't colour-coded). */
const MEMORY_CUE_COLOR = "#f43f5e";
/** Rekordbox shows loops in a fixed orange, overriding the slot colour. */
const LOOP_CUE_COLOR = "#f09235";

export interface CueDisplayInput {
  type: string;
  index?: number | null;
  color?: string | null;
  timeMs?: number;
  /** Loop out-point (ms); a cue with `outMs > timeMs` is a loop. */
  outMs?: number | null;
}

export interface CueDisplay {
  /** Resolved marker colour (`#RRGGBB`). */
  color: string;
  /** Marker glyph: a letter (A, B…) for hot cues, a number for memory cues. */
  label: string;
  /** True for hot cues (colour-coded), false for memory cues (numbered). */
  isHot: boolean;
  /** True when the cue is a loop (out-point set) → orange + loop glyph. */
  isLoop: boolean;
}

/**
 * Resolve how each cue renders: hot cues get a colour (from the cue, else its
 * slot palette) and their letter; memory cues get a sequential number from 1
 * (they carry no label in Rekordbox). Loops override the colour with Rekordbox's
 * loop orange. Input order is assumed time-sorted, so memory numbering follows
 * playback order.
 */
export function computeCueDisplays(
  cues: readonly CueDisplayInput[],
): CueDisplay[] {
  let memoryNumber = 0;
  return cues.map((c) => {
    const isLoop = c.outMs != null && c.timeMs != null && c.outMs > c.timeMs;
    if (c.type === "hot") {
      const slot = c.index ?? 1;
      const base =
        c.color ?? HOT_CUE_PALETTE[(slot - 1) % HOT_CUE_PALETTE.length];
      return {
        color: isLoop ? LOOP_CUE_COLOR : base,
        label: hotCueLetter(c.index),
        isHot: true,
        isLoop,
      };
    }
    memoryNumber += 1;
    return {
      color: isLoop ? LOOP_CUE_COLOR : (c.color ?? MEMORY_CUE_COLOR),
      label: String(memoryNumber),
      isHot: false,
      isLoop,
    };
  });
}

/**
 * Decode PWV5 colour-detail bytes (2 bytes/column, big-endian). Bit layout per
 * column: `rrr ggg bbb hhhhh 00` (3-bit R/G/B, 5-bit height).
 */
export function decodePwv5(bytes: Uint8Array): DetailWave {
  const n = Math.floor(bytes.length / 2);
  const heights = new Float32Array(n);
  const colors = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
    const r = (x >> 13) & 0x7;
    const g = (x >> 10) & 0x7;
    const b = (x >> 7) & 0x7;
    const h = (x >> 2) & 0x1f;
    heights[i] = h / 31;
    colors[i] = pack(
      Math.round((r / 7) * 255),
      Math.round((g / 7) * 255),
      Math.round((b / 7) * 255),
    );
  }
  return { heights, colors, columnsPerSecond: DETAIL_COLUMNS_PER_SECOND };
}

/**
 * Decode PWV3 monochrome-detail bytes (1 byte/column): 5-bit height (low) +
 * 3-bit whiteness (high). Rendered as the Rekordbox "blue" palette — a dim blue
 * silhouette brightening toward cyan-white where whiteness bits are set.
 */
export function decodePwv3(bytes: Uint8Array): DetailWave {
  const n = bytes.length;
  const heights = new Float32Array(n);
  const colors = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const height = (bytes[i] & 0x1f) / 31;
    const white = ((bytes[i] >> 5) & 0x7) / 7;
    heights[i] = height;
    colors[i] = pack(
      Math.round(40 + white * 150),
      Math.round(120 + white * 110),
      Math.round(220 + white * 35),
    );
  }
  return { heights, colors, columnsPerSecond: DETAIL_COLUMNS_PER_SECOND };
}

/**
 * Wrap high-resolution local-file peaks (already `[0, 1]`) as a themed
 * (colourless) detail wave. `columnsPerSecond` is derived from the track length.
 */
export function decodeFloatPeaks(
  peaks: number[],
  durationSec: number,
): DetailWave {
  const heights = Float32Array.from(peaks);
  const cps =
    durationSec > 0 ? peaks.length / durationSec : DETAIL_COLUMNS_PER_SECOND;
  return { heights, colors: null, columnsPerSecond: cps };
}

/**
 * Seconds spanned by `zoomBars` bars at `bpm` (4 beats/bar). Falls back to
 * 120 BPM when the tempo is unknown so local files without a BPM still zoom.
 */
export function barSpanSeconds(
  zoomBars: number,
  bpm: number | null | undefined,
): number {
  const effective = bpm && bpm > 0 ? bpm : 120;
  return (zoomBars * 4 * 60) / effective;
}

export interface BeatTick {
  beat: number;
  timeMs: number;
}

/**
 * Precompute, for each beatgrid entry, how many downbeats (bar starts) have
 * occurred up to and including it — so bar numbers are an O(log n) lookup.
 */
export function buildDownbeatPrefix(
  beatgrid: readonly BeatTick[],
): Uint32Array {
  const prefix = new Uint32Array(beatgrid.length);
  let bars = 0;
  for (let i = 0; i < beatgrid.length; i++) {
    if (beatgrid[i].beat === 1) bars++;
    prefix[i] = bars;
  }
  return prefix;
}

/** Index of the last beat at or before `timeMs` (binary search), or -1. */
function beatIndexAt(timeMs: number, beatgrid: readonly BeatTick[]): number {
  let lo = 0;
  let hi = beatgrid.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beatgrid[mid].timeMs <= timeMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Render a `bar.beat` counter (e.g. `"33.2"`) for a playback time, using the
 * beatgrid and a downbeat prefix from {@link buildDownbeatPrefix}. Returns `"–"`
 * before the first beat or when there is no beatgrid.
 */
export function barBeatLabel(
  timeSec: number,
  beatgrid: readonly BeatTick[],
  downbeatPrefix: Uint32Array,
): string {
  if (beatgrid.length === 0) return "–";
  const idx = beatIndexAt(timeSec * 1000, beatgrid);
  if (idx < 0) return "–";
  const bar = Math.max(1, downbeatPrefix[idx]);
  return `${bar}.${beatgrid[idx].beat}`;
}

/**
 * Continuous (unrounded) semitone shift for a playback rate — a pitch of +12.5%
 * is +2.04 semitones, landing *between* two keys. Use this for the numeric
 * readout so the fraction is honest; use {@link keySemitonesForRate} to pick the
 * nearest key label.
 */
export function semitonesFloatForRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return 12 * Math.log2(rate);
}

/** Whole semitones a playback rate shifts pitch (rate 1 → 0, up → positive). */
export function keySemitonesForRate(rate: number): number {
  return Math.round(semitonesFloatForRate(rate));
}

const CAMELOT_RE = /^\s*(\d{1,2})\s*([AB])\s*$/i;
const CHROMATIC = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const ENHARMONIC: Record<string, string> = {
  Db: "C#",
  Eb: "D#",
  Fb: "E",
  Gb: "F#",
  Ab: "G#",
  Bb: "A#",
  Cb: "B",
  "E#": "F",
  "B#": "C",
};

/**
 * Transpose a musical key by `semitones`. Handles Camelot notation (`"8A"` →
 * +1 semitone is +7 wheel positions, same letter) and standard note names
 * (`"Am"`, `"C#"`, `"Db"`). Returns the input unchanged for 0 semitones or an
 * unrecognised key.
 */
export function transposeKey(key: string, semitones: number): string {
  if (!semitones) return key;

  const cam = key.match(CAMELOT_RE);
  if (cam) {
    const n = Number(cam[1]);
    if (n >= 1 && n <= 12) {
      const shifted = ((((n - 1 + 7 * semitones) % 12) + 12) % 12) + 1;
      return `${shifted}${cam[2].toUpperCase()}`;
    }
  }

  const std = key.match(/^\s*([A-Ga-g][#b]?)\s*(m|min|maj|major|minor)?\s*$/);
  if (std) {
    const root = std[1][0].toUpperCase() + std[1].slice(1);
    const canon = ENHARMONIC[root] ?? root;
    const idx = CHROMATIC.indexOf(canon);
    if (idx >= 0) {
      const shifted = (((idx + semitones) % 12) + 12) % 12;
      const quality = std[2]?.toLowerCase() ?? "";
      const minor = quality === "m" || quality.startsWith("min") ? "m" : "";
      return `${CHROMATIC[shifted]}${minor}`;
    }
  }

  return key;
}
