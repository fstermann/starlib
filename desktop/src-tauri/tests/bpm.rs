//! Integration tests for the BPM analysis module.
//!
//! These exercise `starlib_lib::bpm::analyze_samples` on synthetic click
//! tracks at known tempos and verify the estimated BPM is within ±1.0 BPM.

use starlib_lib::bpm::local::analyze_local_file;
use starlib_lib::bpm::types::AnalysisMode;
use starlib_lib::bpm::{analyze_samples, BpmOptions};

/// Build a mono click track at `bpm` for `duration_s` seconds at `sr` Hz.
/// Each click is a short exponentially-decaying impulse — a decent stand-in
/// for a percussive onset. Background silence everywhere else.
fn click_track(bpm: f32, duration_s: f32, sr: u32) -> Vec<f32> {
    let total = (duration_s * sr as f32) as usize;
    let mut out = vec![0.0f32; total];
    let period = 60.0 / bpm;
    let click_len = (sr as f32 * 0.02) as usize; // 20 ms click
    let mut t = 0.0f32;
    while t < duration_s {
        let start = (t * sr as f32) as usize;
        for i in 0..click_len {
            let idx = start + i;
            if idx >= total {
                break;
            }
            // Exponentially-decaying impulse.
            let env = (-5.0 * i as f32 / click_len as f32).exp();
            out[idx] += env;
        }
        t += period;
    }
    out
}

fn assert_bpm_close(bpm: f32, target: f32, tol: f32) {
    assert!(
        (bpm - target).abs() <= tol,
        "detected bpm {bpm:.3} not within ±{tol} of {target}",
    );
}

#[test]
fn click_track_120_bpm() {
    let sr = 22050u32;
    let samples = click_track(120.0, 30.0, sr);
    let opts = BpmOptions::default();
    let result = analyze_samples(&samples, sr, &opts).unwrap();
    assert_bpm_close(result.bpm, 120.0, 1.0);
}

#[test]
fn click_track_128_bpm() {
    let sr = 22050u32;
    let samples = click_track(128.0, 30.0, sr);
    let opts = BpmOptions::default();
    let result = analyze_samples(&samples, sr, &opts).unwrap();
    assert_bpm_close(result.bpm, 128.0, 1.0);
}

#[test]
fn click_track_140_bpm() {
    let sr = 22050u32;
    let samples = click_track(140.0, 30.0, sr);
    let opts = BpmOptions::default();
    let result = analyze_samples(&samples, sr, &opts).unwrap();
    assert_bpm_close(result.bpm, 140.0, 1.0);
}

/// Write a mono 16-bit PCM WAV with `samples` at `sr` Hz.
fn write_wav(path: &std::path::Path, samples: &[f32], sr: u32) {
    use std::fs::File;
    use std::io::Write;
    let mut f = File::create(path).expect("create wav");
    let n = samples.len();
    let byte_rate = sr * 2; // 16-bit mono
    let data_size = (n * 2) as u32;
    let chunk_size = 36 + data_size;
    f.write_all(b"RIFF").unwrap();
    f.write_all(&chunk_size.to_le_bytes()).unwrap();
    f.write_all(b"WAVE").unwrap();
    f.write_all(b"fmt ").unwrap();
    f.write_all(&16u32.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap();
    f.write_all(&sr.to_le_bytes()).unwrap();
    f.write_all(&byte_rate.to_le_bytes()).unwrap();
    f.write_all(&2u16.to_le_bytes()).unwrap();
    f.write_all(&16u16.to_le_bytes()).unwrap();
    f.write_all(b"data").unwrap();
    f.write_all(&data_size.to_le_bytes()).unwrap();
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        f.write_all(&v.to_le_bytes()).unwrap();
    }
}

#[test]
fn consensus_mode_survives_middle_breakdown() {
    // Build a 60-second 128 BPM track where the middle 20s is silent
    // (breakdown). Single-window analysis landing at 50% would see silence;
    // consensus samples 25/50/75, median rescues the real tempo.
    let sr = 22050u32;
    let bpm = 128.0_f32;
    let total_s = 60.0_f32;
    let mut samples = click_track(bpm, total_s, sr);
    // Insert ghost notes (half-amplitude off-beat) across the full track
    // to exercise the "tempo breakdown / ghost notes" scenario.
    let period_samples = (60.0 / bpm * sr as f32) as usize;
    let half_offset = period_samples / 2;
    let click_len = (sr as f32 * 0.02) as usize;
    let total = samples.len();
    let mut t = 0usize;
    while t + half_offset < total {
        let start = t + half_offset;
        for i in 0..click_len {
            let idx = start + i;
            if idx >= total {
                break;
            }
            let env = 0.4 * (-5.0 * i as f32 / click_len as f32).exp();
            samples[idx] += env;
        }
        t += period_samples;
    }
    // Zero out the middle 20 s (breakdown).
    let mid_start = (20.0 * sr as f32) as usize;
    let mid_end = (40.0 * sr as f32) as usize;
    for v in &mut samples[mid_start..mid_end] {
        *v = 0.0;
    }

    let dir = std::env::temp_dir().join("starlib-bpm-consensus-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("breakdown_128.wav");
    write_wav(&path, &samples, sr);

    let opts = BpmOptions {
        mode: AnalysisMode::Consensus,
        ..BpmOptions::default()
    };
    let result = analyze_local_file(&path, 30.0, 15.0, &opts).unwrap();
    assert_bpm_close(result.bpm, 128.0, 1.5);
}

#[test]
fn octave_correction_doubles_60_bpm_click_track() {
    // A 60 BPM click track — below the 90 BPM floor — should be doubled to
    // 120 BPM when octave correction is on, with `corrected_from` set.
    let sr = 22050u32;
    let samples = click_track(60.0, 30.0, sr);
    let opts = BpmOptions::default();
    let result = analyze_samples(&samples, sr, &opts).unwrap();
    assert_bpm_close(result.bpm, 120.0, 1.0);
    assert!(
        result.corrected_from.is_some(),
        "expected corrected_from to be set when octave correction kicks in",
    );
    let from = result.corrected_from.unwrap();
    assert_bpm_close(from, 60.0, 1.0);
}
