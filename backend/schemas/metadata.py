"""
Pydantic schemas for metadata operations (Meta Editor).

Request and response models for all metadata-related API endpoints.

The flat tag fields are declared once on `_TagFieldsMixin` and reused by every
schema below so that adding a new tag means: registry entry in track.py,
field on `TrackInfo`, and one line on the mixin (and a DB column).  A
parity test (`test_schemas_include_every_registry_field`) catches drift.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

# ============================================================================
# Tag-field mixin (mirrors SIMPLE_TAG_FIELDS in soundcloud_tools.handler.track)
# ============================================================================


class _TagFieldsMixin(BaseModel):
    """Flat optional fields mirroring SIMPLE_TAG_FIELDS at the API boundary."""

    title: str | None = None
    artist: str | list[str] | None = None
    genre: str | None = None
    bpm: int | None = None
    key: str | None = None
    original_artist: str | list[str] | None = None
    remixer: str | list[str] | None = None
    mix_name: str | None = None
    release_date: date | None = None
    release_year: int | None = None
    user_comment: str | None = None
    starlib_meta: str | None = None  # serialised "key=value; ..." form


# ============================================================================
# Request Schemas
# ============================================================================


class TrackInfoUpdateRequest(_TagFieldsMixin):
    """Request to update track metadata. All fields optional."""

    artwork_data: str | None = None  # base64-encoded image bytes


class ApplyRulesRequest(BaseModel):
    """Request to apply the active ruleset to a track.

    No body fields are currently required — the ruleset to run is resolved
    server-side from the file's folder bindings.  The model exists so that
    future per-call options (e.g. an explicit ruleset id override) have a
    place to land without changing the endpoint shape.
    """


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


class TrackInfoResponse(_TagFieldsMixin):
    """Response containing track metadata. Tag fields are flat per the registry."""

    file_path: str
    file_name: str
    has_artwork: bool
    is_ready: bool
    missing_fields: list[str] = []
    issues: list[str] = []


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
    """Response indicating if file is ready for rule application."""

    file_path: str
    is_ready: bool
    missing_fields: list[str]
    issues: list[str]


class ApplyRulesStep(BaseModel):
    """A single rule execution result."""

    id: str
    type: str
    status: str  # "done" or "skipped"
    message: str


class ApplyRulesResponse(BaseModel):
    """Response from applying a ruleset to a track."""

    success: bool
    message: str
    new_file_path: str
    steps: list[ApplyRulesStep] = []


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


class TrackBrowseResponse(_TagFieldsMixin):
    """Lightweight response for collection browse/table view."""

    file_path: str
    file_name: str
    folder: str | None = None
    soundcloud_id: int | None = None
    has_artwork: bool = False
    file_format: str
    file_size: int
    duration: float | None = None
    mtime: float | None = None


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
    file_formats: list[str] = []
    file_format_counts: dict[str, int] = {}
    file_size_min: int | None = None
    file_size_max: int | None = None


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


class FetchFromDownloadsRequest(BaseModel):
    """Request to move recent audio files from ~/Downloads into a folder."""

    dest_path: str
    window_days: int = Field(1, ge=1, le=365)
    # When provided, only files whose names appear here are moved. None = move
    # every eligible candidate (back-compat with one-shot callers).
    file_names: list[str] | None = None


class FetchCandidate(BaseModel):
    """One candidate audio file under ~/Downloads for the preview dialog."""

    name: str
    size: int
    mtime: float


class FetchFromDownloadsPreview(BaseModel):
    """Preview of what a Fetch-from-Downloads call would do."""

    candidates: list[FetchCandidate] = []
    skipped: list[str] = []


class FetchFromDownloadsResponse(BaseModel):
    """Result of a Fetch-from-Downloads operation."""

    moved: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []
