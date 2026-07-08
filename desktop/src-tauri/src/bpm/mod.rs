//! Re-export shim for the extracted `starlib_audio` crate.
//!
//! All BPM analysis logic now lives in the workspace's `starlib_audio` crate
//! so the Python backend can spawn the `analyser-stream` CLI for streaming
//! analysis. Tauri command wrappers in `crate::commands` continue to reach
//! the analyzer through `crate::bpm::*` to keep the existing call sites
//! unchanged.
//!
//! The `soundcloud` Cargo feature on `starlib_audio` is always enabled by
//! `desktop/src-tauri/Cargo.toml`, so `bpm::soundcloud` is always available.

pub use starlib_audio::{
    analyze_bytes, analyze_file, analyze_samples, BpmError, BpmOptions, BpmResult, Confidence,
    ALGORITHM_VERSION,
};
pub use starlib_audio::{chunk, decode, local, segment, soundcloud, tempo, types};
