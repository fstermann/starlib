"""Loudness statistics over a mix, after ITU-R BS.1770 / EBU R128.

Input is the meter's frame series: one frame per 100 ms carrying the
momentary loudness (400 ms window), the short-term loudness (3 s window)
and the true peak of that frame, plus the momentary loudness of the low
band (the mix low-passed) for the bass balance. Momentary windows at a 100 ms hop are the
standard's 75 %-overlapping gating blocks, so integrated loudness over any
span is computed from them directly.
"""

from __future__ import annotations

import itertools
import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass

FRAME_S = 0.1
ABSOLUTE_GATE_LUFS = -70.0
_RELATIVE_GATE_LU = -10.0
# EBU Tech 3342 gates the loudness range 20 LU below the integrated level;
# the quietest short-term reading uses the same gate so fades and silence don't count.
_RANGE_GATE_LU = -20.0
# Segments within this of the reference are left alone: about the smallest
# level change listeners notice between tracks.
EVEN_OUT_TOLERANCE_LU = 1.0
# Shorter spans are fades or tails, not tracks, and would always read as too quiet.
MIN_SEGMENT_S = 30.0
# Loudness either side of a track change is compared over this much audio.
TRANSITION_WINDOW_S = 30.0
# A step this big at a mix-in is audible even when the tracks' averages match.
TRANSITION_JUMP_LU = 2.0
# Bass balance differs more between tracks than overall loudness, so the bar is higher.
LOW_END_TOLERANCE_LU = 2.0


@dataclass(frozen=True, slots=True)
class LoudnessFrames:
    """The meter's 100 ms frame series for one mix; the lists are equally long.

    ``low_band`` is empty when the low band wasn't metered.
    """

    momentary: Sequence[float]
    short_term: Sequence[float]
    true_peak: Sequence[float]
    low_band: Sequence[float] = ()


@dataclass(frozen=True, slots=True)
class Segment:
    """A span of the mix to measure on its own, such as one track."""

    start_s: float
    end_s: float
    label: str | None = None


@dataclass(frozen=True, slots=True)
class SegmentLoudness:
    """One segment's loudness, and the gain change that brings it to the reference.

    ``low_end_lu`` is the low band's loudness relative to the whole segment;
    higher means more bass.
    """

    start_s: float
    end_s: float
    label: str | None
    integrated_lufs: float
    true_peak_dbtp: float | None
    suggested_gain_db: float | None
    low_end_lu: float | None


@dataclass(frozen=True, slots=True)
class Transition:
    """Loudness just before and after a track change."""

    at_s: float
    from_label: str | None
    to_label: str | None
    before_lufs: float
    after_lufs: float

    @property
    def jump_lu(self) -> float:
        """How much louder the mix gets at the change; negative when it drops."""
        return self.after_lufs - self.before_lufs


@dataclass(frozen=True, slots=True)
class LoudnessSummary:
    """Loudness readings for a whole mix or one span of it."""

    integrated_lufs: float | None
    short_term_max_lufs: float | None
    short_term_min_lufs: float | None
    momentary_max_lufs: float | None
    true_peak_dbtp: float | None


def integrated_lufs(momentary: Sequence[float]) -> float | None:
    """Gated integrated loudness from momentary blocks (BS.1770-4, section 2.8).

    Args:
        momentary: Momentary loudness of each 400 ms block, 100 ms apart.

    Returns:
        Integrated loudness in LUFS, or ``None`` when every block is below the
        absolute gate (silence).
    """
    gated = _gated_blocks(momentary)
    return _mean_loudness([momentary[i] for i in gated]) if gated else None


def low_end_lu(frames: LoudnessFrames, start_s: float = 0.0, end_s: float | None = None) -> float | None:
    """Low-band loudness relative to the full band over a span, in LU.

    Both are averaged over the blocks the full band's integrated gate keeps,
    so silence and breakdowns don't count.

    Args:
        frames: The mix's frame series.
        start_s: Span start.
        end_s: Span end; ``None`` for the end of the mix.

    Returns:
        The difference, or ``None`` when the span is silent or the low band
        wasn't metered.
    """
    if not frames.low_band:
        return None
    lo, hi = _frame_range(len(frames.momentary), start_s, end_s)
    gated = [lo + i for i in _gated_blocks(frames.momentary[lo:hi])]
    if not gated:
        return None
    full = _mean_loudness([frames.momentary[i] for i in gated])
    return _mean_loudness([frames.low_band[i] for i in gated]) - full


def summarise(frames: LoudnessFrames, start_s: float = 0.0, end_s: float | None = None) -> LoudnessSummary:
    """Integrated, short-term extremes, momentary maximum and true peak over a span.

    Args:
        frames: The mix's frame series.
        start_s: Span start.
        end_s: Span end; ``None`` for the end of the mix.

    Returns:
        The span's readings; each is ``None`` when the span is silent or empty.
    """
    lo, hi = _frame_range(len(frames.momentary), start_s, end_s)
    momentary = frames.momentary[lo:hi]
    short_term = frames.short_term[lo:hi]
    integrated = integrated_lufs(momentary)
    audible_short_term = [s for s in short_term if s > ABSOLUTE_GATE_LUFS]
    range_gate = integrated + _RANGE_GATE_LU if integrated is not None else ABSOLUTE_GATE_LUFS
    gated_short_term = [s for s in audible_short_term if s > range_gate]
    return LoudnessSummary(
        integrated_lufs=integrated,
        short_term_max_lufs=max(audible_short_term, default=None),
        short_term_min_lufs=min(gated_short_term, default=None),
        momentary_max_lufs=max((m for m in momentary if m > ABSOLUTE_GATE_LUFS), default=None),
        true_peak_dbtp=max(frames.true_peak[lo:hi], default=None),
    )


