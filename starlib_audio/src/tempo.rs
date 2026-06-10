//! Tempo (BPM) detection via spectral-flux onset envelope + autocorrelation.
//!
//! Includes parabolic peak interpolation on the autocorrelation lag so the
//! estimate isn't quantised to integer-lag BPMs, and returns a confidence
//! bucket derived from peak sharpness.

use anyhow::{anyhow, Result};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

use crate::types::{BeatTracker, BpmError, BpmOptions, BpmResult, Confidence, ALGORITHM_VERSION};

const STFT_HOP: usize = 512;

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
    let (acorr_bpm, peak_ratio) = autocorrelate_bpm(&onset, sr, options)?;
    let raw_bpm = match options.beat_tracker {
        BeatTracker::Autocorrelation => acorr_bpm,
        BeatTracker::DynamicProgramming => dp_beat_track_bpm(&onset, sr, acorr_bpm)?,
    };

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
/// 2048-sample window / 512-sample hop at the pipeline's target sample rate
/// of 22050 Hz gives ~93 ms frames with ~23 ms steps (43 Hz frame rate) —
/// fine-grained enough to catch percussive onsets while keeping FFT cost low.
pub(crate) fn spectral_flux_onset(samples: &[f32]) -> Result<Vec<f32>> {
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

    let mut best_lag = min_lag;
    let mut best_score = f32::NEG_INFINITY;
    for (lag, &score) in acorr.iter().enumerate().take(max_lag + 1).skip(min_lag) {
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }

    let offset = parabolic_offset(acorr[best_lag - 1], acorr[best_lag], acorr[best_lag + 1]);
    let refined_lag = best_lag as f32 + offset;

    let bpm = if refined_lag > 0.0 {
        frame_rate * 60.0 / refined_lag
    } else {
        0.0
    };

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
    if !off.is_finite() || off.abs() > 1.0 {
        0.0
    } else {
        off
    }
}

/// Penalty weight on tempo deviation in the DP beat tracker. Ellis 2007
/// uses ~680 against unit-variance onsets; we z-score the envelope first
/// so this stays comparable. Larger = sticks closer to the target tempo;
/// smaller = trusts the onset peaks more.
const DP_ALPHA: f32 = 100.0;

/// Ellis 2007 dynamic-programming beat tracker, multi-target variant.
///
/// The autocorrelation peak is a strong-but-not-perfect tempo guess: on
/// tracks with a dotted or triplet feel it can lock onto a 2:3 sub-rate
/// (e.g. 138 BPM tracks misread as 92). To break those ties we run DP at
/// several candidate tempi — the autocorrelation peak itself plus its
/// 2:3, 3:2, 0.5× and 2× ratios — and pick the candidate whose beat
/// sequence captures the most onset energy. The chosen sequence's median
/// IBI is then parabolic-refined for sub-frame precision.
fn dp_beat_track_bpm(onset: &[f32], sr: u32, target_bpm: f32) -> Result<f32> {
    let frame_rate = sr as f32 / STFT_HOP as f32;
    if target_bpm <= 0.0 {
        return Err(BpmError::InsufficientData(format!("dp: bad target bpm {target_bpm}")).into());
    }
    let n = onset.len();

    // Z-score the envelope so DP_ALPHA is comparable across tracks.
    let mean = onset.iter().sum::<f32>() / n as f32;
    let var = onset.iter().map(|&v| (v - mean).powi(2)).sum::<f32>() / n as f32;
    let std = var.sqrt().max(1e-9);
    let norm: Vec<f32> = onset.iter().map(|&v| (v - mean) / std).collect();

    let base_lag = frame_rate * 60.0 / target_bpm;
    // Octave + 2:3 ratio variants. Order doesn't matter; we score them all.
    let ratios = [1.0, 2.0 / 3.0, 3.0 / 2.0, 0.5, 2.0];

    let mut best_capture = f32::NEG_INFINITY;
    let mut best_bpm = target_bpm;
    for &r in &ratios {
        let cand_lag = base_lag * r;
        let cand_bpm = frame_rate * 60.0 / cand_lag;
        // Stay inside the autocorrelation's search range; otherwise the
        // candidate doesn't correspond to a real tempo hypothesis.
        if cand_bpm < 50.0 || cand_bpm > 220.0 || cand_lag < 2.0 {
            continue;
        }
        if n < (cand_lag * 4.0) as usize {
            continue;
        }
        let Some((beats, _d_end)) = dp_forward(&norm, cand_lag, n) else {
            continue;
        };
        if beats.len() < 4 {
            continue;
        }
        // Score: raw onset energy at beat positions. Tempo-penalty-free,
        // so candidates with different targets are comparable.
        let capture: f32 = beats.iter().map(|&t| onset[t]).sum();
        if capture > best_capture {
            best_capture = capture;
            best_bpm = bpm_from_beats(&beats, onset, frame_rate).unwrap_or(cand_bpm);
        }
    }

    Ok(best_bpm)
}

