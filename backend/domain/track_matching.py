"""Pick the SoundCloud search result that matches a recognised track."""

import re
import unicodedata
from typing import Any

# Shorter results are previews/snippets, longer ones are DJ sets or mixes.
MIN_TRACK_S = 90
MAX_TRACK_S = 15 * 60


def _norm(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", folded.lower()).split())


def _contains(haystack: str, needle: str) -> bool:
    return bool(needle) and f" {needle} " in f" {haystack} "


_MIX_TYPES = r"remix|edit|bootleg|rework|flip|mix|dub|vip"
_NEUTRAL_MIXES = {"extended", "original", "radio", "club", "dub", "full"}


def _remixers(title: str) -> list[str]:
    """Names in ``(Foo Remix)`` / ``[Foo Edit]`` suffixes, minus neutral mix types."""
    names = []
    for inner in re.findall(r"[(\[]([^)\]]*)[)\]]", title):
        if not re.search(rf"\b(?:{_MIX_TYPES})\b", inner, flags=re.IGNORECASE):
            continue
        name = _norm(re.sub(rf"\b(?:{_MIX_TYPES})\b", "", inner, flags=re.IGNORECASE))
        if name and name not in _NEUTRAL_MIXES:
            names.append(name)
    return names


def _artists(artist: str | None) -> list[str]:
    """Split a joint credit like ``"A, B & C feat. D"`` into normalised names."""
    parts = re.split(r",|&|\bx\b|\band\b|\bfeat\.?|\bft\.?", artist or "", flags=re.IGNORECASE)
    return [n for n in (_norm(p) for p in parts) if n]


def _base_title(title: str) -> str:
    return _norm(re.sub(r"[(\[].*?[)\]]", "", title))


def search_query(title: str, artist: str | None) -> str:
    """SoundCloud search text: the base title plus the first credited artist.

    Remix suffixes and long joint credits make SoundCloud's search miss, so
    they're left to :func:`pick_soundcloud_match` to check instead.
    """
    artists = _artists(artist)
    return f"{_base_title(title)} {artists[0]}" if artists else _base_title(title)


def pick_soundcloud_match(title: str, artist: str | None, results: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return the first result that plausibly is the same track, or ``None``.

    A result matches when its title contains the track's base title (bracketed
    suffixes stripped), every remixer appears in its title, any credited artist
    appears in its title, uploader or metadata artist, and its length is that
    of a single track.

    Args:
        title: Recognised track title, e.g. ``"Invasion (Extended Mix)"``.
        artist: Recognised artist, if known.
        results: SoundCloud ``/tracks`` search results in relevance order.

    Returns:
        The matching SoundCloud track payload.
    """
    base = _base_title(title)
    remixers = _remixers(title)
    artists = _artists(artist)
    for result in results:
        duration_ms = result.get("duration")
        if not isinstance(duration_ms, int | float) or not MIN_TRACK_S <= duration_ms / 1000 <= MAX_TRACK_S:
            continue
        sc_title = _norm(result.get("title") or "")
        if not _contains(sc_title, base) or not all(_contains(sc_title, r) for r in remixers):
            continue
        if artists:
            user = result.get("user") or {}
            credits = " ".join(
                _norm(str(v or "")) for v in (result.get("title"), user.get("username"), result.get("metadata_artist"))
            )
            if not any(_contains(credits, a) for a in artists):
                continue
        return result
    return None
