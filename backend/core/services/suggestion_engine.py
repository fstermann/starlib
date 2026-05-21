"""Metadata suggestion engine.

Each registered :class:`FieldSuggester` produces zero or more candidates for
one editor field. The orchestrator collects everything, drops candidates equal
to the current value, sorts by confidence (with a deterministic source-priority
tiebreak), and dedupes.

Adding a new field = drop a suggester module under
``backend.core.services.suggesters`` and register it in that package's
``__init__``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from backend.schemas.suggestions import (
    FieldName,
    FieldSuggestion,
    SCTrackPayload,
    SuggestionResponse,
    SuggestionSource,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ParsedFilename:
    """Best-effort decomposition of a local audio file's stem."""

    artist: str | None = None
    title: str | None = None
    remixer: str | None = None
    mix_name: str | None = None


@dataclass(frozen=True)
class ParsedSCTitle:
    """Heuristic parse of an SC track title (delegates to soundcloud_tools)."""

    first_artist: str | None = None
    mix_artist: str | None = None
    mix_name: str | None = None
    is_remix: bool = False


@dataclass
class SuggestionContext:
    """Bundle of inputs handed to every suggester.

    `current` is a plain dict of field → value pulled off the in-flight
    `TrackInfoUpdateRequest`. Suggesters use it for two things: (a) to skip
    proposing a value that already matches what's in the editor, and
    (b) optionally to inform their heuristics (e.g. `is_remix(current.title)`).
    """

    file_path: Path
    filename_parsed: ParsedFilename
    current: dict[str, object]
    sc_track: SCTrackPayload | None
    sc_parsed: ParsedSCTitle | None


# ---------------------------------------------------------------------------
# Suggester protocol
# ---------------------------------------------------------------------------


class FieldSuggester(Protocol):
    """One suggester per field. Field name is declared as a class attribute
    so the registry stays trivial — no decorator dance."""

    field: FieldName

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]: ...


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
    # Local imports break a circular dep: suggesters import the engine for
    # types, and the engine imports them for the registry.
    from backend.core.services.suggesters import REGISTRY

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
# Parsing entrypoints (defined here as thin wrappers so the engine has a
# single import surface; real heuristics live in dedicated modules).
# ---------------------------------------------------------------------------


def _parse_sc_title(title: str) -> ParsedSCTitle:
    from soundcloud_tools.utils.string import (
        get_first_artist,
        get_mix_arist,
        get_mix_name,
        is_remix,
    )

    return ParsedSCTitle(
        first_artist=get_first_artist(title),
        mix_artist=get_mix_arist(title),
        mix_name=get_mix_name(title),
        is_remix=is_remix(title),
    )


def _parse_filename_for_path(path: Path) -> ParsedFilename:
    from backend.core.services.filename_parser import parse_filename

    return parse_filename(path.stem)
