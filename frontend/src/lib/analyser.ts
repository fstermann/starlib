/**
 * Analyser API client + SSE event types.
 *
 * Mirrors the wire format of `backend.core.services.analyser.events`. SSE
 * is consumed via native `EventSource`; the helper here just narrows the
 * `event.data` payload to the right discriminated-union variant.
 */

import { fetchApi } from "./api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface AnalyserJobOptions {
  target_bpm?: number | null;
  bpm_range?: [number, number] | null;
  pitch_strategy: "none" | "single" | "range";
  window_s: number;
  hop_s: number;
  min_section_gap_s: number;
  sections_enabled: boolean;
  /** Shazam scan grid step. */
  scan_cadence_s: number;
  /** Length of audio fed to each Shazam call. */
  scan_window_s: number;
}

export const DEFAULT_JOB_OPTIONS: AnalyserJobOptions = {
  pitch_strategy: "none",
  window_s: 30,
  hop_s: 25,
  min_section_gap_s: 90,
  sections_enabled: true,
  scan_cadence_s: 45,
  scan_window_s: 12,
};

export interface StartJobRequest {
  url?: string;
  soundcloud_id?: number;
  options: AnalyserJobOptions;
  title?: string;
  artist?: string;
}

export interface JobSummary {
  id: string;
  soundcloud_id: number | null;
  title: string | null;
  artist: string | null;
  duration_s: number | null;
  status: "pending" | "running" | "complete" | "error";
  created_at: number;
  /** Number of tracks in the merged tracklist (Shazam + manual − hidden). */
  track_count: number;
}

export interface WindowBpm {
  start_s: number;
  end_s: number;
  bpm: number;
  confidence: "high" | "medium" | "low";
}

export interface Section {
  section_index: number;
  start_s: number;
  end_s: number;
  confidence: number;
}

export type ShazamTier = "sweep" | "refine" | "pinpoint";

export const SHAZAM_TIERS: ReadonlyArray<ShazamTier> = [
  "sweep",
  "refine",
  "pinpoint",
];

/** Default cadence/window per tier — kept in sync with the backend
 *  ``SHAZAM_TIERS`` table in ``services/analyser/controller.py``. */
export const SHAZAM_TIER_DEFAULTS: Record<
  ShazamTier,
  { cadence_s: number; window_s: number }
> = {
  sweep: { cadence_s: 60, window_s: 12 },
  refine: { cadence_s: 20, window_s: 12 },
  pinpoint: { cadence_s: 8, window_s: 8 },
};

export interface ShazamScan {
  scan_s: number;
  title: string | null;
  artist: string | null;
  shazam_id: string | null;
  confidence: number;
  pitch_offset: number;
  tier?: ShazamTier;
  preview_url?: string | null;
  artwork_url?: string | null;
}

/** A track on the merged tracklist.
 *
 *  Backed by ``analyser_tracks`` on the backend — Shazam-sourced rows
 *  and manual rows live in the same table and have a real ``id`` from
 *  the moment they exist. Edits go through ``PATCH /tracks/{id}``;
 *  no overlay or hide-row dance.
 */
export interface TrackTimelineEntry {
  id: number;
  start_s: number;
  /** End in seconds. Equal to ``start_s`` when the user hasn't set an
   *  explicit end — the timeline renderer falls back to the next
   *  track's start (or the SC duration) in that case. */
  end_s: number;
  title: string;
  artist: string | null;
  shazam_id: string | null;
  confidence: number;
  /** Where the row was first created. ``shazam`` rows are auto-populated
   *  from the scan cache; ``manual`` rows are user-added. */
  source: "shazam" | "manual";
  soundcloud_id?: number | null;
  soundcloud_permalink_url?: string | null;
  artwork_url?: string | null;
  duration_s?: number | null;
  confirmed?: boolean;
  user_edited?: boolean;
  /** Mix tempo (BPM) at the matched scan point. ``null`` for legacy /
   *  manual rows. Combined with ``pitch_offset`` it derives the original
   *  track's BPM via ``original_bpm = set_bpm × 2^(pitch_offset/12)``. */
  set_bpm?: number | null;
  /** Semitones applied to the slice that matched. The same ratio
   *  (``2^(pitch_offset/12)``) scales original duration to its
   *  in-set length: pitched up → ratio < 1 → shorter. */
  pitch_offset?: number | null;
}

