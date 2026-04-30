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
}

export const DEFAULT_JOB_OPTIONS: AnalyserJobOptions = {
  pitch_strategy: "none",
  window_s: 30,
  hop_s: 25,
  min_section_gap_s: 90,
  sections_enabled: true,
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

export interface TrackId {
  section_index: number;
  title: string | null;
  artist: string | null;
  shazam_id: string | null;
  confidence: number;
  pitch_offset: number;
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
  tracks: TrackId[];
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
      type: "track.identified";
      job_id: string;
      section_index: number;
      title: string | null;
      artist: string | null;
      shazam_id: string | null;
      confidence: number;
      pitch_offset: number;
    }
  | { type: "job.complete"; job_id: string }
  | { type: "job.error"; job_id: string; message: string }
  | {
      type: "job.reanalyse_started";
      job_id: string;
      ranges: Array<{ start_s: number; end_s: number }>;
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
  limit = 25,
): Promise<{ jobs: JobSummary[] }> {
  return fetchApi(`/api/analyser/sets?limit=${limit}`);
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

export function jobEventsUrl(jobId: string): string {
  return `${API_BASE_URL}/api/analyser/sets/${encodeURIComponent(jobId)}/events`;
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
    "track.identified",
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
  const trackBySection = new Map(
    snapshot.tracks.map((t) => [t.section_index, t]),
  );
  for (const section of snapshot.sections) {
    const t = trackBySection.get(section.section_index);
    const time = formatTimecode(section.start_s);
    if (t && t.title) {
      lines.push(`${time}  ${t.artist ?? "Unknown"} — ${t.title}`);
    } else {
      lines.push(`${time}  (unidentified)`);
    }
  }
  return lines.join("\n");
}

export function buildTracklistCsv(snapshot: JobSnapshot): string {
  const header = "start_s,end_s,artist,title,confidence";
  const rows = snapshot.sections.map((section) => {
    const t = snapshot.tracks.find(
      (x) => x.section_index === section.section_index,
    );
    const cell = (v: string | number | null | undefined) =>
      v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`;
    return [
      section.start_s.toFixed(2),
      section.end_s.toFixed(2),
      cell(t?.artist),
      cell(t?.title),
      (t?.confidence ?? 0).toFixed(2),
    ].join(",");
  });
  return [header, ...rows].join("\n");
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
