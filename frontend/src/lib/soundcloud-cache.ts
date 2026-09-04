import { api } from "./api";

/* SoundCloud signed stream URLs are valid for ~15 minutes. Cache for 10 to
 * leave headroom; the WaveformPlayer already has a 403-refresh fallback
 * for the rare case where a URL expires mid-playback. */
const STREAM_TTL_MS = 10 * 60 * 1000;

interface StreamEntry {
  url: string;
  expiresAt: number;
  inflight?: Promise<string>;
}

const streamCache = new Map<string, StreamEntry>();

export async function getCachedSoundcloudStreamUrl(
  id: string | number,
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  const key = String(id);
  const now = Date.now();
  if (!opts?.forceRefresh) {
    const hit = streamCache.get(key);
    if (hit) {
      if (hit.inflight) return hit.inflight;
      if (hit.expiresAt > now) return hit.url;
    }
  } else {
    streamCache.delete(key);
  }
  const inflight = api
    .getSoundcloudStreamUrl(id, { forceRefresh: opts?.forceRefresh })
    .then((r) => {
      streamCache.set(key, {
        url: r.url,
        expiresAt: Date.now() + STREAM_TTL_MS,
      });
      return r.url;
    })
    .catch((err) => {
      streamCache.delete(key);
      throw err;
    });
  streamCache.set(key, { url: "", expiresAt: 0, inflight });
  return inflight;
}

export function invalidateSoundcloudStreamUrl(id: string | number): void {
  streamCache.delete(String(id));
}

/* Decoded high-res peaks — keyed by track id, deduped across callers. The
 * backend decodes the actual audio (not the coarse waveform_url), so this is
 * the fidelity source for alignment. Cached for the session. */
export interface DecodedPeaks {
  peaks: number[];
  durationS: number;
  /** Effective tempo: the user's correction if set, else the detected value. */
  bpm: number | null;
  /** True when ``bpm`` is a user correction rather than the detected value. */
  overridden: boolean;
}

interface DecodedPeaksEntry {
  result?: DecodedPeaks | null;
  inflight?: Promise<DecodedPeaks | null>;
}

const decodedPeaksCache = new Map<string, DecodedPeaksEntry>();

export function getCachedSoundcloudDecodedPeaks(
  id: string | number,
): Promise<DecodedPeaks | null> {
  const key = String(id);
  const hit = decodedPeaksCache.get(key);
  if (hit) {
    if (hit.inflight) return hit.inflight;
    return Promise.resolve(hit.result ?? null);
  }
  const inflight = api
    .getSoundcloudTrackPeaks(id)
    .then((r) => {
      const result: DecodedPeaks = {
        peaks: r.peaks,
        durationS: r.duration_s,
        bpm: r.bpm,
        overridden: r.bpm_overridden,
      };
      decodedPeaksCache.set(key, { result });
      return result;
    })
    .catch(() => {
      decodedPeaksCache.delete(key);
      return null;
    });
  decodedPeaksCache.set(key, { inflight });
  return inflight;
}

/* Update the cached BPM after a correction or reanalyse so reopening the
 * dialog reflects it without re-decoding. No-op if peaks aren't cached yet. */
export function updateCachedSoundcloudBpm(
  id: string | number,
  bpm: number | null,
  overridden: boolean,
): void {
  const hit = decodedPeaksCache.get(String(id));
  if (hit?.result) hit.result = { ...hit.result, bpm, overridden };
}

/* Peaks cache — keyed by `${waveformUrl}::${numPeaks}` so we can reuse
 * across tracks when the bar count is the same (common, since the waveform
 * container width is stable). Also dedupes concurrent fetches. */
interface PeaksEntry {
  peaks?: number[] | null;
  inflight?: Promise<number[] | null>;
}

const peaksCache = new Map<string, PeaksEntry>();

async function fetchPeaksOnce(
  url: string,
  n: number,
): Promise<number[] | null> {
  try {
    const jsonUrl = url.replace(/\.png(\?|$)/, ".json$1");
    const resp = await fetch(jsonUrl);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { samples?: unknown };
    const samples = data.samples;
    if (!Array.isArray(samples) || samples.length === 0) return null;
    let max = 0;
    for (const v of samples) {
      if (typeof v === "number" && v > max) max = v;
    }
    if (max === 0) return null;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor((i * samples.length) / n);
      const end = Math.max(
        start + 1,
        Math.floor(((i + 1) * samples.length) / n),
      );
      let peak = 0;
      for (let j = start; j < end && j < samples.length; j++) {
        const v = samples[j];
        if (typeof v === "number" && v > peak) peak = v;
      }
      out[i] = peak / max;
    }
    return out;
  } catch {
    return null;
  }
}

export function getCachedSoundcloudPeaks(
  url: string,
  n: number,
): Promise<number[] | null> {
  const key = `${url}::${n}`;
  const hit = peaksCache.get(key);
  if (hit) {
    if (hit.inflight) return hit.inflight;
    return Promise.resolve(hit.peaks ?? null);
  }
  const inflight = fetchPeaksOnce(url, n).then((peaks) => {
    peaksCache.set(key, { peaks });
    return peaks;
  });
  peaksCache.set(key, { inflight });
  return inflight;
}
