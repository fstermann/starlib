"""
Pydantic schemas for metadata operations (Meta Editor).

Request and response models for all metadata-related API endpoints.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, create_model

from soundcloud_tools.handler.track import SIMPLE_TAG_FIELDS, TrackInfo

# ============================================================================
# Registry-driven field map
# ============================================================================
#
# Every field in SIMPLE_TAG_FIELDS becomes an optional column on the request
# and response schemas.  Adding a tag to the registry automatically flows
# through to the API surface — no per-field edits needed here.
#
# starlib_meta is the one structured value we serialise as a string at the API
# boundary (the on-disk format is "key=value; key=value"), so we override its
# annotation to `str | None` rather than the StarlibMeta object.

_SCALAR_OVERRIDES: dict[str, type] = {"starlib_meta": str | None}


def _tag_fields() -> dict[str, tuple[type, object]]:
    fields: dict[str, tuple[type, object]] = {}
    for f in SIMPLE_TAG_FIELDS:
        annotation = _SCALAR_OVERRIDES.get(
            f.name, TrackInfo.model_fields[f.name].annotation | None
        )
        fields[f.name] = (annotation, None)
    return fields


_TAG_FIELDS = _tag_fields()


# ============================================================================
# Request Schemas
# ============================================================================


TrackInfoUpdateRequest = create_model(
    "TrackInfoUpdateRequest",
    **_TAG_FIELDS,
    artwork_data=(str | None, None),  # base64-encoded image bytes
    __doc__="Request to update track metadata. All fields optional.",
)


class FinalizeRequest(BaseModel):
    """Request to finalize a track (convert and move)."""

    target_format: Literal["mp3", "aiff"] = Field(default="aiff", description="Target audio format")
    quality: int = Field(default=320, description="Quality for MP3 (kbps)")
    collection_folder: str | None = Field(None, description="Target collection folder (optional)")


class CollectionFilterRequest(BaseModel):
    """Request to filter tracks in collection."""

    genres: list[str] | None = None
    artists: list[str] | None = None
    keys: list[str] | None = None
    bpm_values: list[int] | None = None
    bpm_range: tuple[int, int] | None = None
    start_date: date | None = None
    end_date: date | None = None
    search_query: str | None = None


class MoveFilesRequest(BaseModel):
    """Request to move files between folders."""

    target_mode: Literal["prepare", "collection", "cleaned"] = Field(..., description="Target folder mode")
    file_indices: list[int] | None = Field(None, description="Indices of files to move (None = all)")


class BatchInfoRequest(BaseModel):
    """Request to get metadata for multiple files at once."""

    file_paths: list[str]


class BatchUpdateItem(BaseModel):
    """A single file update within a batch."""

    file_path: str
    updates: TrackInfoUpdateRequest


class BatchUpdateRequest(BaseModel):
    """Request to update metadata for multiple files at once."""

    items: list[BatchUpdateItem]


# ============================================================================
# Response Schemas
# ============================================================================


TrackInfoResponse = create_model(
    "TrackInfoResponse",
    file_path=(str, ...),
    file_name=(str, ...),
    has_artwork=(bool, ...),
    is_ready=(bool, ...),
    missing_fields=(list[str], []),
    issues=(list[str], []),
    **_TAG_FIELDS,
    __doc__="Response containing track metadata. Tag fields are flat per the registry.",
)


class FileInfoResponse(BaseModel):
    """Response containing basic file information."""

    file_path: str
    file_name: str
    file_size: int
    file_format: str
    has_artwork: bool = False


class FolderListResponse(BaseModel):
    """Response containing list of files in folder."""

    folder_path: str
    folder_mode: str
    total_files: int
    total_size_mb: float
    files: list[FileInfoResponse]


class FileReadinessResponse(BaseModel):
    """Response indicating if file is ready for finalization."""

    file_path: str
    is_ready: bool
    missing_fields: list[str]
    issues: list[str]


class FinalizeStep(BaseModel):
    """A single rule execution result."""

    id: str
    type: str
    status: str  # "done" or "skipped"
    message: str


class FinalizeResponse(BaseModel):
    """Response from finalization operation."""

    success: bool
    message: str
    new_file_path: str
    steps: list[FinalizeStep] = []


class OperationResponse(BaseModel):
    """Generic operation success/failure response."""

    success: bool
    message: str
    new_file_path: str | None = None


class BatchResultItem(BaseModel):
    """Result of a single file update within a batch."""

    file_path: str
    success: bool
    message: str
    new_file_path: str | None = None


class BatchUpdateResponse(BaseModel):
    """Response from a batch update operation."""

    results: list[BatchResultItem]


TrackBrowseResponse = create_model(
    "TrackBrowseResponse",
    file_path=(str, ...),
    file_name=(str, ...),
    soundcloud_id=(int | None, None),
    has_artwork=(bool, False),
    file_format=(str, ...),
    file_size=(int, ...),
    duration=(float | None, None),
    mtime=(float | None, None),
    **_TAG_FIELDS,
    __doc__="Lightweight response for collection browse/table view.",
)


class PeaksResponse(BaseModel):
    """Waveform amplitude peak data for visualization."""

    peaks: list[float]


class FilterValuesResponse(BaseModel):
    """Available filter values for a folder (for filter dropdowns)."""

    genres: list[str] = []
    genre_counts: dict[str, int] = {}
    artists: list[str] = []
    keys: list[str] = []
    key_counts: dict[str, int] = {}
    bpm_min: int | None = None
    bpm_max: int | None = None


class CollectionStatsResponse(BaseModel):
    """Response containing collection statistics."""

    total_tracks: int
    complete_tracks: int
    incomplete_tracks: int
    total_artists: int
    total_genres: int
    missing_fields: dict[str, int]
    genres: list[str] = []
    artists: list[str] = []
    keys: list[str] = []
    bpm_min: int | None = None
    bpm_max: int | None = None


class ArtworkResponse(BaseModel):
    """Response containing artwork data."""

    has_artwork: bool
    artwork_path: str | None = None


class CollectionSoundcloudIdsResponse(BaseModel):
    """SoundCloud track IDs linked to collection tracks."""

    soundcloud_ids: list[int]


class RenameResponse(BaseModel):
    """Response from rename operation."""

    success: bool
    old_path: str
    new_path: str
    message: str
