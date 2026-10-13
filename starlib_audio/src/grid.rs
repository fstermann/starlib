//! Beatgrid detection for a track whose tempo is already known.
//!
//! The tempo comes from outside (SoundCloud's listed BPM), so the job is to
//! find *where* the beats fall: a constant grid `t_k = first + k * period`.
//! The period is only refined within a narrow band around the hint, which
//! rules out octave and triplet errors by construction.
//!
//! Pipeline: a fine-hop onset envelope weighted toward the kick band, a fold
//! over candidate periods to find the period and phase, then a weighted
//! least-squares fit of the grid to the onset peaks near each predicted beat.
//! The downbeat is the beat-in-bar offset where block-level timbre changes
//! concentrate, since drops and breakdowns land on bar starts.

use anyhow::Result;
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::Serialize;

use crate::types::BpmError;

/// Sample rate the grid analysis expects its input at.
pub const GRID_SR: u32 = 22050;
const WIN: usize = 1024;
/// 128 samples at 22050 Hz: 5.8 ms frames, fine enough for sub-10 ms grids.
const HOP: usize = 128;
/// Upper edge of the kick band (Hz) that dominates the onset envelope.
const KICK_HZ: f32 = 150.0;
/// Number of log-spaced bands in the timbre features (40 Hz .. Nyquist).
pub(crate) const BANDS: usize = 12;
/// Period search band around the hint, relative. SoundCloud's listed BPM is a
/// whole number and was measured up to 2 BPM (1.4%) off the audio; octave and
/// triplet errors stay far outside the band.
const PERIOD_SPAN: f64 = 0.03;
/// Coarse period search step, relative.
const COARSE_STEP: f64 = 1e-4;
/// Fine period search step, relative. Small enough that a whole track's drift
/// stays under one fold bin.
const FINE_STEP: f64 = 1e-5;
/// Fold resolution: bins per beat period.
const FOLD_BINS: usize = 320;
/// Half-width of the onset-peak search around each predicted beat.
const PEAK_SEARCH_S: f64 = 0.03;
/// Residual beyond which a beat is dropped from the final fit.
const INLIER_S: f64 = 0.015;
/// How far the onset-envelope peak leads a kick's attack: the windowed flux
/// rises before the frame centre reaches the transient. Measured on synthetic
/// kicks (constant across tempo and phase).
const ONSET_LEAD_S: f64 = 0.0159;
pub(crate) const BEATS_PER_BAR: usize = 4;

/// One beat in the detected grid.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GridBeat {
    pub time_s: f64,
    /// Position in the bar, 1-4 (1 = downbeat).
    pub beat: u8,
}

/// A constant-tempo beatgrid.
#[derive(Debug, Clone)]
pub struct BeatGrid {
    pub bpm: f64,
    pub beats: Vec<GridBeat>,
    /// Share of audible beats with an onset on the grid, 0-1.
    pub confidence: f32,
}

/// Per-frame analysis shared by the grid and phrase stages.
pub(crate) struct Frames {
    /// Frames per second.
    pub rate: f64,
    /// Onset strength per frame, kick-weighted, locally mean-removed.
    pub onset: Vec<f32>,
    /// Log band energies per frame.
    pub bands: Vec<[f32; BANDS]>,
    /// Log total energy per frame.
    pub energy: Vec<f32>,
}

impl Frames {
    /// Time (s) of a frame's centre.
    fn time(&self, frame: f64) -> f64 {
        frame / self.rate + (WIN as f64 / 2.0) / (self.rate * HOP as f64)
    }

    /// Fractional frame index whose centre is at `t`.
    pub(crate) fn frame_at(&self, t: f64) -> f64 {
        (t - (WIN as f64 / 2.0) / (self.rate * HOP as f64)) * self.rate
    }
}

