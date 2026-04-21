//! Tempo (BPM) detection via spectral-flux onset envelope + autocorrelation.
//!
//! Ported from the `bpm_bench_rs` prototype. Adds parabolic peak
//! interpolation on the autocorrelation lag so the estimate isn't quantised
//! to integer-lag BPMs, and returns a confidence bucket derived from peak
//! sharpness.

use anyhow::{anyhow, Result};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

use super::types::{BpmError, BpmOptions, BpmResult, Confidence, ALGORITHM_VERSION};

/// Combine multiple single-shot BPM results into one consensus estimate.
///
/// Returns the median BPM. Confidence is derived from window agreement
/// spread: High if all within ±2 BPM of the median, Medium if within ±5,
/// else Low. `corrected_from` on the consensus result is the pre-correction
/// median in case any octave correction was applied.
pub fn consensus(results: &[BpmResult]) -> Result<BpmResult> {
    if results.is_empty() {
        return Err(anyhow!("consensus requires at least one result"));
    }
    let mut bpms: Vec<f32> = results.iter().map(|r| r.bpm).collect();
    bpms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = bpms[bpms.len() / 2];

    let max_dev = bpms
        .iter()
        .map(|b| (b - median).abs())
        .fold(0.0_f32, f32::max);
    let confidence = if max_dev <= 2.0 {
        Confidence::High
    } else if max_dev <= 5.0 {
        Confidence::Medium
    } else {
        Confidence::Low
    };

    // Consensus doesn't "correct" itself — correction already happened per
    // window. Expose any pre-correction median for debugging if every run
    // carries a corrected_from value.
    let corrected_from = if results.iter().all(|r| r.corrected_from.is_some()) {
        let mut pre: Vec<f32> = results.iter().map(|r| r.corrected_from.unwrap()).collect();
        pre.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some(pre[pre.len() / 2])
    } else {
        None
    };

    Ok(BpmResult {
        bpm: median,
        confidence,
        corrected_from,
        algorithm_version: ALGORITHM_VERSION,
    })
}

/// Analyse PCM samples (mono, at `sr`) and return a BPM estimate.
pub fn analyze(samples: &[f32], sr: u32, options: &BpmOptions) -> Result<BpmResult> {
    // Need enough samples to run at least a couple of STFT frames
    // (win=2048, hop=512) and leave room for autocorrelation lags.
    if samples.len() < 4096 {
        return Err(BpmError::InsufficientData(format!(
            "need at least 4096 PCM samples for STFT, got {}",
            samples.len()
        ))
        .into());
    }

    let onset = spectral_flux_onset(samples)?;
    if onset.iter().all(|&v| v == 0.0) {
        return Err(BpmError::SilentInput.into());
    }
    let (raw_bpm, peak_ratio) = autocorrelate_bpm(&onset, sr, options)?;

    let confidence = if peak_ratio >= 3.0 {
        Confidence::High
    } else if peak_ratio >= 1.5 {
        Confidence::Medium
    } else {
        Confidence::Low
    };

    let (bpm, corrected_from) = if options.octave_correction {
        apply_octave_correction(raw_bpm)
    } else {
        (raw_bpm, None)
    };

    Ok(BpmResult {
        bpm,
        confidence,
        corrected_from,
        algorithm_version: ALGORITHM_VERSION,
    })
}

