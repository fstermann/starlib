"""Tests for the filename parser used by the suggestion engine."""

from __future__ import annotations

import pytest

from backend.core.services.filename_parser import parse_filename


def test_simple_artist_title() -> None:
    parsed = parse_filename("Foo - Bar")
    assert parsed.artist == "Foo"
    assert parsed.title == "Bar"
    assert parsed.remixer is None
    assert parsed.mix_name is None


def test_remix_in_parens() -> None:
    """``mix_name`` mirrors ``get_mix_name``: the keyword tail with the mix
    artist already stripped (e.g. ``"Remix"`` for ``"(Baz Remix)"``)."""
    parsed = parse_filename("Foo - Bar (Baz Remix)")
    assert parsed.artist == "Foo"
    assert parsed.title == "Bar"
    assert parsed.remixer == "Baz"
    assert parsed.mix_name == "Remix"


def test_extended_mix_paren() -> None:
    """Quirk of the shared heuristics: ``"Extended"`` is the bit before the
    "mix" keyword, so it lands in ``remixer`` even though it isn't a person.
    Suggesters layer their own smarter logic on top of this primitive."""
    parsed = parse_filename("Foo - Bar (Extended Mix)")
    assert parsed.artist == "Foo"
    assert parsed.title == "Bar"
    assert parsed.remixer == "Extended"
    assert parsed.mix_name == "Mix"


def test_underscores_normalized() -> None:
    parsed = parse_filename("Foo_Artist_-_Some_Title")
    assert parsed.artist == "Foo Artist"
    assert parsed.title == "Some Title"


def test_free_dl_marker_stripped() -> None:
    parsed = parse_filename("Foo - Bar [Free DL]")
    assert parsed.artist == "Foo"
    assert parsed.title == "Bar"


def test_premiere_prefix_stripped() -> None:
    parsed = parse_filename("Premiere: Foo - Bar")
    assert parsed.artist == "Foo"
    assert parsed.title == "Bar"


def test_no_dash_returns_title_only() -> None:
    parsed = parse_filename("just_a_filename")
    assert parsed.artist is None
    assert parsed.title == "just a filename"
    assert parsed.remixer is None


def test_empty_stem() -> None:
    assert parse_filename("") == parse_filename("   ")
    parsed = parse_filename("")
    assert parsed.artist is None
    assert parsed.title is None


def test_multiple_dashes_keeps_first_artist() -> None:
    """A common pattern: ``Label - Artist - Title``. We don't handle this any
    better than `get_first_artist` does — verify the documented behaviour."""
    parsed = parse_filename("Label - Artist - Title")
    # get_first_artist is non-greedy, so it returns "Label".
    assert parsed.artist == "Label"
    assert parsed.title == "Artist - Title"


@pytest.mark.parametrize(
    "stem,expected_remixer",
    [
        ("Foo - Bar (Baz Bootleg)", "Baz"),
        ("Foo - Bar (Qux Edit)", "Qux"),
        ("Foo - Bar (Whatever Rework)", "Whatever"),
    ],
)
def test_various_mix_keywords(stem: str, expected_remixer: str) -> None:
    parsed = parse_filename(stem)
    assert parsed.remixer == expected_remixer
