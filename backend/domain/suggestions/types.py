"""Inputs and the suggester contract.

Kept separate from :mod:`backend.domain.suggestions.engine` so the dependency
runs one way: suggesters import these types, the registry imports the
suggesters, and the engine imports the registry. Previously the protocol lived
on the engine, which forced the engine to import its own registry lazily.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from backend.schemas.suggestions import FieldName, FieldSuggestion, SCTrackPayload


@dataclass(frozen=True)
class ParsedFilename:
    """Best-effort decomposition of a local audio file's stem."""

    artist: str | None = None
    title: str | None = None
    remixer: str | None = None
    mix_name: str | None = None


@dataclass(frozen=True)
class ParsedSCTitle:
    """Heuristic parse of an SC track title (delegates to backend.domain.titles)."""

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


class FieldSuggester(Protocol):
    """One suggester per field. Field name is declared as a class attribute
    so the registry stays trivial — no decorator dance."""

    field: FieldName

    def suggest(self, ctx: SuggestionContext) -> list[FieldSuggestion]: ...
