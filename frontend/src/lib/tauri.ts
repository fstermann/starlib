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
 * Run BPM detection on a local audio file. Resolves with the detection
 * result; rejects with a human-readable string on decode / analysis failure.
 */
export async function analyzeLocalBpm(path: string): Promise<BpmResult> {
  return invoke<BpmResult>("analyze_local_bpm", { path });
}

/**
 * Run BPM detection on a SoundCloud track. The Client-Credentials `token` is
 * fetched from the Python backend (see `api.getSoundcloudClientToken`) and
 * passed through — the Rust layer doesn't manage auth state.
 */
export async function analyzeScBpm(
  trackId: number,
  token: string,
): Promise<BpmResult> {
  return invoke<BpmResult>("analyze_sc_bpm", { trackId, token });
}
