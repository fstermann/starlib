//! Phrase (song-structure) detection on top of a beatgrid.
//!
//! Electronic tracks change in bar-aligned blocks, so we segment at bar
//! resolution: per-bar timbre features, then a dynamic program that picks the
//! boundaries minimising within-phrase variance plus a per-phrase penalty.
//! Inner phrases are whole multiples of 4 bars; only the first and last may
//! be ragged (pickups, fade tails), and every phrase spans at least 4 bars.
//! Labels use Rekordbox's high-mood vocabulary (Intro, Up, Down, Chorus,
//! Outro), assigned from energy and bass level relative to the track's
//! fullest phrase.

use anyhow::Result;
use serde::Serialize;

use crate::grid::{
    analyse_frames, beat_features, grid_from_frames, mean_vec, standardise, BeatGrid, Frames, BANDS,
};

/// Inner phrases are whole multiples of this many bars.
const PHRASE_UNIT_BARS: usize = 4;
/// Longest phrase; longer homogeneous stretches split, like Rekordbox does.
const MAX_PHRASE_BARS: usize = 32;
/// Cost of opening a phrase, per feature dimension. Higher → fewer phrases.
const PHRASE_PENALTY: f32 = 3.0;
/// Bars quieter than the loudest frame by this much are silence, not content.
const SILENCE_DB: f32 = 30.0;
/// A phrase within this many dB of the fullest phrase's bass and upper-band
/// level is a chorus.
const CHORUS_DB: f32 = 3.0;
/// Bass this far below the loudest phrase's means the kick/bassline is out.
const NO_BASS_DB: f32 = 6.0;
/// Upper-band rise across a phrase (second half over first) that makes it a build.
const BUILD_RISE_DB: f32 = 1.0;
/// Bands 0..BASS_BANDS cover roughly 40-160 Hz.
const BASS_BANDS: usize = 3;

/// One labelled phrase.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Phrase {
    /// Normalised kind: intro, up, down, chorus or outro.
    pub kind: &'static str,
    /// Display label, e.g. "Chorus".
    pub label: &'static str,
    pub start_s: f64,
    pub end_s: f64,
}

/// Detect the beatgrid and phrases of mono `samples` at `sr`, given the tempo.
pub fn analyse_structure(
    samples: &[f32],
    sr: u32,
    bpm_hint: f64,
) -> Result<(BeatGrid, Vec<Phrase>)> {
    let frames = analyse_frames(samples, sr)?;
    let duration_s = samples.len() as f64 / sr as f64;
    let grid = grid_from_frames(&frames, duration_s, bpm_hint);
    let phrases = detect_phrases(&frames, &grid, duration_s);
    Ok((grid, phrases))
}

/// A bar's raw (unstandardised) loudness summary.
struct BarLevel {
    energy_db: f32,
    bass_db: f32,
    /// Everything above the bass: pads, leads, vocals, hats.
    upper_db: f32,
}

fn detect_phrases(frames: &Frames, grid: &BeatGrid, duration_s: f64) -> Vec<Phrase> {
    let times: Vec<f64> = grid.beats.iter().map(|b| b.time_s).collect();
    let bar_starts: Vec<usize> = grid
        .beats
        .iter()
        .enumerate()
        .filter(|(_, b)| b.beat == 1)
        .map(|(i, _)| i)
        .collect();
    if bar_starts.len() < 2 * PHRASE_UNIT_BARS {
        return vec![];
    }
    let beat_feats = beat_features(frames, &times);
    let bar_end = |j: usize| bar_starts.get(j + 1).copied().unwrap_or(times.len());
    let bar_time = |j: usize| {
        bar_starts
            .get(j)
            .map_or(duration_s, |&i| times[i])
            .min(duration_s)
    };

    let bars: Vec<[f32; BANDS]> = (0..bar_starts.len())
        .map(|j| mean_vec(&beat_feats[bar_starts[j]..bar_end(j)]))
        .collect();
    let levels: Vec<BarLevel> = (0..bars.len())
        .map(|j| bar_level(frames, bar_time(j), bar_time(j + 1)))
        .collect();

    let loudest = levels.iter().map(|l| l.energy_db).fold(f32::MIN, f32::max);
    let audible = |j: &usize| levels[*j].energy_db > loudest - SILENCE_DB;
    let (Some(first), Some(last)) = (
        (0..bars.len()).find(audible),
        (0..bars.len()).rfind(audible),
    ) else {
        return vec![];
    };
    let content = &bars[first..=last];
    let bounds = segment(&standardise(content));

    let segments: Vec<(usize, usize)> = bounds
        .windows(2)
        .map(|w| (first + w[0], first + w[1]))
        .collect();
    let kinds = label(&segments, &levels);
    segments
        .iter()
        .zip(kinds)
        .map(|(&(a, b), kind)| Phrase {
            kind,
            label: display_label(kind),
            start_s: bar_time(a),
            end_s: bar_time(b),
        })
        .collect()
}

fn bar_level(frames: &Frames, start_s: f64, end_s: f64) -> BarLevel {
    let a = frames.frame_at(start_s).max(0.0) as usize;
    let b = (frames.frame_at(end_s).max(0.0) as usize).min(frames.energy.len());
    if a >= b {
        return BarLevel {
            energy_db: f32::MIN,
            bass_db: f32::MIN,
            upper_db: f32::MIN,
        };
    }
    let mean_db = |vals: &mut dyn Iterator<Item = f32>| {
        let (sum, n) = vals.fold((0.0f64, 0usize), |(s, n), db| {
            (s + 10f64.powf(db as f64 / 10.0), n + 1)
        });
        (10.0 * (sum / n as f64).log10()) as f32
    };
    BarLevel {
        energy_db: mean_db(&mut frames.energy[a..b].iter().copied()),
        bass_db: mean_db(
            &mut frames.bands[a..b]
                .iter()
                .flat_map(|f| f[..BASS_BANDS].to_vec()),
        ),
        upper_db: mean_db(
            &mut frames.bands[a..b]
                .iter()
                .flat_map(|f| f[BASS_BANDS..].to_vec()),
        ),
    }
}

