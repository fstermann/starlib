//! Integration tests for the BPM analysis module.
//!
//! These exercise `starlib_lib::bpm::analyze_samples` on synthetic click
//! tracks at known tempos and verify the estimated BPM is within ±1.0 BPM.

use starlib_lib::bpm::{BpmOptions, analyze_samples};

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
