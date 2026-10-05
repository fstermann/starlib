//! Locate a known track inside a window of a DJ mix.
//!
//! The original is cut into overlapping chunks, each correlated against the
//! whole mix window on log band energies. Every strong peak is a vote for
//! "the track's t=0 sits at mix time T". Repeated sections, loops, fades and
//! the overlapping neighbour track scatter their votes, while the regular
//! play-through stacks them on one line `t = start + k·u`; a Hough search over
//! start and a small speed drift `k` finds it. A fine pass then correlates
//! onset envelopes at ~3 ms resolution around the line to pin the start.
//!
//! Tempo: the caller passes playback-rate hints (set BPM / original BPM, or
//! from the Shazam pitch offset). Each hint is tried with key-lock (tempo
//! changes, pitch kept) and pitch-fader (both change) features; the best
//! scoring candidate wins.

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::Serialize;

/// Sample rate both signals are decoded to before alignment.
pub const ALIGN_SR: u32 = 11025;

const COARSE_WIN: usize = 2048;
const COARSE_HOP: usize = 512;
const COARSE_BANDS: usize = 24;
const COARSE_HZ: (f64, f64) = (50.0, 5000.0);
const FINE_WIN: usize = 512;
const FINE_HOP: usize = 32;
const FINE_BANDS: usize = 8;
const FINE_HZ: (f64, f64) = (60.0, 5000.0);

// ~16 bars at 128 BPM: long enough to span phrase changes, so a chunk
// matches its own place better than a repeat of the same loop elsewhere.
const CHUNK_S: f64 = 30.0;
const CHUNK_HOP_S: f64 = 5.0;
const PEAKS_PER_CHUNK: usize = 5;
const PEAK_NMS_S: f64 = 0.3;
const MAX_DRIFT: f64 = 0.03;
const DRIFT_STEP: f64 = 0.001;
const START_BIN_S: f64 = 0.1;
const INLIER_S: f64 = 0.25;
// A rival start closer than this is the same hypothesis, not a competitor.
const RIVAL_MIN_GAP_S: f64 = 1.0;
const FINE_CHUNK_S: f64 = 8.0;
const FINE_SEARCH_S: f64 = 0.15;
const MAX_FINE_CHUNKS: usize = 12;
const MIN_FINE_SCORE: f32 = 0.2;
// A tempo ride bends the vote line; fit only near the entry so the start is
// right where the track comes in.
const CURVED_RMS_S: f64 = 0.015;
const LOCAL_FIT_S: f64 = 60.0;
const ACTIVE_FRACTION: f32 = 0.5;

/// Where the original sits in the mix window.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Alignment {
    /// Mix-window time where the original's t=0 lands (may be negative).
    pub start_s: f64,
    /// Playback rate of the original in the mix (>1 = sped up).
    pub rate: f64,
    /// True when the tempo changed without pitch (key-lock / master tempo).
    pub key_lock: bool,
    /// `1 - rival/best` vote weight, in `[0, 1]`.
    pub confidence: f64,
    /// Mix-window time where the original first matches.
    pub enter_s: f64,
    /// Mix-window time where the original last matches.
    pub exit_s: f64,
    /// Chunks of the original whose best match agrees with the result.
    pub matched_chunks: usize,
}

