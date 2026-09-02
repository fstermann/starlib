//! Chunked BPM analysis for streaming use cases.
//!
//! Splits a long PCM buffer (typically a full DJ set) into overlapping
//! windows and emits one BPM estimate per window. Designed to feed an event
//! stream — yields windows in order so downstream consumers (the analyser
//! SSE pipeline) can render BPM points as they arrive without waiting for
//! the whole set.

use anyhow::Result;
use serde::Serialize;

use crate::tempo::analyze;
use crate::types::{BpmOptions, BpmResult, Confidence};

/// Tunables for chunked analysis.
#[derive(Debug, Clone)]
pub struct ChunkOptions {
    /// Window length in seconds. 30 s is a good electronic-music default —
    /// long enough for a stable autocorrelation peak, short enough that
    /// 60-min sets still produce ~120 windows for a useful BPM curve.
    pub window_s: f32,
    /// Step between window starts in seconds. `< window_s` ⇒ overlap.
    pub hop_s: f32,
}

impl Default for ChunkOptions {
    fn default() -> Self {
        Self {
            window_s: 30.0,
            hop_s: 25.0,
        }
    }
}

/// One BPM estimate covering a fixed time range of the source PCM.
#[derive(Debug, Clone, Serialize)]
pub struct ChunkResult {
    pub start_s: f32,
    pub end_s: f32,
    pub bpm: f32,
    pub confidence: &'static str,
}

/// Generate chunked windows over PCM at `sr`, run `analyze` per window, and
/// invoke `on_chunk` as each result becomes available.
///
/// Failures on individual windows (e.g. silent stretches) are logged through
/// the callback as a `Low`-confidence zero-BPM result rather than aborting
/// the whole pipeline — a DJ set often has silent intros/outros or breakdown
/// sections that legitimately have no detectable tempo, and we want to keep
/// streaming the rest.
pub fn analyze_chunks<F>(
    pcm: &[f32],
    sr: u32,
    options: &BpmOptions,
    chunk: &ChunkOptions,
    mut on_chunk: F,
) -> Result<Vec<ChunkResult>>
where
    F: FnMut(&ChunkResult),
{
    let win_n = (chunk.window_s * sr as f32) as usize;
    let hop_n = (chunk.hop_s * sr as f32).max(1.0) as usize;
    if pcm.len() < win_n {
        // Whole-PCM single-window fallback — short clips still produce one
        // event so the timeline isn't empty.
        let result = single_chunk(pcm, sr, 0.0, pcm.len() as f32 / sr as f32, options);
        on_chunk(&result);
        return Ok(vec![result]);
    }

    let mut results = Vec::new();
    let mut start = 0usize;
    while start + win_n <= pcm.len() {
        let end = start + win_n;
        let start_s = start as f32 / sr as f32;
        let end_s = end as f32 / sr as f32;
        let result = single_chunk(&pcm[start..end], sr, start_s, end_s, options);
        on_chunk(&result);
        results.push(result);
        start += hop_n;
    }
    Ok(results)
}

fn single_chunk(
    window: &[f32],
    sr: u32,
    start_s: f32,
    end_s: f32,
    options: &BpmOptions,
) -> ChunkResult {
    match analyze(window, sr, options) {
        Ok(BpmResult {
            bpm, confidence, ..
        }) => ChunkResult {
            start_s,
            end_s,
            bpm,
            confidence: confidence_str(confidence),
        },
        Err(_) => ChunkResult {
            start_s,
            end_s,
            bpm: 0.0,
            confidence: "low",
        },
    }
}

fn confidence_str(c: Confidence) -> &'static str {
    match c {
        Confidence::High => "high",
        Confidence::Medium => "medium",
        Confidence::Low => "low",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click_track(bpm: f32, seconds: f32, sr: u32) -> Vec<f32> {
        let n = (seconds * sr as f32) as usize;
        let period = (60.0 / bpm * sr as f32) as usize;
        let mut out = vec![0.0f32; n];
        let click_len = (sr as f32 * 0.02) as usize;
        let mut t = 0usize;
        while t < n {
            for i in 0..click_len {
                if t + i < n {
                    let env = (-5.0 * i as f32 / click_len as f32).exp();
                    out[t + i] += env;
                }
            }
            t += period;
        }
        out
    }

    #[test]
    fn chunked_analysis_emits_per_window_estimates() {
        let sr = 22050u32;
        // 90 seconds of 128 BPM clicks → with default 30s window / 25s hop,
        // expect floor((90-30)/25) + 1 = 3 chunks.
        let pcm = click_track(128.0, 90.0, sr);
        let mut events = Vec::new();
        let results = analyze_chunks(
            &pcm,
            sr,
            &BpmOptions::default(),
            &ChunkOptions::default(),
            |c| events.push(c.clone()),
        )
        .unwrap();
        assert_eq!(results.len(), events.len());
        assert_eq!(results.len(), 3);
        for r in &results {
            assert!(
                (r.bpm - 128.0).abs() < 1.5,
                "chunk {}-{}s expected ~128 BPM, got {}",
                r.start_s,
                r.end_s,
                r.bpm,
            );
        }
    }

    #[test]
    fn shorter_than_window_emits_single_event() {
        let sr = 22050u32;
        let pcm = click_track(128.0, 5.0, sr);
        let mut events = Vec::new();
        let results = analyze_chunks(
            &pcm,
            sr,
            &BpmOptions::default(),
            &ChunkOptions {
                window_s: 30.0,
                hop_s: 25.0,
            },
            |c| events.push(c.clone()),
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(results.len(), 1);
    }
}
