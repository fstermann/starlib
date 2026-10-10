//! Per-bar spectral features and the 16th-note groove grid.

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::Serialize;

use super::grid::Grid;
use crate::decode::Stereo;

const N_FFT: usize = 4096;
const HOP: usize = 512;
pub const BANDS_HZ: [(f64, f64); 6] = [
    (20.0, 60.0),
    (60.0, 150.0),
    (150.0, 500.0),
    (500.0, 2000.0),
    (2000.0, 6000.0),
    (6000.0, 20000.0),
];
/// Level reported for bars with no energy.
pub const FLOOR_DB: f64 = -120.0;
const GRID_FLOOR_DB: f64 = -60.0;
pub const SLOTS_PER_BAR: usize = 16;

/// Per-bar features of one source. dB values are relative to the loudest bar
/// of the full mix, so stems and mix share one scale.
#[derive(Debug, Serialize)]
pub struct SourceFeatures {
    pub db: Vec<f64>,
    pub bands_db: Vec<[f64; 6]>,
    pub centroid_hz: Vec<f64>,
    /// Side power over mid power.
    pub width: Vec<f64>,
    /// Mean positive spectral flux of log magnitudes.
    pub onset: Vec<f64>,
}

/// Linear per-bar measurements before dB conversion.
pub struct RawFeatures {
    power: Vec<f64>,
    band_power: Vec<[f64; 6]>,
    centroid_hz: Vec<f64>,
    width: Vec<f64>,
    onset: Vec<f64>,
}

impl RawFeatures {
    /// Power of the loudest bar, the 0 dB reference.
    pub fn peak_power(&self) -> f64 {
        self.power.iter().cloned().fold(0.0, f64::max)
    }

    pub fn into_db(self, reference: f64) -> SourceFeatures {
        let db = |p: f64| relative_db(p, reference, FLOOR_DB);
        SourceFeatures {
            db: self.power.iter().map(|&p| db(p)).collect(),
            bands_db: self.band_power.iter().map(|bands| bands.map(db)).collect(),
            centroid_hz: self.centroid_hz,
            width: self.width,
            onset: self.onset,
        }
    }
}

fn relative_db(power: f64, reference: f64, floor: f64) -> f64 {
    if power <= 0.0 || reference <= 0.0 {
        return floor;
    }
    (10.0 * (power / reference).log10()).max(floor)
}

pub fn mid(audio: &Stereo) -> Vec<f32> {
    audio
        .left
        .iter()
        .zip(&audio.right)
        .map(|(l, r)| (l + r) / 2.0)
        .collect()
}

