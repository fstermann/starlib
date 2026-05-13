"""Pydantic schemas for the metadata suggestion engine."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from backend.schemas.metadata import TrackInfoUpdateRequest

FieldName = Literal[
    "title",
    "artist",
    "genre",
    "bpm",
    "key",
    "original_artist",
    "remixer",
    "mix_name",
    "release_date",
    "release_year",
    "user_comment",
    "artwork_url",
]

SuggestionSource = Literal[
    "sc_title",
    "sc_metadata_artist",
    "sc_uploader",
    "sc_genre",
    "sc_release_date",
    "sc_artwork_url",
    "sc_bpm",
    "sc_key",
    "sc_tag",
    "filename_parse",
    "tag_existing",
    "derived",
    "list_normalized",
    "list_aggregated",
]


class SCUserPayload(BaseModel):
    """Loose subset of the SC user object used during suggestion."""

    model_config = ConfigDict(extra="ignore")

    username: str | None = None


class SCTrackPayload(BaseModel):
    """Loose subset of the SoundCloud OpenAPI track shape used by the engine.

    The frontend sends the raw `SCTrack` (the OpenAPI generated type); we only
    pull the fields suggesters need and ignore the rest. Adding a new
    suggestion source means: add the field here + add a suggester.
    """

    model_config = ConfigDict(extra="ignore")

    title: str | None = None
    metadata_artist: str | None = None
    genre: str | None = None
    bpm: float | None = None
    key_signature: str | None = None
    tag_list: str | None = None
    label_name: str | None = None
    description: str | None = None
    artwork_url: str | None = None
    permalink_url: str | None = None
    urn: str | None = None
    release_year: int | None = None
    release_month: int | None = None
    release_day: int | None = None
    created_at: str | None = None
    user: SCUserPayload | None = None


class SuggestionRequest(BaseModel):
    """Request body for the suggestion endpoint.

    Parameters
    ----------
    file_path:
        Absolute or root-relative path of the local track being edited. The
        server uses it for filename parsing and (in the future) reading
        existing on-disk tags as a suggestion source.
    sc_track:
        Optional SoundCloud track payload. When ``None``, only filename- and
        tag-based suggestions are produced.
    current:
        In-flight editor state. Suggestions equal to a current value are
        suppressed so the UI never proposes a no-op.
    """

    file_path: str
    sc_track: SCTrackPayload | None = None
    current: TrackInfoUpdateRequest = Field(default_factory=TrackInfoUpdateRequest)


class FieldSuggestion(BaseModel):
    """A single ranked candidate value for one editor field."""

    value: Any
    source: SuggestionSource
    confidence: float = Field(ge=0.0, le=1.0)
    label: str


class SuggestionResponse(BaseModel):
    """Map of field name → ranked candidates (top first)."""

    fields: dict[str, list[FieldSuggestion]] = Field(default_factory=dict)
