"""Metadata suggestion engine.

Each registered :class:`FieldSuggester` produces zero or more candidates for
one editor field. The orchestrator collects everything, drops candidates equal
to the current value, sorts by confidence (with a deterministic source-priority
tiebreak), and dedupes.

Adding a new field = drop a suggester module under
``backend.domain.suggestions.suggesters`` and register it in
``backend.domain.suggestions.registry``.
"""

from __future__ import annotations

import logging
from pathlib import Path

from backend.domain.filenames import parse_filename
from backend.domain.suggestions.registry import REGISTRY
from backend.domain.suggestions.types import (
    ParsedFilename,
    ParsedSCTitle,
    SuggestionContext,
)
from backend.domain.titles import get_first_artist, get_mix_arist, get_mix_name, is_remix
from backend.schemas.suggestions import (
    FieldSuggestion,
    SCTrackPayload,
    SuggestionResponse,
    SuggestionSource,
)

logger = logging.getLogger(__name__)


# Source-priority tiebreak. Lower value wins when confidences are equal.
_SOURCE_PRIORITY: dict[SuggestionSource, int] = {
    "sc_metadata_artist": 0,
    "sc_title": 0,
    "sc_genre": 0,
    "sc_release_date": 0,
    "sc_artwork_url": 0,
    "sc_bpm": 0,
    "sc_key": 0,
    "sc_uploader": 1,
    "sc_tag": 2,
    "derived": 3,
    "list_normalized": 3,
    "list_aggregated": 4,
    "filename_parse": 5,
    "tag_existing": 6,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_for_compare(value: object) -> object:
    """Loose comparator so trailing whitespace etc. doesn't prevent dedup."""
    if isinstance(value, str):
        return value.strip().casefold()
    return value


def _dedupe_sorted(suggestions: list[FieldSuggestion]) -> list[FieldSuggestion]:
    """Drop duplicate values, keeping the first (highest-ranked)."""
    seen: set[object] = set()
    out: list[FieldSuggestion] = []
    for s in suggestions:
        key = _normalize_for_compare(s.value)
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def _sort_key(s: FieldSuggestion) -> tuple[float, int]:
    """Primary: -confidence (higher first). Secondary: source priority asc."""
    return (-s.confidence, _SOURCE_PRIORITY.get(s.source, 99))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_suggestions(
    *,
    file_path: Path,
    sc_track: SCTrackPayload | None,
    current,
) -> SuggestionResponse:
    """Run every registered suggester and return a ranked map.

    `current` may be a `TrackInfoUpdateRequest` or any object exposing
    `.model_dump()` — we coerce to a plain dict so suggesters don't need to
    know about pydantic.
    """
    current_dict = current.model_dump(exclude_none=False) if hasattr(current, "model_dump") else dict(current or {})

    sc_parsed = _parse_sc_title(sc_track.title) if sc_track and sc_track.title else None
    filename_parsed = _parse_filename_for_path(file_path)

    ctx = SuggestionContext(
        file_path=file_path,
        filename_parsed=filename_parsed,
        current=current_dict,
        sc_track=sc_track,
        sc_parsed=sc_parsed,
    )

    fields: dict[str, list[FieldSuggestion]] = {}
    for suggester in REGISTRY:
        try:
            raw = suggester.suggest(ctx)
        except Exception:
            logger.exception("Suggester %s failed; skipping", suggester.__class__.__name__)
            continue

        current_value = current_dict.get(suggester.field)
        current_norm = _normalize_for_compare(current_value)
        filtered = [s for s in raw if _normalize_for_compare(s.value) != current_norm]

        if not filtered:
            continue

        filtered.sort(key=_sort_key)
        fields[suggester.field] = _dedupe_sorted(filtered)

    return SuggestionResponse(fields=fields)


# ---------------------------------------------------------------------------
# Parsing entrypoints — thin wrappers; the heuristics live in
# backend.domain.titles and backend.domain.filenames.
# ---------------------------------------------------------------------------


def _parse_sc_title(title: str) -> ParsedSCTitle:
    return ParsedSCTitle(
        first_artist=get_first_artist(title),
        mix_artist=get_mix_arist(title),
        mix_name=get_mix_name(title),
        is_remix=is_remix(title),
    )


def _parse_filename_for_path(path: Path) -> ParsedFilename:
    return parse_filename(path.stem)
