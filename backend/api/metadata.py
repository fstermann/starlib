"""
Meta Editor API routes.

FastAPI endpoints for metadata editing operations:
- File listing and folder operations
- Track metadata read/update
- SoundCloud search and track fetching
- File finalization (conversion and moving)
- Artwork management
"""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse

from backend.api.deps import (
    get_root_folder,
    get_soundcloud_client,
    validate_file_path,
    validate_folder_mode,
)
from backend.core.services import collection, metadata, soundcloud
from backend.schemas.metadata import (
    ArtworkResponse,
    AutoActionRequest,
    AutoActionResponse,
    CollectionStatsResponse,
    FileInfoResponse,
    FileReadinessResponse,
    FinalizeRequest,
    FinalizeResponse,
    FolderListResponse,
    MoveFilesRequest,
    OperationResponse,
    SoundCloudSearchRequest,
    SoundCloudSearchResponse,
    SoundCloudTrackResponse,
    TrackInfoRequest,
    TrackInfoResponse,
    TrackInfoUpdateRequest,
)
from soundcloud_tools.client import Client
from soundcloud_tools.handler.folder import FolderHandler

router = APIRouter(prefix="/api/metadata", tags=["metadata"])


# ==================== File and Folder Operations ====================


@router.get("/folders/{mode}/files", response_model=FolderListResponse)
def list_folder_files(
    mode: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FolderListResponse:
    """
    List all audio files in a specific folder.

    Parameters
    ----------
    mode : str
        Folder mode: "prepare", "collection", "cleaned", or ""
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    FolderListResponse
        List of audio files with basic info

    Raises
    ------
    HTTPException
        If folder doesn't exist or is invalid
    """
    validated_mode = validate_folder_mode(mode)

    # Get folder for this mode
    folder_handler = FolderHandler(folder=root_folder)

    if validated_mode == "prepare":
        folder_path = folder_handler.get_prepare_folder()
    elif validated_mode == "collection":
        folder_path = folder_handler.get_collection_folder()
    elif validated_mode == "cleaned":
        folder_path = folder_handler.get_cleaned_folder()
    else:
        folder_path = root_folder

    # Validate folder exists
    is_valid, errors = collection.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=errors,  # Return first error
        )

    # List files
    files = collection.list_audio_files(folder_path)

    # Convert to response format
    file_infos = [
        FileInfoResponse(
            file_path=str(f),
            file_name=f.name,
            file_size=f.stat().st_size,
            file_format=f.suffix,
        )
        for f in files
    ]

    return FolderListResponse(
        folder_path=str(folder_path),
        folder_mode=validated_mode,
        total_files=len(files),
        total_size_mb=sum(f.file_size for f in file_infos) / (1024 * 1024),
        files=file_infos,
    )


@router.get("/files/{file_path:path}/info", response_model=TrackInfoResponse)
def get_file_info(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> TrackInfoResponse:
    """
    Get metadata for a specific audio file.

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
    # Validate and resolve path
    resolved_path = validate_file_path(file_path, root_folder)

    # Get track info
    try:
        track_info = metadata.get_track_info(resolved_path, root_folder)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to read track metadata: {str(e)}"
        )

    # Check file readiness
    readiness = metadata.check_file_readiness(resolved_path, root_folder)

    return TrackInfoResponse(
        file_path=str(resolved_path),
        file_name=resolved_path.name,
        title=track_info.title,
        artist=track_info.artist_str,
        bpm=track_info.bpm,
        key=track_info.key,
        genre=track_info.genre,
        comment=track_info.comment.to_str() if track_info.comment else None,
        release_date=track_info.release_date,
        remixers=[track_info.remix.remixer_str] if track_info.remix else None,
        has_artwork=track_info.artwork is not None,
        is_ready=readiness["is_ready"],
        missing_fields=readiness["missing_fields"],
        issues=readiness["issues"],
    )


@router.post("/files/{file_path:path}/info", response_model=OperationResponse)
def update_file_info(
    file_path: str,
    updates: TrackInfoUpdateRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """
    Update metadata for a specific audio file.

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
    # Validate and resolve path
    resolved_path = validate_file_path(file_path, root_folder)

    # Get current track info
    try:
        current_info = metadata.get_track_info(resolved_path, root_folder)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to read current metadata: {str(e)}"
        )

    # Build modified track info
    modified_info = metadata.build_modified_track_info(
        original_info=current_info,
        title=updates.title,
        artist=updates.artist,
        bpm=updates.bpm,
        key=updates.key,
        genre=updates.genre,
        comment=updates.comment,
        release_date=updates.release_date,
        remixers=updates.remixers,
    )

    # Save metadata
    try:
        metadata.save_track_metadata(resolved_path, root_folder, modified_info)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to save metadata: {str(e)}"
        )

    return OperationResponse(
        success=True,
        message=f"Metadata updated for {resolved_path.name}",
    )