/// Single DP forward + backtrack pass at a fixed target lag.
/// Returns `(beats, score_at_end)` or `None` if the envelope is too short.
fn dp_forward(norm: &[f32], target_lag: f32, n: usize) -> Option<(Vec<usize>, f32)> {
    let lag_lo = (target_lag * 0.5).max(2.0) as usize;
    let lag_hi = ((target_lag * 2.0) as usize).min(n.saturating_sub(1));
    if lag_hi <= lag_lo {
        return None;
    }
    let log_target = target_lag.ln();

    let mut d = vec![f32::NEG_INFINITY; n];
    let mut p = vec![-1i32; n];
    for t in 0..lag_lo.min(n) {
        d[t] = norm[t];
    }
    for t in lag_lo..n {
        let mut best = 0.0_f32;
        let mut best_prev: i32 = -1;
        let upper = lag_hi.min(t);
        for tau in lag_lo..=upper {
            let prev_score = d[t - tau];
            if !prev_score.is_finite() {
                continue;
            }
            let log_ratio = (tau as f32).ln() - log_target;
            let penalty = DP_ALPHA * log_ratio * log_ratio;
            let score = prev_score - penalty;
            if score > best {
                best = score;
                best_prev = (t - tau) as i32;
            }
        }
        d[t] = norm[t] + best;
        p[t] = best_prev;
    }

    // End at the highest-scoring beat in the last quarter — trailing
    // frames have had the most context to accumulate score.
    let start = (n * 3) / 4;
    let mut end = start;
    let mut max_d = d[start];
    for t in start..n {
        if d[t] > max_d {
            max_d = d[t];
            end = t;
        }
    }

    let mut beats: Vec<usize> = vec![end];
    let mut cur = p[end];
    while cur >= 0 {
        beats.push(cur as usize);
        cur = p[cur as usize];
    }
    beats.reverse();
    Some((beats, max_d))
}

