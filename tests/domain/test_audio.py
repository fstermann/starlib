"""Tests for the pure waveform-peak reducer."""

from __future__ import annotations

import struct

import pytest

from backend.domain.audio import reduce_peaks


def _pcm(samples: list[float]) -> bytes:
    return struct.pack(f"{len(samples)}f", *samples)


def test_empty_input_returns_zeros() -> None:
    assert reduce_peaks(b"", 8) == [0.0] * 8


def test_non_positive_count_returns_empty() -> None:
    assert reduce_peaks(_pcm([1.0, -1.0]), 0) == []


def test_length_matches_requested_count() -> None:
    pcm = _pcm([0.1 * i for i in range(100)])
    assert len(reduce_peaks(pcm, 10)) == 10


def test_normalizes_to_unit_max() -> None:
    # A chunked signal whose loudest sample is 0.5 must normalize to 1.0.
    pcm = _pcm([0.1, 0.2, 0.5, 0.25, 0.4, 0.3])
    peaks = reduce_peaks(pcm, 3)
    assert max(peaks) == 1.0
    assert all(0.0 <= p <= 1.0 for p in peaks)


def test_uses_absolute_amplitude() -> None:
    # Negative peaks count by magnitude, so a -1.0 trough is the max.
    pcm = _pcm([0.2, -1.0, 0.3, 0.1])
    peaks = reduce_peaks(pcm, 2)
    assert peaks[0] == 1.0


def test_peaks_span_the_full_signal() -> None:
    # The tail sample (index 9) lands in the last chunk only under proportional
    # bounds. A floored fixed chunk size (10 // 3 = 3) would cover indices 0-8
    # and drop it, flattening the last peak and drifting the time axis.
    samples = [0.1, 0.1, 0.1, 0.1, 1.0, 0.1, 0.1, 0.1, 0.1, 0.8]
    peaks = reduce_peaks(_pcm(samples), 3)
    assert peaks[-1] == pytest.approx(0.8)