/// Spectral-flux onset envelope: STFT magnitude differences (positive only),
/// mean-subtracted and half-wave rectified.
///
/// The 2048-sample window / 512-sample hop combo is the usual MIR default:
/// at the pipeline's target sample rate of 22050 Hz this gives ~93 ms frames
/// with ~23 ms steps (43 Hz frame rate) — fine-grained enough to catch
/// percussive onsets while keeping FFT cost low. If `BpmOptions::target_sr`
/// changes, revisit these constants.
fn spectral_flux_onset(samples: &[f32]) -> Result<Vec<f32>> {
    let win = 2048usize;
    let hop = 512usize;

    if samples.len() < win + hop {
        return Err(BpmError::InsufficientData(format!(
            "spectral-flux needs at least {} samples, got {}",
            win + hop,
            samples.len()
        ))
        .into());
    }

    let hann: Vec<f32> = (0..win)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / win as f32).cos())
        .collect();

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(win);

    let n_frames = (samples.len() - win) / hop + 1;
    let half = win / 2;
    let mut mag_prev: Vec<f32> = vec![0.0; half];
    let mut flux: Vec<f32> = Vec::with_capacity(n_frames);

    let mut buf: Vec<Complex<f32>> = vec![Complex { re: 0.0, im: 0.0 }; win];
    for f in 0..n_frames {
        let start = f * hop;
        for i in 0..win {
            buf[i] = Complex {
                re: samples[start + i] * hann[i],
                im: 0.0,
            };
        }
        fft.process(&mut buf);
        let mut s = 0.0f32;
        for i in 0..half {
            let m = (buf[i].re * buf[i].re + buf[i].im * buf[i].im).sqrt();
            let diff = m - mag_prev[i];
            if diff > 0.0 {
                s += diff;
            }
            mag_prev[i] = m;
        }
        flux.push(s);
    }

    let mean = flux.iter().sum::<f32>() / flux.len().max(1) as f32;
    Ok(flux.iter().map(|v| (v - mean).max(0.0)).collect())
}

/// Autocorrelation over the onset envelope. Returns `(bpm, peak_ratio)` where
/// `peak_ratio` is the peak autocorrelation score divided by the median over
/// the searched lag range (used for confidence).
fn autocorrelate_bpm(onset: &[f32], sr: u32, options: &BpmOptions) -> Result<(f32, f32)> {
    let hop = 512usize;
    let frame_rate = sr as f32 / hop as f32;
    let min_lag = (frame_rate * 60.0 / options.max_bpm) as usize;
    let max_lag = (frame_rate * 60.0 / options.min_bpm) as usize;

    let n = onset.len();
    if min_lag < 2 {
        return Err(BpmError::InsufficientData(format!(
            "min_lag={min_lag} < 2; max_bpm={} too high for frame_rate={frame_rate}",
            options.max_bpm
        ))
        .into());
    }
    if n <= max_lag + 2 {
        return Err(BpmError::InsufficientData(format!(
            "onset envelope ({n} frames) shorter than max_lag+2 ({})",
            max_lag + 2
        ))
        .into());
    }

    // Classic autocorrelation. We need lags [min_lag - 1, max_lag + 1]
    // available so parabolic interpolation has neighbours.
    let lo = min_lag - 1;
    let hi = (max_lag + 1).min(n - 1);
    let mut acorr = vec![0.0f32; hi + 1];
    for lag in lo..=hi {
        let mut s = 0.0f32;
        for i in 0..(n - lag) {
            s += onset[i] * onset[i + lag];
        }
        acorr[lag] = s;
    }

    // Find best integer lag in [min_lag, max_lag].
    let mut best_lag = min_lag;
    let mut best_score = f32::NEG_INFINITY;
    for (lag, &score) in acorr.iter().enumerate().take(max_lag + 1).skip(min_lag) {
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }

    // Parabolic peak interpolation around best_lag.
    let offset = parabolic_offset(acorr[best_lag - 1], acorr[best_lag], acorr[best_lag + 1]);
    let refined_lag = best_lag as f32 + offset;

    let bpm = if refined_lag > 0.0 {
        frame_rate * 60.0 / refined_lag
    } else {
        0.0
    };

    // Peak sharpness: best score / median of acorr in the search range.
    let mut search: Vec<f32> = acorr[min_lag..=max_lag].to_vec();
    search.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = search[search.len() / 2].max(1e-9);
    let peak_ratio = best_score / median;

    Ok((bpm, peak_ratio))
}

