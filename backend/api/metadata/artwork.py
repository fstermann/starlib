"""Artwork operations for the Meta Editor."""

import asyncio
import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from backend.api.deps import get_root_folder, validate_file_path
from backend.config import get_backend_settings
from backend.core.services import collection, metadata
from backend.schemas.metadata import OperationResponse

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/files/{file_path:path}/artwork")
async def get_file_artwork(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FileResponse:
    """Get artwork image for an audio file.

    Artwork is extracted once and cached to ``<cache_dir>/artwork/``.  Fast
    path returns the cached file without re-reading the audio file.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    FileResponse
        Artwork image (JPEG or PNG)

    Raises
    ------
    HTTPException
        If file doesn't exist or has no artwork
    """
    resolved_path = validate_file_path(file_path, root_folder)
    settings = get_backend_settings()

    try:
        loop = asyncio.get_event_loop()
        artwork_path = await loop.run_in_executor(
            None, metadata.extract_artwork, resolved_path, root_folder, settings.cache_dir
        )
    except Exception as e:
        logger.exception("Failed to extract artwork")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to extract artwork",
        ) from e

    if not artwork_path or not artwork_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No artwork found for this file")

    return FileResponse(
        path=artwork_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.post("/files/{file_path:path}/artwork", response_model=OperationResponse)
async def update_file_artwork(
    file_path: str,
    file: UploadFile,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """Update artwork for an audio file by uploading an image.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    file : UploadFile
        Uploaded artwork image file
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    OperationResponse
        Operation result

    Raises
    ------
    HTTPException
        If file doesn't exist or upload fails
    """
    resolved_path = validate_file_path(file_path, root_folder)

    try:
        artwork_data = await file.read()
        if not artwork_data:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No image data received")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to read uploaded file")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read uploaded file",
        ) from e

    try:
        metadata.add_artwork_to_track(resolved_path, root_folder, artwork_data)
    except Exception as e:
        logger.exception("Failed to embed artwork")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to embed artwork",
        ) from e

    collection.invalidate_cache()

    return OperationResponse(
        success=True,
        message=f"Artwork updated for {resolved_path.name}",
    )


@router.delete("/files/{file_path:path}/artwork", response_model=OperationResponse)
def delete_file_artwork(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """Remove artwork from an audio file.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    OperationResponse
        Operation result

    Raises
    ------
    HTTPException
        If file doesn't exist or removal fails
    """
    resolved_path = validate_file_path(file_path, root_folder)

    try:
        metadata.remove_artwork(resolved_path, root_folder)
    except Exception as e:
        logger.exception("Failed to remove artwork")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to remove artwork",
        ) from e

    collection.invalidate_cache()

    return OperationResponse(
        success=True,
        message=f"Artwork removed from {resolved_path.name}",
    )