@router.get("/files/{file_path:path}/readiness", response_model=FileReadinessResponse)
def check_file_readiness(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FileReadinessResponse:
    """
    Check if a file is ready for finalization.

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
        track_info = metadata.get_track_info(resolved_path, root_folder)
        readiness = metadata.check_file_readiness(resolved_path, root_folder)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to check readiness: {str(e)}"
        )

    return FileReadinessResponse(
        file_path=str(resolved_path),
        is_ready=readiness["is_ready"],
        missing_fields=readiness["missing_fields"],
        issues=readiness["issues"],
    )


@router.post("/files/{file_path:path}/finalize", response_model=FinalizeResponse)
def finalize_file(
    file_path: str,
    request: FinalizeRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FinalizeResponse:
    """
    Finalize a track: convert format and move to collection.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    request : FinalizeRequest
        Finalization options (target format, quality, collection folder)
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    FinalizeResponse
        Result with new file path

    Raises
    ------
    HTTPException
        If file not ready or finalization fails
    """
    resolved_path = validate_file_path(file_path, root_folder)

    # Check readiness
    try:
        track_info = metadata.get_track_info(resolved_path, root_folder)
        readiness = metadata.check_file_readiness(resolved_path, root_folder)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to check readiness: {str(e)}"
        )

    if not readiness["is_ready"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File not ready for finalization. Missing: {', '.join(readiness['missing_fields'])}",
        )

    # Get collection folder
    folder_handler = FolderHandler(folder=root_folder)
    if request.collection_folder:
        collection_folder = Path(request.collection_folder)
    else:
        collection_folder = folder_handler.get_collection_folder()

    # Finalize track
    try:
        result = metadata.finalize_track(
            file_path=resolved_path,
            root_folder=root_folder,
            target_format=request.target_format,
        )
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Finalization failed: {str(e)}")

    return FinalizeResponse(
        success=result["success"],
        message=result["message"],
        new_file_path=result["output_path"],
    )


@router.delete("/files/{file_path:path}", response_model=OperationResponse)
def delete_file(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """
    Delete an audio file.

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
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to delete file: {str(e)}"
        )

    return OperationResponse(
        success=True,
        message=f"File deleted: {resolved_path.name}",
    )


# ==================== SoundCloud Operations ====================


@router.post("/soundcloud/search", response_model=SoundCloudSearchResponse)
async def search_soundcloud(
    request: SoundCloudSearchRequest,
    sc_client: Annotated[Client, Depends(get_soundcloud_client)],
) -> SoundCloudSearchResponse:
    """
    Search for tracks on SoundCloud.

    Parameters
    ----------
    request : SoundCloudSearchRequest
        Search parameters (query, limit, filters)
    sc_client : Client
        SoundCloud API client (injected)

    Returns
    -------
    SoundCloudSearchResponse
        List of matching tracks

    Raises
    ------
    HTTPException
        If search fails
    """
    try:
        tracks = await soundcloud.search_tracks(
            query=request.query,
            client=sc_client,
        )
        # Limit results
        tracks = tracks[: request.limit]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"SoundCloud search failed: {str(e)}"
        )

    # Convert to response format
    track_responses = [
        SoundCloudTrackResponse(
            id=t.id,
            title=t.title,
            artist=t.artist,
            permalink_url=t.permalink_url,
            artwork_url=t.artwork_url,
            duration_ms=t.duration_s * 1000 if t.duration_s else None,
            genre=t.genre,
            release_date=t.release_date,
            artist_options=[
                a
                for a in (
                    t.publisher_metadata and t.publisher_metadata.artist,
                    t.user.username,
                )
                if a
            ],
            # label=t.label,
            # isrc=t.isrc,
            # bpm=t.bpm,
        )
        for t in tracks
    ]

    return SoundCloudSearchResponse(
        query=request.query,
        total_results=len(track_responses),
        tracks=track_responses,
    )


