//! Public types for the BPM analysis module.

use thiserror::Error;

/// Current algorithm version. Bump when the analysis pipeline changes
/// in a way that would produce different BPM values for the same input.
pub const ALGORITHM_VERSION: u16 = 1;

/// Typed errors produced by the BPM analysis pipeline.
///
/// These cover cases that were previously either swallowed (returning a
/// zero-BPM `Low`-confidence result) or paved over with a silent default.
/// Surface them to the caller so bad inputs don't masquerade as valid
/// analysis results.
#[derive(Debug, Error)]
pub enum BpmError {
    /// PCM buffer is too short to run the STFT / autocorrelation stages.
    #[error("insufficient data for BPM analysis: {0}")]
    InsufficientData(String),
    /// The onset envelope is all zeros — the signal is silent or lacks any
    /// detectable spectral change across frames.
    #[error("silent or featureless input: onset envelope is all zeros")]
    SilentInput,
    /// The decoded track carries no sample-rate metadata. We refuse to guess.
    #[error("decoded track is missing sample-rate metadata")]
    MissingSampleRate,
}

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

/// Tempo estimator back-end.
///
/// `Autocorrelation` is the original: pick the highest peak in the onset
/// envelope's autocorrelation. Fast, works well on tracks with clear
/// metronomic pulse.
///
/// `DynamicProgramming` runs Ellis 2007's beat-tracking DP on the onset
/// envelope, using the autocorrelation's peak as the tempo target and
/// allowing per-beat deviation under a log-Gaussian penalty. The BPM is
/// then derived from the median inter-beat-interval. More robust on
/// tracks where the autocorrelation peak is contaminated by an off-beat
/// subdivision (e.g. dotted/triplet 2:3 ratio errors).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BeatTracker {
    #[default]
    Autocorrelation,
    DynamicProgramming,
}

/// Analysis strategy — single-shot or multi-window consensus.
///
/// `Consensus` runs the single-shot analyzer on three windows at 25%, 50%
/// and 75% of the track (or the source-provided range) and returns the
/// median, with confidence derived from agreement spread. Cost is ~3× but
/// catches breakdowns / intro-heavy tracks where a single 15s window can
/// land in a tempo-ambiguous section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AnalysisMode {
    #[default]
    Single,
    Consensus,
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
    /// Single-shot vs multi-window consensus.
    pub mode: AnalysisMode,
    /// Tempo estimator: raw autocorrelation peak or DP beat-tracking.
    pub beat_tracker: BeatTracker,
}

impl Default for BpmOptions {
    fn default() -> Self {
        Self {
            octave_correction: true,
            target_sr: 22050,
            min_bpm: 60.0,
            max_bpm: 200.0,
            mode: AnalysisMode::Single,
            beat_tracker: BeatTracker::Autocorrelation,
        }
    }
}
