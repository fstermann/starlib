"""BPM persistence endpoints.

Analysis itself happens in the Tauri/Rust layer (see
``desktop/src-tauri/src/bpm/``). These endpoints exist so the frontend can
hand the computed BPM to the backend for storage in the local cache DB, and
— for SoundCloud tracks — read cached BPMs back in bulk when rendering the
library table.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from backend.core.services import cache_db
from soundcloud_tools.oauth import OAuthManager
from soundcloud_tools.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bpm", tags=["bpm"])


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


@router.post("/soundcloud", response_model=SoundcloudBpmResponse)
def save_soundcloud_bpm(payload: SoundcloudBpmPayload) -> SoundcloudBpmResponse:
    """Persist a BPM value for a SoundCloud track."""
    bpm_int = round(payload.bpm)
    if bpm_int <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="BPM rounds to a non-positive integer",
        )
    cache_db.upsert_sc_bpm(
        track_id=payload.track_id,
        bpm=bpm_int,
        analyzed_at=time.time(),
    )
    logger.info("saved sc bpm=%d for track_id=%s", bpm_int, payload.track_id)
    return SoundcloudBpmResponse(track_id=payload.track_id, bpm=bpm_int)


@router.get("/soundcloud/{track_id}", response_model=SoundcloudBpmResponse | None)
def get_soundcloud_bpm(track_id: int) -> SoundcloudBpmResponse | None:
    """Return the cached BPM for a SoundCloud track, or 404 if not analyzed."""
    row = cache_db.get_sc_bpm(track_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No cached BPM for this track")
    return SoundcloudBpmResponse(track_id=int(row["track_id"]), bpm=int(row["bpm"]))


class BulkBpmRequest(BaseModel):
    track_ids: list[int] = Field(default_factory=list)


class BulkBpmResponse(BaseModel):
    bpms: dict[str, int]  # string keys for JSON friendliness


@router.post("/soundcloud/bulk", response_model=BulkBpmResponse)
def get_soundcloud_bpms_bulk(payload: BulkBpmRequest) -> BulkBpmResponse:
    """Bulk lookup of cached SoundCloud BPMs by track_id."""
    hits = cache_db.get_sc_bpms(payload.track_ids)
    return BulkBpmResponse(bpms={str(k): v for k, v in hits.items()})


@router.get("/soundcloud-client-token", response_model=ClientTokenResponse)
def get_soundcloud_client_token() -> ClientTokenResponse:
    """Return a valid Client-Credentials OAuth token for the public API.

    Used by the Rust BPM pipeline to authenticate /tracks/{id}/streams
    requests. Refreshes transparently via OAuthManager.
    """
    settings = get_settings()
    if not settings.has_oauth_credentials():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SoundCloud OAuth credentials not configured",
        )
    try:
        token = OAuthManager(settings.client_id, settings.client_secret).get_access_token()
    except Exception as exc:
        logger.exception("Failed to acquire SoundCloud client-credentials token")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"SoundCloud auth error: {exc}",
        ) from exc
    return ClientTokenResponse(token=token)
