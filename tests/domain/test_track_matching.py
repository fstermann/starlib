"""Tests for picking the SoundCloud upload that matches a Shazam result."""

from __future__ import annotations

from backend.domain.track_matching import pick_soundcloud_match, search_query


def _sc(title: str, username: str = "label", duration_s: float = 360, **extra) -> dict:
    return {
        "id": hash(title) & 0xFFFF,
        "title": title,
        "user": {"username": username},
        "duration": duration_s * 1000,
        **extra,
    }


def test_picks_first_result_with_title_and_artist() -> None:
    hit = _sc("Entasia - Invasion", username="Entasia")
    assert pick_soundcloud_match("Invasion", "Entasia", [_sc("Unrelated"), hit]) is hit


def test_matches_artist_via_uploader_or_metadata_artist() -> None:
    by_user = _sc("Invasion", username="Entasia")
    by_meta = _sc("Invasion", username="label", metadata_artist="Entasia")
    assert pick_soundcloud_match("Invasion", "Entasia", [by_user]) is by_user
    assert pick_soundcloud_match("Invasion", "Entasia", [by_meta]) is by_meta


def test_rejects_wrong_artist() -> None:
    assert pick_soundcloud_match("Invasion", "Entasia", [_sc("Other Guy - Invasion")]) is None


def test_neutral_mix_suffix_still_matches_plain_upload() -> None:
    hit = _sc("Entasia - Invasion")
    assert pick_soundcloud_match("Invasion (Extended Mix)", "Entasia", [hit]) is hit


def test_remix_requires_remixer_in_title() -> None:
    original = _sc("Entasia - Invasion")
    remix = _sc("Entasia - Invasion (Foo Remix)")
    assert pick_soundcloud_match("Invasion (Foo Remix)", "Entasia", [original, remix]) is remix


def test_rejects_previews_and_dj_sets_by_length() -> None:
    preview = _sc("Entasia - Invasion", duration_s=30)
    dj_set = _sc("Entasia - Invasion (live set)", duration_s=3600)
    assert pick_soundcloud_match("Invasion", "Entasia", [preview, dj_set]) is None


def test_ignores_accents_and_punctuation() -> None:
    hit = _sc("BLAYDÉ - Vallée De L'armes")
    assert pick_soundcloud_match("Vallee de l armes", "Blayde", [hit]) is hit


def test_joint_credit_matches_any_artist() -> None:
    hit = _sc("Sil & Olav Basoski - Windows", username="Olav Basoski")
    assert pick_soundcloud_match("Windows", "Entasia, Sil & Olav Basoski", [hit]) is hit


def test_square_bracket_remix_requires_remixer() -> None:
    original = _sc("Inner City - Dance")
    remix = _sc("Inner City - Dance (Maruwa Remix)")
    title = "Dance (feat. Steffanie Christi'an) [Maruwa Remix]"
    assert pick_soundcloud_match(title, "Inner City", [original, remix]) is remix


def test_search_query_uses_base_title_and_first_artist() -> None:
    assert search_query("Dance (feat. X) [Maruwa Remix]", "Inner City, Y") == "dance inner city"
    assert search_query("Invasion", None) == "invasion"
