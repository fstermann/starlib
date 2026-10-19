"""Tests for the ffmpeg EBU R128 meter adapter and its cache."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.domain.loudness import integrated_lufs, low_end_lu
from backend.domain.spectrum import band_levels
from backend.infra.breakdown import loudness as meter

LOG = (
    "[Parsed_ebur128_0 @ 0x1] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     "
    "I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -inf -inf dBFS  TPK: -inf -inf dBFS\n"
    "[Parsed_ebur128_0 @ 0x1] t: 0.199979   TARGET:-23 LUFS    M: -9.4 S: -10.2     "
    "I: -9.4 LUFS       LRA:   0.0 LU  FTPK: -1.5 -0.8 dBFS  TPK: -1.5 -0.8 dBFS\n"
    """[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:          -9.4 LUFS
    Threshold: -19.4 LUFS

  Loudness range:
    LRA:         4.2 LU
    Threshold: -29.4 LUFS
    LRA low:   -12.1 LUFS
    LRA high:   -7.9 LUFS

  True peak:
    Peak:       -0.8 dBFS
"""
)


@pytest.fixture(autouse=True)
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(meter, "get_backend_settings", lambda: SimpleNamespace(cache_dir=tmp_path))
    return tmp_path


def test_parses_frames_and_summary() -> None:
    m = meter.parse_meter_log(LOG)

    assert list(m.frames.momentary) == [-120.7, -9.4]
    assert list(m.frames.short_term) == [-120.7, -10.2]
    # Silence is floored; the frame peak is the loudest channel.
    assert list(m.frames.true_peak) == [-200.0, -0.8]
    assert (m.integrated_lufs, m.loudness_range_lu, m.true_peak_dbtp) == (-9.4, 4.2, -0.8)


def test_parses_momentary_only_frames() -> None:
    log = (
        "[Parsed_ebur128_2 @ 0x1] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     "
        "I: -70.0 LUFS       LRA:   0.0 LU\n"
        "[Parsed_ebur128_2 @ 0x1] t: 0.199979   TARGET:-23 LUFS    M: -14.1 S: -15.0     "
        "I: -14.1 LUFS       LRA:   0.0 LU\n"
    )

    assert meter.parse_momentary_log(log) == [-120.7, -14.1]


def test_summary_of_silence_reads_as_none() -> None:
    m = meter.parse_meter_log("Summary:\n Integrated loudness:\n I: -inf LUFS\n True peak:\n Peak: -inf dBFS\n")

    assert m.integrated_lufs is None
    assert m.true_peak_dbtp is None


def _ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg not available")
    assert ffmpeg is not None
    return ffmpeg


def _two_level_tone(path: Path) -> Path:
    """30 s of tone at one level, then 30 s at a level 6 dB lower."""
    subprocess.run(
        [
            _ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:duration=60:sample_rate=48000",
            "-af",
            "volume='if(lt(t,30),0.5,0.25)':eval=frame",
            "-ac",
            "2",
            "-y",
            str(path),
        ],
        check=True,
    )
    return path


def test_measure_matches_ffmpeg_integrated(tmp_path: Path) -> None:
    m = meter.measure(_two_level_tone(tmp_path / "tone.wav"))

    assert len(m.frames.momentary) == pytest.approx(600, abs=2)
    assert m.integrated_lufs is not None
    # Our gating over the same blocks agrees with ffmpeg's integrated reading.
    assert integrated_lufs(m.frames.momentary) == pytest.approx(m.integrated_lufs, abs=0.1)
    first = integrated_lufs(m.frames.momentary[50:290])
    second = integrated_lufs(m.frames.momentary[350:590])
    assert first is not None and second is not None
    assert first - second == pytest.approx(6.0, abs=0.1)


def test_measure_meters_the_low_band(tmp_path: Path) -> None:
    path = tmp_path / "bass-then-treble.wav"
    # 30 s of a 60 Hz tone, then 30 s of 1 kHz at the same amplitude.
    subprocess.run(
        [
            _ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.5*sin(2*PI*if(lt(t\\,30)\\,60\\,1000)*t):d=60:s=48000",
            "-ac",
            "2",
            "-y",
            str(path),
        ],
        check=True,
    )

    m = meter.measure(path)

    assert len(m.frames.low_band) == len(m.frames.momentary)
    bass = low_end_lu(m.frames, 5, 29)
    treble = low_end_lu(m.frames, 35, 59)
    assert bass is not None and treble is not None
    # The low-pass keeps the 60 Hz tone and removes the 1 kHz one.
    assert bass == pytest.approx(0.0, abs=1.0)
    assert treble < -30


def test_measure_reports_progress_across_all_passes(tmp_path: Path) -> None:
    reported: list[float] = []

    meter.measure(_two_level_tone(tmp_path / "tone.wav"), reported.append)

    assert reported == sorted(reported)
    # The full band covers the first 70 %, the low band the next 15 %, the spectrum the rest.
    assert any(0.3 < done < 0.7 for done in reported)
    assert any(0.7 < done < 0.85 for done in reported)
    assert any(0.85 < done < 1.0 for done in reported)
    assert reported[-1] == pytest.approx(1.0, abs=0.01)


def test_progress_is_readable_while_measuring_and_cleared_after(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _two_level_tone(tmp_path / "tone.wav")
    real_measure = meter.measure
    seen: list[float | None] = []

    def measure(p: Path, on_progress: Callable[[float], None]) -> meter.Measurement:
        on_progress(0.5)
        seen.append(meter.measuring_progress(p))
        return real_measure(p)

    monkeypatch.setattr(meter, "measure", measure)
    assert meter.measuring_progress(path) is None

    asyncio.run(meter.get_or_measure(path))

    assert seen == [0.5]
    assert meter.measuring_progress(path) is None


def test_measurement_is_cached_per_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _two_level_tone(tmp_path / "tone.wav")
    assert meter.cached_measurement(path) is None

    first = asyncio.run(meter.get_or_measure(path))

    monkeypatch.setattr(meter, "measure", lambda _p: pytest.fail("should read the cache"))
    second = asyncio.run(meter.get_or_measure(path))
    assert list(second.frames.momentary) == list(first.frames.momentary)
    assert second.integrated_lufs == first.integrated_lufs
    assert list(second.frames.low_band) == list(first.frames.low_band)
    assert list(second.spectrum) == list(first.spectrum)


def test_measure_averages_the_spectrum(tmp_path: Path) -> None:
    m = meter.measure(_two_level_tone(tmp_path / "tone.wav"))

    levels = {band.name: band.level_db for band in band_levels(m.spectrum)}
    # Both halves are 1 kHz, so the mid band holds all the power.
    assert levels["Mid"] == pytest.approx(0.0, abs=0.1)
    assert levels["Sub"] < -40
