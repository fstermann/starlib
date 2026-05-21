"""Tests for the pure artist-ranking helper."""

from __future__ import annotations

from soundcloud_tools.handler.artist_ranking import rank_artists


def test_role_artist_non_remix_prefers_dash_prefix() -> None:
    """For ``"Foo - Bar"`` (no remix), the dash-prefix should win."""
    ranked = rank_artists(["Foo", "Bar", "Other"], title="Foo - Bar", role="artist")
    assert ranked[0] == "Foo"


def test_role_artist_remix_prefers_mix_artist() -> None:
    """For a remix title, the parens-content artist should win."""
    ranked = rank_artists(
        ["Foo", "Baz", "Other"],
        title="Foo - Bar (Baz Remix)",
        role="artist",
    )
    assert ranked[0] == "Baz"


def test_role_remixer_always_prefers_mix_artist() -> None:
    ranked = rank_artists(
        ["Foo", "Baz"],
        title="Foo - Bar (Baz Remix)",
        role="remixer",
    )
    assert ranked[0] == "Baz"


def test_role_original_artist_prefers_dash_prefix_even_in_remix() -> None:
    ranked = rank_artists(
        ["Foo", "Baz"],
        title="Foo - Bar (Baz Remix)",
        role="original_artist",
    )
    assert ranked[0] == "Foo"


def test_unmatched_candidates_get_zero_score_in_input_order() -> None:
    """Names that don't appear in the title preserve input order behind matches."""
    ranked = rank_artists(["Alpha", "Beta", "Gamma"], title="Alpha - Beta", role="artist")
    # "Alpha" matches dash-prefix (highest), then "Beta" matches title (mid),
    # then "Gamma" with no match.
    assert ranked == ["Alpha", "Beta", "Gamma"]


def test_empty_candidates_returns_empty() -> None:
    assert rank_artists([], title="Foo - Bar", role="artist") == []


def test_blank_candidate_strings_score_zero() -> None:
    """Blank entries shouldn't be promoted by accidental empty-string matches."""
    ranked = rank_artists(["", "Foo"], title="Foo - Bar", role="artist")
    assert ranked[0] == "Foo"


def test_legacy_wrapper_delegates() -> None:
    """``TrackInfo.sort_artists`` is now a thin wrapper around ``rank_artists``
    — make sure the contract still matches."""
    from soundcloud_tools.handler.track import TrackInfo

    direct = rank_artists({"Foo", "Baz"}, title="Foo - Bar (Baz Remix)", role="artist")
    via = TrackInfo.sort_artists({"Foo", "Baz"}, "Foo - Bar (Baz Remix)", "artist")
    assert direct == via
