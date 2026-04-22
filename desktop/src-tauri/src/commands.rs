//! Tauri commands exposed to the frontend via `invoke`.
//!
//! Keep this file as a thin adapter: parameter parsing, type conversion for
//! the JSON boundary, and error mapping to strings. Real work lives in the
//! underlying modules.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tokio::sync::Semaphore;

use crate::bpm::types::AnalysisMode;
use crate::bpm::{self, BpmOptions, Confidence};

/// Global bound on concurrent blocking BPM analysis tasks.
///
/// Tauri's `spawn_blocking` pool is shared with the rest of the app; without
/// a bound a bulk-analyze run would flood it. Size the semaphore to logical
/// CPU count so we saturate cores without starving other blocking work.
fn analysis_semaphore() -> &'static Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| {
        let n = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        Arc::new(Semaphore::new(n))
    })
}

/// JSON representation of a `BpmResult` across the invoke boundary.
#[derive(Serialize)]
pub struct BpmResponse {
    /// Detected BPM as float. Backend rounds to int at persistence time.
    pub bpm: f32,
    pub confidence: &'static str,
    /// Original pre-correction BPM when octave correction fired.
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

fn to_response(r: bpm::BpmResult) -> BpmResponse {
    BpmResponse {
        bpm: r.bpm,
        confidence: confidence_str(r.confidence),
        corrected_from: r.corrected_from,
        algorithm_version: r.algorithm_version,
    }
}

/// Analyze BPM for a local audio file.
///
/// Runs synchronously on a blocking thread (the decode + analyze together
/// take ~50 ms on a typical track); Tauri invoke handlers can be called from
/// async contexts so no extra wrapper is needed for responsiveness.
///
/// # Parameters
/// - `consensus`: when `true`, run the analyzer on three windows spaced
///   across the track (25% / 50% / 75%) and take the median. This is a
///   **robustness** toggle — it protects against intro/breakdown/outro
///   sections that would mislead a single-window read — not a precision
///   toggle. Per-window analysis uses the same algorithm either way.
///   Costs roughly 3× CPU for the analyze step (decode only runs once).
///   Param name is part of the wire contract; see the frontend `invoke` call.
#[tauri::command]
pub async fn analyze_local_bpm(
    path: String,
    consensus: Option<bool>,
) -> Result<BpmResponse, String> {
    let sem = analysis_semaphore().clone();
    let _permit = sem
        .acquire_owned()
        .await
        .map_err(|e| format!("analysis semaphore closed: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = _permit; // hold across the blocking work
        let mut options = BpmOptions::default();
        if consensus.unwrap_or(false) {
            options.mode = AnalysisMode::Consensus;
        }
        let result = bpm::local::analyze_local_file(&PathBuf::from(&path), 30.0, 15.0, &options)
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(to_response(result))
    })
    .await
    .map_err(|e| format!("analysis task failed: {e}"))?
}

/// Analyze BPM for a SoundCloud track via its HLS stream.
///
/// The OAuth Client-Credentials token is supplied by the caller; this
/// command doesn't touch credentials. See
/// ``backend/api/bpm.py::get_soundcloud_client_token``.
#[tauri::command]
pub async fn analyze_sc_bpm(
    track_id: u64,
    token: String,
    consensus: Option<bool>,
) -> Result<BpmResponse, String> {
    let mut options = BpmOptions::default();
    if consensus.unwrap_or(false) {
        options.mode = AnalysisMode::Consensus;
    }
    let result = bpm::soundcloud::analyze_sc_track(track_id, &token, &options)
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_response(result))
}