/// Phrase boundaries over standardised bar features, as bar indices
/// `[0, .., n]`, by dynamic programming over within-phrase squared error.
fn segment(bars: &[[f32; BANDS]]) -> Vec<usize> {
    let n = bars.len();
    let mut sum = vec![[0.0f64; BANDS]; n + 1];
    let mut sq = vec![0.0f64; n + 1];
    for (j, bar) in bars.iter().enumerate() {
        sum[j + 1] = std::array::from_fn(|d| sum[j][d] + bar[d] as f64);
        sq[j + 1] = sq[j] + bar.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
    }
    let sse = |a: usize, b: usize| {
        let len = (b - a) as f64;
        let centre: f64 = (0..BANDS)
            .map(|d| (sum[b][d] - sum[a][d]).powi(2))
            .sum::<f64>()
            / len;
        sq[b] - sq[a] - centre
    };
    let penalty = (PHRASE_PENALTY * BANDS as f32) as f64;

    let mut cost = vec![f64::INFINITY; n + 1];
    let mut prev = vec![0usize; n + 1];
    cost[0] = 0.0;
    for b in 1..=n {
        for len in 1..=MAX_PHRASE_BARS.min(b) {
            let a = b - len;
            let whole = len % PHRASE_UNIT_BARS == 0;
            let edge = a == 0 || b == n;
            let long_enough = len >= PHRASE_UNIT_BARS || (a == 0 && b == n);
            if !(whole || edge) || !long_enough {
                continue;
            }
            let c = cost[a] + sse(a, b) + penalty;
            if c < cost[b] {
                cost[b] = c;
                prev[b] = a;
            }
        }
    }
    let mut bounds = vec![n];
    let mut b = n;
    while b > 0 {
        b = prev[b];
        bounds.push(b);
    }
    bounds.reverse();
    bounds
}

/// Label each `(start_bar, end_bar)` segment from its loudness.
fn label(segments: &[(usize, usize)], levels: &[BarLevel]) -> Vec<&'static str> {
    let mean = |a: usize, b: usize, f: fn(&BarLevel) -> f32| {
        levels[a..b].iter().map(f).sum::<f32>() / (b - a) as f32
    };
    let upper: Vec<f32> = segments
        .iter()
        .map(|&(a, b)| mean(a, b, |l| l.upper_db))
        .collect();
    let bass: Vec<f32> = segments
        .iter()
        .map(|&(a, b)| mean(a, b, |l| l.bass_db))
        .collect();
    let max_u = upper.iter().cloned().fold(f32::MIN, f32::max);
    let max_b = bass.iter().cloned().fold(f32::MIN, f32::max);

    let mut chorus: Vec<bool> = (0..segments.len())
        .map(|i| upper[i] >= max_u - CHORUS_DB && bass[i] >= max_b - CHORUS_DB)
        .collect();
    if !chorus.contains(&true) {
        let loudest = (0..segments.len())
            .max_by(|a, b| (upper[*a] + bass[*a]).total_cmp(&(upper[*b] + bass[*b])))
            .unwrap_or(0);
        chorus[loudest] = true;
    }
    let first_chorus = chorus.iter().position(|c| *c).unwrap_or(0);
    let last_chorus = chorus.iter().rposition(|c| *c).unwrap_or(0);

    (0..segments.len())
        .map(|i| {
            if chorus[i] {
                return "chorus";
            }
            if i > last_chorus {
                return "outro";
            }
            let (a, b) = segments[i];
            let mid = a + (b - a) / 2;
            let rising = b - a >= 2
                && mean(mid, b, |l| l.upper_db) - mean(a, mid, |l| l.upper_db) >= BUILD_RISE_DB;
            let no_bass = bass[i] < max_b - NO_BASS_DB;
            if chorus.get(i + 1) == Some(&true) && rising {
                "up"
            } else if no_bass && i > 0 {
                "down"
            } else if i < first_chorus {
                "intro"
            } else {
                "down"
            }
        })
        .collect()
}

fn display_label(kind: &str) -> &'static str {
    match kind {
        "intro" => "Intro",
        "up" => "Up",
        "down" => "Down",
        "chorus" => "Chorus",
        _ => "Outro",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::tests::{synth_track, Part};
    use crate::grid::GRID_SR;

    #[test]
    fn finds_bar_aligned_phrases_and_labels_them() {
        let part = |from_bar, pad, kick| Part {
            from_bar,
            pad,
            kick,
        };
        let parts = [
            part(0, 0.0, true),   // intro: kick only
            part(16, 1.0, true),  // chorus
            part(48, 0.6, false), // breakdown
            part(64, 1.0, true),  // chorus
            part(96, 0.0, true),  // outro
        ];
        let bpm = 126.0;
        let bar_s = 4.0 * 60.0 / bpm;
        let first_s = 0.2;
        let pcm = synth_track(bpm, first_s, first_s + 112.0 * bar_s, 0, &parts);
        let (_, phrases) = analyse_structure(&pcm, GRID_SR, bpm).unwrap();

        let got: Vec<(&str, i64)> = phrases
            .iter()
            .map(|p| (p.kind, ((p.start_s - first_s) / bar_s).round() as i64))
            .collect();
        assert_eq!(
            got,
            vec![
                ("intro", 0),
                ("chorus", 16),
                ("down", 48),
                ("chorus", 64),
                ("outro", 96)
            ],
            "{phrases:?}"
        );
    }
}
