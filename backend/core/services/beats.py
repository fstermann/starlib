"""
Beat analysis service — extracts BPM and beat positions from audio files.

Uses Essentia's RhythmExtractor2013 (already a project dependency via the
editor group).  Results are cached in a SQLite DB at
``.cache/analysis.db`` (outside music folders) so repeated calls are instant.
"""

import logging
from pathlib import Path

from backend.core.services.cache_db import get_beats, set_beats

logger = logging.getLogger(__name__)


def _snap_bpm(bpm: float, threshold: float = 0.5) -> float:
    """Snap BPM to the nearest integer or half-integer if within *threshold*.

    Most electronic music has an integer BPM.  The raw extractor output is
    slightly noisy (e.g. 128.046) — using it verbatim causes the grid to drift
    noticeably over a 6-minute track.
    """
    nearest_int = round(bpm)
    if abs(bpm - nearest_int) <= threshold:
        return float(nearest_int)
    nearest_half = round(bpm * 2) / 2
    if abs(bpm - nearest_half) <= threshold:
        return nearest_half
    return bpm


def _reanchor_beats(beats: list[float], bpm: float) -> list[float]:
    """Re-space beats using the exact *bpm* interval anchored to the first beat.

    Even when the raw beat positions are correct on average, small per-beat
    jitter from the extractor accumulates into visible drift.  Fixing the
    interval to 60/bpm and keeping only the first detected beat as the anchor
    gives a perfectly rigid grid — which is what the waveform display needs.
    """
    if not beats:
        return beats
    interval = 60.0 / bpm
    return [beats[0] + i * interval for i in range(len(beats))]


