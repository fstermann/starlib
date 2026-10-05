"""Tests for the playlist-occurrence ranking."""

from __future__ import annotations

from backend.domain.playlist_picks import rank_by_playlist_occurrence


def test_ranks_by_playlist_count() -> None:
    playlists = [[1, 2, 3], [3, 4], [3, 4, 5]]
    assert rank_by_playlist_occurrence(playlists, exclude=99, limit=10) == [
        (3, 3),
        (4, 2),
        (1, 1),
        (2, 1),
        (5, 1),
    ]


def test_excludes_seed_track() -> None:
    assert rank_by_playlist_occurrence([[7, 1], [7, 1]], exclude=7, limit=10) == [(1, 2)]


def test_counts_duplicates_within_a_playlist_once() -> None:
    assert rank_by_playlist_occurrence([[1, 1, 1], [2], [2]], exclude=0, limit=10) == [(2, 2), (1, 1)]


def test_applies_limit() -> None:
    assert rank_by_playlist_occurrence([[1, 2, 3]], exclude=0, limit=2) == [(1, 1), (2, 1)]
