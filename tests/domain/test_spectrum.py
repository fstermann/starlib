"""Tests for the average spectrum and band levels."""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.domain.spectrum import BANDS, FFT_SIZE, SAMPLE_RATE, SpectrumMeter, band_levels, octave_curve


def _stereo(mono: np.ndarray) -> np.ndarray:
    return np.stack([mono, mono], axis=1).astype(np.float32)


def _sine(hz: float, seconds: float = 5.0, amplitude: float = 0.5) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return _stereo(amplitude * np.sin(2 * math.pi * hz * t))


def _levels(samples: np.ndarray) -> dict[str, float]:
    meter = SpectrumMeter()
    meter.add(samples)
    return {band.name: band.level_db for band in band_levels(meter.mean_power())}


def _audible(levels: dict[str, float]) -> dict[str, float]:
    """Levels floored at -60 dB, below which float rounding and window leakage live."""
    return {name: max(level, -60.0) for name, level in levels.items()}


def test_a_tone_sits_in_its_band() -> None:
    levels = _levels(_sine(1000))

    assert levels["Mid"] == pytest.approx(0.0, abs=0.1)
    assert all(level < -40 for name, level in levels.items() if name != "Mid")


def test_white_noise_spreads_by_band_width() -> None:
    rng = np.random.default_rng(0)
    levels = _levels(_stereo(rng.uniform(-0.5, 0.5, 20 * SAMPLE_RATE)))

    total_hz = BANDS[-1].high_hz - BANDS[0].low_hz
    for band in BANDS:
        assert levels[band.name] == pytest.approx(10 * math.log10((band.high_hz - band.low_hz) / total_hz), abs=0.3)


def test_levels_ignore_how_loud_the_mix_is() -> None:
    quiet, loud = _levels(_sine(80, amplitude=0.05)), _levels(_sine(80, amplitude=0.5))

    assert _audible(quiet) == pytest.approx(_audible(loud), abs=0.01)


def test_silence_between_tracks_does_not_count() -> None:
    with_gap = np.concatenate([_sine(1000), np.zeros((10 * SAMPLE_RATE, 2), np.float32)])

    assert _audible(_levels(with_gap)) == pytest.approx(_audible(_levels(_sine(1000))), abs=0.01)


def test_blocks_of_any_size_add_up_to_the_same_spectrum() -> None:
    samples = _sine(440)
    whole = SpectrumMeter()
    whole.add(samples)
    pieces = SpectrumMeter()
    for start in range(0, len(samples), FFT_SIZE // 3):
        pieces.add(samples[start : start + FFT_SIZE // 3])

    assert pieces.mean_power() == pytest.approx(whole.mean_power())


def test_a_silent_mix_has_no_spectrum() -> None:
    meter = SpectrumMeter()
    meter.add(np.zeros((SAMPLE_RATE, 2), np.float32))

    assert meter.mean_power() == []


def test_curve_steps_in_sixth_octaves_and_peaks_at_the_tone() -> None:
    meter = SpectrumMeter()
    meter.add(_sine(1000))

    centres, levels = octave_curve(meter.mean_power())

    assert len(centres) == len(levels) == 60
    assert centres[0] == pytest.approx(20 * 2 ** (1 / 12))
    assert abs(centres[int(np.argmax(levels))] - 1000) < 1000 * (2 ** (1 / 6) - 1)
