"""
Beat analysis API routes.

FastAPI endpoints for rhythm/beat detection:
- POST /api/beats/analyze — run Essentia beat analysis on a local audio file
"""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from backend.api.deps import get_root_folder, validate_file_path
from backend.core.services.beats import analyze_beats
from backend.schemas.beats import BeatAnalysisRequest, BeatAnalysisResponse

router = APIRouter(prefix="/api/beats", tags=["beats"])


@router.post("/analyze", response_model=BeatAnalysisResponse)
def analyze_track_beats(
    request: BeatAnalysisRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> BeatAnalysisResponse:
    """
    Analyse beat positions and BPM for an audio file.

    Results are cached in ``.cache/analysis.db`` so repeated calls are fast.

    Parameters
    ----------
    request : BeatAnalysisRequest
        ``file_path`` relative to the root music folder.
    root_folder : Path
        Root music folder (injected).

    Returns
    -------
    BeatAnalysisResponse
        bpm, beats (seconds), downbeats (every 4th beat in seconds).
    """
    path = validate_file_path(request.file_path, root_folder)

    try:
        result = analyze_beats(path)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Beat analysis failed: {exc}",
        ) from exc

    return BeatAnalysisResponse(**result)
