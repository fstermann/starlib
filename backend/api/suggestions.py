"""Metadata suggestion endpoint.

Given a local track and (optionally) a linked SoundCloud track, return ranked
candidate values for every editor field. The endpoint is read-only — accepting
a suggestion is a separate, normal metadata update on the client side.

The actual ranking lives in :mod:`backend.core.services.suggestion_engine`;
this router is just the HTTP shell.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from backend.api.deps import get_root_folder, validate_file_path
from backend.core.services import suggestion_engine
from backend.schemas.suggestions import SuggestionRequest, SuggestionResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/suggestions", tags=["suggestions"])


@router.post("/track", response_model=SuggestionResponse)
def suggest_track_metadata(
    request: SuggestionRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> SuggestionResponse:
    """Compute ranked metadata suggestions for a single local track."""
    resolved_path = validate_file_path(request.file_path, root_folder)
    try:
        return suggestion_engine.compute_suggestions(
            file_path=resolved_path,
            sc_track=request.sc_track,
            current=request.current,
        )
    except Exception as exc:
        logger.exception("Failed to compute suggestions for %s", resolved_path)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to compute suggestions",
        ) from exc
