//! Tonal centre: bass note from the bass stem, pitch-class chroma per bar.
//!
//! Whole-track key profiles were unreliable on techno, so this reports the
//! bass root and chroma rather than a major/minor key.

use serde::Serialize;

use super::features::{mid, stft};
use super::grid::Grid;
use crate::decode::Stereo;

const BASS_N_FFT: usize = 16_384;
const BASS_RANGE_HZ: (f64, f64) = (30.0, 200.0);
const BASS_PEAKS: usize = 3;
const CHROMA_N_FFT: usize = 8192;
const CHROMA_RANGE_HZ: (f64, f64) = (55.0, 2000.0);
pub const NOTE_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

#[derive(Debug, Serialize)]
pub struct BassPeak {
    pub hz: f64,
    pub note: String,
    /// Relative to the strongest peak.
    pub db: f64,
}

#[derive(Debug, Serialize)]
pub struct Tonal {
    /// Pitch class of the strongest bass peak.
    pub root: Option<String>,
    pub bass_peaks: Vec<BassPeak>,
    /// Pitch-class energy per bar (C..B), scaled so each bar's maximum is 1.
    pub chroma: Vec<[f64; 12]>,
}

fn midi(hz: f64) -> f64 {
    12.0 * (hz / 440.0).log2() + 69.0
}

fn pitch_class(hz: f64) -> usize {
    (midi(hz).round() as i64).rem_euclid(12) as usize
}

/// Strongest spectral peaks of the averaged bass spectrum.
pub fn bass_peaks(bass: &Stereo) -> Vec<BassPeak> {
    let sr = f64::from(bass.sr);
    let bin_hz = sr / BASS_N_FFT as f64;
    let mut spectrum = vec![0.0f64; BASS_N_FFT / 2 + 1];
    stft(&mid(bass), BASS_N_FFT, BASS_N_FFT / 2, |_, frame| {
        spectrum
            .iter_mut()
            .zip(frame)
            .for_each(|(s, c)| *s += c.norm_sqr() as f64);
    });
    let lo = (BASS_RANGE_HZ.0 / bin_hz).ceil() as usize;
    let hi = (BASS_RANGE_HZ.1 / bin_hz).floor() as usize;
    let mut peaks: Vec<(f64, f64)> = (lo.max(1)..=hi)
        .filter(|&k| spectrum[k] > spectrum[k - 1] && spectrum[k] >= spectrum[k + 1])
        .map(|k| {
            // Parabolic interpolation on log power for a sub-bin frequency.
            let (a, b, c) = (spectrum[k - 1].ln(), spectrum[k].ln(), spectrum[k + 1].ln());
            let offset = 0.5 * (a - c) / (a - 2.0 * b + c);
            ((k as f64 + offset) * bin_hz, spectrum[k])
        })
        .collect();
    peaks.sort_by(|x, y| y.1.total_cmp(&x.1));
    let strongest = peaks.first().map_or(0.0, |p| p.1);
    peaks
        .into_iter()
        .take(BASS_PEAKS)
        .map(|(hz, power)| BassPeak {
            hz,
            note: format!(
                "{}{}",
                NOTE_NAMES[pitch_class(hz)],
                (midi(hz).round() as i64).div_euclid(12) - 1
            ),
            db: 10.0 * (power / strongest).log10(),
        })
        .collect()
}

/// Pitch-class energy per bar.
pub fn chroma(audio: &Stereo, grid: &Grid) -> Vec<[f64; 12]> {
    let sr = f64::from(audio.sr);
    let bin_hz = sr / CHROMA_N_FFT as f64;
    let lo = (CHROMA_RANGE_HZ.0 / bin_hz).ceil() as usize;
    let hi = (CHROMA_RANGE_HZ.1 / bin_hz).floor() as usize;
    let classes: Vec<usize> = (lo..=hi).map(|k| pitch_class(k as f64 * bin_hz)).collect();
    let mut chroma = vec![[0.0; 12]; grid.n_bars];
    stft(
        &mid(audio),
        CHROMA_N_FFT,
        CHROMA_N_FFT / 2,
        |start, frame| {
            let bar =
                ((((start + CHROMA_N_FFT / 2) as f64 / sr) - grid.downbeat_s) / grid.bar_s).floor();
            if bar < 0.0 || bar as usize >= grid.n_bars {
                return;
            }
            for (c, &pc) in frame[lo..=hi].iter().zip(&classes) {
                chroma[bar as usize][pc] += c.norm_sqr() as f64;
            }
        },
    );
    for bar in &mut chroma {
        let max = bar.iter().cloned().fold(0.0, f64::max);
        if max > 0.0 {
            bar.iter_mut().for_each(|v| *v /= max);
        }
    }
    chroma
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    fn tone(hz: f64, seconds: f64) -> Stereo {
        let x: Vec<f32> = (0..(seconds * f64::from(SR)) as usize)
            .map(|i| (std::f64::consts::TAU * hz * i as f64 / f64::from(SR)).sin() as f32)
            .collect();
        Stereo {
            left: x.clone(),
            right: x,
            sr: SR,
        }
    }

    #[test]
    fn b1_bass_reads_as_b() {
        let peaks = bass_peaks(&tone(61.74, 4.0));
        assert_eq!(peaks[0].note, "B1");
        assert!((peaks[0].hz - 61.74).abs() < 0.5, "hz {}", peaks[0].hz);
    }

    #[test]
    fn a440_chroma_peaks_at_a() {
        let grid = Grid::fixed(120.0, 0.0, 4.0);
        let chroma = chroma(&tone(440.0, 4.0), &grid);
        assert_eq!(chroma[0][9], 1.0);
        assert!(chroma[0]
            .iter()
            .enumerate()
            .all(|(pc, &v)| pc == 9 || v < 0.1));
    }
}