/// Find `original` inside `mix` (both mono at `sr`).
///
/// `rate_hints` are candidate playback rates of the original in the mix;
/// pass `[1.0]` when nothing is known. Returns `None` when no chunk of the
/// original matches consistently.
pub fn align(mix: &[f32], original: &[f32], sr: u32, rate_hints: &[f64]) -> Option<Alignment> {
    let mix_frames = frame_positions(mix.len(), COARSE_HOP as f64, 0.0);
    let mix_bins = bin_bands(COARSE_WIN, sr, 1.0, COARSE_BANDS, COARSE_HZ);
    let mix_feats = band_energies(mix, &mix_frames, COARSE_WIN, &mix_bins, COARSE_BANDS);
    let frame_s = COARSE_HOP as f64 / sr as f64;

    let mut best: Option<(Coarse, f64, bool)> = None;
    for &rate in rate_hints.iter().filter(|r| r.is_finite() && **r > 0.0) {
        let modes: &[bool] = if (rate - 1.0).abs() < 0.002 { &[true] } else { &[true, false] };
        for &key_lock in modes {
            let freq_scale = if key_lock { 1.0 } else { rate };
            let orig_frames = frame_positions(original.len(), COARSE_HOP as f64 * rate, 0.0);
            let bins = bin_bands(COARSE_WIN, sr, freq_scale, COARSE_BANDS, COARSE_HZ);
            let orig_feats = band_energies(original, &orig_frames, COARSE_WIN, &bins, COARSE_BANDS);
            if let Some(c) = coarse_match(&mix_feats, &orig_feats, frame_s) {
                if best.as_ref().is_none_or(|(b, _, _)| c.weight > b.weight) {
                    best = Some((c, rate, key_lock));
                }
            }
        }
    }
    let (coarse, rate, key_lock) = best?;

    let mut points: Vec<(f64, f64)> = Vec::new();
    let step = coarse.inliers.len().div_ceil(MAX_FINE_CHUNKS).max(1);
    for &(u, _) in coarse.inliers.iter().step_by(step) {
        let t0 = coarse.start + coarse.slope * u;
        let playback = rate / coarse.slope;
        if let Some(delta) = fine_offset(mix, original, sr, u * rate, t0, playback, key_lock) {
            points.push((u, t0 + delta));
        }
    }
    let (start, slope) = robust_line(&points).unwrap_or((coarse.start, coarse.slope));

    let (enter_s, exit_s) = coarse.active_span(start, slope, mix.len() as f64 / sr as f64);
    Some(Alignment {
        start_s: start,
        rate: rate / slope,
        key_lock,
        confidence: coarse.confidence,
        enter_s,
        exit_s,
        matched_chunks: coarse.inliers.len(),
    })
}

/// Result of the coarse vote: a line `t = start + slope·u` in mix seconds,
/// with `u` the chunk's offset in rate-corrected original seconds.
struct Coarse {
    start: f64,
    slope: f64,
    weight: f64,
    confidence: f64,
    /// `(u, t)` of the vote each agreeing chunk cast.
    inliers: Vec<(f64, f64)>,
    /// Per chunk: its offset `u` and correlation score at every mix lag.
    scores: Vec<(f64, Vec<f32>)>,
    frame_s: f64,
}

impl Coarse {
    fn active_span(&self, start: f64, slope: f64, mix_s: f64) -> (f64, f64) {
        let at_line: Vec<(f64, f32)> = self
            .scores
            .iter()
            .map(|(u, s)| {
                let lag = ((start + slope * u) / self.frame_s).round() as i64;
                let near = (lag - 1..=lag + 1)
                    .filter(|&l| l >= 0 && (l as usize) < s.len())
                    .map(|l| s[l as usize])
                    .fold(f32::MIN, f32::max);
                (*u, near)
            })
            .collect();
        let peak = at_line.iter().map(|p| p.1).fold(0.0, f32::max);
        let active: Vec<f64> = at_line
            .iter()
            .filter(|p| p.1 >= peak * ACTIVE_FRACTION)
            .map(|p| p.0)
            .collect();
        let (Some(first), Some(last)) = (active.first(), active.last()) else {
            return (start.max(0.0), start.max(0.0));
        };
        let clamp = |t: f64| t.clamp(0.0, mix_s);
        (clamp(start + slope * first), clamp(start + slope * (last + CHUNK_S)))
    }
}

