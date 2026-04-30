//! Section segmentation via spectral novelty.
//!
//! BPM-only clustering is a non-starter for DJ sets — track changes are
//! deliberately beat-matched, so BPM is flat across boundaries. Instead we
//! lean on **timbre + energy + onset density** (the literature's strongest
//! boundary signals for electronic music): build a per-frame feature vector,
//! compute a self-similarity matrix on cosine distance, run a checkerboard
//! novelty kernel along the diagonal, and pick peaks with a minimum
//! section-length constraint.
//!
//! Quality target is "decent v1, edit-me-in-UI" — the published ceiling on
//! hand-labelled DJ-mix corpora is ~5% boundary error and ~90% usable
//! switch points; this implementation is deliberately simpler than that
//! ceiling but produces the right *shape* of answer.

use anyhow::Result;
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::Serialize;

use crate::types::BpmError;

/// Tunables for section segmentation.
#[derive(Debug, Clone)]
pub struct SegmentOptions {
    /// Number of log-power frequency bands in the timbre feature vector.
    /// 8 is a cheap stand-in for full MFCC coefficients — enough resolution
    /// to separate "kick + bassline" from "synth-led breakdown" without the
    /// cost of a mel-filter bank + DCT.
    pub bands: usize,
    /// Half-width (in seconds) of the checkerboard kernel along the diagonal.
    /// Wider kernels detect coarser, slower boundaries; 32 s catches typical
    /// 3–8 minute DJ tracks well.
    pub kernel_half_s: f32,
    /// Minimum gap between detected boundaries (seconds). Suppresses
    /// double-counting around long crossfades. 90 s is the issue's
    /// recommended floor.
    pub min_gap_s: f32,
    /// Novelty peak threshold as a fraction of the maximum novelty value.
    /// Lower → more boundaries, more false positives.
    pub peak_threshold: f32,
}

impl Default for SegmentOptions {
    fn default() -> Self {
        Self {
            bands: 8,
            kernel_half_s: 32.0,
            min_gap_s: 90.0,
            peak_threshold: 0.35,
        }
    }
}

/// One detected section boundary. The first boundary is always at `start_s = 0`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Section {
    pub start_s: f32,
    pub end_s: f32,
    /// Peak prominence at this boundary, normalised to `[0, 1]`. Higher =
    /// stronger acoustic change. The trailing "implicit" end-of-track
    /// section carries the boundary that opened it.
    pub confidence: f32,
}

/// STFT analysis frame rate (frames per second) the segmenter operates at.
/// Hard-coded to match `tempo::spectral_flux_onset` (2048 win, 512 hop,
/// 22050 Hz target SR ≈ 43 Hz frame rate).
const STFT_HOP: usize = 512;
const STFT_WIN: usize = 2048;

/// Aggregate to one feature frame per second so the SSM stays cheap on long
/// sets. At 43 Hz STFT frame rate, that's a 43:1 reduction.
const FEATURES_PER_SECOND: f32 = 1.0;

/// Run segmentation on PCM samples (mono, at `sr`) and return the section
/// list. Always emits at least one section spanning the whole input.
pub fn segment(samples: &[f32], sr: u32, options: &SegmentOptions) -> Result<Vec<Section>> {
    let total_s = samples.len() as f32 / sr as f32;
    if samples.len() < STFT_WIN + STFT_HOP * 4 {
        // Less than ~5 seconds of audio — emit a single section spanning the
        // entire clip rather than failing.
        return Ok(vec![Section {
            start_s: 0.0,
            end_s: total_s.max(0.0),
            confidence: 0.0,
        }]);
    }

    let frame_rate = sr as f32 / STFT_HOP as f32;
    let features = compute_features(samples, options.bands)?;
    if features.is_empty() {
        return Ok(vec![Section {
            start_s: 0.0,
            end_s: total_s,
            confidence: 0.0,
        }]);
    }

    // Aggregate frame-rate features to ~1-per-second.
    let group = (frame_rate / FEATURES_PER_SECOND).max(1.0) as usize;
    let aggregated = aggregate_frames(&features, group);
    if aggregated.len() < 4 {
        return Ok(vec![Section {
            start_s: 0.0,
            end_s: total_s,
            confidence: 0.0,
        }]);
    }
    let agg_rate = frame_rate / group as f32;

    // SSM (cosine similarity on L2-normalised feature vectors).
    let ssm = self_similarity(&aggregated);

    // Checkerboard novelty along the diagonal.
    let kernel_half = (options.kernel_half_s * agg_rate).max(2.0) as usize;
    let novelty = checkerboard_novelty(&ssm, kernel_half);

    // Peak-pick with min-gap and threshold.
    let min_gap_frames = ((options.min_gap_s * agg_rate).max(1.0)) as usize;
    let peaks = pick_peaks(&novelty, min_gap_frames, options.peak_threshold);

    // Build sections.
    let mut sections = Vec::with_capacity(peaks.len() + 1);
    let mut prev_start = 0.0f32;
    let max_nov = novelty.iter().cloned().fold(0.0_f32, f32::max).max(1e-9);
    for &(idx, score) in &peaks {
        let t = idx as f32 / agg_rate;
        if t - prev_start < options.min_gap_s {
            continue;
        }
        sections.push(Section {
            start_s: prev_start,
            end_s: t,
            confidence: (score / max_nov).clamp(0.0, 1.0),
        });
        prev_start = t;
    }
    // Final tail section.
    sections.push(Section {
        start_s: prev_start,
        end_s: total_s,
        confidence: 0.0,
    });
    Ok(sections)
}

