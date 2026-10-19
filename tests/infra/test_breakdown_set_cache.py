"""Tests for the downloaded-set cache: lookups and LRU eviction."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.infra.breakdown import cache
from backend.infra.breakdown import loudness as meter


@pytest.fixture
def cfg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> cache.BreakdownCacheConfig:
    config = cache.BreakdownCacheConfig(sets_dir=tmp_path / "sets", slices_dir=tmp_path / "slices")
    config.sets_dir.mkdir(parents=True)
    monkeypatch.setattr(cache, "_config", lambda: config)
    return config


def _download(cfg: cache.BreakdownCacheConfig, soundcloud_id: int, *, size: int, used_at: float) -> Path:
    path = cfg.sets_dir / f"{soundcloud_id}.mp4"
    path.write_bytes(b"\0" * size)
    os.utime(path, (used_at, 1_000_000))
    return path


def test_looking_up_a_set_keeps_its_identity_for_derived_caches(cfg: cache.BreakdownCacheConfig) -> None:
    path = _download(cfg, 1, size=10, used_at=1_000_000)
    key = meter._cache_key(path)

    assert cache.cached_set_path(1) == path

    # Loudness and peaks key on the modified time; a lookup must not change it.
    assert path.stat().st_mtime == 1_000_000
    assert meter._cache_key(path) == key


def test_eviction_drops_the_least_recently_used_set(cfg: cache.BreakdownCacheConfig) -> None:
    cfg.max_total_bytes = 25
    old = _download(cfg, 1, size=10, used_at=1_000_000)
    _download(cfg, 2, size=10, used_at=2_000_000)
    _download(cfg, 3, size=10, used_at=3_000_000)
    cache.cached_set_path(1)

    cache.enforce_size_cap()

    # Set 1 was downloaded first but used last, so set 2 goes.
    assert sorted(p.name for p in cfg.sets_dir.iterdir()) == ["1.mp4", "3.mp4"]
    assert old.exists()