fn coarse_match(mix: &[Vec<f32>], orig: &[Vec<f32>], frame_s: f64) -> Option<Coarse> {
    let n_mix = mix.first()?.len();
    let n_orig = orig.first()?.len();
    let chunk_len = ((CHUNK_S / frame_s) as usize).min(n_orig).min(n_mix);
    if chunk_len < 8 {
        return None;
    }
    let index = MixIndex::new(mix, chunk_len);
    let hop = ((CHUNK_HOP_S / frame_s) as usize).max(1);
    let nms = (PEAK_NMS_S / frame_s).ceil() as usize;

    let mut votes: Vec<Vote> = Vec::new();
    let mut scores = Vec::new();
    let mut chunk_start = 0;
    while chunk_start + chunk_len <= n_orig {
        let chunk: Vec<&[f32]> = orig.iter().map(|b| &b[chunk_start..chunk_start + chunk_len]).collect();
        if let Some(s) = index.scores(&chunk) {
            let u = chunk_start as f64 * frame_s;
            for (lag, w) in top_peaks(&s, nms, PEAKS_PER_CHUNK) {
                votes.push(Vote { chunk: scores.len(), u, t: lag * frame_s, w: w as f64 });
            }
            scores.push((u, s));
        }
        chunk_start += hop;
    }

    let (start, slope, weight, rival) = hough(&votes)?;
    let mut inliers: Vec<(f64, f64)> = Vec::new();
    for chunk in 0..scores.len() {
        let closest = votes
            .iter()
            .filter(|v| v.chunk == chunk)
            .map(|v| (v, (v.t - start - slope * v.u).abs()))
            .filter(|(_, d)| *d < INLIER_S)
            .min_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((v, _)) = closest {
            inliers.push((v.u, v.t));
        }
    }
    if inliers.len() < 2 {
        return None;
    }
    let (start, slope) = fit_line(&inliers).unwrap_or((start, slope));
    Some(Coarse {
        start,
        slope,
        weight,
        confidence: (1.0 - rival / weight).clamp(0.0, 1.0),
        inliers,
        scores,
        frame_s,
    })
}

struct Vote {
    chunk: usize,
    u: f64,
    t: f64,
    w: f64,
}

/// Best `(start, slope, weight, rival_weight)` over a start × drift grid.
fn hough(votes: &[Vote]) -> Option<(f64, f64, f64, f64)> {
    if votes.is_empty() {
        return None;
    }
    let u_max = votes.iter().map(|v| v.u).fold(0.0, f64::max);
    let t_min = votes.iter().map(|v| v.t).fold(f64::MAX, f64::min);
    let t_max = votes.iter().map(|v| v.t).fold(f64::MIN, f64::max);
    let s_min = t_min - (1.0 + MAX_DRIFT) * u_max - START_BIN_S;
    let n_bins = ((t_max - s_min) / START_BIN_S) as usize + 3;
    let steps = (MAX_DRIFT / DRIFT_STEP).round() as i64;

    let mut profile = vec![0.0f64; n_bins];
    let mut best = (0.0f64, 0usize, 1.0f64);
    let mut hist = vec![0.0f64; n_bins];
    for i in -steps..=steps {
        let slope = 1.0 + i as f64 * DRIFT_STEP;
        hist.fill(0.0);
        for v in votes {
            let b = ((v.t - slope * v.u - s_min) / START_BIN_S).round() as usize;
            hist[b.min(n_bins - 1)] += v.w;
        }
        for b in 1..n_bins - 1 {
            let smoothed = 0.5 * hist[b - 1] + hist[b] + 0.5 * hist[b + 1];
            profile[b] = profile[b].max(smoothed);
            if smoothed > best.0 {
                best = (smoothed, b, slope);
            }
        }
    }
    let (weight, bin, slope) = best;
    if weight <= 0.0 {
        return None;
    }
    let gap = (RIVAL_MIN_GAP_S / START_BIN_S) as usize;
    let rival = profile
        .iter()
        .enumerate()
        .filter(|(b, _)| b.abs_diff(bin) > gap)
        .map(|(_, w)| *w)
        .fold(0.0, f64::max);
    Some((s_min + bin as f64 * START_BIN_S, slope, weight, rival))
}