@router.get("/soundcloud/track", response_model=SoundCloudTrackResponse)
async def get_soundcloud_track(
    url: Annotated[str, Query(description="SoundCloud track URL")],
    sc_client: Annotated[Client, Depends(get_soundcloud_client)],
) -> SoundCloudTrackResponse:
    """
    Get track info from SoundCloud URL.

    Parameters
    ----------
    url : str
        Full SoundCloud track URL
    sc_client : Client
        SoundCloud API client (injected)

    Returns
    -------
    SoundCloudTrackResponse
        Track information

    Raises
    ------
    HTTPException
        If URL is invalid or track not found
    """
    try:
        track = await soundcloud.get_track_by_url(url, sc_client)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to fetch track: {str(e)}"
        )

    return SoundCloudTrackResponse(
        id=track["id"],
        title=track["title"],
        artist=track["artist"],
        permalink_url=track["permalink_url"],
        artwork_url=track.get("artwork_url"),
        duration_ms=track.get("duration_ms"),
        genre=track.get("genre"),
        release_date=track.get("release_date"),
        label=track.get("label"),
        isrc=track.get("isrc"),
        bpm=track.get("bpm"),
    )


@router.post("/soundcloud/apply", response_model=OperationResponse)
async def apply_soundcloud_metadata(
    request: TrackInfoRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
    sc_client: Annotated[Client, Depends(get_soundcloud_client)],
) -> OperationResponse:
    """
    Apply metadata from SoundCloud track to local file.

    Parameters
    ----------
    request : TrackInfoRequest
        File path and SoundCloud track ID
    root_folder : Path
        Root music folder (injected)
    sc_client : Client
        SoundCloud API client (injected)

    Returns
    -------
    OperationResponse
        Operation result

    Raises
    ------
    HTTPException
        If file doesn't exist or metadata application fails
    """
    resolved_path = validate_file_path(request.file_path, root_folder)

    # Get SoundCloud track
    try:
        sc_track = await soundcloud.get_track_by_id(request.soundcloud_id, sc_client)
        track_info = soundcloud.convert_sc_track_to_track_info(sc_track)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to fetch SoundCloud track: {str(e)}"
        )

    # Save metadata
    try:
        metadata.save_track_metadata(resolved_path, root_folder, track_info)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to save metadata: {str(e)}"
        )

    return OperationResponse(
        success=True,
        message=f"Applied SoundCloud metadata to {resolved_path.name}",
    )


# ==================== Artwork Operations ====================


@router.get("/files/{file_path:path}/artwork")
def get_file_artwork(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FileResponse:
    """
    Get artwork image for an audio file.

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

    try:
        artwork_path = metadata.extract_artwork(resolved_path, root_folder)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to extract artwork: {str(e)}"
        )

    if not artwork_path or not artwork_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No artwork found for this file")

    return FileResponse(
        path=artwork_path,
        media_type="image/jpeg",  # or detect mime type
    )


@router.post("/files/{file_path:path}/artwork", response_model=OperationResponse)
async def update_file_artwork(
    file_path: str,
    file: UploadFile,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """
    Update artwork for an audio file by uploading an image.

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

    # Read uploaded file
    try:
        artwork_data = await file.read()
        if not artwork_data:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No image data received")
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Failed to read uploaded file: {str(e)}")

    # Embed artwork
    try:
        from soundcloud_tools.handler.track import TrackHandler

        handler = TrackHandler(root_folder=root_folder, file=resolved_path)
        handler.add_cover(artwork_data)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to embed artwork: {str(e)}"
        )

    return OperationResponse(
        success=True,
        message=f"Artwork updated for {resolved_path.name}",
    )


