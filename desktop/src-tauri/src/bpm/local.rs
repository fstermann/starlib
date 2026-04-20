//! Local-file BPM analysis.
//!
//! Decodes the file at `path`, slices a window starting at `offset_pct` of
//! the total duration, and runs tempo detection on that slice. Window-based
//! analysis keeps analysis cost constant regardless of track length; decode
//! cost still scales with file length but is negligible on local disk.

use std::path::Path;

use anyhow::{Result, anyhow};

use super::tempo::consensus;
use super::types::AnalysisMode;
use super::{decode, tempo, types::BpmOptions, types::BpmResult};

const CONSENSUS_OFFSETS_PCT: &[f32] = &[25.0, 50.0, 75.0];

/// Analyse a snippet of `path` and return a BPM estimate.
///
/// In `AnalysisMode::Consensus` the PCM is decoded once and three windows
/// are analyzed at 25/50/75% offsets — CPU cost triples, but the full-file
/// decode (the slow part) only runs once. No extra disk I/O over single mode.
///
/// # Parameters
/// - `offset_pct`: start of the analysis window as a percent of track length
///   (clamped to `[0, 100]`). 30 is a reasonable default for electronic music
///   — past the intro, inside the first main section. Ignored in consensus mode.
/// - `snippet_s`: window length in seconds. Shorter = faster, less accurate.
pub fn analyze_local_file(
    path: &Path,
    offset_pct: f32,
    snippet_s: f32,
    options: &BpmOptions,
) -> Result<BpmResult> {
    let pcm = decode::decode_file(path, options)?;
    let sr = options.target_sr;
    if pcm.is_empty() {
        return Err(anyhow!("decoded PCM is empty"));
    }

    match options.mode {
        AnalysisMode::Single => analyze_window(&pcm, sr, offset_pct, snippet_s, options),
        AnalysisMode::Consensus => {
            let results: Vec<BpmResult> = CONSENSUS_OFFSETS_PCT
                .iter()
                .map(|&off| analyze_window(&pcm, sr, off, snippet_s, options))
                .collect::<Result<_>>()?;
            consensus(&results)
        }
    }
}

fn analyze_window(
    pcm: &[f32],
    sr: u32,
    offset_pct: f32,
    snippet_s: f32,
    options: &BpmOptions,
) -> Result<BpmResult> {
    let total_samples = pcm.len();
    let total_s = total_samples as f32 / sr as f32;
    let start_s = (total_s * offset_pct.clamp(0.0, 100.0) / 100.0).max(0.0);
    let start = ((start_s * sr as f32) as usize).min(total_samples);
    let end = (((start_s + snippet_s) * sr as f32) as usize).min(total_samples);
    let window: &[f32] = if start >= end {
        // Track shorter than the requested window / offset — analyse what we have.
        pcm
    } else {
        &pcm[start..end]
    };
    if window.is_empty() {
        return Err(anyhow!("analysis window is empty"));
    }
    tempo::analyze(window, sr, options)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a tiny WAV (RIFF) file with the given mono f32 samples at `sr`.
    fn write_wav(path: &Path, samples: &[f32], sr: u32) {
        use std::fs::File;
        let mut f = File::create(path).expect("create wav");
        let n = samples.len();
        let byte_rate = sr * 2; // 16-bit mono
        let data_size = (n * 2) as u32;
        let chunk_size = 36 + data_size;
        // RIFF header
        f.write_all(b"RIFF").unwrap();
        f.write_all(&chunk_size.to_le_bytes()).unwrap();
        f.write_all(b"WAVE").unwrap();
        // fmt chunk
        f.write_all(b"fmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap(); // PCM header size
        f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM format
        f.write_all(&1u16.to_le_bytes()).unwrap(); // mono
        f.write_all(&sr.to_le_bytes()).unwrap();
        f.write_all(&byte_rate.to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap(); // block align
        f.write_all(&16u16.to_le_bytes()).unwrap(); // bits per sample
        // data chunk
        f.write_all(b"data").unwrap();
        f.write_all(&data_size.to_le_bytes()).unwrap();
        for s in samples {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            f.write_all(&v.to_le_bytes()).unwrap();
        }
    }

    fn click_track(bpm: f32, seconds: f32, sr: u32) -> Vec<f32> {
        let n = (seconds * sr as f32) as usize;
        let period = (60.0 / bpm * sr as f32) as usize;
        let mut out = vec![0.0f32; n];
        let mut i = 0;
        while i < n {
            for j in 0..64 {
                if i + j < n {
                    out[i + j] = 1.0;
                }
            }
            i += period;
        }
        out
    }

    #[test]
    fn analyze_local_file_wav_128_bpm() {
        let dir = std::env::temp_dir().join("starlib-bpm-local-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("click_128.wav");
        write_wav(&path, &click_track(128.0, 30.0, 22050), 22050);
        let result = analyze_local_file(&path, 30.0, 15.0, &BpmOptions::default()).unwrap();
        assert!(
            (result.bpm - 128.0).abs() < 1.0,
            "expected 128 BPM, got {}",
            result.bpm
        );
    }

    #[test]
    fn analyze_local_file_window_shorter_than_snippet_is_tolerated() {
        // 5-second track, ask for a 15-second window at 30% offset.
        let dir = std::env::temp_dir().join("starlib-bpm-local-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("click_short.wav");
        write_wav(&path, &click_track(128.0, 5.0, 22050), 22050);
        let result = analyze_local_file(&path, 30.0, 15.0, &BpmOptions::default()).unwrap();
        assert!((result.bpm - 128.0).abs() < 1.5);
    }
}
