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
