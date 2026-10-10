//! Tempo refinement and 4/4 bar grid for a single track.
//!
//! The rough tempo from [`crate::tempo`] is refined against the kick: the mix
//! is low-passed at 120 Hz, its rectified envelope differenced, and every BPM
//! within ±[`SCAN_SPAN_BPM`] of the rough value is scored by how tightly the
//! onsets cluster in beat phase. Bar 1 starts at the first audible kick, which
//! holds for DJ-oriented tracks.

use std::f64::consts::TAU;

use anyhow::Result;
use serde::Serialize;

use crate::decode::linear_resample;
use crate::tempo;
use crate::types::BpmOptions;

const LOWPASS_HZ: f64 = 120.0;
const ENVELOPE_HOP: usize = 64;
const SCAN_SPAN_BPM: f64 = 1.5;
const SCAN_STEP_BPM: f64 = 0.01;
const SNAP_STEP_BPM: f64 = 0.5;
const SNAP_TOLERANCE_BPM: f64 = 0.03;
/// The first kick is the first envelope block within this many dB of the loudest.
const FIRST_KICK_DB: f64 = -20.0;
/// From there, backtrack to where the kick's attack crosses this level.
const ATTACK_START_DB: f64 = -40.0;
const ATTACK_BACKTRACK_S: f64 = 0.05;
pub const BEATS_PER_BAR: u32 = 4;

/// Bar grid of a track.
#[derive(Debug, Clone, Serialize)]
pub struct Grid {
    pub bpm: f64,
    pub bpm_rough: f64,
    /// Phase concentration of kick onsets at `bpm`, 0..1; `None` when the
    /// grid was supplied rather than estimated.
    pub concentration: Option<f64>,
    pub downbeat_s: f64,
    pub bar_s: f64,
    pub n_bars: usize,
    pub beats_per_bar: u32,
}

impl Grid {
    /// Build a grid from a known tempo and downbeat (Rekordbox or a manual nudge).
    pub fn fixed(bpm: f64, downbeat_s: f64, duration_s: f64) -> Self {
        let bar_s = 60.0 * f64::from(BEATS_PER_BAR) / bpm;
        Self {
            bpm,
            bpm_rough: bpm,
            concentration: None,
            downbeat_s,
            bar_s,
            n_bars: count_bars(duration_s, downbeat_s, bar_s),
            beats_per_bar: BEATS_PER_BAR,
        }
    }
}

/// Estimate the bar grid from mono PCM.
pub fn estimate(mono: &[f32], sr: u32) -> Result<Grid> {
    let opts = BpmOptions::default();
    let rough_pcm = linear_resample(mono, sr, opts.target_sr);
    let rough = tempo::analyze(&rough_pcm, opts.target_sr, &opts)?.bpm as f64;
    let onsets = kick_onsets(mono, sr);
    let frame_s = ENVELOPE_HOP as f64 / f64::from(sr);

    let (bpm, concentration) = refine(&onsets.novelty, frame_s, rough);
    let downbeat_s = onsets.first_kick_block as f64 * frame_s;
    let duration_s = mono.len() as f64 / f64::from(sr);
    let bar_s = 60.0 / bpm * f64::from(BEATS_PER_BAR);
    Ok(Grid {
        bpm,
        bpm_rough: rough,
        concentration: Some(concentration),
        downbeat_s,
        bar_s,
        n_bars: count_bars(duration_s, downbeat_s, bar_s),
        beats_per_bar: BEATS_PER_BAR,
    })
}

fn count_bars(duration_s: f64, downbeat_s: f64, bar_s: f64) -> usize {
    ((duration_s - downbeat_s) / bar_s).floor().max(0.0) as usize
}

struct KickOnsets {
    /// Half-wave rectified envelope difference, one value per envelope block.
    novelty: Vec<f64>,
    first_kick_block: usize,
}

