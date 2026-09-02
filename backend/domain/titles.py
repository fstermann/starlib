"""Title-string heuristics: parsing artist/mix/date out of track titles,
and ranking artist candidates against a title.

The parsing helpers normalise the many ways SoundCloud titles encode a
remix ("(Foo Remix)", "[Foo Edit]", "Free DL", ...). The ranking helpers
score a set of candidate names by how the title references them.
"""

import re
from collections.abc import Callable, Iterable
from datetime import date
from typing import Literal

ArtistRole = Literal["artist", "original_artist", "remixer"]


def remove_free_dl(title: str):
    return re.sub(r"[\(\[\{]\s*free\s*(dl|download)\s*.*?[\)\]\}]", "", title, flags=re.IGNORECASE).strip()


def remove_remix(title: str):
    return re.sub(r"\(.*edit|mix|bootleg|rework|flip.*\)", "", title, flags=re.IGNORECASE).strip()


def remove_mix(title: str) -> str:
    """Remove parenthesized mix/edit type strings from a title.

    Removes tokens like (Extended Mix), (Original Mix), (Radio Edit), (Club Mix), etc.
    """
    return re.sub(r"\([^)]*\b(?:edit|mix|bootleg|rework|flip)\b[^)]*\)", "", title, flags=re.IGNORECASE).strip()


def remove_premiere(title: str):
    return re.sub(r"(premiere|premear):?", "", title, flags=re.IGNORECASE).strip()


def remove_double_spaces(title: str):
    return re.sub(r"\s+", " ", title).strip()


def replace_underscores(title: str):
    return re.sub(r"_", " ", title).strip()


def is_remix(title: str) -> bool:
    return bool(re.search(r"\(.*edit|mix|bootleg|rework|flip.*\)", title, flags=re.IGNORECASE))


def get_mix_name(title: str) -> str | None:
    if match := re.search(r"\((.*)\)", title):
        return match.group(1).replace(get_mix_arist(title) or "", "").strip()
    return None


def get_first_artist(title: str) -> str | None:
    if match := re.match(r"(.*?)\s*-\s*(.*)", title):
        return match.group(1).strip()
    return None


def get_mix_arist(title: str) -> str | None:
    if match := re.search(r"\((.*)\)", title):
        mix_name = match.group(1)
        return re.sub(r"edit|remix|bootleg|rework|mix|flip", "", mix_name, flags=re.IGNORECASE).strip()
    return None


def parse_date(text: str) -> date | None:
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _is_in(artist: str, text: str | None) -> int:
    if not text:
        return 0
    return int(re.search(re.escape(artist.strip()), text, flags=re.IGNORECASE) is not None)


def _scorer(title: str, role: ArtistRole) -> Callable[[str], int]:
    first_artist = get_first_artist(title) or ""
    mix_artist = get_mix_arist(title) or ""

    def by_first(artist: str) -> int:
        if not artist:
            return 0
        return _is_in(artist, title) + _is_in(artist, first_artist)

    def by_mix(artist: str) -> int:
        if not artist:
            return 0
        return _is_in(artist, title) + _is_in(artist, mix_artist)

    if role == "remixer":
        return by_mix
    if role == "original_artist":
        return by_first
    return by_mix if is_remix(title) else by_first


def rank_artists(
    candidates: Iterable[str],
    *,
    title: str,
    role: ArtistRole,
) -> list[str]:
    """Rank ``candidates`` from most to least likely match for ``role``.

    Stable sort: ties preserve input order, so callers can pass a meaningful
    source-priority sequence (e.g. metadata_artist before username) and have
    that order respected when no heuristic distinguishes the candidates.
    """
    scorer = _scorer(title, role)
    return sorted(candidates, key=scorer, reverse=True)