/// Measure per-bar features of `audio` on `grid`.
pub fn measure(audio: &Stereo, grid: &Grid) -> RawFeatures {
    let sr = f64::from(audio.sr);
    let mid = mid(audio);
    let n_bars = grid.n_bars;
    let bar_of = |sample: usize| -> Option<usize> {
        let bar = ((sample as f64 / sr - grid.downbeat_s) / grid.bar_s).floor();
        (bar >= 0.0 && (bar as usize) < n_bars).then_some(bar as usize)
    };

    let bin_hz = sr / N_FFT as f64;
    let band_bins: Vec<(usize, usize)> = BANDS_HZ
        .iter()
        .map(|&(lo, hi)| {
            (
                (lo / bin_hz).ceil() as usize,
                ((hi / bin_hz).floor() as usize).min(N_FFT / 2),
            )
        })
        .collect();

    let mut frames = vec![0usize; n_bars];
    let mut power = vec![0.0; n_bars];
    let mut band_power = vec![[0.0; 6]; n_bars];
    let mut magnitude = vec![0.0; n_bars];
    let mut weighted_hz = vec![0.0; n_bars];
    let mut onset = vec![0.0; n_bars];
    let mut prev_log: Vec<f64> = vec![0.0; N_FFT / 2 + 1];

    stft(&mid, N_FFT, HOP, |start, spectrum| {
        let log: Vec<f64> = spectrum.iter().map(|c| (c.norm() as f64).ln_1p()).collect();
        let flux = log
            .iter()
            .zip(&prev_log)
            .map(|(a, b)| (a - b).max(0.0))
            .sum::<f64>()
            / log.len() as f64;
        prev_log = log;
        let Some(bar) = bar_of(start + N_FFT / 2) else {
            return;
        };
        frames[bar] += 1;
        onset[bar] += flux;
        for (k, c) in spectrum.iter().enumerate() {
            let p = c.norm_sqr() as f64;
            let m = c.norm() as f64;
            power[bar] += p;
            magnitude[bar] += m;
            weighted_hz[bar] += m * k as f64 * bin_hz;
        }
        for (b, &(lo, hi)) in band_bins.iter().enumerate() {
            band_power[bar][b] += spectrum[lo..=hi]
                .iter()
                .map(|c| c.norm_sqr() as f64)
                .sum::<f64>();
        }
    });

    let mut side_power = vec![0.0; n_bars];
    let mut mid_power = vec![0.0; n_bars];
    for (i, (l, r)) in audio.left.iter().zip(&audio.right).enumerate() {
        if let Some(bar) = bar_of(i) {
            let m = f64::from(l + r) / 2.0;
            let s = f64::from(l - r) / 2.0;
            mid_power[bar] += m * m;
            side_power[bar] += s * s;
        }
    }

    let per_frame = |total: f64, bar: usize| {
        if frames[bar] > 0 {
            total / frames[bar] as f64
        } else {
            0.0
        }
    };
    RawFeatures {
        power: (0..n_bars).map(|b| per_frame(power[b], b)).collect(),
        band_power: (0..n_bars)
            .map(|b| band_power[b].map(|p| per_frame(p, b)))
            .collect(),
        centroid_hz: (0..n_bars)
            .map(|b| {
                if magnitude[b] > 0.0 {
                    weighted_hz[b] / magnitude[b]
                } else {
                    0.0
                }
            })
            .collect(),
        width: (0..n_bars)
            .map(|b| {
                if mid_power[b] > 0.0 {
                    side_power[b] / mid_power[b]
                } else {
                    0.0
                }
            })
            .collect(),
        onset: (0..n_bars).map(|b| per_frame(onset[b], b)).collect(),
    }
}

/// Band energy per 16th note, in dB relative to the lane's loudest slot.
///
/// Each slot's unwindowed spectrum gives its in-band energy, which equals the
/// energy of the band-passed slot by Parseval.
pub fn groove_lane(
    audio: &Stereo,
    grid: &Grid,
    lo_hz: f64,
    hi_hz: f64,
) -> Vec<[f64; SLOTS_PER_BAR]> {
    let sr = f64::from(audio.sr);
    let mid = mid(audio);
    let slot_s = grid.bar_s / SLOTS_PER_BAR as f64;
    let n_fft = ((slot_s * sr).ceil() as usize).next_power_of_two();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(n_fft);
    let bin_hz = sr / n_fft as f64;
    let (lo, hi) = (
        (lo_hz / bin_hz).ceil() as usize,
        ((hi_hz / bin_hz).floor() as usize).min(n_fft / 2),
    );
    let mut buf = vec![Complex::new(0.0f32, 0.0); n_fft];

    let energy: Vec<[f64; SLOTS_PER_BAR]> = (0..grid.n_bars)
        .map(|bar| {
            std::array::from_fn(|slot| {
                let start_s = grid.downbeat_s + (bar * SLOTS_PER_BAR + slot) as f64 * slot_s;
                let start = (start_s * sr).round() as usize;
                let end = (((start_s + slot_s) * sr).round() as usize).min(mid.len());
                buf.iter_mut().for_each(|c| *c = Complex::new(0.0, 0.0));
                for (c, &x) in buf.iter_mut().zip(mid.get(start..end).unwrap_or(&[])) {
                    c.re = x;
                }
                fft.process(&mut buf);
                buf[lo..=hi]
                    .iter()
                    .map(|c| c.norm_sqr() as f64)
                    .sum::<f64>()
            })
        })
        .collect();
    let peak = energy.iter().flatten().cloned().fold(0.0, f64::max);
    energy
        .iter()
        .map(|slots| slots.map(|e| relative_db(e, peak, GRID_FLOOR_DB)))
        .collect()
}

