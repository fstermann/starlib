"""Title suggester.

Three candidates, in order of confidence:

1. SC title with both the paren-suffixed mix descriptor *and* the leading
   ``Artist - `` prefix stripped — i.e. the bare song title. This matches the
   convention used in the local ``title`` ID3 frame; the artist lives in
   ``TPE1`` and the mix detail in ``TIT3``/``TPE4``.
2. The filename's title component.
3. The raw SC title (lowest confidence: useful as a fallback when the strip
   heuristic produced something empty/garbled, e.g. titles without a dash).
"""

from __future__ import annotations

import re

from backend.core.services.suggesters._base import candidate, compact
from backend.core.services.suggestion_engine import SuggestionContext
from backend.schemas.suggestions import FieldName, FieldSuggestion

# Strip any trailing paren group containing one of the mix keywords. Uses a
# whole-word check via lookarounds so "Mix"/"Edit" match but "Remix" also
# matches (the upstream ``\bmix\b`` pattern in ``remove_mix`` rejects "Remix"
# because there's no word-boundary inside it).
_MIX_PAREN_RE = re.compile(
    r"\s*\([^)]*(?:remix|edit|mix|bootleg|rework|flip)[^)]*\)\s*",
    flags=re.IGNORECASE,
)


def _strip_mix_paren(title: str) -> str:
    return _MIX_PAREN_RE.sub("", title).strip()


def _bare_title(sc_title: str) -> str:
    """Reduce a SC track title to just the song name.

    Drops the trailing ``(Mix)`` group and the leading ``Artist - `` prefix.
    Falls back to the input when no dash is present (e.g. one-word titles or
    titles where the uploader didn't follow the convention).
    """
    stripped = _strip_mix_paren(sc_title)
    if " - " in stripped:
        # Non-greedy split on the first dash separator only — matches
        # ``get_first_artist`` so artist parsing stays consistent.
        return stripped.split(" - ", 1)[1].strip()
    return stripped


class TitleSuggester:
    field: FieldName = "title"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        out: list[FieldSuggestion | None] = []

        if ctx.sc_track and ctx.sc_track.title:
            out.append(
                candidate(
                    _bare_title(ctx.sc_track.title),
                    source="sc_title",
                    confidence=0.9,
                    label="from SoundCloud title",
                )
            )
            out.append(
                candidate(
                    ctx.sc_track.title,
                    source="sc_title",
                    confidence=0.5,
                    label="from SoundCloud title (raw)",
                )
            )

        if ctx.filename_parsed.title:
            out.append(
                candidate(
                    ctx.filename_parsed.title,
                    source="filename_parse",
                    confidence=0.6,
                    label="from filename",
                )
            )

        return compact(out)