/// BPM from a beat sequence, with parabolic refinement on the local
/// autocorrelation around the median inter-beat-interval. Without the
/// refinement, integer-frame quantisation caps precision at ±1 BPM
/// around the chosen lag.
fn bpm_from_beats(beats: &[usize], onset: &[f32], frame_rate: f32) -> Option<f32> {
    if beats.len() < 4 {
        return None;
    }
    let mut ibis: Vec<usize> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    ibis.sort_unstable();
    let median_ibi = ibis[ibis.len() / 2];
    if median_ibi == 0 {
        return None;
    }
    let refined_lag = if median_ibi >= 2 && median_ibi + 1 < onset.len() {
        let acorr_at = |lag: usize| -> f32 {
            (0..onset.len().saturating_sub(lag))
                .map(|i| onset[i] * onset[i + lag])
                .sum()
        };
        let y0 = acorr_at(median_ibi - 1);
        let y1 = acorr_at(median_ibi);
        let y2 = acorr_at(median_ibi + 1);
        median_ibi as f32 + parabolic_offset(y0, y1, y2)
    } else {
        median_ibi as f32
    };
    if refined_lag <= 0.0 {
        return None;
    }
    Some(frame_rate * 60.0 / refined_lag)
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
        let off = parabolic_offset(1.0, 2.0, 1.0);
        assert!(off.abs() < 1e-6, "offset={off}");
    }

    #[test]
    fn parabolic_interpolation_shifted_peak() {
        let f = |x: f32| -(x - 0.25).powi(2) + 1.0;
        let off = parabolic_offset(f(-1.0), f(0.0), f(1.0));
        assert!((off - 0.25).abs() < 1e-4, "offset={off}");
    }

    #[test]
    fn parabolic_interpolation_zero_denominator() {
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
        let c = consensus(&[result(125.0), result(128.0), result(132.0)]).unwrap();
        assert_eq!(c.bpm, 128.0);
        assert_eq!(c.confidence, Confidence::Medium);
    }

    #[test]
    fn consensus_wide_spread_is_low() {
        let c = consensus(&[result(120.0), result(128.0), result(140.0)]).unwrap();
        assert_eq!(c.bpm, 128.0);
        assert_eq!(c.confidence, Confidence::Low);
    }

    #[test]
    fn consensus_empty_errors() {
        assert!(consensus(&[]).is_err());
    }

    #[test]
    fn dp_recovers_125_bpm_when_given_2_3_subrate_target() {
        // Regression for the "always 167 BPM" failure on melodic-house
        // tracks: the autocorrelation peak lands on a dotted-beat (3:2)
        // sub-rate at ~83 BPM, which octave-correction then doubles to ~167.
        // DP at the 2/3× ratio candidate should recover the true 125 BPM
        // from an envelope where the *physical* beat is the true periodicity.
        let sr = 22050u32;
        let frame_rate = sr as f32 / STFT_HOP as f32;
        let beat_lag = frame_rate * 60.0 / 125.0; // ≈ 20.67

        let n = 1500usize;
        let mut onset = vec![0.0f32; n];
        // Kick on every beat. Real spectral flux is kick-dominated; the
        // pathological behaviour comes from autocorrelation getting fooled
        // by the *spacing* of accents, not their amplitude.
        let mut t = 5.0_f32;
        while (t as usize) < n {
            onset[t as usize] = 1.0;
            t += beat_lag;
        }

        // Hand DP a target at the 3:2 sub-rate (the wrong autocorrelation
        // lock). Its 2/3× ratio candidate should find the true beat.
        let target_bpm = 125.0 * 2.0 / 3.0; // ≈ 83.3 → would correct to 167
        let bpm = dp_beat_track_bpm(&onset, sr, target_bpm).unwrap();
        let (bpm, _) = apply_octave_correction(bpm);
        assert!(
            (bpm - 125.0).abs() < 3.0,
            "DP failed to recover 125 from a 3:2 target: got {bpm}"
        );
    }

    #[test]
    fn dp_beat_track_recovers_synthetic_tempo() {
        // Synthetic onset envelope: spikes every `spacing` frames at
        // sr=22050, hop=512 (frame_rate=43.066 Hz). spacing=20 frames ≈
        // 129.2 BPM. Targeting 130 should let the DP recover ~129 from
        // the median IBI even though the target is slightly off.
        let frame_rate = 22050.0 / STFT_HOP as f32;
        let spacing = 20usize;
        let mut onset = vec![0.0f32; 1000];
        for t in (5..onset.len()).step_by(spacing) {
            onset[t] = 1.0;
        }
        let bpm = dp_beat_track_bpm(&onset, 22050, 130.0).unwrap();
        let expected = frame_rate * 60.0 / spacing as f32;
        assert!(
            (bpm - expected).abs() < 1.0,
            "dp recovered {bpm}, expected ~{expected}"
        );
    }
}
