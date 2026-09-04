"""Pure audio math for waveform rendering.

No I/O, no ffmpeg, no network. Takes decoded PCM samples and reduces them
to a normalized peak envelope for display.
"""

from __future__ import annotations

import struct

__all__ = ["reduce_peaks"]


def reduce_peaks(pcm_f32le: bytes, num_peaks: int) -> list[float]:
    """Reduce mono ``f32le`` PCM to ``num_peaks`` normalized amplitude peaks.

    Splits the samples into ``num_peaks`` contiguous chunks spanning the whole
    signal and takes the maximum absolute amplitude of each, then normalizes
    the result to ``[0, 1]`` by the global maximum.

    Parameters
    ----------
    pcm_f32le : bytes
        Mono little-endian 32-bit float PCM samples.
    num_peaks : int
        Number of peaks to produce. Must be positive.

    Returns
    -------
    list[float]
        ``num_peaks`` values in ``[0, 1]``. All zeros for silent or empty
        input.
    """
    if num_peaks <= 0:
        return []
    n = len(pcm_f32le) // 4
    if n == 0:
        return [0.0] * num_peaks

    samples = struct.unpack(f"{n}f", pcm_f32le[: n * 4])

    # Proportional bounds so the peaks span all ``n`` samples. A floored fixed
    # chunk size would cover only ``(n // num_peaks) * num_peaks`` samples,
    # stretching the displayed time axis and drifting kicks from playback time.
    peaks: list[float] = []
    for i in range(num_peaks):
        start = i * n // num_peaks
        end = (i + 1) * n // num_peaks
        segment = samples[start:end]
        peaks.append(max(abs(s) for s in segment) if segment else 0.0)

    max_val = max(peaks) or 1.0
    return [p / max_val for p in peaks]
