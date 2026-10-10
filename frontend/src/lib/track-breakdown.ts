/**
 * Track Breakdown API client and types.
 *
 * Mirrors `backend/api/breakdown_tracks.py` and the `features.json` written by
 * `analyser-stream breakdown`. Per-bar arrays are indexed by bar - 1.
 */

import { api, fetchApi } from "./api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const;
export type StemName = (typeof STEM_NAMES)[number];
/** The drums stem split again; together they make up the drums. */
export const DRUM_PART_NAMES = ["kick", "snare", "hats"] as const;
export type DrumPartName = (typeof DRUM_PART_NAMES)[number];

/** One chart colour per stem, shared by its lanes and the analysis progress. */
export const STEM_COLORS: Record<StemName, string> = {
  drums: "var(--chart-1)",
  bass: "var(--chart-2)",
  other: "var(--chart-3)",
  vocals: "var(--chart-4)",
};

export interface Grid {
  bpm: number;
  bpm_rough: number;
  /** `null` when the grid was set by hand rather than estimated. */
  concentration: number | null;
  downbeat_s: number;
  bar_s: number;
  n_bars: number;
  beats_per_bar: number;
}

export interface SourceFeatures {
  /** Level per bar, dB relative to the loudest mix bar. */
  db: number[];
  /** Six band levels per bar, same reference as `db`. */
  bands_db: number[][];
  centroid_hz: number[];
  /** Side power over mid power. */
  width: number[];
  onset: number[];
}

export interface BassPeak {
  hz: number;
  note: string;
  db: number;
}

export interface TrackFeatures {
  pipeline_version: number;
  sample_rate: number;
  duration_s: number;
  grid: Grid;
  bands_hz: [number, number][];
  /** `mix` plus one entry per stem. */
  sources: Record<string, SourceFeatures>;
  /** 16 slots per bar, dB relative to the lane's loudest slot. */
  groove: Record<string, number[][]>;
  tonal: { root: string | null; bass_peaks: BassPeak[]; chroma: number[][] };
}

/** A labelled run of bars, 1-based and inclusive. */
export interface Section {
  start_bar: number;
  end_bar: number;
  label: string;
}

/** The SoundCloud track a breakdown's audio was downloaded from. */
export interface SoundCloudOrigin {
  id: number;
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
}

export interface TrackBreakdown {
  digest: string;
  features: TrackFeatures;
  sections: Section[];
  detected_sections: Section[];
  sections_edited: boolean;
  grid_edited: boolean;
  soundcloud: SoundCloudOrigin | null;
}

/** What to break down: a file in the collection or a SoundCloud track. */
export type TrackSource =
  { kind: "file"; path: string } | { kind: "soundcloud"; id: number };

/** The source named by the Track view's `path` or `sc` query parameter. */
export function trackSourceFrom(params: URLSearchParams): TrackSource | null {
  const path = params.get("path");
  if (path) return { kind: "file", path };
  const id = Number(params.get("sc"));
  return Number.isInteger(id) && id > 0 ? { kind: "soundcloud", id } : null;
}

export function trackSourceHref(source: TrackSource): string {
  return source.kind === "file"
    ? trackBreakdownHref(source.path)
    : `/breakdown?view=track&sc=${source.id}`;
}

/** Audio of the whole track, for the Original lane. */
export function originalAudioUrl(source: TrackSource): string {
  return source.kind === "file"
    ? api.getAudioUrl(source.path)
    : `${API_BASE_URL}/api/breakdown/tracks/soundcloud/${source.id}/audio`;
}

export type TrackJobEvent =
  | { type: "stage"; stage: string; progress: number | null }
  | { type: "complete"; digest: string }
  | { type: "error"; message: string; code?: "stems_unavailable" }
  | { type: "cancelled" };

export interface StemSetup {
  status: "missing" | "installing" | "ready" | "error";
  stage: "uv" | "python" | "packages" | "model" | "drum_model" | null;
  error: string | null;
  size_bytes: number;
}

export function getStemSetup(): Promise<StemSetup> {
  return fetchApi("/api/breakdown/stem-separation");
}

export function installStemSetup(): Promise<StemSetup> {
  return fetchApi("/api/breakdown/stem-separation/install", { method: "POST" });
}

export function removeStemSetup(): Promise<StemSetup> {
  return fetchApi("/api/breakdown/stem-separation", { method: "DELETE" });
}

export interface RecentTrack {
  digest: string;
  path: string;
  bpm: number;
  root: string | null;
  n_bars: number;
  duration_s: number;
  /** Unix seconds. */
  opened_at: number;
  /** Set when the audio was downloaded from SoundCloud, with its details. */
  soundcloud_id: number | null;
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
  /** The file is no longer at `path`. */
  missing: boolean;
}