/// STFT-based feature extraction: per-frame log-power bands.
/// Returns a Vec of feature vectors (length == `bands`), one per STFT frame.
fn compute_features(samples: &[f32], bands: usize) -> Result<Vec<Vec<f32>>> {
    if samples.len() < STFT_WIN + STFT_HOP {
        return Err(BpmError::InsufficientData(format!(
            "feature extraction needs at least {} samples, got {}",
            STFT_WIN + STFT_HOP,
            samples.len()
        ))
        .into());
    }

    let hann: Vec<f32> = (0..STFT_WIN)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / STFT_WIN as f32).cos())
        .collect();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(STFT_WIN);

    let n_frames = (samples.len() - STFT_WIN) / STFT_HOP + 1;
    let half = STFT_WIN / 2;
    let band_size = (half / bands).max(1);
    let mut buf: Vec<Complex<f32>> = vec![Complex { re: 0.0, im: 0.0 }; STFT_WIN];
    let mut features = Vec::with_capacity(n_frames);

    for f in 0..n_frames {
        let start = f * STFT_HOP;
        for i in 0..STFT_WIN {
            buf[i] = Complex {
                re: samples[start + i] * hann[i],
                im: 0.0,
            };
        }
        fft.process(&mut buf);

        let mut feats = vec![0.0f32; bands];
        for b in 0..bands {
            let lo = b * band_size;
            let hi = ((b + 1) * band_size).min(half);
            let mut p = 0.0f32;
            for i in lo..hi {
                p += buf[i].re * buf[i].re + buf[i].im * buf[i].im;
            }
            feats[b] = (p + 1e-12).ln();
        }
        features.push(feats);
    }

    Ok(features)
}

/// Average together blocks of `group` consecutive feature vectors.
fn aggregate_frames(features: &[Vec<f32>], group: usize) -> Vec<Vec<f32>> {
    if group <= 1 {
        return features.to_vec();
    }
    let dim = features[0].len();
    let n_out = features.len() / group;
    let mut out = Vec::with_capacity(n_out);
    for g in 0..n_out {
        let mut sum = vec![0.0f32; dim];
        for f in 0..group {
            for (i, v) in features[g * group + f].iter().enumerate() {
                sum[i] += *v;
            }
        }
        for v in &mut sum {
            *v /= group as f32;
        }
        out.push(sum);
    }
    out
}

/// Cosine self-similarity matrix on L2-normalised vectors.
fn self_similarity(features: &[Vec<f32>]) -> Vec<Vec<f32>> {
    let n = features.len();
    let normed: Vec<Vec<f32>> = features
        .iter()
        .map(|v| {
            let norm = (v.iter().map(|x| x * x).sum::<f32>()).sqrt().max(1e-9);
            v.iter().map(|x| x / norm).collect()
        })
        .collect();
    let mut ssm = vec![vec![0.0f32; n]; n];
    for i in 0..n {
        for j in i..n {
            let mut dot = 0.0f32;
            for k in 0..normed[i].len() {
                dot += normed[i][k] * normed[j][k];
            }
            ssm[i][j] = dot;
            ssm[j][i] = dot;
        }
    }
    ssm
}

/// Checkerboard-novelty kernel along the diagonal of `ssm`. The kernel
/// shape is the standard `[[+, -], [-, +]]` 2x2 block applied at scale
/// `2 * half_size` (+1 in same-quadrant, -1 in cross-quadrant), which peaks
/// where past/future are internally similar but mutually dissimilar.
fn checkerboard_novelty(ssm: &[Vec<f32>], half_size: usize) -> Vec<f32> {
    let n = ssm.len();
    let mut novelty = vec![0.0f32; n];
    if half_size == 0 || n == 0 {
        return novelty;
    }
    let half = half_size as i64;
    for c in 0..n {
        let center = c as i64;
        let mut s = 0.0f32;
        for di in -half..half {
            for dj in -half..half {
                let i = center + di;
                let j = center + dj;
                if i < 0 || j < 0 || i >= n as i64 || j >= n as i64 {
                    continue;
                }
                // Same-side quadrant: +1; cross quadrant: -1.
                let sign = if (di < 0) == (dj < 0) { 1.0 } else { -1.0 };
                s += sign * ssm[i as usize][j as usize];
            }
        }
        novelty[c] = s;
    }
    // Half-wave rectify: only positive novelty corresponds to boundaries.
    for v in &mut novelty {
        *v = v.max(0.0);
    }
    novelty
}