def partition(starts: Sequence[tuple[float, str | None]], duration_s: float) -> list[Segment]:
    """Split a mix at each track's start: a track runs until the next one starts.

    Overlapping transitions belong to the incoming track, which is where a
    DJ's set recording or CUE sheet places the change.

    Args:
        starts: ``(start_s, label)`` per track, in any order.
        duration_s: Length of the mix.

    Returns:
        Contiguous segments in time order; empty when there are no starts.
    """
    ordered = sorted((max(0.0, s), label) for s, label in starts if s < duration_s)
    if not ordered:
        return []
    ends = [start for start, _ in ordered[1:]] + [duration_s]
    return [
        Segment(start_s=start, end_s=end, label=label)
        for (start, label), end in zip(ordered, ends, strict=True)
        if end > start
    ]


def even_out(frames: LoudnessFrames, segments: Sequence[Segment]) -> tuple[float | None, list[SegmentLoudness]]:
    """Measure each segment and suggest the gain change that levels it with the rest.

    The reference is the median segment loudness, so one very loud or very
    quiet track doesn't move the target for all the others.

    Args:
        frames: The mix's frame series.
        segments: Spans to compare, such as the tracks of a set.

    Returns:
        The reference loudness (``None`` with no measurable segment) and one
        entry per audible segment of at least :data:`MIN_SEGMENT_S`.
        ``suggested_gain_db`` is ``None`` within :data:`EVEN_OUT_TOLERANCE_LU`
        of the reference.
    """
    measured = [
        (segment, summary.integrated_lufs, summary.true_peak_dbtp)
        for segment in segments
        if segment.end_s - segment.start_s >= MIN_SEGMENT_S
        and (summary := summarise(frames, segment.start_s, segment.end_s)).integrated_lufs is not None
    ]
    if not measured:
        return None, []
    reference = statistics.median(lufs for _, lufs, _ in measured)
    return reference, [
        SegmentLoudness(
            start_s=segment.start_s,
            end_s=segment.end_s,
            label=segment.label,
            integrated_lufs=lufs,
            true_peak_dbtp=peak,
            suggested_gain_db=reference - lufs if abs(reference - lufs) >= EVEN_OUT_TOLERANCE_LU else None,
            low_end_lu=low_end_lu(frames, segment.start_s, segment.end_s),
        )
        for segment, lufs, peak in measured
    ]


def low_end_reference(levels: Sequence[SegmentLoudness]) -> float | None:
    """Median low-end balance of the measured segments.

    Args:
        levels: Output of :func:`even_out`.

    Returns:
        The median, or ``None`` when no segment has a low-band reading.
    """
    values = [level.low_end_lu for level in levels if level.low_end_lu is not None]
    return statistics.median(values) if values else None


def transitions(frames: LoudnessFrames, segments: Sequence[Segment]) -> list[Transition]:
    """Loudness over :data:`TRANSITION_WINDOW_S` either side of each track change.

    Each window stays inside its own track, so a short track isn't measured
    together with its neighbour.

    Args:
        frames: The mix's frame series.
        segments: Contiguous segments in time order, as from :func:`partition`.

    Returns:
        One entry per change where both sides are audible.
    """
    changes = []
    for outgoing, incoming in itertools.pairwise(segments):
        at = incoming.start_s
        before = _span_lufs(frames, max(outgoing.start_s, at - TRANSITION_WINDOW_S), at)
        after = _span_lufs(frames, at, min(incoming.end_s, at + TRANSITION_WINDOW_S))
        if before is None or after is None:
            continue
        changes.append(
            Transition(
                at_s=at,
                from_label=outgoing.label,
                to_label=incoming.label,
                before_lufs=before,
                after_lufs=after,
            )
        )
    return changes


def _gated_blocks(momentary: Sequence[float]) -> list[int]:
    """Indices of the blocks that pass the absolute and relative gates."""
    above_absolute = [i for i, m in enumerate(momentary) if m > ABSOLUTE_GATE_LUFS]
    if not above_absolute:
        return []
    relative_gate = _mean_loudness([momentary[i] for i in above_absolute]) + _RELATIVE_GATE_LU
    return [i for i in above_absolute if momentary[i] > relative_gate]


def _span_lufs(frames: LoudnessFrames, start_s: float, end_s: float) -> float | None:
    lo, hi = _frame_range(len(frames.momentary), start_s, end_s)
    return integrated_lufs(frames.momentary[lo:hi])


def _mean_loudness(blocks: Sequence[float]) -> float:
    """Loudness of the mean power of the blocks (BS.1770 averages power, not dB)."""
    mean_power = sum(10 ** ((b + 0.691) / 10) for b in blocks) / len(blocks)
    return -0.691 + 10 * math.log10(mean_power)


def _frame_range(n_frames: int, start_s: float, end_s: float | None) -> tuple[int, int]:
    # A frame is stamped at the end of its 100 ms hop, so frame i covers ((i), (i + 1)] * FRAME_S.
    lo = max(0, math.floor(start_s / FRAME_S + 1e-9))
    hi = n_frames if end_s is None else min(n_frames, math.ceil(end_s / FRAME_S - 1e-9))
    return lo, max(lo, hi)
