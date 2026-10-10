"""End-to-end check against the hand-analysed reference track.

Runs only when ``STARLIB_BREAKDOWN_REFERENCE`` points at "Entasia - Bumper"
and ``STARLIB_DEMUCS_PYTHON`` at a Python with demucs; the audio isn't in git.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from backend.services.breakdown.track import analyse_track

REFERENCE = os.environ.get("STARLIB_BREAKDOWN_REFERENCE")

pytestmark = pytest.mark.skipif(
    not (REFERENCE and os.environ.get("STARLIB_DEMUCS_PYTHON")),
    reason="set STARLIB_BREAKDOWN_REFERENCE and STARLIB_DEMUCS_PYTHON to run",
)


def test_bumper_matches_the_hand_analysis() -> None:
    result = asyncio.run(analyse_track(Path(REFERENCE or "")))

    assert result.features["grid"]["bpm"] == 144
    assert result.features["tonal"]["root"] == "B"
    assert 60 < result.features["tonal"]["bass_peaks"][0]["hz"] < 64
    musical = [(s.start_bar, s.end_bar, s.label) for s in result.sections if s.label != "tail"]
    assert musical == [
        (1, 16, "intro"),
        (17, 48, "groove"),
        (49, 64, "build"),
        (65, 112, "main"),
        (113, 128, "breakdown"),
        (129, 144, "filtered"),
        (145, 160, "build"),
        (161, 208, "main"),
        (209, 224, "outro"),
    ]