/// Parabolic peak interpolation for three adjacent samples `y0, y1, y2`
/// (where `y1` is the integer-lag peak). Returns the sub-sample offset
/// relative to `y1`, in the range roughly `[-0.5, 0.5]`.
pub(crate) fn parabolic_offset(y0: f32, y1: f32, y2: f32) -> f32 {
    let denom = y0 - 2.0 * y1 + y2;
    if denom.abs() < f32::EPSILON {
        return 0.0;
    }
    let off = 0.5 * (y0 - y2) / denom;
    // Guard pathological cases where the three points aren't a concave peak.
    if !off.is_finite() || off.abs() > 1.0 {
        0.0
    } else {
        off
    }
}

/// Fold BPMs outside `[90, 180]` into that range by doubling/halving.
pub(crate) fn apply_octave_correction(bpm: f32) -> (f32, Option<f32>) {
    if bpm <= 0.0 {
        return (bpm, None);
    }
    if bpm < 90.0 {
        (bpm * 2.0, Some(bpm))
    } else if bpm > 180.0 {
        (bpm / 2.0, Some(bpm))
    } else {
        (bpm, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parabolic_interpolation_symmetric_peak() {
        // Symmetric parabola centred on y1 → offset ~ 0.
        let off = parabolic_offset(1.0, 2.0, 1.0);
        assert!(off.abs() < 1e-6, "offset={off}");
    }

    #[test]
    fn parabolic_interpolation_shifted_peak() {
        // Construct y = -(x - 0.25)^2 + 1 sampled at x = -1, 0, 1.
        // Peak is at x = 0.25, so interpolation should return ~0.25.
        let f = |x: f32| -(x - 0.25).powi(2) + 1.0;
        let off = parabolic_offset(f(-1.0), f(0.0), f(1.0));
        assert!((off - 0.25).abs() < 1e-4, "offset={off}");
    }

    #[test]
    fn parabolic_interpolation_zero_denominator() {
        // Flat line → denominator zero → offset 0.
        let off = parabolic_offset(1.0, 1.0, 1.0);
        assert_eq!(off, 0.0);
    }

    #[test]
    fn octave_correction_doubles_slow_bpm() {
        let (corrected, from) = apply_octave_correction(60.0);
        assert_eq!(corrected, 120.0);
        assert_eq!(from, Some(60.0));
    }

    #[test]
    fn octave_correction_halves_fast_bpm() {
        let (corrected, from) = apply_octave_correction(200.0);
        assert_eq!(corrected, 100.0);
        assert_eq!(from, Some(200.0));
    }

    #[test]
    fn octave_correction_leaves_in_range() {
        let (corrected, from) = apply_octave_correction(128.0);
        assert_eq!(corrected, 128.0);
        assert_eq!(from, None);
    }

    fn result(bpm: f32) -> BpmResult {
        BpmResult {
            bpm,
            confidence: Confidence::Medium,
            corrected_from: None,
            algorithm_version: ALGORITHM_VERSION,
        }
    }

    #[test]
    fn consensus_tight_cluster_is_high_confidence() {
        let c = consensus(&[result(127.0), result(128.0), result(128.5)]).unwrap();
        assert_eq!(c.bpm, 128.0);
        assert_eq!(c.confidence, Confidence::High);
    }

    #[test]
    fn consensus_moderate_spread_is_medium() {
        let c = consensus(&[result(125.0), result(128.0), max_dev_helper()]).unwrap();
        assert_eq!(c.bpm, 128.0);
        assert_eq!(c.confidence, Confidence::Medium);
    }

    fn max_dev_helper() -> BpmResult {
        result(132.0) // 4 BPM from median 128 → Medium (≤5)
    }

    #[test]
    fn consensus_wide_spread_is_low() {
        let c = consensus(&[result(120.0), result(128.0), result(140.0)]).unwrap();
        assert_eq!(c.bpm, 128.0);
        assert_eq!(c.confidence, Confidence::Low); // 12 BPM from median
    }

    #[test]
    fn consensus_empty_errors() {
        assert!(consensus(&[]).is_err());
    }
}
