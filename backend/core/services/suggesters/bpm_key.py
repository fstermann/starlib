"""BPM and musical-key suggesters.

Both fields are rare on SoundCloud uploads, so confidences are low — these
suggestions exist mostly so a user with a track that *does* expose them can
one-click accept. BPM is rounded to int to match the local tag column.
"""

from __future__ import annotations

from backend.core.services.suggesters._base import candidate, compact
from backend.core.services.suggestion_engine import SuggestionContext
from backend.schemas.suggestions import FieldName, FieldSuggestion


class BPMSuggester:
    field: FieldName = "bpm"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        if not ctx.sc_track or not ctx.sc_track.bpm or ctx.sc_track.bpm <= 0:
            return []
        rounded = round(ctx.sc_track.bpm)
        return compact(
            [
                candidate(
                    rounded,
                    source="sc_bpm",
                    confidence=0.5,
                    label="from SoundCloud BPM",
                ),
            ]
        )


class KeySuggester:
    field: FieldName = "key"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        if not ctx.sc_track or not ctx.sc_track.key_signature:
            return []
        return compact(
            [
                candidate(
                    ctx.sc_track.key_signature,
                    source="sc_key",
                    confidence=0.5,
                    label="from SoundCloud key",
                ),
            ]
        )