/// Band-major mix features with per-band spectra and running sums, so each
/// chunk's normalised cross-correlation costs one FFT pair per band.
struct MixIndex {
    len: usize,
    chunk_len: usize,
    nfft: usize,
    spectra: Vec<Vec<Complex<f32>>>,
    sums: Vec<(Vec<f64>, Vec<f64>)>,
    planner: std::cell::RefCell<FftPlanner<f32>>,
}

impl MixIndex {
    fn new(mix: &[Vec<f32>], chunk_len: usize) -> Self {
        let len = mix[0].len();
        let nfft = (len + chunk_len).next_power_of_two();
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(nfft);
        let spectra = mix
            .iter()
            .map(|band| {
                let mut buf: Vec<Complex<f32>> = band.iter().map(|&x| Complex { re: x, im: 0.0 }).collect();
                buf.resize(nfft, Complex::default());
                fft.process(&mut buf);
                buf
            })
            .collect();
        let sums = mix
            .iter()
            .map(|band| {
                let mut s1 = vec![0.0f64; len + 1];
                let mut s2 = vec![0.0f64; len + 1];
                for (i, &x) in band.iter().enumerate() {
                    s1[i + 1] = s1[i] + x as f64;
                    s2[i + 1] = s2[i] + (x as f64) * (x as f64);
                }
                (s1, s2)
            })
            .collect();
        Self { len, chunk_len, nfft, spectra, sums, planner: std::cell::RefCell::new(planner) }
    }

    /// Band-averaged normalised cross-correlation of `chunk` at every lag,
    /// or `None` if the chunk is flat (silence) in every band.
    fn scores(&self, chunk: &[&[f32]]) -> Option<Vec<f32>> {
        let l = self.chunk_len;
        let lags = self.len - l + 1;
        let mut planner = self.planner.borrow_mut();
        let fwd = planner.plan_fft_forward(self.nfft);
        let inv = planner.plan_fft_inverse(self.nfft);
        let mut total = vec![0.0f32; lags];
        let mut used = 0;
        let mut buf = vec![Complex::default(); self.nfft];
        for (b, band) in chunk.iter().enumerate() {
            let Some((centred, norm)) = centre(band) else { continue };
            buf.fill(Complex::default());
            for (i, x) in centred.iter().enumerate() {
                buf[i].re = *x;
            }
            fwd.process(&mut buf);
            for (c, m) in buf.iter_mut().zip(&self.spectra[b]) {
                *c = c.conj() * m;
            }
            inv.process(&mut buf);
            let (s1, s2) = &self.sums[b];
            for (lag, out) in total.iter_mut().enumerate() {
                let sum = s1[lag + l] - s1[lag];
                let var = s2[lag + l] - s2[lag] - sum * sum / l as f64;
                if var > 1e-6 * l as f64 {
                    let dot = buf[lag].re as f64 / self.nfft as f64;
                    *out += (dot / (norm * var.sqrt())) as f32;
                }
            }
            used += 1;
        }
        if used == 0 {
            return None;
        }
        total.iter_mut().for_each(|s| *s /= used as f32);
        Some(total)
    }
}

/// Zero-mean copy of `x` and its L2 norm, or `None` when `x` is flat.
fn centre(x: &[f32]) -> Option<(Vec<f32>, f64)> {
    let mean = x.iter().map(|&v| v as f64).sum::<f64>() / x.len() as f64;
    let centred: Vec<f32> = x.iter().map(|&v| (v as f64 - mean) as f32).collect();
    let norm = centred.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>().sqrt();
    // Std below 0.05 (log-energy units) is silence or a constant tone.
    (norm > 0.05 * (x.len() as f64).sqrt()).then_some((centred, norm))
}

