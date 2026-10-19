"""Average spectrum of a mix: its tonal balance, independent of how loud it is.

The meter sums windowed power spectra over the whole mix. Levels are the
power in a frequency span relative to the power from 20 Hz to 20 kHz, so two
mixes compare by balance even when one is mastered 9 dB louder.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 44100
FFT_SIZE = 8192
LOWEST_HZ = 20.0
HIGHEST_HZ = 20000.0
POINTS_PER_OCTAVE = 6
# Windows quieter than this are silence between tracks, not part of the balance.
_SILENCE_DBFS = -70.0
_BIN_HZ = SAMPLE_RATE / FFT_SIZE
_FREQS = np.fft.rfftfreq(FFT_SIZE, 1 / SAMPLE_RATE)
_WINDOW = np.hanning(FFT_SIZE)


@dataclass(frozen=True, slots=True)
class Band:
    """A named frequency span."""

    name: str
    low_hz: float
    high_hz: float


# The low band shares its 150 Hz edge with the loudness report's low-end reading.
BANDS = (
    Band("Sub", 20, 60),
    Band("Bass", 60, 150),
    Band("Low mid", 150, 500),
    Band("Mid", 500, 2000),
    Band("High mid", 2000, 6000),
    Band("Air", 6000, 20000),
)


@dataclass(frozen=True, slots=True)
class BandLevel:
    """A band's share of the mix's power, in dB."""

    name: str
    low_hz: float
    high_hz: float
    level_db: float


class SpectrumMeter:
    """Running sum of power spectra over a stream of stereo samples."""

    def __init__(self) -> None:
        self._power = np.zeros(len(_FREQS))
        self._windows = 0
        self._carry = np.empty((0, 2), dtype=np.float32)
        self._silence = FFT_SIZE * 10 ** (_SILENCE_DBFS / 10)

    def add(self, samples: np.ndarray) -> None:
        """Feed the next block of samples.

        Args:
            samples: Shape ``(n, 2)``, float in -1..1, at ``SAMPLE_RATE``.
        """
        samples = np.concatenate([self._carry, samples])
        n = len(samples) // FFT_SIZE
        self._carry = samples[n * FFT_SIZE :]
        if n == 0:
            return
        windows = samples[: n * FFT_SIZE].reshape(n, FFT_SIZE, 2)
        audible = (windows**2).sum(axis=(1, 2)) / 2 > self._silence
        windows = windows[audible]
        if len(windows) == 0:
            return
        spectra = np.fft.rfft(windows * _WINDOW[None, :, None], axis=1)
        self._power += (np.abs(spectra) ** 2).sum(axis=(0, 2))
        self._windows += len(windows)

    def mean_power(self) -> list[float]:
        """Mean power per FFT bin, empty when every window was silent.

        Returns:
            One value per bin from 0 Hz to Nyquist.
        """
        return [] if self._windows == 0 else (self._power / self._windows).tolist()


def octave_curve(power: Sequence[float]) -> tuple[list[float], list[float]]:
    """The spectrum in 1/6-octave steps from 20 Hz to 20 kHz.

    Each point is the power in its 1/6 octave relative to the whole range, so
    pink noise reads flat.

    Args:
        power: ``SpectrumMeter.mean_power()``.

    Returns:
        Centre frequencies in Hz and levels in dB.
    """
    octaves = math.log2(HIGHEST_HZ / LOWEST_HZ)
    points = round(octaves * POINTS_PER_OCTAVE)
    edges = LOWEST_HZ * 2 ** (np.arange(points + 1) / POINTS_PER_OCTAVE)
    spans = list(itertools.pairwise(edges))
    centres = [math.sqrt(low * high) for low, high in spans]
    return centres, _relative_db(np.asarray(power), spans)


def band_levels(power: Sequence[float]) -> list[BandLevel]:
    """Each of ``BANDS``' share of the power from 20 Hz to 20 kHz.

    Args:
        power: ``SpectrumMeter.mean_power()``.

    Returns:
        One level per band, in dB.
    """
    levels = _relative_db(np.asarray(power), [(b.low_hz, b.high_hz) for b in BANDS])
    return [BandLevel(b.name, b.low_hz, b.high_hz, level) for b, level in zip(BANDS, levels, strict=True)]


def _relative_db(power: np.ndarray, spans: Sequence[tuple[float, float]]) -> list[float]:
    total = _span_power(power, LOWEST_HZ, HIGHEST_HZ)
    return [round(10 * math.log10(max(_span_power(power, low, high), 1e-30) / total), 2) for low, high in spans]


def _span_power(power: np.ndarray, low_hz: float, high_hz: float) -> float:
    inside = (_FREQS >= low_hz) & (_FREQS < high_hz)
    if inside.any():
        density = float(power[inside].mean())
    else:
        # Low 1/6 octaves are narrower than one bin: read the level at their centre.
        density = float(np.interp(math.sqrt(low_hz * high_hz), _FREQS, power))
    return density * (high_hz - low_hz) / _BIN_HZ
