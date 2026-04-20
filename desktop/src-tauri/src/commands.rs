//! Tauri commands exposed to the frontend via `invoke`.
//!
//! Keep this file as a thin adapter: parameter parsing, type conversion for
//! the JSON boundary, and error mapping to strings. Real work lives in the
//! underlying modules.

use serde::Serialize;

use crate::bpm::{self, BpmOptions, Confidence};

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

/// Analyze BPM for a SoundCloud track via its HLS stream.
///
/// The OAuth Client-Credentials token is supplied by the caller; this
/// command doesn't touch credentials. See
/// ``backend/api/bpm.py::get_soundcloud_client_token``.
#[tauri::command]
pub async fn analyze_sc_bpm(track_id: u64, token: String) -> Result<BpmResponse, String> {
    let options = BpmOptions::default();
    let result = bpm::soundcloud::analyze_sc_track(track_id, &token, &options)
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_response(result))
}
