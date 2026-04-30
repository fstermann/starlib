//! BPM analysis + section segmentation for Starlib.
//!
//! Pure library code: decode audio bytes/files to mono PCM, run spectral-flux
//! onset + autocorrelation tempo detection, run spectral-novelty section
//! segmentation. No Tauri, no FastAPI, no IO beyond audio decoding (and the
//! optional SoundCloud HLS fetcher behind the `soundcloud` feature).
//!
//! Consumers:
//! - `desktop/src-tauri` calls `analyze_*` directly via the Rust API.
//! - The Python backend spawns `bpm-stream` (CLI binary in this crate) as a
//!   subprocess and consumes JSON-lines events on stdout for SSE relay.

use std::path::Path;

use anyhow::Result;

pub mod chunk;
pub mod decode;
pub mod local;
pub mod segment;
pub mod tempo;
pub mod types;

#[cfg(feature = "soundcloud")]
pub mod soundcloud;

pub use types::{
    AnalysisMode, BpmError, BpmOptions, BpmResult, Confidence, ALGORITHM_VERSION,
};

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