export async function listRecentTracks(): Promise<RecentTrack[]> {
  const { tracks } = await fetchApi<{ tracks: RecentTrack[] }>(
    "/api/breakdown/tracks",
  );
  return tracks;
}

export function deleteTrackBreakdown(digest: string): Promise<void> {
  return fetchApi(`/api/breakdown/tracks/${digest}`, { method: "DELETE" });
}

export async function startTrackJob(source: TrackSource): Promise<string> {
  const body =
    source.kind === "file"
      ? { path: source.path }
      : { soundcloud_id: source.id };
  const { job_id } = await fetchApi<{ job_id: string }>(
    "/api/breakdown/tracks/jobs",
    { method: "POST", body: JSON.stringify(body) },
  );
  return job_id;
}

export function cancelTrackJob(jobId: string): Promise<{ cancelled: boolean }> {
  return fetchApi(`/api/breakdown/tracks/jobs/${jobId}/cancel`, {
    method: "POST",
  });
}

export function trackJobEventsUrl(jobId: string): string {
  return `${API_BASE_URL}/api/breakdown/tracks/jobs/${jobId}/events`;
}

export function getTrackBreakdown(digest: string): Promise<TrackBreakdown> {
  return fetchApi(`/api/breakdown/tracks/${digest}`);
}

export function saveSections(
  digest: string,
  sections: Section[],
): Promise<TrackBreakdown> {
  return fetchApi(`/api/breakdown/tracks/${digest}/sections`, {
    method: "PUT",
    body: JSON.stringify({ sections }),
  });
}

export function resetSections(digest: string): Promise<TrackBreakdown> {
  return fetchApi(`/api/breakdown/tracks/${digest}/sections`, {
    method: "DELETE",
  });
}

export function saveGrid(
  digest: string,
  bpm: number,
  downbeatS: number,
): Promise<void> {
  return fetchApi(`/api/breakdown/tracks/${digest}/grid`, {
    method: "PUT",
    body: JSON.stringify({ bpm, downbeat_s: downbeatS }),
  });
}

export function resetGrid(digest: string): Promise<void> {
  return fetchApi(`/api/breakdown/tracks/${digest}/grid`, {
    method: "DELETE",
  });
}

export function stemUrl(digest: string, stem: StemName | DrumPartName): string {
  return `${API_BASE_URL}/api/breakdown/tracks/${digest}/stems/${stem}`;
}

export function trackBreakdownHref(path: string): string {
  return `/breakdown?view=track&path=${encodeURIComponent(path)}`;
}

/** Start time of a 1-based bar, in seconds. */
export function barStartS(grid: Grid, bar: number): number {
  return grid.downbeat_s + (bar - 1) * grid.bar_s;
}

/** Fractional 1-based bar position of a time, e.g. 1.5 is halfway through bar 1. */
export function barAt(grid: Grid, seconds: number): number {
  return (seconds - grid.downbeat_s) / grid.bar_s + 1;
}

const NOTE_NAMES = [
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

/** Nearest note to `hz`, named like the measured bass peaks (A4 = 440 Hz). */
export function noteAt(hz: number): string {
  const midi = Math.round(12 * Math.log2(hz / 440) + 69);
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const minutes = Math.floor(s / 60);
  return `${minutes}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

/** Stem display name. The vocals stem of an instrumental track holds shots and FX. */
export function stemLabel(stem: StemName, features: TrackFeatures): string {
  if (stem !== "vocals") return stem[0].toUpperCase() + stem.slice(1);
  const levels = [...(features.sources.vocals?.db ?? [])].sort((a, b) => a - b);
  const median = levels[Math.floor(levels.length / 2)] ?? -120;
  return median < MOSTLY_SILENT_DB ? "FX" : "Vocals";
}

/** Median level below which the vocals stem counts as mostly silent. */
const MOSTLY_SILENT_DB = -40;

const LABEL_COLORS: Record<string, string> = {
  intro: "var(--section-intro)",
  groove: "var(--section-verse)",
  build: "var(--section-up)",
  main: "var(--section-chorus)",
  breakdown: "var(--section-down)",
  break: "var(--section-down)",
  filtered: "var(--section-bridge)",
  outro: "var(--section-outro)",
};

/** Section fill colour; labels the detector doesn't produce read as "other". */
export function sectionColor(label: string): string {
  return LABEL_COLORS[label.toLowerCase()] ?? "var(--section-other)";
}

export const SECTION_LABELS = Object.keys(LABEL_COLORS);
