//! Public types for the BPM analysis module.

/// Current algorithm version. Bump when the analysis pipeline changes
/// in a way that would produce different BPM values for the same input.
pub const ALGORITHM_VERSION: u16 = 1;

/// Confidence bucket for a BPM estimate.
///
/// Derived from the sharpness of the autocorrelation peak relative to the
/// median of the search range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    High,
    Medium,
    Low,
}

/// Result of a BPM analysis run.
#[derive(Debug, Clone)]
pub struct BpmResult {
    /// Estimated tempo in beats per minute.
    pub bpm: f32,
    /// Peak-sharpness-derived confidence bucket.
    pub confidence: Confidence,
    /// If octave correction kicked in, the pre-correction BPM. Otherwise `None`.
    pub corrected_from: Option<f32>,
    /// Version of the algorithm used for this estimate.
    pub algorithm_version: u16,
}

/// Tunables for the BPM analysis pipeline.
#[derive(Debug, Clone)]
pub struct BpmOptions {
    /// If true, fold detected BPMs outside `[90, 180]` into that range by
    /// doubling or halving. Good for electronic music.
    pub octave_correction: bool,
    /// Sample rate the signal is resampled to before analysis.
    pub target_sr: u32,
    /// Minimum BPM considered during autocorrelation search.
    pub min_bpm: f32,
    /// Maximum BPM considered during autocorrelation search.
    pub max_bpm: f32,
}

impl Default for BpmOptions {
    fn default() -> Self {
        Self {
            octave_correction: true,
            target_sr: 22050,
            min_bpm: 60.0,
            max_bpm: 200.0,
        }
    }
}
