"""Release-date and release-year suggesters.

SC stores release dates split across three integer fields. We reconstruct an
ISO date when ``release_year`` is set; missing month/day fall back to ``01``
since most catalogues only commit to month-of-year. ``created_at`` is a much
weaker fallback — it's the upload date, not the release date — so its
confidence is intentionally low.

Two suggesters because the editor exposes both fields independently. Sharing
the parse keeps them consistent.
"""

from __future__ import annotations

from datetime import date, datetime

from backend.core.services.suggesters._base import candidate, compact
from backend.core.services.suggestion_engine import SuggestionContext
from backend.schemas.suggestions import FieldName, FieldSuggestion, SCTrackPayload


def _from_release_parts(sc: SCTrackPayload) -> date | None:
    if not sc.release_year or sc.release_year <= 0:
        return None
    month = sc.release_month if (sc.release_month and sc.release_month > 0) else 1
    day = sc.release_day if (sc.release_day and sc.release_day > 0) else 1
    try:
        return date(sc.release_year, month, day)
    except ValueError:
        return None


def _from_created_at(sc: SCTrackPayload) -> date | None:
    if not sc.created_at:
        return None
    # SC formats vary: ISO-8601, "YYYY/MM/DD HH:MM:SS +0000", etc.
    raw = sc.created_at.replace("/", "-").replace(" +0000", "Z").replace(" ", "T")
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        return None


class ReleaseDateSuggester:
    field: FieldName = "release_date"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        if not ctx.sc_track:
            return []
        primary = _from_release_parts(ctx.sc_track)
        fallback = _from_created_at(ctx.sc_track)
        out = [
            candidate(
                primary.isoformat() if primary else None,
                source="sc_release_date",
                confidence=0.9,
                label="from SoundCloud release date",
            ),
            candidate(
                fallback.isoformat() if fallback else None,
                source="sc_release_date",
                confidence=0.3,
                label="from SoundCloud upload date",
            ),
        ]
        return compact(out)


class ReleaseYearSuggester:
    field: FieldName = "release_year"

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]:
        if not ctx.sc_track:
            return []
        primary = _from_release_parts(ctx.sc_track)
        fallback = _from_created_at(ctx.sc_track)
        out = [
            candidate(
                primary.year if primary else None,
                source="sc_release_date",
                confidence=0.9,
                label="from SoundCloud release year",
            ),
            candidate(
                fallback.year if fallback else None,
                source="sc_release_date",
                confidence=0.3,
                label="from SoundCloud upload year",
            ),
        ]
        return compact(out)
