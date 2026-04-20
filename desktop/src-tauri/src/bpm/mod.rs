//! BPM analysis: decode audio bytes/files to mono PCM, run spectral-flux
//! onset + autocorrelation tempo detection, return a BPM estimate with
//! confidence.
//!
//! This module is pure library code — no Tauri commands, no network.
//! Command wiring lives in later PRs.

use std::path::Path;

use anyhow::Result;

pub mod decode;
pub mod local;
pub mod soundcloud;
pub mod tempo;
pub mod types;

pub use types::{ALGORITHM_VERSION, BpmOptions, BpmResult, Confidence};

/// Decode `bytes` (with optional format `hint`) and return a BPM estimate.
pub fn analyze_bytes(bytes: &[u8], hint: Option<&str>, options: &BpmOptions) -> Result<BpmResult> {
    let pcm = decode::decode_bytes(bytes, hint, options)?;
    tempo::analyze(&pcm, options.target_sr, options)
}

/// Analyse already-decoded mono PCM samples at the given sample rate.
pub fn analyze_samples(pcm: &[f32], sr: u32, options: &BpmOptions) -> Result<BpmResult> {
    tempo::analyze(pcm, sr, options)
}

/// Decode the audio file at `path` and return a BPM estimate.
pub fn analyze_file(path: &Path, options: &BpmOptions) -> Result<BpmResult> {
    let pcm = decode::decode_file(path, options)?;
    tempo::analyze(&pcm, options.target_sr, options)
}
