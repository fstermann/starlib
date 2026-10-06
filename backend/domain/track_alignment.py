"""Inputs for locating an identified track inside its DJ mix."""

import math

# DJs rarely push a track more than ~20% off its tempo; a ratio outside this
# band means one of the BPMs was detected at half, double or 3:2 time.
MIN_RATE = 0.8
MAX_RATE = 1.25
_OCTAVE_FOLDS = (0.5, 2 / 3, 1.0, 1.5, 2.0)
# Below this the best start barely beats the runner-up (measured: tracks
# absent from the mix score 0.13-0.19, present ones 0.30-0.64).
MIN_CONFIDENCE = 0.25
# Slack around the Shazam hit, which can lag the track's entry or lead its exit.
WINDOW_MARGIN_S = 15.0


def rate_hints(set_bpm: float | None, original_bpm: float | None, pitch_offset: float | None) -> list[float]:
    """Candidate playback rates of the original in the mix (>1 = sped up).

    Uses the BPM ratio, folded into a plausible range to undo octave errors,
    and the Shazam pitch offset (the semitones that brought the mix slice back
    to the original). Falls back to ``[1.0]`` when neither is usable.

    Args:
        set_bpm: Tempo of the mix around the track.
        original_bpm: Detected (or user-corrected) tempo of the original.
        pitch_offset: Shazam pitch offset in semitones.

    Returns:
        Distinct rates, most trusted first.
    """
    hints: list[float] = []
    if set_bpm and original_bpm and set_bpm > 0 and original_bpm > 0:
        hints += [r for f in _OCTAVE_FOLDS if MIN_RATE <= (r := set_bpm / original_bpm * f) <= MAX_RATE]
    if pitch_offset is not None:
        hints.append(2 ** (-pitch_offset / 12))
    distinct = [h for i, h in enumerate(hints) if all(abs(h - p) > 0.002 for p in hints[:i])]
    return distinct or [1.0]


def fold_rate(rate: float) -> float:
    """Undo a half- or double-time BPM in a playback rate.

    Args:
        rate: Set BPM over original BPM.

    Returns:
        The octave fold of ``rate`` nearest 1.0.
    """
    return min((rate * f for f in (0.5, 1.0, 2.0)), key=lambda r: abs(math.log2(r)))


def search_window(
    detected_s: float, duration_s: float, rate: float, set_duration_s: float | None
) -> tuple[float, float]:
    """Mix span that must contain the track, given where Shazam heard it.

    Args:
        detected_s: Mix time where the track was detected.
        duration_s: Length of the original.
        rate: Expected playback rate in the mix.
        set_duration_s: Length of the mix, if known.

    Returns:
        ``(start_s, end_s)`` in mix time.
    """
    reach = duration_s / rate + WINDOW_MARGIN_S
    end = detected_s + reach
    if set_duration_s is not None:
        end = min(end, set_duration_s)
    return max(0.0, detected_s - reach), end