/// Pick local maxima above `threshold * max(novelty)`, enforcing a minimum
/// gap between selected peaks. Returns `(index, score)` pairs sorted by index.
fn pick_peaks(novelty: &[f32], min_gap: usize, threshold: f32) -> Vec<(usize, f32)> {
    if novelty.is_empty() {
        return vec![];
    }
    let max = novelty.iter().cloned().fold(0.0_f32, f32::max);
    if max <= 0.0 {
        return vec![];
    }
    let cutoff = max * threshold;

    // First pass: every local max above cutoff.
    let mut candidates: Vec<(usize, f32)> = Vec::new();
    for i in 1..novelty.len().saturating_sub(1) {
        let v = novelty[i];
        if v < cutoff {
            continue;
        }
        if v >= novelty[i - 1] && v >= novelty[i + 1] {
            candidates.push((i, v));
        }
    }
    // Sort by score desc and greedily admit, skipping any within min_gap of
    // an already-admitted peak.
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut picked: Vec<(usize, f32)> = Vec::new();
    for (idx, score) in candidates {
        if picked.iter().any(|(p, _)| {
            let d = if *p > idx { *p - idx } else { idx - *p };
            d < min_gap
        }) {
            continue;
        }
        picked.push((idx, score));
    }
    picked.sort_by_key(|(i, _)| *i);
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic two-section signal at `sr`: `dur_s` seconds of low
    /// frequency tone followed by `dur_s` of high frequency tone. The
    /// timbre change should produce a single boundary near the midpoint.
    fn timbre_change_signal(sr: u32, half_s: f32) -> Vec<f32> {
        let n_half = (half_s * sr as f32) as usize;
        let mut out = Vec::with_capacity(n_half * 2);
        let mut t = 0.0f32;
        let dt = 1.0 / sr as f32;
        for _ in 0..n_half {
            // 200 Hz square-ish + bass impulses every 0.5 s
            let v = (2.0 * std::f32::consts::PI * 200.0 * t).sin();
            out.push(v * 0.4);
            t += dt;
        }
        for _ in 0..n_half {
            // 4 kHz sine — clearly different timbre.
            let v = (2.0 * std::f32::consts::PI * 4000.0 * t).sin();
            out.push(v * 0.4);
            t += dt;
        }
        out
    }

    #[test]
    fn segment_produces_at_least_one_section() {
        // 3-second silence — too short for boundary detection, should emit
        // one whole-clip section.
        let pcm = vec![0.0f32; 22050 * 3];
        let sections = segment(&pcm, 22050, &SegmentOptions::default()).unwrap();
        assert_eq!(sections.len(), 1);
        assert!((sections[0].end_s - 3.0).abs() < 0.05);
    }

    #[test]
    fn segment_detects_timbre_change() {
        let sr = 22050u32;
        // 100 s of low + 100 s of high = 200 s total. min_gap default is 90 s,
        // so the midpoint boundary at ~100 s clears the gap.
        let pcm = timbre_change_signal(sr, 100.0);
        let opts = SegmentOptions {
            min_gap_s: 90.0,
            kernel_half_s: 32.0,
            peak_threshold: 0.2,
            ..Default::default()
        };
        let sections = segment(&pcm, sr, &opts).unwrap();
        assert!(
            sections.len() >= 2,
            "expected at least 2 sections, got {}: {:?}",
            sections.len(),
            sections,
        );
        // Midpoint boundary should land near 100 s (±20 s tolerance — the
        // checkerboard kernel smears the peak across the kernel half-width).
        let boundary = sections[0].end_s;
        assert!(
            (boundary - 100.0).abs() < 20.0,
            "boundary {boundary} not within ±20 s of 100",
        );
    }

    #[test]
    fn pick_peaks_respects_min_gap() {
        // Three peaks: scores 1.0, 0.9, 0.8 at positions 10, 12, 50.
        let mut nov = vec![0.0f32; 60];
        nov[10] = 1.0;
        nov[12] = 0.9;
        nov[50] = 0.8;
        let peaks = pick_peaks(&nov, 5, 0.5);
        // peak at 10 admitted; 12 within min_gap so skipped; 50 admitted.
        assert_eq!(peaks.len(), 2);
        assert_eq!(peaks[0].0, 10);
        assert_eq!(peaks[1].0, 50);
    }
}