/// Up to `k` highest positive local maxima, at least `nms` lags apart, with
/// sub-lag (parabolic) positions.
fn top_peaks(s: &[f32], nms: usize, k: usize) -> Vec<(f64, f32)> {
    let mut cands: Vec<usize> = (1..s.len().saturating_sub(1))
        .filter(|&i| s[i] > 0.0 && s[i] >= s[i - 1] && s[i] > s[i + 1])
        .collect();
    cands.sort_by(|&a, &b| s[b].total_cmp(&s[a]));
    let mut picked: Vec<usize> = Vec::new();
    for i in cands {
        if picked.iter().all(|&p| p.abs_diff(i) > nms) {
            picked.push(i);
            if picked.len() == k {
                break;
            }
        }
    }
    picked
        .into_iter()
        .map(|i| (i as f64 + parabolic(s[i - 1], s[i], s[i + 1]), s[i]))
        .collect()
}

fn parabolic(y0: f32, y1: f32, y2: f32) -> f64 {
    let denom = y0 - 2.0 * y1 + y2;
    if denom.abs() < 1e-12 {
        0.0
    } else {
        (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5) as f64
    }
}

/// Offset (s) of the original's onsets from mix time `t0`, searched within
/// ±[`FINE_SEARCH_S`]. `tau0` is the original time that should sound at `t0`.
fn fine_offset(
    mix: &[f32],
    original: &[f32],
    sr: u32,
    tau0: f64,
    t0: f64,
    playback: f64,
    key_lock: bool,
) -> Option<f64> {
    let hop = FINE_HOP as f64;
    let sr_f = sr as f64;
    let len = (FINE_CHUNK_S * sr_f / hop) as usize;
    let w = (FINE_SEARCH_S * sr_f / hop).ceil() as usize;
    let orig_pos: Vec<f64> = (0..=len).map(|j| tau0 * sr_f + j as f64 * hop * playback).collect();
    let mix_pos: Vec<f64> = (0..=len + 2 * w).map(|i| t0 * sr_f + (i as f64 - w as f64) * hop).collect();
    if mix_pos[0] < 0.0 || *mix_pos.last()? as usize + FINE_WIN > mix.len() {
        return None;
    }
    if *orig_pos.last()? as usize + FINE_WIN > original.len() {
        return None;
    }
    let freq_scale = if key_lock { 1.0 } else { playback };
    let orig = onsets(&band_energies(
        original,
        &orig_pos,
        FINE_WIN,
        &bin_bands(FINE_WIN, sr, freq_scale, FINE_BANDS, FINE_HZ),
        FINE_BANDS,
    ));
    let mixed = onsets(&band_energies(
        mix,
        &mix_pos,
        FINE_WIN,
        &bin_bands(FINE_WIN, sr, 1.0, FINE_BANDS, FINE_HZ),
        FINE_BANDS,
    ));

    let bands: Vec<(Vec<f32>, f64, &Vec<f32>)> = orig
        .iter()
        .zip(&mixed)
        .filter_map(|(o, m)| centre(o).map(|(c, n)| (c, n, m)))
        .collect();
    if bands.is_empty() {
        return None;
    }
    let scores: Vec<f32> = (0..=2 * w)
        .map(|lag| {
            let total: f64 = bands
                .iter()
                .map(|(c, norm, m)| {
                    let win = &m[lag..lag + len];
                    let mean = win.iter().map(|&v| v as f64).sum::<f64>() / len as f64;
                    let (mut dot, mut var) = (0.0f64, 0.0f64);
                    for (a, &b) in c.iter().zip(win) {
                        let d = b as f64 - mean;
                        dot += *a as f64 * d;
                        var += d * d;
                    }
                    if var > 1e-12 { dot / (norm * var.sqrt()) } else { 0.0 }
                })
                .sum();
            (total / bands.len() as f64) as f32
        })
        .collect();
    let (best, &score) = scores.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1))?;
    if score < MIN_FINE_SCORE || best == 0 || best == 2 * w {
        return None;
    }
    let lag = best as f64 + parabolic(scores[best - 1], scores[best], scores[best + 1]);
    Some((lag - w as f64) * hop / sr_f)
}

