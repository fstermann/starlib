"""Genre suggester.

Primary source is the SC ``genre`` field; the first ``tag_list`` entry is a
reasonable fallback when no genre is set (uploaders often fill in tags but
forget the dedicated genre slot).
"""

from __future__ import annotations

from backend.core.services.suggesters._base import candidate, compact
from backend.core.services.suggestion_engine import SuggestionContext
from backend.schemas.suggestions import FieldName, FieldSuggestion


def _first_tag(tag_list: str | None) -> str | None:
    """SC's ``tag_list`` is space-separated, with quoted multi-word tags."""
    if not tag_list:
        return None
    s = tag_list.strip()
    if not s:
        return None
    if s.startswith('"'):
        end = s.find('"', 1)
        if end > 1:
            return s[1:end]
    return s.split()[0]


class GenreSuggester:
    field: FieldName = "genre"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        if not ctx.sc_track:
            return []
        out = [
            candidate(
                ctx.sc_track.genre,
                source="sc_genre",
                confidence=0.9,
                label="from SoundCloud genre",
            ),
            candidate(
                _first_tag(ctx.sc_track.tag_list),
                source="sc_tag",
                confidence=0.4,
                label="from SoundCloud tags",
            ),
        ]
        return compact(out)
