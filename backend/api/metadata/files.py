"""Per-file metadata routes: read, update, batch, readiness, rules, delete."""

import asyncio
import base64
import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from backend.api.deps import get_root_folder, validate_file_path
from backend.api.metadata._helpers import _track_info_to_response_dict
from backend.infra import cache
from backend.schemas.metadata import (
    ApplyRulesRequest,
    ApplyRulesResponse,
    BatchInfoRequest,
    BatchResultItem,
    BatchUpdateRequest,
    BatchUpdateResponse,
    FileReadinessResponse,
    OperationResponse,
    TrackInfoResponse,
    TrackInfoUpdateRequest,
)
from backend.services import metadata
from backend.services.collection import indexing

logger = logging.getLogger(__name__)

router = APIRouter()

# Bound concurrent Apply Rules jobs so a stack of clicks can't spawn
# unbounded ffmpeg conversions in parallel.
_apply_rules_semaphore = asyncio.Semaphore(2)


@router.get("/files/{file_path:path}/info", response_model=TrackInfoResponse)
def get_file_info(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> TrackInfoResponse:
    """Get metadata for a specific audio file.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    TrackInfoResponse
        Complete track metadata

    Raises
    ------
    HTTPException
        If file doesn't exist or can't be read
    """
    resolved_path = validate_file_path(file_path, root_folder)

    try:
        track_info = metadata.get_track_info(resolved_path, root_folder)
    except Exception as e:
        logger.exception("Failed to read track metadata")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to read track metadata"
        ) from e

    readiness = metadata.check_file_readiness(resolved_path, root_folder)

    return TrackInfoResponse(
        file_path=str(resolved_path),
        file_name=resolved_path.name,
        has_artwork=track_info.artwork is not None,
        is_ready=readiness["is_ready"],
        missing_fields=readiness["missing_fields"],
        issues=readiness["issues"],
        **_track_info_to_response_dict(track_info),
    )


@router.post("/files/{file_path:path}/info", response_model=OperationResponse)
def update_file_info(
    file_path: str,
    updates: TrackInfoUpdateRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """Update metadata for a specific audio file.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    updates : TrackInfoUpdateRequest
        Fields to update
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    OperationResponse
        Operation result

    Raises
    ------
    HTTPException
        If file doesn't exist or update fails
    """
    resolved_path = validate_file_path(file_path, root_folder)

    try:
        current_info = metadata.get_track_info(resolved_path, root_folder)
    except Exception as e:
        logger.exception("Failed to read current metadata")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to read current metadata"
        ) from e

    modified_info = metadata.build_modified_track_info(current_info, updates)

    try:
        new_path = metadata.save_track_metadata(resolved_path, root_folder, modified_info)
    except Exception as e:
        logger.exception("Failed to save metadata")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save metadata") from e

    if updates.artwork_data:
        max_artwork_bytes = 10 * 1024 * 1024
        try:
            artwork_bytes = base64.b64decode(updates.artwork_data)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid base64 artwork data.",
            ) from e
        if len(artwork_bytes) > max_artwork_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Artwork data exceeds 10 MB limit.",
            )
        metadata.add_artwork_to_track(new_path, root_folder, artwork_bytes)

    # Targeted cache update: remove old entry and re-index the (possibly renamed) file
    if new_path != resolved_path:
        cache.delete_track(resolved_path)
    indexing.reindex_file(root_folder, new_path)

    return OperationResponse(
        success=True,
        message=f"Metadata updated for {new_path.name}",
        new_file_path=str(new_path),
    )


