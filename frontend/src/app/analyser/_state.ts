/**
 * Reducer + state types for the analyser timeline view.
 *
 * Owns the live merge of SSE events and the persisted snapshot. Components
 * consume the resulting state through the `useAnalyserJob` hook.
 */

import type {
  AnalyserEvent,
  JobSnapshot,
  Section,
  ShazamScan,
  TrackTimelineEntry,
  WindowBpm,
} from "@/lib/analyser";

export type JobStatus =
  | "idle"
  | "loading"
  | "pending"
  | "running"
  | "complete"
  | "error";

export interface AnalyserUiState {
  jobId: string | null;
  status: JobStatus;
  meta: {
    durationS: number;
    sampleRate: number | null;
    title: string | null;
    artist: string | null;
    soundcloudId: number | null;
    sourceUrl: string | null;
  };
  windows: WindowBpm[];
  sections: Section[];
  /** Raw Shazam scan grid — every probe, including misses. */
  scans: ShazamScan[];
  /** Aggregated tracklist — runs of consecutive matching scans. */
  timeline: TrackTimelineEntry[];
  errorMessage: string | null;
  /** Last-clicked region the detail pane and re-analyse panel target. */
  selection: { start_s: number; end_s: number } | null;
  /** Time ranges currently being re-analysed. Set by the
   *  ``job.reanalyse_started`` event and cleared on terminal events.
   *  Used by the header to compute progress relative to the active
   *  pass instead of pinning to the previous full run's last scan. */
  activeRanges: Array<{ start_s: number; end_s: number }>;
  /** Per-run progress state for the active Shazam scan. Populated by
   *  ``shazam.scan_started`` so the progress bar tracks *this* tier's
   *  walk rather than the highest scan_s in the cumulative scans
   *  array (which pins refines to ~99% because the prior sweep covered
   *  the full mix). Cleared on terminal events. */
  activeShazamScan: {
    tier: string;
    region: { start_s: number; end_s: number } | null;
    totalPoints: number;
    /** scan_s values seen since this run started (set semantics — re-emits
     *  for the same point don't double-count). */
    arrivedScanS: number[];
  } | null;
}

export const INITIAL_STATE: AnalyserUiState = {
  jobId: null,
  status: "idle",
  meta: {
    durationS: 0,
    sampleRate: null,
    title: null,
    artist: null,
    soundcloudId: null,
    sourceUrl: null,
  },
  windows: [],
  sections: [],
  scans: [],
  timeline: [],
  errorMessage: null,
  selection: null,
  activeRanges: [],
  activeShazamScan: null,
};

export type AnalyserAction =
  | { type: "load.snapshot"; snapshot: JobSnapshot }
  | { type: "sse"; event: AnalyserEvent }
  | { type: "select.range"; start_s: number; end_s: number }
  | { type: "select.clear" }
  | { type: "reset" };

export function analyserReducer(
  state: AnalyserUiState,
  action: AnalyserAction,
): AnalyserUiState {
  switch (action.type) {
    case "load.snapshot": {
      const snap = action.snapshot;
      return {
        ...state,
        jobId: snap.id,
        status: snap.status,
        meta: {
          durationS: snap.duration_s ?? 0,
          sampleRate: null,
          title: snap.title,
          artist: snap.artist,
          soundcloudId: snap.soundcloud_id ?? null,
          sourceUrl: snap.source_url ?? null,
        },
        windows: [...snap.windows].sort((a, b) => a.start_s - b.start_s),
        sections: [...snap.sections].sort(
          (a, b) => a.section_index - b.section_index,
        ),
        scans: [...snap.scans].sort((a, b) => a.scan_s - b.scan_s),
        timeline: [...snap.timeline].sort((a, b) => a.start_s - b.start_s),
        errorMessage: snap.error,
        activeRanges: [],
        activeShazamScan: null,
      };
    }
    case "sse":
      return applySse(state, action.event);
    case "select.range":
      return {
        ...state,
        selection: { start_s: action.start_s, end_s: action.end_s },
      };
    case "select.clear":
      return { ...state, selection: null };
    case "reset":
      return INITIAL_STATE;
  }
}

