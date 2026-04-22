/** Tauri environment detection + thin wrappers around Rust-backed commands. */

import { invoke } from "@tauri-apps/api/core";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Detection result returned by every Rust BPM command. */
export interface BpmResult {
  bpm: number;
  confidence: "high" | "medium" | "low";
  /** Original BPM prior to octave correction, when it fired. */
  corrected_from: number | null;
  algorithm_version: number;
}

/**
 * Run BPM detection on a local audio file. `consensus=true` analyzes three
 * windows (25/50/75%) and returns the median — ~3× CPU, higher accuracy on
 * breakdown-heavy tracks.
 */
export async function analyzeLocalBpm(
  path: string,
  consensus = false,
): Promise<BpmResult> {
  return invoke<BpmResult>("analyze_local_bpm", { path, consensus });
}

/**
 * Run BPM detection on a SoundCloud track. The Client-Credentials `token` is
 * fetched from the Python backend (see `api.getSoundcloudClientToken`) and
 * passed through — the Rust layer doesn't manage auth state.
 *
 * `consensus=true` enables the 3-window median mode (~3× network + CPU).
 */
export async function analyzeScBpm(
  trackId: number,
  token: string,
  consensus = false,
): Promise<BpmResult> {
  return invoke<BpmResult>("analyze_sc_bpm", { trackId, token, consensus });
}