def _compute_energy_envelope(
    audio, sr: int = 44100, win_sec: float = 0.25, smooth_sec: float = 2.0,
):
    """Return ``(times, smoothed_rms)`` — an RMS energy envelope of *audio*.

    *win_sec* controls the analysis window; *smooth_sec* the moving-average
    kernel used to remove per-beat fluctuations so that only section-level
    dynamics remain.
    """
    import numpy as np

    hop = int(win_sec * sr / 2)  # 50 % overlap
    frame = int(win_sec * sr)
    n_frames = max(1, (len(audio) - frame) // hop + 1)

    rms = np.empty(n_frames)
    times = np.empty(n_frames)
    for i in range(n_frames):
        start = i * hop
        chunk = audio[start : start + frame]
        rms[i] = float(np.sqrt(np.mean(chunk ** 2)))
        times[i] = (start + frame / 2) / sr

    # Moving-average smoothing.
    kernel_len = max(1, int(smooth_sec / (hop / sr)))
    kernel = np.ones(kernel_len) / kernel_len
    smoothed = np.convolve(rms, kernel, mode="same")
    return times, smoothed


def _detect_drops(
    times, energy, *, threshold: float = 3.0, look_sec: float = 2.0,
) -> list[tuple[float, float]]:
    """Detect energy "drops" — points where energy rises sharply.

    Returns a list of ``(time, ratio)`` where *ratio* is the energy after the
    rise divided by the energy before it.  Only the strongest drop within each
    *look_sec* window is kept.
    """
    import numpy as np

    dt = float(times[1] - times[0]) if len(times) > 1 else 0.125
    half_win = max(1, int(look_sec / dt))

    drops: list[tuple[float, float]] = []
    for i in range(half_win, len(energy) - half_win):
        before = float(np.mean(energy[i - half_win : i]))
        after = float(np.mean(energy[i : i + half_win]))
        if before > 0 and after / before >= threshold:
            drops.append((float(times[i]), after / before))

    # Deduplicate: keep the strongest drop within each 2x look window.
    if not drops:
        return drops
    drops.sort(key=lambda d: d[0])
    deduped: list[tuple[float, float]] = [drops[0]]
    for t, r in drops[1:]:
        if t - deduped[-1][0] < look_sec * 2:
            if r > deduped[-1][1]:
                deduped[-1] = (t, r)
        else:
            deduped.append((t, r))
    return deduped


def _detect_energy_transitions(
    times, energy, *, threshold: float = 2.0, look_sec: float = 2.0,
) -> list[float]:
    """Detect all large energy changes (both rises and falls)."""
    import numpy as np

    dt = float(times[1] - times[0]) if len(times) > 1 else 0.125
    half_win = max(1, int(look_sec / dt))

    transitions: list[tuple[float, float]] = []
    for i in range(half_win, len(energy) - half_win):
        before = float(np.mean(energy[i - half_win : i]))
        after = float(np.mean(energy[i : i + half_win]))
        denom = max(before, after, 1e-12)
        ratio = max(before, after) / denom
        if ratio >= threshold:
            transitions.append((float(times[i]), ratio))

    # Deduplicate within 2x look window.
    if not transitions:
        return []
    transitions.sort(key=lambda d: d[0])
    deduped: list[float] = [transitions[0][0]]
    for t, _ in transitions[1:]:
        if t - deduped[-1] >= look_sec * 2:
            deduped.append(t)
    return deduped


# ------------------------------------------------------------------
# Phase scoring helpers — each returns an ndarray of shape (4,).
# ------------------------------------------------------------------

def _score_phase_from_drops(beats: list[float], drops: list[tuple[float, float]]):
    """Strategy A: snap each detected drop to the nearest beat and vote."""
    import numpy as np

    beats_arr = np.asarray(beats)
    scores = np.zeros(4)
    for drop_time, ratio in drops:
        idx = int(np.argmin(np.abs(beats_arr - drop_time)))
        phase = idx % 4
        scores[phase] += ratio
    return scores


def _score_phase_from_frequency(audio, beats: list[float], stable_mask):
    """Strategy B: BeatsLoudness restricted to high-energy (full-mix) beats."""
    import numpy as np
    from essentia.standard import BeatsLoudness

    bl = BeatsLoudness(sampleRate=44100, beats=beats)
    _, band_ratios = bl(audio)
    band_ratios = np.asarray(band_ratios, dtype=float)

    # Trim to match stable_mask length (BeatsLoudness may return n-1 rows).
    n = min(len(stable_mask), band_ratios.shape[0])
    band_ratios = band_ratios[:n]
    mask = stable_mask[:n]

    n_bands = band_ratios.shape[1]
    split = n_bands // 2
    low_freq = band_ratios[:, :split].sum(axis=1)
    high_freq = band_ratios[:, split:].sum(axis=1)
    diff = low_freq - high_freq

    scores = np.zeros(4)
    for offset in range(4):
        indices = np.arange(offset, n, 4)
        sel = indices[mask[indices]]
        if len(sel):
            scores[offset] = float(diff[sel].mean())
    return scores


def _score_phase_from_structure(
    beats: list[float], bpm: float, transitions: list[float],
):
    """Strategy C: phrase-boundary alignment with energy transitions."""
    import numpy as np

    if not transitions:
        return np.zeros(4)

    beat_interval = 60.0 / bpm
    tolerance = beat_interval  # ±1 beat
    trans_arr = np.asarray(transitions)

    scores = np.zeros(4)
    for offset in range(4):
        # Downbeats for this offset, then every 32nd beat = 8-bar phrases.
        phrase_beats = np.arange(offset, len(beats), 32)
        phrase_times = np.asarray([beats[i] for i in phrase_beats if i < len(beats)])
        if len(phrase_times) == 0:
            continue
        # Count how many phrase boundaries land near a transition.
        dists = np.abs(phrase_times[:, None] - trans_arr[None, :])
        hits = (dists.min(axis=1) <= tolerance).sum()
        scores[offset] = hits / len(phrase_times)
    return scores


def _detect_downbeats(audio, beats: list[float], bpm: float) -> list[float]:
    """Return the subset of *beats* that are bar downbeats (beat 1).

    Uses three complementary strategies to determine which of the 4 possible
    phase offsets aligns beat 1 with actual musical bar boundaries:

    A. **Drop-anchor voting** — energy drops (intro→drop) almost always land
       on beat 1.  Strongest signal when drops are present.
    B. **Frequency-band analysis on stable sections** — the classic
       (low_band - high_band) metric, but restricted to full-mix sections
       so breakdowns don't dilute the average.
    C. **Structural alignment** — electronic music phrases in 8/16/32-bar
       multiples; the correct phase lines up phrase boundaries with energy
       transitions.

    Scores from each strategy are normalised and combined with fixed weights.
    Falls back to offset 0 if all strategies are inconclusive.
    """
    if len(beats) < 4:
        return beats[:]

    try:
        import numpy as np

        # --- shared energy envelope ---
        times, energy = _compute_energy_envelope(audio)

        # Per-beat energy (for stable_mask).
        beats_arr = np.asarray(beats)
        beat_energy = np.interp(beats_arr, times, energy)
        stable_threshold = np.percentile(beat_energy, 60)
        stable_mask = beat_energy >= stable_threshold

        # --- Strategy A: drop-anchor voting ---
        drops = _detect_drops(times, energy)
        scores_a = _score_phase_from_drops(beats, drops)
        logger.debug("Strategy A (drops): %s  (%d drops)", np.round(scores_a, 3), len(drops))

        # --- Strategy B: frequency-band on stable sections ---
        try:
            scores_b = _score_phase_from_frequency(audio, beats, stable_mask)
        except Exception as exc:
            logger.debug("Strategy B unavailable: %s", exc)
            scores_b = np.zeros(4)
        logger.debug("Strategy B (freq-band): %s", np.round(scores_b, 3))

        # --- Strategy C: structural alignment ---
        transitions = _detect_energy_transitions(times, energy)
        scores_c = _score_phase_from_structure(beats, bpm, transitions)
        logger.debug("Strategy C (structure): %s  (%d transitions)", np.round(scores_c, 3), len(transitions))

        # --- normalise each to [0, 1] and combine ---
        def _norm(s):
            r = s.max() - s.min()
            return (s - s.min()) / r if r > 0 else np.zeros(4)

        combined = 0.5 * _norm(scores_a) + 0.2 * _norm(scores_b) + 0.3 * _norm(scores_c)
        offset = int(combined.argmax())

        # If combined scores are essentially flat, fall back to 0.
        if combined.max() - combined.min() < 0.05:
            logger.debug("All strategies inconclusive, falling back to offset 0")
            offset = 0

        logger.debug(
            "Downbeat phase offset: %d  combined=%s",
            offset, np.round(combined, 3),
        )
    except Exception as exc:
        logger.warning("Downbeat detection failed, falling back: %s", exc)
        offset = 0

    return [beats[i] for i in range(offset, len(beats), 4)]


def analyze_beats(file_path: Path) -> dict:
    """
    Analyze beat positions and BPM for an audio file.

    Results are cached in ``.cache/analysis.db`` (outside music folders)
    so subsequent calls are O(1).

    Parameters
    ----------
    file_path : Path
        Absolute path to the audio file.

    Returns
    -------
    dict
        Keys: ``bpm`` (float), ``beats`` (list[float] in seconds),
        ``downbeats`` (list[float] in seconds, every 4th beat).

    Raises
    ------
    RuntimeError
        If Essentia is not installed or analysis fails.
    """
    cached = get_beats(file_path)
    if cached is not None:
        return cached

    logger.info("Analysing beats for %s …", file_path.name)

    try:
        from essentia.standard import MonoLoader, RhythmExtractor2013
    except ImportError as exc:
        raise RuntimeError(
            "Essentia is not installed. Install it via: uv sync --group editor"
        ) from exc

    audio = MonoLoader(filename=str(file_path))()
    extractor = RhythmExtractor2013(method="multifeature")
    bpm, ticks, _confidence, _estimates, _bpm_intervals = extractor(audio)

    beats: list[float] = [float(t) for t in ticks]

    # Snap to nearest musical BPM (integer / half-integer) and re-anchor all
    # beat positions from the first detected beat.  Raw extractor BPM is noisy
    # (e.g. 128.046) — using it verbatim causes the grid to drift over time.
    bpm = _snap_bpm(float(bpm))
    beats = _reanchor_beats(beats, bpm)
    logger.debug("BPM snapped to %.1f, %d beats re-anchored", bpm, len(beats))

    # Detect the downbeat phase: find which of the 4 possible beat offsets
    # (0, 1, 2, 3) lands on beat 1 of each bar, using multi-strategy analysis
    # (drop anchors, frequency bands on stable sections, structural alignment).
    downbeats = _detect_downbeats(audio, beats, bpm)

    result = {
        "bpm": float(bpm),
        "beats": beats,
        "downbeats": downbeats,
    }

    try:
        set_beats(file_path, result)
    except Exception as exc:
        logger.warning("Could not write beat cache: %s", exc)

    return result