@router.delete("/files/{file_path:path}/artwork", response_model=OperationResponse)
def delete_file_artwork(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """
    Remove artwork from an audio file.

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
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to remove artwork: {str(e)}"
        )

    return OperationResponse(
        success=True,
        message=f"Artwork removed from {resolved_path.name}",
    )


# ==================== Collection Operations ====================


@router.get("/collection/stats", response_model=CollectionStatsResponse)
def get_collection_stats(
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> CollectionStatsResponse:
    """
    Get statistics for the entire collection.

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
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to get collection stats: {str(e)}"
        )

    return CollectionStatsResponse(
        total_tracks=stats["total_tracks"],
        complete_tracks=stats["complete_tracks"],
        incomplete_tracks=stats["incomplete_tracks"],
        total_artists=stats["total_artists"],
        total_genres=stats["total_genres"],
        missing_fields=stats["missing_fields"],
    )


# ==================== Auto-Action Utilities ====================


@router.post("/auto-actions/clean-title", response_model=AutoActionResponse)
def clean_title_action(request: AutoActionRequest) -> AutoActionResponse:
    """
    Clean a title string by removing common noise.

    Removes free download mentions, premiere labels, and normalizes spacing.

    Parameters
    ----------
    request : AutoActionRequest
        Text to clean

    Returns
    -------
    AutoActionResponse
        Original, transformed, and changed flag
    """
    transformed = metadata.apply_clean_title(request.text)
    return AutoActionResponse(
        original=request.text,
        transformed=transformed,
        changed=request.text != transformed,
    )


@router.post("/auto-actions/clean-artist", response_model=AutoActionResponse)
def clean_artist_action(request: AutoActionRequest) -> AutoActionResponse:
    """
    Clean an artist string by normalizing separators.

    Converts "&", "and", "x", "X" to commas and removes noise.

    Parameters
    ----------
    request : AutoActionRequest
        Artist text to clean

    Returns
    -------
    AutoActionResponse
        Original, transformed, and changed flag
    """
    transformed = metadata.apply_clean_artist(request.text)
    return AutoActionResponse(
        original=request.text,
        transformed=transformed,
        changed=request.text != transformed,
    )


@router.post("/auto-actions/titelize", response_model=AutoActionResponse)
def titelize_action(request: AutoActionRequest) -> AutoActionResponse:
    """
    Properly capitalize text with special handling for music terms.

    Handles DJ, contractions, and standard title casing.

    Parameters
    ----------
    request : AutoActionRequest
        Text to capitalize

    Returns
    -------
    AutoActionResponse
        Original, transformed, and changed flag
    """
    transformed = metadata.apply_titelize(request.text)
    return AutoActionResponse(
        original=request.text,
        transformed=transformed,
        changed=request.text != transformed,
    )


@router.post("/auto-actions/remove-original-mix", response_model=AutoActionResponse)
def remove_original_mix_action(request: AutoActionRequest) -> AutoActionResponse:
    """
    Remove "(Original Mix)" from title.

    Parameters
    ----------
    request : AutoActionRequest
        Title text

    Returns
    -------
    AutoActionResponse
        Original, transformed, and changed flag
    """
    transformed = metadata.apply_remove_original_mix(request.text)
    return AutoActionResponse(
        original=request.text,
        transformed=transformed,
        changed=request.text != transformed,
    )


@router.post("/auto-actions/remove-parenthesis", response_model=AutoActionResponse)
def remove_parenthesis_action(request: AutoActionRequest) -> AutoActionResponse:
    """
    Remove square brackets and their contents from title.

    Parameters
    ----------
    request : AutoActionRequest
        Title text

    Returns
    -------
    AutoActionResponse
        Original, transformed, and changed flag
    """
    transformed = metadata.apply_remove_parenthesis(request.text)
    return AutoActionResponse(
        original=request.text,
        transformed=transformed,
        changed=request.text != transformed,
    )