fn kick_onsets(mono: &[f32], sr: u32) -> KickOnsets {
    let low = lowpass(mono, sr, LOWPASS_HZ);
    let envelope: Vec<f64> = low
        .chunks(ENVELOPE_HOP)
        .map(|block| block.iter().map(|x| x.abs()).sum::<f64>() / block.len() as f64)
        .collect();
    let peak = envelope.iter().cloned().fold(0.0, f64::max);
    let level = |db: f64| peak * 10f64.powf(db / 20.0);
    let loud = envelope
        .iter()
        .position(|&e| e >= level(FIRST_KICK_DB))
        .unwrap_or(0);
    let backtrack = (ATTACK_BACKTRACK_S * f64::from(sr) / ENVELOPE_HOP as f64) as usize;
    let first_kick_block = (loud.saturating_sub(backtrack)..=loud)
        .find(|&i| envelope[i] >= level(ATTACK_START_DB))
        .unwrap_or(loud);
    let novelty = std::iter::once(0.0)
        .chain(envelope.windows(2).map(|w| (w[1] - w[0]).max(0.0)))
        .collect();
    KickOnsets {
        novelty,
        first_kick_block,
    }
}

/// Return `(bpm, concentration)` maximising onset phase concentration.
fn refine(novelty: &[f64], frame_s: f64, rough: f64) -> (f64, f64) {
    let onsets: Vec<(f64, f64)> = novelty
        .iter()
        .enumerate()
        .filter(|(_, &w)| w > 0.0)
        .map(|(i, &w)| (i as f64 * frame_s, w))
        .collect();
    let total: f64 = onsets.iter().map(|(_, w)| w).sum();

    let steps = (2.0 * SCAN_SPAN_BPM / SCAN_STEP_BPM).round() as usize;
    let mut best = (rough, 0.0);
    for i in 0..=steps {
        let bpm = rough - SCAN_SPAN_BPM + i as f64 * SCAN_STEP_BPM;
        let r = phase_concentration(&onsets, bpm) / total;
        if r > best.1 {
            best = (bpm, r);
        }
    }
    let mut bpm = best.0;
    let snapped = (bpm / SNAP_STEP_BPM).round() * SNAP_STEP_BPM;
    if (bpm - snapped).abs() <= SNAP_TOLERANCE_BPM {
        bpm = snapped;
    }
    (bpm, phase_concentration(&onsets, bpm) / total)
}

/// Magnitude of the weighted sum of onset phases on the beat circle.
fn phase_concentration(onsets: &[(f64, f64)], bpm: f64) -> f64 {
    let omega = TAU * bpm / 60.0;
    let (re, im) = onsets.iter().fold((0.0, 0.0), |(re, im), &(t, w)| {
        let (sin, cos) = (omega * t).sin_cos();
        (re + w * cos, im + w * sin)
    });
    re.hypot(im)
}

/// Second-order Butterworth low-pass (RBJ biquad).
pub(crate) fn lowpass(x: &[f32], sr: u32, cutoff_hz: f64) -> Vec<f64> {
    let w0 = TAU * cutoff_hz / f64::from(sr);
    let alpha = w0.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
    let cos = w0.cos();
    let a0 = 1.0 + alpha;
    let b0 = (1.0 - cos) / 2.0 / a0;
    let b1 = (1.0 - cos) / a0;
    let a1 = -2.0 * cos / a0;
    let a2 = (1.0 - alpha) / a0;
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    x.iter()
        .map(|&s| {
            let s = f64::from(s);
            let y = b0 * s + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
            (x2, x1, y2, y1) = (x1, s, y1, y);
            y
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 22050;

    /// Decaying 55 Hz kick on every beat starting at `start_s`.
    fn kick_track(bpm: f64, start_s: f64, seconds: f64) -> Vec<f32> {
        let n = (seconds * f64::from(SR)) as usize;
        let beat = 60.0 / bpm;
        (0..n)
            .map(|i| {
                let t = i as f64 / f64::from(SR);
                if t < start_s {
                    return 0.0;
                }
                let since = (t - start_s) % beat;
                ((TAU * 55.0 * since).sin() * (-since * 25.0).exp()) as f32
            })
            .collect()
    }

    #[test]
    fn finds_tempo_and_first_kick() {
        let grid = estimate(&kick_track(144.0, 1.0, 60.0), SR).unwrap();
        assert_eq!(grid.bpm, 144.0);
        assert!(
            (grid.downbeat_s - 1.0).abs() < 0.01,
            "downbeat {}",
            grid.downbeat_s
        );
        assert_eq!(grid.n_bars, 35);
    }

    #[test]
    fn keeps_off_grid_tempo_unsnapped() {
        let grid = estimate(&kick_track(127.3, 0.0, 60.0), SR).unwrap();
        assert!((grid.bpm - 127.3).abs() < 0.02, "bpm {}", grid.bpm);
    }
}