function applySse(
  state: AnalyserUiState,
  event: AnalyserEvent,
): AnalyserUiState {
  switch (event.type) {
    case "meta":
      return {
        ...state,
        status: "running",
        meta: {
          ...state.meta,
          durationS: event.duration_s,
          sampleRate: event.sample_rate,
          title: event.title ?? state.meta.title,
          artist: event.artist ?? state.meta.artist,
        },
      };
    case "window.bpm": {
      const merged = mergeWindow(state.windows, {
        start_s: event.start_s,
        end_s: event.end_s,
        bpm: event.bpm,
        confidence: event.confidence,
      });
      return { ...state, windows: merged };
    }
    case "section.detected": {
      const next = upsertSection(state.sections, {
        section_index: event.section_index,
        start_s: event.start_s,
        end_s: event.end_s,
        confidence: event.confidence,
      });
      return { ...state, sections: next };
    }
    case "shazam.scan": {
      const scans = upsertScan(state.scans, {
        scan_s: event.scan_s,
        title: event.title,
        artist: event.artist,
        shazam_id: event.shazam_id,
        confidence: event.confidence,
        pitch_offset: event.pitch_offset,
        tier: event.tier,
        preview_url: event.preview_url ?? null,
        artwork_url: event.artwork_url ?? null,
      });
      // Track per-run progress: append the scan_s to the active run's
      // arrived list (de-duped), so the header bar advances on actual
      // scheduler progress rather than reading the global max scan_s.
      // Tier-match filter: replays after a reload include cached rows
      // from prior tiers (e.g., sweep) that would otherwise inflate the
      // counter for an active refine pass.
      let activeShazamScan = state.activeShazamScan;
      if (
        activeShazamScan != null &&
        (event.tier == null || event.tier === activeShazamScan.tier) &&
        !activeShazamScan.arrivedScanS.includes(event.scan_s)
      ) {
        activeShazamScan = {
          ...activeShazamScan,
          arrivedScanS: [...activeShazamScan.arrivedScanS, event.scan_s],
        };
      }
      return { ...state, scans, activeShazamScan };
    }
    case "shazam.scan_started":
      return {
        ...state,
        status: "running",
        activeShazamScan: {
          tier: event.tier,
          region:
            event.region != null
              ? { start_s: event.region[0], end_s: event.region[1] }
              : null,
          totalPoints: event.total_points,
          arrivedScanS: [],
        },
      };
    case "track.timeline": {
      // The SSE event still uses the legacy ``override_id`` field name
      // (kept for backward compat); map it to ``id`` for the reducer's
      // tracklist shape.
      if (event.override_id == null) return state;
      const timeline = upsertTimeline(state.timeline, {
        id: event.override_id,
        start_s: event.start_s,
        end_s: event.end_s,
        title: event.title,
        artist: event.artist,
        shazam_id: event.shazam_id,
        confidence: event.confidence,
        source: event.source ?? "shazam",
        soundcloud_id: event.soundcloud_id ?? null,
        soundcloud_permalink_url: event.soundcloud_permalink_url ?? null,
        artwork_url: event.artwork_url ?? null,
        duration_s: event.duration_s ?? null,
        // Carry user-curation flags so SSE replays after a snapshot
        // refresh don't silently revert a confirm-toggle.
        confirmed: event.confirmed ?? false,
        user_edited: event.user_edited ?? false,
        set_bpm: event.set_bpm ?? null,
        pitch_offset: event.pitch_offset ?? null,
      });
      return { ...state, timeline };
    }
    case "job.complete":
      return {
        ...state,
        status: "complete",
        activeRanges: [],
        activeShazamScan: null,
      };
    case "job.error":
      return {
        ...state,
        status: "error",
        errorMessage: event.message,
        activeRanges: [],
        activeShazamScan: null,
      };
    case "job.reanalyse_started": {
      // Drop windows + scans within the re-analysed ranges so the
      // header's progress bar tracks *this* pass instead of pinning to
      // the previous full run's last scan_s. The new SSE events will
      // repopulate as the pipeline progresses.
      const ranges = event.ranges ?? [];
      const inAnyRange = (a: number, b: number) =>
        ranges.some((r) => a < r.end_s && b > r.start_s);
      return {
        ...state,
        status: "running",
        errorMessage: null,
        activeRanges: ranges.map((r) => ({
          start_s: r.start_s,
          end_s: r.end_s,
        })),
        windows: state.windows.filter(
          (w) => !inAnyRange(w.start_s, w.end_s),
        ),
        scans: state.scans.filter((s) => !inAnyRange(s.scan_s, s.scan_s)),
      };
    }
  }
}

function mergeWindow(existing: WindowBpm[], next: WindowBpm): WindowBpm[] {
  const idx = existing.findIndex(
    (w) => Math.abs(w.start_s - next.start_s) < 0.5,
  );
  if (idx === -1) {
    return [...existing, next].sort((a, b) => a.start_s - b.start_s);
  }
  const out = [...existing];
  out[idx] = next;
  return out;
}

function upsertSection(existing: Section[], next: Section): Section[] {
  const idx = existing.findIndex((s) => s.section_index === next.section_index);
  if (idx === -1) {
    return [...existing, next].sort(
      (a, b) => a.section_index - b.section_index,
    );
  }
  const out = [...existing];
  out[idx] = next;
  return out;
}

function upsertScan(existing: ShazamScan[], next: ShazamScan): ShazamScan[] {
  const idx = existing.findIndex((s) => s.scan_s === next.scan_s);
  if (idx === -1) {
    return [...existing, next].sort((a, b) => a.scan_s - b.scan_s);
  }
  const out = [...existing];
  out[idx] = next;
  return out;
}

function upsertTimeline(
  existing: TrackTimelineEntry[],
  next: TrackTimelineEntry,
): TrackTimelineEntry[] {
  // Every track has a real ``id`` from the moment it exists in the DB
  // (no more `start_s|title` improvisation). Same id → replace; new id
  // → append + re-sort.
  const idx = existing.findIndex((t) => t.id === next.id);
  if (idx === -1) {
    return [...existing, next].sort((a, b) => a.start_s - b.start_s);
  }
  const out = [...existing];
  out[idx] = next;
  return out;
}
