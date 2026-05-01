"""Mix-name suggester.

Picks the parens-content tail (e.g. ``"Extended Mix"``, ``"Remix"``) from the
SC title or the local filename. Kept dumb on purpose: the engine drops
suggestions that equal the current value, so even a noisy ``"Mix"`` candidate
is only shown when the field is empty or different.
"""

from __future__ import annotations

from backend.core.services.suggesters._base import candidate, compact
from backend.core.services.suggestion_engine import SuggestionContext
from backend.schemas.suggestions import FieldName, FieldSuggestion


class MixNameSuggester:
    field: FieldName = "mix_name"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        out = [
            candidate(
                ctx.sc_parsed.mix_name if ctx.sc_parsed else None,
                source="sc_title",
                confidence=0.8,
                label="from SoundCloud title",
            ),
            candidate(
                ctx.filename_parsed.mix_name,
                source="filename_parse",
                confidence=0.5,
                label="from filename",
            ),
        ]
        return compact(out)
