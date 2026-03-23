"""Rekordbox waveform API routes.

FastAPI endpoints for reading Rekordbox ANLZ analysis files:
- GET /api/rekordbox/waveform — colour-detail waveform + beat grid
"""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from backend.api.deps import get_root_folder, validate_file_path
from backend.core.services.rekordbox import get_waveform
from backend.schemas.rekordbox import RekordboxWaveformResponse

router = APIRouter(prefix="/api/rekordbox", tags=["rekordbox"])


@router.get("/waveform", response_model=RekordboxWaveformResponse)
def get_rekordbox_waveform(
    file_path: Annotated[str, Query(description="Path to the audio file (relative to root folder or absolute)")],
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> RekordboxWaveformResponse:
    """Return PWV5 colour-detail waveform and PQTZ beat grid.

    Looks up the ANLZ path via the Rekordbox 6 database, parses the
    ``.EXT`` file for PWV5 and ``.DAT`` for PQTZ.
    """
    try:
        path = validate_file_path(file_path, root_folder)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid file path: {exc}",
        ) from exc

    result = get_waveform(path)
    return RekordboxWaveformResponse(**result)
