"""Artwork-URL suggester.

Returns the SC artwork URL upgraded to the high-quality ``-t500x500`` variant.
We deliberately don't fetch the bytes here — the response would balloon and
keystroke-driven suggestion fetches would become expensive. The frontend
fetches the URL when the user accepts the suggestion, then re-uses the
existing ``artwork_data`` field on the metadata-update endpoint.
"""

from __future__ import annotations

from backend.core.services.suggesters._base import candidate, compact
from backend.core.services.suggestion_engine import SuggestionContext
from backend.schemas.suggestions import FieldName, FieldSuggestion


def _hq(url: str) -> str:
    return url.replace("-large", "-t500x500")


class ArtworkSuggester:
    field: FieldName = "artwork_url"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        if not ctx.sc_track or not ctx.sc_track.artwork_url:
            return []
        return compact(
            [
                candidate(
                    _hq(ctx.sc_track.artwork_url),
                    source="sc_artwork_url",
                    confidence=0.9,
                    label="from SoundCloud artwork",
                ),
            ]
        )
