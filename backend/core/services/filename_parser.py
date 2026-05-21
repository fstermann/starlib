"""Best-effort decomposition of an audio file's stem.

Audio filenames in the wild follow the convention ``Artist - Title (Mix)``.
This parser uses the same regex helpers as SC-title parsing
(:mod:`soundcloud_tools.utils.string`) so a remix appearing in either the SC
title or the local filename is handled consistently.

The parser is intentionally conservative: ambiguous stems return ``None``
fields rather than guesses, so the suggestion engine can fall back to other
sources without misleading low-confidence noise.
"""

from __future__ import annotations

import re

from backend.core.services.suggestion_engine import ParsedFilename
from soundcloud_tools.utils.string import (
    get_first_artist,
    get_mix_arist,
    get_mix_name,
    is_remix,
    remove_double_spaces,
    remove_free_dl,
    remove_premiere,
    replace_underscores,
)


def _strip_trailing_paren(text: str) -> str:
    """Drop a trailing ``(…)`` group, used to isolate the bare title."""
    return re.sub(r"\s*\([^)]*\)\s*$", "", text).strip()


def parse_filename(stem: str) -> ParsedFilename:
    """Decompose ``Artist - Title (Mix)``-style stems.

    Parameters
    ----------
    stem
        Filename without extension (e.g. ``"Foo - Bar (Baz Remix)"``).

    Returns
    -------
    ParsedFilename
        Heuristic fields. Any unrecognisable component is left as ``None``.
    """
    if not stem or not stem.strip():
        return ParsedFilename()

    cleaned = replace_underscores(stem)
    cleaned = remove_free_dl(cleaned)
    cleaned = remove_premiere(cleaned)
    cleaned = remove_double_spaces(cleaned)

    if not cleaned:
        return ParsedFilename()

    artist = get_first_artist(cleaned)
    remixer = get_mix_arist(cleaned) if is_remix(cleaned) else None
    mix_name = get_mix_name(cleaned)

    title: str | None
    if artist and " - " in cleaned:
        # Strip the leading "Artist - " then drop a trailing "(…)" group so the
        # title is the bare song name.
        rest = cleaned.split(" - ", 1)[1].strip()
        title = _strip_trailing_paren(rest) or None
    else:
        # No dash → treat the whole string as a title; we can't infer artist.
        title = _strip_trailing_paren(cleaned) or None

    return ParsedFilename(
        artist=artist or None,
        title=title,
        remixer=remixer or None,
        mix_name=mix_name,
    )
