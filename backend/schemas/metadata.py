"""
Pydantic schemas for metadata operations (Meta Editor).

Request and response models for all metadata-related API endpoints.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

# ============================================================================
# Request Schemas
# ============================================================================


class TrackInfoUpdateRequest(BaseModel):
    """Request to update track metadata."""

    title: str | None = None
    artist: str | None = None
    bpm: int | None = None
    key: str | None = None
    genre: str | None = None
    comment: str | None = None
    release_date: date | None = None
    remixers: list[str] | None = None
    artwork_data: str | None = None  # base64-encoded image bytes


class RemixInfo(BaseModel):
    """Remix information."""

    remixer: str
    original_artist: str
    mix_name: str | None = None


class CommentInfo(BaseModel):
    """Comment information."""

    version: str | None = None
    soundcloud_id: int | None = None
    soundcloud_permalink: str | None = None


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


# ============================================================================
# Response Schemas
# ============================================================================


class TrackInfoResponse(BaseModel):
    """Response containing track metadata."""

    file_path: str
    file_name: str
    title: str | None = None
    artist: str | None = None
    bpm: int | None = None
    key: str | None = None
    genre: str | None = None
    comment: str | None = None
    release_date: date | None = None
    remixers: list[str] | None = None
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


class FinalizeResponse(BaseModel):
    """Response from finalization operation."""

    success: bool
    message: str
    new_file_path: str


class OperationResponse(BaseModel):
    """Generic operation success/failure response."""

    success: bool
    message: str
    new_file_path: str | None = None


class CollectionStatsResponse(BaseModel):
    """Response containing collection statistics."""

    total_tracks: int
    complete_tracks: int
    incomplete_tracks: int
    total_artists: int
    total_genres: int
    missing_fields: dict[str, int]


class ArtworkResponse(BaseModel):
    """Response containing artwork data."""

    has_artwork: bool
    artwork_path: str | None = None


class RenameResponse(BaseModel):
    """Response from rename operation."""

    success: bool
    old_path: str
    new_path: str
    message: str
