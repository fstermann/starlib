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
  TrackId,
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
  };
  windows: WindowBpm[];
  sections: Section[];
  tracks: Map<number, TrackId>;
  errorMessage: string | null;
  /** Last-clicked region the detail pane and re-analyse panel target. */
  selection: { start_s: number; end_s: number } | null;
}

export const INITIAL_STATE: AnalyserUiState = {
  jobId: null,
  status: "idle",
  meta: { durationS: 0, sampleRate: null, title: null, artist: null },
  windows: [],
  sections: [],
  tracks: new Map(),
  errorMessage: null,
  selection: null,
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
      const tracks = new Map<number, TrackId>();
      for (const t of snap.tracks) tracks.set(t.section_index, t);
      return {
        ...state,
        jobId: snap.id,
        status: snap.status,
        meta: {
          durationS: snap.duration_s ?? 0,
          sampleRate: null,
          title: snap.title,
          artist: snap.artist,
        },
        windows: [...snap.windows].sort((a, b) => a.start_s - b.start_s),
        sections: [...snap.sections].sort(
          (a, b) => a.section_index - b.section_index,
        ),
        tracks,
        errorMessage: snap.error,
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
    case "track.identified": {
      const tracks = new Map(state.tracks);
      tracks.set(event.section_index, {
        section_index: event.section_index,
        title: event.title,
        artist: event.artist,
        shazam_id: event.shazam_id,
        confidence: event.confidence,
        pitch_offset: event.pitch_offset,
      });
      return { ...state, tracks };
    }
    case "job.complete":
      return { ...state, status: "complete" };
    case "job.error":
      return { ...state, status: "error", errorMessage: event.message };
    case "job.reanalyse_started":
      return { ...state, status: "running", errorMessage: null };
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
