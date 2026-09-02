"""Request/response models for the BPM endpoints."""

from __future__ import annotations

from pydantic import BaseModel, Field


class LocalBpmPayload(BaseModel):
    """Client-computed BPM for a local audio file."""

    file_path: str = Field(..., description="Absolute path of the local audio file.")
    bpm: float = Field(..., gt=0, description="Detected BPM from the analysis layer.")
    algorithm_version: int = Field(..., ge=1, description="Version tag of the analyzer.")


class LocalBpmResponse(BaseModel):
    file_path: str
    bpm: int
    algorithm_version: int


class LocalCandidatesResponse(BaseModel):
    """Absolute file paths of indexed tracks without a cached BPM."""

    file_paths: list[str]


class SoundcloudBpmPayload(BaseModel):
    """Client-computed BPM for a SoundCloud track."""

    track_id: int = Field(..., gt=0)
    bpm: float = Field(..., gt=0)


class SoundcloudBpmResponse(BaseModel):
    track_id: int
    bpm: int


class ClientTokenResponse(BaseModel):
    """Client-Credentials OAuth token for Rust-side API calls."""

    token: str


class BulkBpmRequest(BaseModel):
    track_ids: list[int] = Field(default_factory=list)


class BulkBpmResponse(BaseModel):
    bpms: dict[str, int]  # string keys for JSON friendliness
