/** Tauri environment detection + thin wrappers around Rust-backed commands. */

import { invoke } from "@tauri-apps/api/core";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Detection result from `desktop/src-tauri/src/bpm/local.rs`. */
export interface LocalBpmResult {
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
export async function analyzeLocalBpm(path: string): Promise<LocalBpmResult> {
  return invoke<LocalBpmResult>("analyze_local_bpm", { path });
}