/// Positive frame-to-frame rise of each band: an onset envelope.
fn onsets(bands: &[Vec<f32>]) -> Vec<Vec<f32>> {
    bands
        .iter()
        .map(|b| b.windows(2).map(|p| (p[1] - p[0]).max(0.0)).collect())
        .collect()
}

/// Least-squares line through `(u, t)`, dropping outliers; when the points
/// curve (a tempo ride), refit on the stretch nearest the track's entry.
fn robust_line(points: &[(f64, f64)]) -> Option<(f64, f64)> {
    let (a, b) = fit_line(points)?;
    let residual = |p: &(f64, f64)| (p.1 - a - b * p.0).abs();
    let mut res: Vec<f64> = points.iter().map(residual).collect();
    res.sort_by(f64::total_cmp);
    let cutoff = (3.0 * res[res.len() / 2]).max(0.02);
    let kept: Vec<(f64, f64)> = points.iter().copied().filter(|p| residual(p) <= cutoff).collect();
    let (a, b) = fit_line(&kept).unwrap_or((a, b));
    let rms = (kept.iter().map(|p| (p.1 - a - b * p.0).powi(2)).sum::<f64>() / kept.len() as f64).sqrt();
    if rms > CURVED_RMS_S {
        let first = kept.iter().map(|p| p.0).fold(f64::MAX, f64::min);
        let near: Vec<(f64, f64)> = kept.iter().copied().filter(|p| p.0 <= first + LOCAL_FIT_S).collect();
        if let Some(local) = fit_line(&near) {
            return Some(local);
        }
    }
    Some((a, b))
}

/// Least-squares `t = a + b·u`; with one point (or no spread in `u`) keeps
/// the slope at 1.
fn fit_line(points: &[(f64, f64)]) -> Option<(f64, f64)> {
    let n = points.len() as f64;
    if points.is_empty() {
        return None;
    }
    let mu = points.iter().map(|p| p.0).sum::<f64>() / n;
    let mt = points.iter().map(|p| p.1).sum::<f64>() / n;
    let suu: f64 = points.iter().map(|p| (p.0 - mu).powi(2)).sum();
    if suu < 1.0 {
        return Some((mt - mu, 1.0));
    }
    let sut: f64 = points.iter().map(|p| (p.0 - mu) * (p.1 - mt)).sum();
    let b = sut / suu;
    Some((mt - b * mu, b))
}

fn frame_positions(len: usize, hop: f64, offset: f64) -> Vec<f64> {
    let n = (len as f64 / hop).floor() as usize;
    (0..n).map(|i| offset + i as f64 * hop).collect()
}

/// Band index per FFT bin for log-spaced bands over `hz`. `freq_scale`
/// moves each bin to where it sounds after a pitch change.
fn bin_bands(win: usize, sr: u32, freq_scale: f64, bands: usize, hz: (f64, f64)) -> Vec<Option<usize>> {
    let span = (hz.1 / hz.0).ln();
    (0..win / 2)
        .map(|i| {
            let f = i as f64 * sr as f64 / win as f64 * freq_scale;
            if f < hz.0 || f >= hz.1 {
                return None;
            }
            Some(((f / hz.0).ln() / span * bands as f64) as usize).filter(|&b| b < bands)
        })
        .collect()
}