pub(crate) fn analyse_frames(samples: &[f32], sr: u32) -> Result<Frames> {
    if samples.len() < WIN * 8 {
        return Err(BpmError::InsufficientData(format!(
            "grid analysis needs at least {} samples, got {}",
            WIN * 8,
            samples.len()
        ))
        .into());
    }
    let peak = samples.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak == 0.0 {
        return Err(BpmError::SilentInput.into());
    }
    let gain = 1.0 / peak;

    let hann: Vec<f32> = (0..WIN)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WIN as f32).cos())
        .collect();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(WIN);
    let half = WIN / 2;
    let bin_hz = sr as f32 / WIN as f32;
    let kick_bin = ((KICK_HZ / bin_hz).ceil() as usize).clamp(2, half);
    let band_of = band_lookup(half, bin_hz);

    let n_frames = (samples.len() - WIN) / HOP + 1;
    let mut low_flux = Vec::with_capacity(n_frames);
    let mut full_flux = Vec::with_capacity(n_frames);
    let mut bands = Vec::with_capacity(n_frames);
    let mut energy = Vec::with_capacity(n_frames);
    let mut prev = vec![0.0f32; half];
    let mut buf = vec![Complex { re: 0.0, im: 0.0 }; WIN];

    for f in 0..n_frames {
        let start = f * HOP;
        for i in 0..WIN {
            buf[i] = Complex {
                re: samples[start + i] * gain * hann[i],
                im: 0.0,
            };
        }
        fft.process(&mut buf);
        let (mut low, mut full, mut total) = (0.0f32, 0.0f32, 0.0f32);
        let mut band_pow = [0.0f32; BANDS];
        for i in 1..half {
            let pow = buf[i].norm_sqr();
            total += pow;
            if let Some(b) = band_of[i] {
                band_pow[b] += pow;
            }
            let mag = (1.0 + 100.0 * pow.sqrt()).ln();
            let rise = (mag - prev[i]).max(0.0);
            full += rise;
            if i < kick_bin {
                low += rise;
            }
            prev[i] = mag;
        }
        low_flux.push(low);
        full_flux.push(full);
        bands.push(band_pow.map(|p| (p + 1e-9).log10() * 10.0));
        energy.push((total + 1e-9).log10() * 10.0);
    }

    let onset = combine_onsets(&low_flux, &full_flux, sr as f64 / HOP as f64);
    Ok(Frames {
        rate: sr as f64 / HOP as f64,
        onset,
        bands,
        energy,
    })
}

/// Map FFT bins to log-spaced bands from 40 Hz up to Nyquist.
fn band_lookup(half: usize, bin_hz: f32) -> Vec<Option<usize>> {
    let lo = 40.0f32.ln();
    let hi = (bin_hz * half as f32).ln();
    (0..half)
        .map(|i| {
            let f = i as f32 * bin_hz;
            if f < 40.0 {
                return None;
            }
            let b = ((f.ln() - lo) / (hi - lo) * BANDS as f32) as usize;
            Some(b.min(BANDS - 1))
        })
        .collect()
}

/// Sum the kick-band and full-band flux (each normalised by its mean), then
/// remove a ~0.4 s moving average so only sharp attacks remain.
fn combine_onsets(low: &[f32], full: &[f32], rate: f64) -> Vec<f32> {
    let mean = |v: &[f32]| (v.iter().sum::<f32>() / v.len() as f32).max(1e-9);
    let (ml, mf) = (mean(low), mean(full));
    let raw: Vec<f32> = low
        .iter()
        .zip(full)
        .map(|(l, f)| 2.0 * l / ml + f / mf)
        .collect();
    let half_w = (0.2 * rate) as usize;
    let mut prefix = vec![0.0f64; raw.len() + 1];
    for (i, v) in raw.iter().enumerate() {
        prefix[i + 1] = prefix[i] + *v as f64;
    }
    (0..raw.len())
        .map(|i| {
            let a = i.saturating_sub(half_w);
            let b = (i + half_w + 1).min(raw.len());
            let avg = (prefix[b] - prefix[a]) / (b - a) as f64;
            (raw[i] - avg as f32).max(0.0)
        })
        .collect()
}

/// Detect the beatgrid of mono `samples` at `sr`, given the track's tempo.
pub fn detect_grid(samples: &[f32], sr: u32, bpm_hint: f64) -> Result<BeatGrid> {
    let frames = analyse_frames(samples, sr)?;
    let duration_s = samples.len() as f64 / sr as f64;
    Ok(grid_from_frames(&frames, duration_s, bpm_hint))
}

pub(crate) fn grid_from_frames(frames: &Frames, duration_s: f64, bpm_hint: f64) -> BeatGrid {
    let (period, phase) = fold_search(frames, 60.0 / bpm_hint);
    let (period, first, confidence) = refine(frames, period, phase, duration_s);
    let first = first + ONSET_LEAD_S;
    let first = first - (first / period).floor() * period;
    let n = ((duration_s - first) / period).floor() as usize + 1;
    let times: Vec<f64> = (0..n).map(|k| first + k as f64 * period).collect();
    let offset = downbeat_offset(frames, &times);
    let beats = times
        .into_iter()
        .enumerate()
        .map(|(k, time_s)| GridBeat {
            time_s,
            beat: ((k + BEATS_PER_BAR - offset) % BEATS_PER_BAR) as u8 + 1,
        })
        .collect();
    BeatGrid {
        bpm: 60.0 / period,
        beats,
        confidence,
    }
}

