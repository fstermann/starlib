//! Tauri commands exposed to the frontend via `invoke`.
//!
//! Keep this file as a thin adapter: parameter parsing, type conversion for
//! the JSON boundary, and error mapping to strings. Real work lives in the
//! underlying modules.

use std::path::PathBuf;

use serde::Serialize;

use crate::bpm::{self, BpmOptions, Confidence};

#[derive(Serialize)]
pub struct LocalBpmResponse {
    /// Detected BPM. Rounded at persistence time by the backend, but kept
    /// as float here for algorithm-version migrations / debugging.
    pub bpm: f32,
    pub confidence: &'static str,
    /// Original pre-correction BPM when octave correction kicked in.
    pub corrected_from: Option<f32>,
    pub algorithm_version: u16,
}

fn confidence_str(c: Confidence) -> &'static str {
    match c {
        Confidence::High => "high",
        Confidence::Medium => "medium",
        Confidence::Low => "low",
    }
}

/// Analyze BPM for a local audio file.
///
/// Runs synchronously on a blocking thread (the decode + analyze together
/// take ~50 ms on a typical track); Tauri invoke handlers can be called from
/// async contexts so no extra wrapper is needed for responsiveness.
#[tauri::command]
pub async fn analyze_local_bpm(path: String) -> Result<LocalBpmResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let options = BpmOptions::default();
        let result = bpm::local::analyze_local_file(&PathBuf::from(&path), 30.0, 15.0, &options)
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(LocalBpmResponse {
            bpm: result.bpm,
            confidence: confidence_str(result.confidence),
            corrected_from: result.corrected_from,
            algorithm_version: result.algorithm_version,
        })
    })
    .await
    .map_err(|e| format!("analysis task failed: {e}"))?
}
