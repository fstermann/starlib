"""Per-suggester unit tests.

Each suggester is exercised in isolation via :func:`compute_suggestions`
(end-to-end through the engine, since the engine is what filters out
"current==top" candidates). This means we get coverage of the integration
seam — sort order, dedup, equal-to-current filtering — for free.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.core.services.suggestion_engine import compute_suggestions
from backend.schemas.metadata import TrackInfoUpdateRequest
from backend.schemas.suggestions import SCTrackPayload, SCUserPayload


@pytest.fixture
def music_file(tmp_path: Path) -> Path:
    f = tmp_path / "Foo - Bar (Baz Remix).mp3"
    f.write_bytes(b"")
    return f


@pytest.fixture
def empty_file(tmp_path: Path) -> Path:
    f = tmp_path / "track.mp3"
    f.write_bytes(b"")
    return f


def _sc(**kwargs) -> SCTrackPayload:
    """Tiny helper to build a SCTrackPayload with sensible defaults."""
    return SCTrackPayload(**kwargs)


def _run(file_path: Path, *, sc=None, current=None) -> dict:
    response = compute_suggestions(
        file_path=file_path,
        sc_track=sc,
        current=current or TrackInfoUpdateRequest(),
    )
    return {field: [s.model_dump() for s in cands] for field, cands in response.fields.items()}


# ---------------------------------------------------------------------------
# Title
# ---------------------------------------------------------------------------


def test_title_strips_artist_prefix_and_remix_suffix(music_file: Path) -> None:
    """Top suggestion should be the bare song title — no leading ``Artist - ``,
    no trailing ``(Mix)``. Raw SC title is also offered as a fallback."""
    out = _run(music_file, sc=_sc(title="Foo - Bar (Baz Remix)"))
    titles = [s["value"] for s in out["title"]]
    assert titles[0] == "Bar"
    # Raw SC title is still on the list as a low-confidence fallback.
    assert "Foo - Bar (Baz Remix)" in titles


def test_title_one_word_passes_through(music_file: Path) -> None:
    """No dash, no paren → suggest the title verbatim."""
    out = _run(music_file, sc=_sc(title="Onesong"))
    titles = [s["value"] for s in out["title"]]
    assert "Onesong" in titles


def test_title_drops_artist_prefix_when_no_remix(music_file: Path) -> None:
    out = _run(music_file, sc=_sc(title="Foo - Bar"))
    titles = [s["value"] for s in out["title"]]
    assert titles[0] == "Bar"


def test_title_uses_filename_when_no_sc(music_file: Path) -> None:
    out = _run(music_file)
    titles = [s["value"] for s in out["title"]]
    # Filename "Foo - Bar (Baz Remix).mp3" parses title → "Bar"
    assert titles == ["Bar"]


def test_title_skips_when_equal_to_current(music_file: Path) -> None:
    """Engine drops candidates equal to the current value."""
    out = _run(
        music_file,
        sc=_sc(title="Foo - Bar"),
        current=TrackInfoUpdateRequest(title="Foo - Bar"),
    )
    titles = [s["value"] for s in out.get("title", [])]
    assert "Foo - Bar" not in titles


# ---------------------------------------------------------------------------
# Artist (incl. list normalisation + aggregation)
# ---------------------------------------------------------------------------


def test_artist_picks_metadata_artist_for_non_remix(empty_file: Path) -> None:
    out = _run(
        empty_file,
        sc=_sc(
            title="Foo - Bar",
            metadata_artist="Foo",
            user=SCUserPayload(username="some_uploader"),
        ),
    )
    assert out["artist"][0]["value"] == "Foo"
    assert out["artist"][0]["source"] == "sc_metadata_artist"


def test_artist_aggregates_distinct_sources(empty_file: Path) -> None:
    """When SC says ``Foo`` and the filename says ``Bar``, an aggregated
    ``"Foo, Bar"`` candidate is offered."""
    f = empty_file.parent / "Bar - Some Title.mp3"
    f.write_bytes(b"")
    out = _run(
        f,
        sc=_sc(
            title="Some Title",
            metadata_artist="Foo",
        ),
    )
    values = [s["value"] for s in out["artist"]]
    assert "Foo, Bar" in values


def test_artist_normalizes_compound_value(empty_file: Path) -> None:
    out = _run(
        empty_file,
        sc=_sc(title="Random Title", metadata_artist="A & B feat. C"),
    )
    values = [s["value"] for s in out["artist"]]
    assert "A, B, C" in values


def test_remixer_only_for_remix(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo - Bar", metadata_artist="Foo"))
    assert "remixer" not in out

    out = _run(empty_file, sc=_sc(title="Foo - Bar (Baz Remix)", metadata_artist="Foo"))
    remixers = [s["value"] for s in out["remixer"]]
    assert "Baz" in remixers


def test_original_artist_only_for_remix(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo - Bar", metadata_artist="Foo"))
    assert "original_artist" not in out

    out = _run(empty_file, sc=_sc(title="Foo - Bar (Baz Remix)", metadata_artist="Foo"))
    values = [s["value"] for s in out["original_artist"]]
    assert "Foo" in values


# ---------------------------------------------------------------------------
# Mix name
# ---------------------------------------------------------------------------


def test_mix_name_from_sc_title(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo - Bar (Baz Remix)"))
    values = [s["value"] for s in out["mix_name"]]
    assert "Remix" in values


# ---------------------------------------------------------------------------
# Genre
# ---------------------------------------------------------------------------


def test_genre_prefers_explicit_field(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo - Bar", genre="House", tag_list="techno dance"))
    assert out["genre"][0]["value"] == "House"
    # tag fallback is also offered
    values = [s["value"] for s in out["genre"]]
    assert "techno" in values


def test_genre_falls_back_to_first_tag(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo - Bar", tag_list='"Deep House" something'))
    assert out["genre"][0]["value"] == "Deep House"


def test_genre_no_sc(empty_file: Path) -> None:
    out = _run(empty_file)
    assert "genre" not in out


# ---------------------------------------------------------------------------
# Release date / year
# ---------------------------------------------------------------------------


def test_release_date_from_parts(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo", release_year=2024, release_month=3, release_day=15))
    assert out["release_date"][0]["value"] == "2024-03-15"
    assert out["release_year"][0]["value"] == 2024


def test_release_date_partial_parts_fills_with_january_first(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo", release_year=2024))
    assert out["release_date"][0]["value"] == "2024-01-01"


def test_release_date_from_created_at(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo", created_at="2024/03/15 10:00:00 +0000"))
    values = [s["value"] for s in out["release_date"]]
    assert "2024-03-15" in values


# ---------------------------------------------------------------------------
# Artwork
# ---------------------------------------------------------------------------


def test_artwork_url_upgraded_to_hq(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo", artwork_url="https://i1.sndcdn.com/abc-large.jpg"))
    assert out["artwork_url"][0]["value"] == "https://i1.sndcdn.com/abc-t500x500.jpg"


def test_artwork_skipped_when_missing(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo"))
    assert "artwork_url" not in out


# ---------------------------------------------------------------------------
# BPM / Key
# ---------------------------------------------------------------------------


def test_bpm_rounded_to_int(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo", bpm=128.4))
    assert out["bpm"][0]["value"] == 128


def test_bpm_skipped_when_missing(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo"))
    assert "bpm" not in out


def test_key_passed_through(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo", key_signature="A min"))
    assert out["key"][0]["value"] == "A min"


# ---------------------------------------------------------------------------
# Cross-cutting
# ---------------------------------------------------------------------------


def test_no_sc_no_filename_returns_empty(tmp_path: Path) -> None:
    f = tmp_path / "untitled.mp3"
    f.write_bytes(b"")
    out = _run(f)
    # "untitled" (whole-stem) lands as a title suggestion via filename parser.
    assert "title" in out
    assert out["title"][0]["value"].lower() == "untitled"


def test_response_is_sorted_by_confidence(empty_file: Path) -> None:
    out = _run(empty_file, sc=_sc(title="Foo - Bar (Baz Remix)"))
    confidences = [s["confidence"] for s in out["title"]]
    assert confidences == sorted(confidences, reverse=True)