export interface AddTrackInput {
  start_s: number;
  end_s?: number | null;
  title: string;
  artist?: string | null;
  shazam_id?: string | null;
  soundcloud_id?: number | null;
  soundcloud_permalink_url?: string | null;
  artwork_url?: string | null;
  duration_s?: number | null;
}

export interface UpdateTrackInput {
  start_s?: number | null;
  end_s?: number | null;
  title?: string | null;
  artist?: string | null;
  soundcloud_id?: number | null;
  soundcloud_permalink_url?: string | null;
  artwork_url?: string | null;
  duration_s?: number | null;
  confirmed?: boolean | null;
}

export interface JobSnapshot {
  id: string;
  soundcloud_id: number | null;
  source_url: string | null;
  title: string | null;
  artist: string | null;
  duration_s: number | null;
  status: "pending" | "running" | "complete" | "error";
  options: AnalyserJobOptions;
  error: string | null;
  created_at: number;
  updated_at: number;
  windows: WindowBpm[];
  sections: Section[];
  scans: ShazamScan[];
  timeline: TrackTimelineEntry[];
}

// ---------------------------------------------------------------------------
// SSE event union — matches AnalyserEvent on the backend.
// ---------------------------------------------------------------------------

export type AnalyserEvent =
  | {
      type: "meta";
      job_id: string;
      duration_s: number;
      sample_rate: number;
      title?: string | null;
      artist?: string | null;
    }
  | {
      type: "window.bpm";
      job_id: string;
      start_s: number;
      end_s: number;
      bpm: number;
      confidence: "high" | "medium" | "low";
    }
  | {
      type: "section.detected";
      job_id: string;
      section_index: number;
      start_s: number;
      end_s: number;
      confidence: number;
    }
  | {
      type: "shazam.scan";
      job_id: string;
      scan_s: number;
      title: string | null;
      artist: string | null;
      shazam_id: string | null;
      confidence: number;
      pitch_offset: number;
      tier?: ShazamTier;
      preview_url?: string | null;
      artwork_url?: string | null;
    }
  | {
      type: "track.timeline";
      job_id: string;
      start_s: number;
      end_s: number;
      title: string;
      artist: string | null;
      shazam_id: string | null;
      confidence: number;
      source?: "shazam" | "manual";
      /** Backend's ``track_id`` (column was renamed from ``override_id``
       *  in the post-overlay rewrite — kept under the old name for the
       *  SSE event so existing subscribers keep working). */
      override_id?: number | null;
      soundcloud_id?: number | null;
      soundcloud_permalink_url?: string | null;
      artwork_url?: string | null;
      duration_s?: number | null;
      set_bpm?: number | null;
      pitch_offset?: number | null;
      confirmed?: boolean;
      user_edited?: boolean;
    }
  | { type: "job.complete"; job_id: string }
  | { type: "job.error"; job_id: string; message: string }
  | {
      type: "job.reanalyse_started";
      job_id: string;
      ranges: Array<{ start_s: number; end_s: number }>;
    }
  | {
      type: "shazam.scan_started";
      job_id: string;
      tier: ShazamTier;
      region: [number, number] | null;
      total_points: number;
    };

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function startAnalyserJob(
  payload: StartJobRequest,
): Promise<{ job_id: string }> {
  return fetchApi("/api/analyser/sets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getJobSnapshot(jobId: string): Promise<JobSnapshot> {
  return fetchApi(`/api/analyser/sets/${encodeURIComponent(jobId)}`);
}

export async function listRecentJobs(
  limit = 100,
): Promise<{ jobs: JobSummary[] }> {
  return fetchApi(`/api/analyser/sets?limit=${limit}`);
}

export async function deleteJob(jobId: string): Promise<{ deleted: boolean }> {
  return fetchApi(`/api/analyser/sets/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export async function reanalyse(
  jobId: string,
  ranges: Array<{ start_s: number; end_s: number }>,
  overrides?: Partial<AnalyserJobOptions>,
): Promise<{ job_id: string; scheduled_ranges: typeof ranges }> {
  return fetchApi(`/api/analyser/sets/${encodeURIComponent(jobId)}/reanalyse`, {
    method: "POST",
    body: JSON.stringify({ ranges, overrides }),
  });
}

export interface ShazamScanRequest {
  tier: ShazamTier;
  region?: [number, number] | null;
  /** Override the tier's default cadence (s). */
  cadence_s?: number | null;
  /** Override the tier's default window (s). */
  window_s?: number | null;
  overrides?: Partial<AnalyserJobOptions>;
}

export interface ShazamScanResponse {
  job_id: string;
  status: string;
  tier: ShazamTier;
  region: [number, number] | null;
  /** Number of confirmed tracks whose span overlaps the requested region —
   *  the scheduler skips those scan points. UI surfaces this as a chip. */
  excluded_confirmed_tracks: number;
}

/**
 * Kick off a tiered Shazam scan. ``tier`` selects sweep / refine / pinpoint
 * resolution; ``region`` restricts to a sub-range. Backend gates this on
 * the user having committed to a ``target_bpm`` (or explicit
 * ``pitch_strategy: "none"``) and skips scan points inside confirmed
 * tracks.
 */
export async function startShazamScan(
  jobId: string,
  payload: ShazamScanRequest,
): Promise<ShazamScanResponse> {
  return fetchApi(
    `/api/analyser/sets/${encodeURIComponent(jobId)}/shazam-scan`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

/** Ask the running Shazam scan to stop at the next scan-point boundary.
 *  Idempotent — returns `{cancelled: false}` if no scan is running. */
export async function cancelShazamScan(
  jobId: string,
): Promise<{ job_id: string; cancelled: boolean }> {
  return fetchApi(
    `/api/analyser/sets/${encodeURIComponent(jobId)}/shazam-scan/cancel`,
    { method: "POST" },
  );
}

export async function addTrack(
  jobId: string,
  input: AddTrackInput,
): Promise<TrackTimelineEntry> {
  return fetchApi(`/api/analyser/sets/${encodeURIComponent(jobId)}/tracks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateTrack(
  jobId: string,
  trackId: number,
  patch: UpdateTrackInput,
): Promise<{ updated: boolean }> {
  return fetchApi(
    `/api/analyser/sets/${encodeURIComponent(jobId)}/tracks/${trackId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export async function deleteTrack(
  jobId: string,
  trackId: number,
): Promise<{ deleted: boolean }> {
  return fetchApi(
    `/api/analyser/sets/${encodeURIComponent(jobId)}/tracks/${trackId}`,
    { method: "DELETE" },
  );
}

export async function resetJob(
  jobId: string,
): Promise<{ job_id: string; reset: boolean }> {
  return fetchApi(`/api/analyser/sets/${encodeURIComponent(jobId)}/reset`, {
    method: "POST",
  });
}

export function jobEventsUrl(jobId: string): string {
  return `${API_BASE_URL}/api/analyser/sets/${encodeURIComponent(jobId)}/events`;
}

export function jobAudioUrl(jobId: string): string {
  return `${API_BASE_URL}/api/analyser/sets/${encodeURIComponent(jobId)}/audio`;
}

/**
 * Subscribe to a job's SSE stream. Returns a cleanup function that closes
 * the underlying `EventSource`. The handler receives one parsed event per
 * line; malformed payloads are dropped silently (logged to console).
 *
 * The native `EventSource` reconnects automatically on socket close, so we
 * explicitly call `source.close()` after `job.complete` / `job.error` —
 * otherwise the browser would re-open the stream and the backend would
 * replay the entire DB-backed history forever.
 */
export function subscribeToJob(
  jobId: string,
  handler: (event: AnalyserEvent) => void,
): () => void {
  const url = jobEventsUrl(jobId);
  const source = new EventSource(url);

  const dispatch = (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as AnalyserEvent;
      handler(parsed);
      if (parsed.type === "job.complete" || parsed.type === "job.error") {
        source.close();
      }
    } catch (e) {
      console.warn("analyser: dropping malformed SSE payload", e, raw);
    }
  };

  // Backend emits `event: <type>\ndata: {...}` so attach typed listeners.
  for (const type of [
    "meta",
    "window.bpm",
    "section.detected",
    "shazam.scan",
    "shazam.scan_started",
    "track.timeline",
    "job.complete",
    "job.error",
    "job.reanalyse_started",
  ]) {
    source.addEventListener(type, (e) => dispatch((e as MessageEvent).data));
  }

  return () => source.close();
}

// ---------------------------------------------------------------------------
// Tracklist export
// ---------------------------------------------------------------------------

export function buildTracklistText(snapshot: JobSnapshot): string {
  const lines: string[] = [];
  if (snapshot.title || snapshot.artist) {
    lines.push(
      `${snapshot.artist ?? "Unknown"} — ${snapshot.title ?? "Untitled"}`,
    );
    lines.push("");
  }
  if (snapshot.timeline.length === 0) {
    lines.push("(no tracks identified — run a Shazam scan)");
    return lines.join("\n");
  }
  for (const entry of snapshot.timeline) {
    const time = formatTimecode(entry.start_s);
    lines.push(`${time}  ${entry.artist ?? "Unknown"} — ${entry.title}`);
  }
  return lines.join("\n");
}

export function buildTracklistCsv(snapshot: JobSnapshot): string {
  const header = "start_s,end_s,artist,title,confidence";
  const rows = snapshot.timeline.map((entry) => {
    const cell = (v: string | number | null | undefined) =>
      v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`;
    return [
      entry.start_s.toFixed(2),
      entry.end_s.toFixed(2),
      cell(entry.artist),
      cell(entry.title),
      entry.confidence.toFixed(2),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

/** Speed ratio applied to the original track to produce its in-set form.
 *  ``original_bpm × ratio = set_bpm`` only when pitch_offset is the
 *  semitone shift that brings the slice **up** to the original — which is
 *  the convention here: positive offset means we pitched the slice up to
 *  match Shazam's reference, so the DJ pitched the original *down*.
 *  In practice DJs almost always pitch **up**, so ``pitch_offset`` is
 *  typically negative and ``ratio`` slightly < 1. */
export function pitchSpeedRatio(pitchOffset: number): number {
  return Math.pow(2, pitchOffset / 12);
}

/** Derive the original (released) BPM from the in-set BPM and the offset
 *  that produced the Shazam match. Returns ``null`` if either input is
 *  missing or non-positive. */
export function originalBpmFromSet(
  setBpm: number | null | undefined,
  pitchOffset: number | null | undefined,
): number | null {
  if (setBpm == null || setBpm <= 0) return null;
  if (pitchOffset == null) return null;
  return setBpm * pitchSpeedRatio(pitchOffset);
}

/** Track length when played in the set (not the released duration).
 *  Pitched up → shorter, so the multiplier follows the same speed
 *  ratio as ``originalBpmFromSet``. Returns the original duration when
 *  ``pitchOffset`` is missing — it's the safest fallback. */
export function effectiveDurationInSet(
  durationOriginal: number | null | undefined,
  pitchOffset: number | null | undefined,
): number | null {
  if (durationOriginal == null || durationOriginal <= 0) return null;
  if (pitchOffset == null) return durationOriginal;
  return durationOriginal * pitchSpeedRatio(pitchOffset);
}

export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
