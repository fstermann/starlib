"""Pure-unit tests for analyser support code: pitch strategy, token bucket, ffmpeg arg builder."""

from __future__ import annotations

import asyncio
import math

import pytest

from backend.core.services.analyser.cache import _atempo_chain
from backend.core.services.analyser.pipeline import (
    _summarise_section_for_shazam,
    select_pitch_offsets,
)
from backend.core.services.analyser.shazam import TokenBucket

# ---------------------------------------------------------------------------
# Pitch strategy
# ---------------------------------------------------------------------------


class TestSelectPitchOffsets:
    def test_none_strategy_yields_unmodified_query(self) -> None:
        assert select_pitch_offsets(section_bpm=128.0, target_bpm=120.0, bpm_range=None, strategy="none") == [0.0]

    def test_single_strategy_picks_one_target_offset(self) -> None:
        offsets = select_pitch_offsets(section_bpm=128.0, target_bpm=120.0, bpm_range=None, strategy="single")
        assert len(offsets) == 1
        # 12 * log2(120/128) ≈ -1.117 semitones
        assert offsets[0] == pytest.approx(12.0 * math.log2(120.0 / 128.0), abs=1e-6)

    def test_range_strategy_fans_out_across_band(self) -> None:
        offsets = select_pitch_offsets(section_bpm=128.0, target_bpm=None, bpm_range=(120.0, 130.0), strategy="range")
        assert len(offsets) == 3
        # Lowest candidate (120) shifts down, highest (130) shifts up.
        assert offsets[0] < offsets[1] < offsets[2]
        assert offsets[0] == pytest.approx(12.0 * math.log2(120.0 / 128.0), abs=1e-6)
        assert offsets[2] == pytest.approx(12.0 * math.log2(130.0 / 128.0), abs=1e-6)

    def test_invalid_section_bpm_falls_back_to_no_shift(self) -> None:
        assert select_pitch_offsets(section_bpm=0.0, target_bpm=120.0, bpm_range=None, strategy="single") == [0.0]


# ---------------------------------------------------------------------------
# Section sampling
# ---------------------------------------------------------------------------


class TestSummariseSectionForShazam:
    def test_centred_window_for_long_section(self) -> None:
        offset, duration = _summarise_section_for_shazam(0.0, 100.0, target_window_s=12.0)
        assert duration == 12.0
        assert offset == pytest.approx(44.0)  # midpoint 50 - 6

    def test_full_section_when_shorter_than_target(self) -> None:
        offset, duration = _summarise_section_for_shazam(10.0, 18.0, target_window_s=12.0)
        assert offset == 10.0
        assert duration == pytest.approx(8.0, abs=1e-6)


# ---------------------------------------------------------------------------
# atempo chain (covers ffmpeg slice generation under range pitch shifts)
# ---------------------------------------------------------------------------


class TestAtempoChain:
    def test_in_range_returns_single_filter(self) -> None:
        assert _atempo_chain(1.5).startswith("atempo=1.5")
        assert "," not in _atempo_chain(1.5)

    def test_below_half_stacks_multiple_atempo(self) -> None:
        chain = _atempo_chain(0.25)
        assert chain.count("atempo=") >= 2
        # Multiplied product should be ~0.25.
        product = 1.0
        for part in chain.split(","):
            product *= float(part.removeprefix("atempo="))
        assert product == pytest.approx(0.25, rel=1e-3)

    def test_above_two_stacks_multiple_atempo(self) -> None:
        chain = _atempo_chain(4.0)
        product = 1.0
        for part in chain.split(","):
            product *= float(part.removeprefix("atempo="))
        assert product == pytest.approx(4.0, rel=1e-3)


# ---------------------------------------------------------------------------
# Token bucket
# ---------------------------------------------------------------------------


class TestTokenBucket:
    @pytest.mark.asyncio
    async def test_burst_allows_capacity_immediately(self) -> None:
        bucket = TokenBucket(rate=1.0, capacity=3.0)
        # Three immediate acquires should not block beyond a tiny epsilon.
        for _ in range(3):
            await asyncio.wait_for(bucket.acquire(), timeout=0.05)

    @pytest.mark.asyncio
    async def test_sustained_rate_throttles(self) -> None:
        bucket = TokenBucket(rate=10.0, capacity=1.0)
        start = asyncio.get_event_loop().time()
        for _ in range(3):
            await bucket.acquire()
        elapsed = asyncio.get_event_loop().time() - start
        # Capacity 1, rate 10 → first acquire instant, next two each cost ~0.1s.
        assert elapsed >= 0.18