@router.post("/files/batch-info", response_model=list[TrackInfoResponse])
def batch_get_file_info(
    request: BatchInfoRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> list[TrackInfoResponse]:
    """Get metadata for multiple audio files at once."""
    results: list[TrackInfoResponse] = []
    for fp in request.file_paths:
        resolved_path = validate_file_path(fp, root_folder)
        try:
            track_info = metadata.get_track_info(resolved_path, root_folder)
            readiness = metadata.check_file_readiness(resolved_path, root_folder)
            results.append(
                TrackInfoResponse(
                    file_path=str(resolved_path),
                    file_name=resolved_path.name,
                    has_artwork=track_info.artwork is not None,
                    is_ready=readiness["is_ready"],
                    missing_fields=readiness["missing_fields"],
                    issues=readiness["issues"],
                    **_track_info_to_response_dict(track_info),
                )
            )
        except Exception:
            logger.exception("Failed to read track metadata for %s", fp)
    return results


@router.post("/files/batch-update", response_model=BatchUpdateResponse)
def batch_update_file_info(
    request: BatchUpdateRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> BatchUpdateResponse:
    """Update metadata for multiple audio files at once.

    Partial failures don't block other files.
    """
    results: list[BatchResultItem] = []
    for item in request.items:
        try:
            resolved_path = validate_file_path(item.file_path, root_folder)
            current_info = metadata.get_track_info(resolved_path, root_folder)
            modified_info = metadata.build_modified_track_info(current_info, item.updates)
            new_path = metadata.save_track_metadata(resolved_path, root_folder, modified_info)

            if item.updates.artwork_data:
                artwork_bytes = base64.b64decode(item.updates.artwork_data)
                metadata.add_artwork_to_track(new_path, root_folder, artwork_bytes)

            if new_path != resolved_path:
                cache.delete_track(resolved_path)
            indexing.reindex_file(root_folder, new_path)

            results.append(
                BatchResultItem(
                    file_path=item.file_path,
                    success=True,
                    message=f"Metadata updated for {new_path.name}",
                    new_file_path=str(new_path),
                )
            )
        except Exception as e:
            logger.exception("Failed to update metadata for %s", item.file_path)
            results.append(
                BatchResultItem(
                    file_path=item.file_path,
                    success=False,
                    message=str(e),
                )
            )
    return BatchUpdateResponse(results=results)


@router.get("/files/{file_path:path}/readiness", response_model=FileReadinessResponse)
def check_file_readiness(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FileReadinessResponse:
    """Check if a file is ready for rule application.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    FileReadinessResponse
        Readiness status

    Raises
    ------
    HTTPException
        If file doesn't exist
    """
    resolved_path = validate_file_path(file_path, root_folder)

    try:
        readiness = metadata.check_file_readiness(resolved_path, root_folder)
    except Exception as e:
        logger.exception("Failed to check readiness")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to check readiness: {e}",
        ) from e

    return FileReadinessResponse(
        file_path=str(resolved_path),
        is_ready=readiness["is_ready"],
        missing_fields=readiness["missing_fields"],
        issues=readiness["issues"],
    )


@router.post("/files/{file_path:path}/apply-rules", response_model=ApplyRulesResponse)
async def apply_rules_to_file(
    file_path: str,
    # `request` is currently empty but kept on the signature so the
    # OpenAPI shape stays stable when per-call options are added later.
    request: ApplyRulesRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> ApplyRulesResponse:
    """Apply the active ruleset to a track (convert, copy, move).

    Runs ffmpeg conversion + file moves in asyncio's default executor rather
    than the FastAPI sync-endpoint threadpool, so long jobs do not starve
    other request handlers.  Concurrent jobs are capped via a semaphore.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    request : ApplyRulesRequest
        Per-call options (currently empty; reserved for future use)
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    ApplyRulesResponse
        Result with new file path and per-step outcomes

    Raises
    ------
    HTTPException
        If file is not ready or rule execution fails
    """
    resolved_path = validate_file_path(file_path, root_folder)
    loop = asyncio.get_event_loop()

    try:
        readiness = await loop.run_in_executor(None, metadata.check_file_readiness, resolved_path, root_folder)
    except Exception as e:
        logger.exception("Failed to check readiness")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to check readiness: {e}",
        ) from e

    if not readiness["is_ready"]:
        missing_fields = readiness["missing_fields"]
        if isinstance(missing_fields, list):
            missing_str = ", ".join(missing_fields)
        else:
            missing_str = str(missing_fields)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File not ready for rule application. Missing: {missing_str}",
        )

    try:
        async with _apply_rules_semaphore:
            result = await loop.run_in_executor(
                None,
                metadata.apply_rules,
                resolved_path,
                root_folder,
            )
    except Exception as e:
        logger.exception("Apply rules failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Apply rules failed: {e}",
        ) from e

    # Remove the old file from cache (it's been moved/converted)
    cache.delete_track(resolved_path)

    return ApplyRulesResponse(
        success=result["success"],
        message=result["message"],
        new_file_path=result["output_path"],
        steps=result.get("steps", []),
    )


@router.delete("/files/{file_path:path}", response_model=OperationResponse)
def delete_file(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """Delete an audio file.

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
        If file doesn't exist or deletion fails
    """
    resolved_path = validate_file_path(file_path, root_folder)

    try:
        metadata.delete_track_file(resolved_path, root_folder)
    except Exception as e:
        logger.exception("Failed to delete file")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to delete file") from e

    cache.delete_track(resolved_path)

    return OperationResponse(
        success=True,
        message=f"File deleted: {resolved_path.name}",
    )
