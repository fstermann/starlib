"""Pure ranking helpers for artist candidate lists.

Extracted from :class:`soundcloud_tools.handler.track.TrackInfo.sort_artists`
so the suggestion engine can rank without instantiating a full ``TrackInfo``.

Three roles are supported:

- ``"artist"`` — the primary performer. When the title is a remix the mix
  artist (parens content) wins; otherwise the dash-prefix wins.
- ``"original_artist"`` — the dash-prefix wins (the person whose track is
  being remixed).
- ``"remixer"`` — the parens content wins.

Names that are referenced by the title get a higher score; everything else
ties at zero. The order within a tie is the input iteration order.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import Literal

from soundcloud_tools.utils.string import (
    get_first_artist,
    get_mix_arist,
    is_remix,
)

ArtistRole = Literal["artist", "original_artist", "remixer"]


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
