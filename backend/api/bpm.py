"""BPM persistence endpoints.

Analysis itself happens in the Tauri/Rust layer (see
`desktop/src-tauri/src/bpm/`). This endpoint exists so the frontend can hand
the computed BPM to the backend for storage in the local cache DB — the
single source of truth for track metadata.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from backend.core.services import cache_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bpm", tags=["bpm"])


class LocalBpmPayload(BaseModel):
    """Client-computed BPM for a local audio file."""

    file_path: str = Field(..., description="Absolute path of the local audio file.")
    bpm: float = Field(..., gt=0, description="Detected BPM from the analysis layer.")
    algorithm_version: int = Field(..., ge=1, description="Version tag of the analyzer.")


class LocalBpmResponse(BaseModel):
    file_path: str
    bpm: int
    algorithm_version: int


@router.post("/local", response_model=LocalBpmResponse)
def save_local_bpm(payload: LocalBpmPayload) -> LocalBpmResponse:
    """Persist a BPM value for a local track.

    The cache DB stores BPM as an integer, matching existing metadata-editor
    conventions. Float precision is dropped at write time — if sub-integer
    BPM ever matters, migrate the column first.
    """
    bpm_int = round(payload.bpm)
    if bpm_int <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="BPM rounds to a non-positive integer",
        )
    updated = cache_db.update_track_bpm(Path(payload.file_path), bpm_int)
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No cached track found at {payload.file_path}",
        )
    logger.info("saved bpm=%d for %s (algo v%d)", bpm_int, payload.file_path, payload.algorithm_version)
    return LocalBpmResponse(
        file_path=payload.file_path,
        bpm=bpm_int,
        algorithm_version=payload.algorithm_version,
    )