/// Log band energies (band-major) of Hann-windowed frames starting at
/// `positions` (samples; out-of-range samples read as silence).
fn band_energies(samples: &[f32], positions: &[f64], win: usize, bins: &[Option<usize>], bands: usize) -> Vec<Vec<f32>> {
    let hann: Vec<f32> = (0..win)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / win as f32).cos())
        .collect();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(win);
    let mut out = vec![vec![0.0f32; positions.len()]; bands];
    let mut buf = vec![Complex::default(); win];
    let mut power = vec![0.0f32; bands];
    for (j, &pos) in positions.iter().enumerate() {
        let start = pos.round() as i64;
        for (i, slot) in buf.iter_mut().enumerate() {
            let idx = start + i as i64;
            let s = if idx >= 0 { samples.get(idx as usize).copied().unwrap_or(0.0) } else { 0.0 };
            *slot = Complex { re: s * hann[i], im: 0.0 };
        }
        fft.process(&mut buf);
        power.fill(0.0);
        for (bin, band) in bins.iter().enumerate() {
            if let Some(b) = band {
                power[*b] += buf[bin].norm_sqr();
            }
        }
        for b in 0..bands {
            out[b][j] = (power[b] + 1e-10).ln();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = ALIGN_SR;
    const BPM: f64 = 124.0;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn unit(&mut self) -> f32 {
            (self.next() % 10_000) as f32 / 10_000.0
        }
    }

    #[derive(Clone)]
    struct Bar {
        kick: bool,
        hats: u16,
        chord: [f32; 3],
        bass: f32,
        seed: u64,
    }

    /// Dance-track score: 8-bar phrases that each loop a 4-bar chord
    /// progression and one hat pattern, with breakdowns (no kick).
    fn score(seed: u64, bars: usize) -> Vec<Bar> {
        let mut rng = Rng(seed);
        let roots = [110.0, 123.5, 130.8, 146.8, 164.8, 174.6, 196.0];
        let mut out = Vec::new();
        while out.len() < bars {
            let kick = rng.unit() > 0.2;
            let hats = (rng.next() & 0xFFFF) as u16 | 0x4444;
            let prog: Vec<f32> = (0..4).map(|_| roots[(rng.next() % 7) as usize]).collect();
            for i in 0..8 {
                let r = prog[i % 4];
                out.push(Bar { kick, hats, chord: [r * 2.0, r * 2.52, r * 3.0], bass: r / 2.0, seed: rng.next() });
            }
        }
        out.truncate(bars);
        out
    }

    fn render(bars: &[Bar], bpm: f64) -> Vec<f32> {
        let sr = SR as f64;
        let beat = 60.0 / bpm;
        let mut out = vec![0.0f32; (bars.len() as f64 * 4.0 * beat * sr) as usize + SR as usize];
        let mut add = |at: f64, len_s: f64, f: &mut dyn FnMut(f64) -> f32| {
            let start = (at * sr) as usize;
            for i in 0..(len_s * sr) as usize {
                if let Some(o) = out.get_mut(start + i) {
                    *o += f(i as f64 / sr);
                }
            }
        };
        for (n, bar) in bars.iter().enumerate() {
            let t_bar = n as f64 * 4.0 * beat;
            let mut rng = Rng(bar.seed | 1);
            for b in 0..4 {
                let t = t_bar + b as f64 * beat;
                if bar.kick {
                    add(t, 0.15, &mut |x| {
                        let phase = 2.0 * std::f64::consts::PI * (45.0 * x + 3.0 * (1.0 - (-x / 0.03).exp()));
                        (phase.sin() * (-x / 0.08).exp()) as f32 * 0.9
                    });
                }
                let off = t + beat / 2.0;
                let bass = bar.bass as f64;
                add(off, 0.12, &mut |x| ((2.0 * std::f64::consts::PI * bass * x).sin() * (-x / 0.06).exp()) as f32 * 0.4);
                let chord = bar.chord;
                add(off, 0.2, &mut |x| {
                    chord.iter().map(|&f| (2.0 * std::f64::consts::PI * f as f64 * x).sin() as f32).sum::<f32>()
                        * (-x / 0.1).exp() as f32
                        * 0.12
                });
            }
            for step in 0..16 {
                if bar.hats & (1 << step) != 0 {
                    let mut prev = 0.0f32;
                    add(t_bar + step as f64 * beat / 4.0, 0.03, &mut |x| {
                        let n = rng.unit() - 0.5;
                        let hp = n - prev;
                        prev = n;
                        hp * (-x / 0.01).exp() as f32 * 0.5
                    });
                }
            }
        }
        out
    }

    /// Plays `x` at `rate` (pitch and tempo change together).
    fn resample(x: &[f32], rate: f64) -> Vec<f32> {
        let n = (x.len() as f64 / rate) as usize;
        (0..n)
            .map(|i| {
                let p = i as f64 * rate;
                let k = p as usize;
                let f = (p - k as f64) as f32;
                x[k] * (1.0 - f) + x.get(k + 1).copied().unwrap_or(0.0) * f
            })
            .collect()
    }

    /// Mix with `inner` faded in at `at_s` over the previous track, and a
    /// next track fading in over its tail.
    fn mix_with(inner: &[f32], at_s: f64, total_s: f64, mix_bpm: f64) -> Vec<f32> {
        let sr = SR as f64;
        let mut mix = vec![0.0f32; (total_s * sr) as usize];
        let fade = (30.0 * sr) as usize;
        let at = (at_s * sr) as usize;
        let prev = render(&score(99, 64), mix_bpm);
        let prev_end = at + fade;
        for (i, s) in prev.iter().enumerate().take(prev_end) {
            let g = if i + fade > prev_end { (prev_end - i) as f32 / fade as f32 } else { 1.0 };
            mix[i] += s * g;
        }
        for (i, s) in inner.iter().enumerate() {
            let g = (i as f32 / fade as f32).min(1.0).min((inner.len() - i) as f32 / fade as f32);
            if let Some(m) = mix.get_mut(at + i) {
                *m += s * g;
            }
        }
        let next = render(&score(7, 64), mix_bpm);
        let next_at = at + inner.len() - fade;
        for (i, s) in next.iter().enumerate() {
            let g = (i as f32 / fade as f32).min(1.0);
            if let Some(m) = mix.get_mut(next_at + i) {
                *m += s * g;
            }
        }
        mix
    }

    #[test]
    fn finds_key_locked_track_at_set_tempo() {
        let bars = score(1, 64);
        let original = render(&bars, BPM);
        let rate = 1.03;
        let mix = mix_with(&render(&bars, BPM * rate), 47.3, 260.0, BPM * rate);

        let a = align(&mix, &original, SR, &[1.027]).expect("match");
        assert!((a.start_s - 47.3).abs() < 0.01, "{a:?}");
        assert!((a.rate - rate).abs() < 0.002, "{a:?}");
        assert!(a.key_lock, "{a:?}");
        assert!(a.confidence > 0.3, "{a:?}");
    }

    #[test]
    fn finds_pitch_fader_track() {
        let bars = score(2, 64);
        let original = render(&bars, BPM);
        let rate = 1.03;
        let mix = mix_with(&resample(&original, rate), 61.0, 260.0, BPM * rate);

        let a = align(&mix, &original, SR, &[1.027]).expect("match");
        assert!((a.start_s - 61.0).abs() < 0.01, "{a:?}");
        assert!((a.rate - rate).abs() < 0.002, "{a:?}");
        assert!(!a.key_lock, "{a:?}");
    }

    #[test]
    fn looped_intro_aligns_to_the_play_through() {
        let bars = score(3, 64);
        let original = render(&bars, BPM);
        let looped: Vec<Bar> = bars[..8].iter().chain(&bars).cloned().collect();
        let mix = mix_with(&render(&looped, BPM), 30.0, 260.0, BPM);
        let eight_bars = 8.0 * 4.0 * 60.0 / BPM;

        let a = align(&mix, &original, SR, &[1.0]).expect("match");
        assert!((a.start_s - (30.0 + eight_bars)).abs() < 0.01, "{a:?}");
        assert!(a.enter_s > 30.0 && a.exit_s > a.enter_s + 60.0, "{a:?}");
    }

    #[test]
    fn absent_track_has_low_confidence() {
        let original = render(&score(4, 64), BPM);
        let mix = mix_with(&render(&score(5, 64), BPM), 40.0, 260.0, BPM);

        let found = align(&mix, &original, SR, &[1.0]);
        assert!(found.as_ref().is_none_or(|a| a.confidence < 0.3), "{found:?}");
    }
}
