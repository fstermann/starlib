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
from pathlib import Path

from fastapi import APIRouter, HTTPException, status

from backend.infra import cache
from backend.infra.soundcloud import token_cache
from backend.infra.soundcloud.oauth import OAuthManager
from backend.infra.soundcloud.settings import get_settings
from backend.schemas.bpm import (
    BulkBpmRequest,
    BulkBpmResponse,
    ClientTokenResponse,
    LocalBpmPayload,
    LocalBpmResponse,
    LocalCandidatesResponse,
    SoundcloudBpmPayload,
    SoundcloudBpmResponse,
)
from backend.services import app_settings as app_settings_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bpm", tags=["bpm"])


# ---------------------------------------------------------------------------
# Local files
# ---------------------------------------------------------------------------


def _validate_library_folder(folder: str) -> Path:
    """Resolve ``folder`` and ensure it lives under the configured library root.

    Rejects traversal (``..``) and any path outside the user's configured
    ``root_music_folder``.

    Parameters
    ----------
    folder : str
        Caller-supplied absolute or relative folder path.

    Returns
    -------
    Path
        Fully resolved absolute path inside the library root.

    Raises
    ------
    HTTPException
        400 if the path is outside the configured library root or no root is
        configured.
    """
    root_str = app_settings_service.get_root_music_folder()
    if not root_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No library root configured",
        )
    root = Path(root_str).expanduser().resolve()
    candidate = Path(folder).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="folder must be inside the configured library root",
        ) from exc
    return resolved


@router.get("/local/candidates", response_model=LocalCandidatesResponse)
def get_local_candidates(folder: str, recursive: bool = True) -> LocalCandidatesResponse:
    """Return indexed-but-unanalyzed tracks in `folder` for the batch runner.

    Filters to tracks with `bpm IS NULL` in the cache DB. `recursive=True` (default)
    walks subdirectories, matching the library view's usual display scope.
    """
    safe_folder = _validate_library_folder(folder)
    paths = cache.get_tracks_missing_bpm(safe_folder, recursive=recursive)
    return LocalCandidatesResponse(file_paths=paths)


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
    updated = cache.update_track_bpm(Path(payload.file_path), bpm_int)
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


# ---------------------------------------------------------------------------
# SoundCloud tracks
# ---------------------------------------------------------------------------


@router.post("/soundcloud", response_model=SoundcloudBpmResponse)
def save_soundcloud_bpm(payload: SoundcloudBpmPayload) -> SoundcloudBpmResponse:
    """Persist a BPM value for a SoundCloud track."""
    bpm_int = round(payload.bpm)
    if bpm_int <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="BPM rounds to a non-positive integer",
        )
    cache.upsert_sc_bpm(
        track_id=payload.track_id,
        bpm=bpm_int,
        analyzed_at=time.time(),
    )
    logger.info("saved sc bpm=%d for track_id=%s", bpm_int, payload.track_id)
    return SoundcloudBpmResponse(track_id=payload.track_id, bpm=bpm_int)


@router.get("/soundcloud/{track_id}", response_model=SoundcloudBpmResponse | None)
def get_soundcloud_bpm(track_id: int) -> SoundcloudBpmResponse | None:
    """Return the cached BPM for a SoundCloud track, or 404 if not analyzed."""
    row = cache.get_sc_bpm(track_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No cached BPM for this track")
    return SoundcloudBpmResponse(track_id=int(row["track_id"]), bpm=int(row["bpm"]))


@router.post("/soundcloud/bulk", response_model=BulkBpmResponse)
def get_soundcloud_bpms_bulk(payload: BulkBpmRequest) -> BulkBpmResponse:
    """Bulk lookup of cached SoundCloud BPMs by track_id."""
    hits = cache.get_sc_bpms(payload.track_ids)
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
        token = token_cache.get_cached_access_token(settings, OAuthManager)
    except Exception as exc:
        logger.exception("Failed to acquire SoundCloud client-credentials token")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SoundCloud auth unavailable",
        ) from exc
    return ClientTokenResponse(token=token)