/// Run a Hann-windowed STFT, calling `on_frame(start_sample, half_spectrum)`.
pub(crate) fn stft(
    x: &[f32],
    n_fft: usize,
    hop: usize,
    mut on_frame: impl FnMut(usize, &[Complex<f32>]),
) {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(n_fft);
    let hann: Vec<f32> = (0..n_fft)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n_fft as f32).cos())
        .collect();
    let mut buf = vec![Complex::new(0.0f32, 0.0); n_fft];
    let mut start = 0;
    while start + n_fft <= x.len() {
        for (i, c) in buf.iter_mut().enumerate() {
            *c = Complex::new(x[start + i] * hann[i], 0.0);
        }
        fft.process(&mut buf);
        on_frame(start, &buf[..=n_fft / 2]);
        start += hop;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    fn grid(n_bars: usize) -> Grid {
        Grid::fixed(120.0, 0.0, n_bars as f64 * 2.0)
    }

    fn tone(hz: f64, seconds: f64, gain: f32) -> Vec<f32> {
        (0..(seconds * f64::from(SR)) as usize)
            .map(|i| gain * (std::f64::consts::TAU * hz * i as f64 / f64::from(SR)).sin() as f32)
            .collect()
    }

    #[test]
    fn tone_lands_in_its_band_and_mono_has_no_width() {
        let x = tone(1000.0, 8.0, 0.5);
        let audio = Stereo {
            left: x.clone(),
            right: x,
            sr: SR,
        };
        let f = measure(&audio, &grid(4));
        let reference = f.peak_power();
        let f = f.into_db(reference);
        assert!(f.db[1].abs() < 0.5);
        let loudest_band = (0..6)
            .max_by(|&a, &b| f.bands_db[1][a].total_cmp(&f.bands_db[1][b]))
            .unwrap();
        assert_eq!(loudest_band, 3);
        assert!(
            (f.centroid_hz[1] - 1000.0).abs() < 50.0,
            "centroid {}",
            f.centroid_hz[1]
        );
        assert!(f.width[1] < 1e-9);
    }

    #[test]
    fn opposite_channels_are_wide() {
        let x = tone(1000.0, 8.0, 0.5);
        let mut left = x.clone();
        left.iter_mut().zip(&x).for_each(|(l, &r)| *l = 0.5 * r);
        let audio = Stereo {
            left,
            right: x.iter().map(|v| -v).collect(),
            sr: SR,
        };
        let f = measure(&audio, &grid(4));
        assert!(f.width[1] > 1.0);
    }

    #[test]
    fn groove_lane_finds_the_hits() {
        let mut x = vec![0.0f32; 2 * SR as usize];
        let slot = (0.125 * f64::from(SR)) as usize;
        for hit in [0, 4, 8, 12] {
            for (i, v) in tone(60.0, 0.1, 0.8).into_iter().enumerate() {
                x[hit * slot + i] = v;
            }
        }
        let audio = Stereo {
            left: x.clone(),
            right: x,
            sr: SR,
        };
        let lane = groove_lane(&audio, &grid(1), 30.0, 120.0);
        for (slot, &db) in lane[0].iter().enumerate() {
            if slot % 4 == 0 {
                assert!(db > -3.0, "slot {slot}: {db}");
            } else {
                assert!(db < -20.0, "slot {slot}: {db}");
            }
        }
    }
}
