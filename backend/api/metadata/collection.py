"""Collection statistics for the Meta Editor."""

import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from backend.api.deps import get_root_folder
from backend.core.services import collection
from backend.schemas.metadata import CollectionSoundcloudIdsResponse, CollectionStatsResponse
from soundcloud_tools.handler.folder import FolderHandler

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/collection/stats", response_model=CollectionStatsResponse)
def get_collection_stats(
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> CollectionStatsResponse:
    """Get statistics for the entire collection.

    Parameters
    ----------
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    CollectionStatsResponse
        Collection statistics

    Raises
    ------
    HTTPException
        If collection folder doesn't exist
    """
    folder_handler = FolderHandler(folder=root_folder)
    collection_folder = folder_handler.get_collection_folder()

    try:
        stats = collection.get_collection_metadata_stats(collection_folder)
    except Exception as e:
        logger.exception("Failed to get collection stats")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get collection stats",
        ) from e

    return CollectionStatsResponse(
        total_tracks=stats["total_tracks"],
        complete_tracks=stats["complete_tracks"],
        incomplete_tracks=stats["incomplete_tracks"],
        total_artists=stats["total_artists"],
        total_genres=stats["total_genres"],
        missing_fields=stats["missing_fields"],
        genres=stats["genres"],
        artists=stats["artists"],
        keys=stats["keys"],
        bpm_min=stats["bpm_min"],
        bpm_max=stats["bpm_max"],
    )


@router.get("/collection/soundcloud-ids", response_model=CollectionSoundcloudIdsResponse)
def get_collection_soundcloud_ids(
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> CollectionSoundcloudIdsResponse:
    """Return SoundCloud track IDs linked to tracks in the collection folder."""
    folder_handler = FolderHandler(folder=root_folder)
    collection_folder = folder_handler.get_collection_folder()

    try:
        ids = collection.get_collection_soundcloud_ids(collection_folder)
    except Exception as e:
        logger.exception("Failed to get collection SoundCloud IDs")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get collection SoundCloud IDs",
        ) from e

    return CollectionSoundcloudIdsResponse(soundcloud_ids=ids)