/// Fold the onset envelope at each candidate period, coarse then fine;
/// return the period and phase (s, of a beat) whose fold peaks highest.
fn fold_search(frames: &Frames, hint_period: f64) -> (f64, f64) {
    let (coarse, _) = fold_scan(frames, hint_period, PERIOD_SPAN, COARSE_STEP);
    fold_scan(frames, coarse, COARSE_STEP, FINE_STEP)
}

fn fold_scan(frames: &Frames, centre: f64, span: f64, step: f64) -> (f64, f64) {
    let steps = (span / step).round() as i64;
    let mut best = (f32::MIN, centre, 0.0);
    let mut fold = vec![0.0f32; FOLD_BINS];
    for s in -steps..=steps {
        let period = centre * (1.0 + s as f64 * step);
        let period_frames = period * frames.rate;
        fold.fill(0.0);
        for (f, v) in frames.onset.iter().enumerate() {
            if *v == 0.0 {
                continue;
            }
            let pos = (f as f64 / period_frames).fract();
            fold[(pos * FOLD_BINS as f64) as usize % FOLD_BINS] += v;
        }
        let (bin, score) = circular_peak(&fold, 3);
        if score > best.0 {
            let frame = bin as f64 / FOLD_BINS as f64 * period_frames;
            best = (score, period, frames.time(frame));
        }
    }
    (best.1, best.2)
}

/// Peak of a circular histogram after a ±`radius` box smoothing.
fn circular_peak(fold: &[f32], radius: usize) -> (usize, f32) {
    let n = fold.len();
    let mut best = (0, f32::MIN);
    for i in 0..n {
        let s: f32 = (0..=2 * radius)
            .map(|d| fold[(i + n + d - radius) % n])
            .sum();
        if s > best.1 {
            best = (i, s);
        }
    }
    best
}

/// Weighted least-squares fit of `t_k = first + k * period` to the onset
/// peaks near each predicted beat. Returns `(period, first, confidence)`.
fn refine(frames: &Frames, period: f64, phase: f64, duration_s: f64) -> (f64, f64, f32) {
    let first = phase - (phase / period).floor() * period;
    let n = ((duration_s - first) / period).floor() as i64 + 1;
    let peaks: Vec<(f64, f64, f64)> = (0..n)
        .filter_map(|k| {
            let t = first + k as f64 * period;
            onset_peak_near(frames, t).map(|(pt, w)| (k as f64, pt, w))
        })
        .collect();
    if peaks.len() < 8 {
        return (period, first, 0.0);
    }

    let mut fit = (first, period);
    for tol in [2.0 * PEAK_SEARCH_S, PEAK_SEARCH_S, INLIER_S] {
        let inliers: Vec<&(f64, f64, f64)> = peaks
            .iter()
            .filter(|(k, t, _)| (t - (fit.0 + k * fit.1)).abs() <= tol)
            .collect();
        if inliers.len() < 8 {
            break;
        }
        fit = weighted_line(&inliers);
    }
    let inliers = peaks
        .iter()
        .filter(|(k, t, _)| (t - (fit.0 + k * fit.1)).abs() <= INLIER_S)
        .count();
    let audible = audible_beats(frames, fit.0, fit.1, n);
    let confidence = (inliers as f32 / audible.max(1) as f32).min(1.0);
    (fit.1, fit.0, confidence)
}

