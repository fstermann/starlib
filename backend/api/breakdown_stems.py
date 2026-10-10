"""HTTP routes for setting up stem separation (Demucs) from the app."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from backend.services.breakdown import stem_setup

router = APIRouter(prefix="/api/breakdown/stem-separation", tags=["breakdown"])


class StemSetupResponse(BaseModel):
    """Setup state: ``missing``, ``installing``, ``ready`` or ``error``."""

    status: str
    stage: str | None
    error: str | None
    size_bytes: int


def _response(state: stem_setup.SetupState) -> StemSetupResponse:
    return StemSetupResponse(**state.__dict__)


@router.get("", response_model=StemSetupResponse)
async def get_setup() -> StemSetupResponse:
    """Return whether stem separation is installed."""
    return _response(stem_setup.state())


@router.post("/install", response_model=StemSetupResponse)
async def install() -> StemSetupResponse:
    """Download and set up Demucs in the background (about 830 MB)."""
    return _response(stem_setup.start_install())


@router.delete("", response_model=StemSetupResponse)
async def remove() -> StemSetupResponse:
    """Delete the Demucs install to free its disk space."""
    try:
        return _response(stem_setup.remove())
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