/// Strongest onset peak within ±`PEAK_SEARCH_S` of `t`, parabolic-refined.
/// Returns `(time_s, height)`.
fn onset_peak_near(frames: &Frames, t: f64) -> Option<(f64, f64)> {
    let centre = frames.frame_at(t);
    let radius = PEAK_SEARCH_S * frames.rate;
    let lo = (centre - radius).ceil().max(1.0) as usize;
    let hi = ((centre + radius).floor() as usize).min(frames.onset.len().saturating_sub(2));
    if lo > hi {
        return None;
    }
    let (i, v) = (lo..=hi)
        .map(|i| (i, frames.onset[i]))
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    if v <= 0.0 {
        return None;
    }
    let (y0, y1, y2) = (frames.onset[i - 1], v, frames.onset[i + 1]);
    let denom = y0 - 2.0 * y1 + y2;
    let offset = if denom.abs() > 1e-9 {
        (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    Some((frames.time(i as f64 + offset as f64), v as f64))
}

fn weighted_line(points: &[&(f64, f64, f64)]) -> (f64, f64) {
    let (mut sw, mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (x, y, w) in points.iter().map(|p| **p) {
        sw += w;
        sx += w * x;
        sy += w * y;
        sxx += w * x * x;
        sxy += w * x * y;
    }
    let slope = (sw * sxy - sx * sy) / (sw * sxx - sx * sx);
    ((sy - slope * sx) / sw, slope)
}

/// Beats whose surrounding frame energy is within 30 dB of the loudest
/// frame, so silent intros and tails don't count against confidence.
fn audible_beats(frames: &Frames, first: f64, period: f64, n: i64) -> usize {
    let max = frames.energy.iter().cloned().fold(f32::MIN, f32::max);
    (0..n)
        .filter(|k| {
            let f = frames.frame_at(first + *k as f64 * period).round();
            f >= 0.0
                && frames
                    .energy
                    .get(f as usize)
                    .is_some_and(|e| *e > max - 30.0)
        })
        .count()
}

/// Beat-synchronous band features: the mean log band energy over each beat.
pub(crate) fn beat_features(frames: &Frames, times: &[f64]) -> Vec<[f32; BANDS]> {
    times
        .iter()
        .enumerate()
        .map(|(k, t)| {
            let end = times
                .get(k + 1)
                .copied()
                .unwrap_or(t + (t - times[k.saturating_sub(1)]));
            let a = frames.frame_at(*t).max(0.0) as usize;
            let b = (frames.frame_at(end).max(0.0) as usize).min(frames.bands.len());
            let mut acc = [0.0f32; BANDS];
            if a >= b {
                return acc;
            }
            for f in &frames.bands[a..b] {
                for (x, v) in acc.iter_mut().zip(f) {
                    *x += v;
                }
            }
            acc.map(|x| x / (b - a) as f32)
        })
        .collect()
}

/// Which beat index mod 4 is the downbeat: the offset where the change
/// between the bar before and the bar after a beat is largest on average.
fn downbeat_offset(frames: &Frames, times: &[f64]) -> usize {
    let feats = standardise(&beat_features(frames, times));
    let mut score = [0.0f64; BEATS_PER_BAR];
    let block = BEATS_PER_BAR * 2;
    for k in block..feats.len().saturating_sub(block) {
        let before = mean_vec(&feats[k - block..k]);
        let after = mean_vec(&feats[k..k + block]);
        let d: f64 = before
            .iter()
            .zip(&after)
            .map(|(a, b)| ((a - b) as f64).powi(2))
            .sum();
        score[k % BEATS_PER_BAR] += d;
    }
    (0..BEATS_PER_BAR)
        .max_by(|a, b| score[*a].total_cmp(&score[*b]))
        .unwrap_or(0)
}

/// Z-score each band across all rows.
pub(crate) fn standardise(rows: &[[f32; BANDS]]) -> Vec<[f32; BANDS]> {
    if rows.is_empty() {
        return vec![];
    }
    let mean = mean_vec(rows);
    let mut var = [0.0f32; BANDS];
    for r in rows {
        for i in 0..BANDS {
            var[i] += (r[i] - mean[i]).powi(2);
        }
    }
    let std = var.map(|v| (v / rows.len() as f32).sqrt().max(1e-6));
    rows.iter()
        .map(|r| std::array::from_fn(|i| (r[i] - mean[i]) / std[i]))
        .collect()
}

pub(crate) fn mean_vec(rows: &[[f32; BANDS]]) -> [f32; BANDS] {
    let mut acc = [0.0f32; BANDS];
    for r in rows {
        for i in 0..BANDS {
            acc[i] += r[i];
        }
    }
    acc.map(|x| x / rows.len().max(1) as f32)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A decaying 55 Hz kick with a 2 ms attack, starting at sample 0.
    fn kick(sr: u32) -> Vec<f32> {
        let n = (0.25 * sr as f32) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / sr as f32;
                let attack = (t / 0.002).min(1.0);
                attack * (-t * 18.0).exp() * (2.0 * std::f32::consts::PI * 55.0 * t).sin()
            })
            .collect()
    }

    /// One stretch of a synthetic track: from `from_bar` on, a 440 Hz pad at
    /// `pad` level and the kick on or off.
    #[derive(Clone, Copy)]
    pub(crate) struct Part {
        pub from_bar: usize,
        pub pad: f32,
        pub kick: bool,
    }

    /// Kicks at `bpm` (first beat at `first_s`), a hi-hat on every off-beat,
    /// and per-bar `parts`. Bars start at beat index `downbeat`; without
    /// parts the kick plays throughout with a full pad.
    pub(crate) fn synth_track(
        bpm: f64,
        first_s: f64,
        seconds: f64,
        downbeat: usize,
        parts: &[Part],
    ) -> Vec<f32> {
        let sr = GRID_SR;
        let mut out = vec![0.0f32; (seconds * sr as f64) as usize];
        let k = kick(sr);
        let period = 60.0 / bpm;
        let mut beat = 0usize;
        let mut t = first_s;
        let mut seed = 1u32;
        while t < seconds {
            let start = (t * sr as f64).round() as usize;
            let bar = beat.saturating_sub(downbeat) / BEATS_PER_BAR;
            let part = parts
                .iter()
                .rev()
                .find(|p| bar >= p.from_bar)
                .copied()
                .unwrap_or(Part {
                    from_bar: 0,
                    pad: 1.0,
                    kick: true,
                });
            if part.kick {
                for (i, v) in k.iter().enumerate() {
                    if let Some(o) = out.get_mut(start + i) {
                        *o += v * 0.8;
                    }
                }
            }
            let hat = ((t + period / 2.0) * sr as f64) as usize;
            for i in 0..(0.03 * sr as f64) as usize {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                let noise = (seed >> 16) as f32 / 32768.0 - 1.0;
                if let Some(o) = out.get_mut(hat + i) {
                    *o += noise * 0.15 * (-(i as f32) / 200.0).exp();
                }
            }
            let pad_end = ((t + period) * sr as f64) as usize;
            for i in start..pad_end.min(out.len()) {
                let ts = i as f32 / sr as f32;
                out[i] += part.pad * 0.2 * (2.0 * std::f32::consts::PI * 440.0 * ts).sin();
            }
            beat += 1;
            t = first_s + beat as f64 * period;
        }
        out
    }

    #[test]
    fn locks_onto_kicks_with_known_tempo() {
        let pcm = synth_track(126.0, 0.317, 90.0, 0, &[]);
        let grid = detect_grid(&pcm, GRID_SR, 126.0).unwrap();
        assert!((grid.bpm - 126.0).abs() < 0.01, "bpm {}", grid.bpm);
        let near = grid
            .beats
            .iter()
            .map(|b| b.time_s)
            .find(|t| *t > 0.2)
            .unwrap();
        assert!((near - 0.317).abs() < 0.005, "first beat {near}");
        assert!(grid.confidence > 0.9, "confidence {}", grid.confidence);
    }

    #[test]
    fn refines_an_off_by_a_fraction_hint() {
        let pcm = synth_track(127.6, 0.1, 120.0, 0, &[]);
        let grid = detect_grid(&pcm, GRID_SR, 128.0).unwrap();
        assert!((grid.bpm - 127.6).abs() < 0.01, "bpm {}", grid.bpm);
        let last = grid.beats.iter().rev().find(|b| b.time_s < 119.0).unwrap();
        let k = ((last.time_s - 0.1) / (60.0 / 127.6)).round();
        let truth = 0.1 + k * 60.0 / 127.6;
        assert!(
            (last.time_s - truth).abs() < 0.005,
            "drift {}",
            last.time_s - truth
        );
    }

    #[test]
    fn downbeat_follows_bar_level_changes() {
        // Pad level toggles every 8 bars, so bar starts carry the changes.
        let layout: Vec<Part> = (0..12)
            .map(|i| Part {
                from_bar: i * 8,
                pad: (i % 2) as f32,
                kick: true,
            })
            .collect();
        for downbeat in 0..BEATS_PER_BAR {
            let pcm = synth_track(124.0, 0.5, 200.0, downbeat, &layout);
            let grid = detect_grid(&pcm, GRID_SR, 124.0).unwrap();
            let first_kick = grid
                .beats
                .iter()
                .position(|b| (b.time_s - 0.5).abs() < 0.005)
                .unwrap();
            assert_eq!(
                grid.beats[first_kick + downbeat].beat,
                1,
                "downbeat {downbeat}"
            );
        }
    }
}
