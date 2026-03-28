"""
Meta Editor API routes.

FastAPI endpoints for metadata editing operations:
- File listing and folder operations
- Track metadata read/update
- File finalization (conversion and moving)
- Artwork management
"""

import asyncio
import base64
import logging
from datetime import date
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from fastapi_pagination import Page, paginate
from fastapi_pagination.utils import disable_installed_extensions_check

from backend.api.deps import (
    get_root_folder,
    validate_file_path,
    validate_folder_mode,
)
from backend.config import get_backend_settings
from backend.core.services import cache_db, collection, metadata
from backend.schemas.metadata import (
    CollectionStatsResponse,
    FileInfoResponse,
    FileReadinessResponse,
    FilterValuesResponse,
    FinalizeRequest,
    FinalizeResponse,
    OperationResponse,
    PeaksResponse,
    TrackBrowseResponse,
    TrackInfoResponse,
    TrackInfoUpdateRequest,
)
from soundcloud_tools.handler.folder import FolderHandler
from soundcloud_tools.handler.track import TrackHandler

disable_installed_extensions_check()

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/metadata", tags=["metadata"])


# ==================== File and Folder Operations ====================


@router.post("/folders/initialize", response_model=OperationResponse)
def initialize_folders(
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """Create the root folder and all required subfolders."""
    root_folder.mkdir(parents=True, exist_ok=True)
    for subfolder in ["prepare", "collection", "cleaned", "archive"]:
        (root_folder / subfolder).mkdir(exist_ok=True)
    return OperationResponse(success=True, message=f"Folders created under {root_folder}")


@router.get("/folders/{mode}/files", response_model=Page[FileInfoResponse])
def list_folder_files(
    mode: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> Page[FileInfoResponse]:
    """
    List all audio files in a specific folder (paginated).

    Parameters
    ----------
    mode : str
        Folder mode: "prepare", "collection", "cleaned", or ""
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    Page[FileInfoResponse]
        Paginated list of audio files with basic info

    Raises
    ------
    HTTPException
        If folder doesn't exist or is invalid
    """
    validated_mode = validate_folder_mode(mode)

    # Check root folder exists before trying to use FolderHandler
    if not root_folder.is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder does not exist",
        )

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

    # Validate subfolder exists
    is_valid, _ = collection.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder does not exist",
        )

    # List files (lightweight — no metadata reads yet)
    files = [f for f in collection.list_audio_files(folder_path) if f.suffix != ".asd"]

    # Only build FileInfoResponse (including the expensive .covers check)
    # for the items that land in the current page, not all 4000+ files.
    def to_file_info(f: Path) -> FileInfoResponse:
        return FileInfoResponse(
            file_path=str(f),
            file_name=f.name,
            file_size=f.stat().st_size,
            file_format=f.suffix,
            has_artwork=bool(TrackHandler(root_folder=root_folder, file=f).covers),
        )

    return paginate(files, transformer=lambda items: [to_file_info(f) for f in items])


@router.get("/folders/{mode}/browse", response_model=Page[TrackBrowseResponse])
def browse_folder_files(
    response: Response,
    mode: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
    search: str | None = Query(None, description="Full-text search across title, artist, genre"),
    genres: list[str] | None = Query(None, description="Filter by genre (OR logic, exact match)"),
    artists: list[str] | None = Query(None, description="Filter by artist (OR logic, substring match)"),
    keys: list[str] | None = Query(None, description="Filter by key (OR logic, exact match)"),
    bpm_min: int | None = Query(None, ge=0, description="Minimum BPM"),
    bpm_max: int | None = Query(None, ge=0, description="Maximum BPM"),
    date_from: date | None = Query(None, description="Earliest release date (YYYY-MM-DD)"),
    date_to: date | None = Query(None, description="Latest release date (YYYY-MM-DD)"),
    sort_by: str = Query("file_name", pattern="^(title|artist|genre|bpm|key|release_date|file_name)$"),
    sort_order: str = Query("asc", pattern="^(asc|desc)$"),
) -> Page[TrackBrowseResponse]:
    """
    Browse tracks in a folder with filtering, sorting, and pagination.

    Reads full metadata for each track server-side and applies filters before
    returning a paginated result. Suitable for large collections (4000+ tracks)
    because only one page is serialized at a time.

    Parameters
    ----------
    mode : str
        Folder mode: "prepare", "collection", "cleaned", or ""
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    Page[TrackBrowseResponse]
        Filtered, sorted, paginated track metadata
    """
    validated_mode = validate_folder_mode(mode)
    folder_handler = FolderHandler(folder=root_folder)

    if validated_mode == "prepare":
        folder_path = folder_handler.get_prepare_folder()
    elif validated_mode == "collection":
        folder_path = folder_handler.get_collection_folder()
    elif validated_mode == "cleaned":
        folder_path = folder_handler.get_cleaned_folder()
    else:
        folder_path = root_folder

    is_valid, errors = collection.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=errors)

    try:
        pairs = collection.list_and_filter_tracks(
            folder=folder_path,
            search_query=search,
            genres=genres,
            artists=artists,
            keys=keys,
            bpm_min=bpm_min,
            bpm_max=bpm_max,
            start_date=date_from,
            end_date=date_to,
            sort_by=sort_by,
            sort_order=sort_order,
        )
    except Exception as e:
        logger.exception("Failed to list tracks")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list tracks",
        ) from e

    def to_browse_response(row) -> TrackBrowseResponse:
        return TrackBrowseResponse(
            file_path=row["file_path"],
            file_name=row["file_name"],
            title=row["title"],
            artist=row["artist_str"],
            bpm=row["bpm"],
            key=row["key"],
            genre=row["genre"],
            release_date=date.fromisoformat(row["release_date"]) if row["release_date"] else None,
            has_artwork=bool(row["has_artwork"]),
            file_format=row["file_format"],
            file_size=row["file_size"] or 0,
            duration=row["duration"],
        )

    if collection.is_indexing(folder_path):
        response.headers["X-Cache-Loading"] = "true"

    return paginate(pairs, transformer=lambda items: [to_browse_response(p) for p in items])


@router.get("/folders/{mode}/filter-values", response_model=FilterValuesResponse)
def get_folder_filter_values(
    mode: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
    search: str | None = Query(None, description="Active search filter"),
    genres: list[str] | None = Query(None, description="Active genre filters"),
    keys: list[str] | None = Query(None, description="Active key filters"),
    bpm_min: int | None = Query(None, ge=0, description="Active BPM minimum"),
    bpm_max: int | None = Query(None, ge=0, description="Active BPM maximum"),
) -> FilterValuesResponse:
    """
    Get available filter values for a folder (genres, artists, keys, BPM range).

    Used to populate filter dropdowns in the View mode.

    Parameters
    ----------
    mode : str
        Folder mode: "prepare", "collection", "cleaned", or ""
    root_folder : Path
        Root music folder (injected)

    Returns
    -------
    FilterValuesResponse
        Available filter options
    """
    validated_mode = validate_folder_mode(mode)
    folder_handler = FolderHandler(folder=root_folder)

    if validated_mode == "prepare":
        folder_path = folder_handler.get_prepare_folder()
    elif validated_mode == "collection":
        folder_path = folder_handler.get_collection_folder()
    elif validated_mode == "cleaned":
        folder_path = folder_handler.get_cleaned_folder()
    else:
        folder_path = root_folder

    is_valid, errors = collection.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=errors)

    try:
        values = collection.get_folder_filter_values(
            folder_path,
            search_query=search,
            genres=genres,
            keys=keys,
            bpm_min=bpm_min,
            bpm_max=bpm_max,
        )
    except Exception as e:
        logger.exception("Failed to get filter values")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get filter values",
        ) from e

    return FilterValuesResponse(**values)


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
        logger.exception("Failed to read track metadata")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to read track metadata"
        ) from e

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
        logger.exception("Failed to read current metadata")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to read current metadata"
        ) from e

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
        new_path = metadata.save_track_metadata(resolved_path, root_folder, modified_info)
    except Exception as e:
        logger.exception("Failed to save metadata")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save metadata") from e

    # Download and embed artwork from URL if provided
    if updates.artwork_data:
        # Limit artwork payload to 10 MB
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

    collection.invalidate_cache()

    return OperationResponse(
        success=True,
        message=f"Metadata updated for {new_path.name}",
        new_file_path=str(new_path),
    )


# ==================== Image Proxy ====================

_ALLOWED_SC_HOSTS = {"i1.sndcdn.com", "i2.sndcdn.com", "i3.sndcdn.com", "i4.sndcdn.com"}


@router.get("/proxy-image")
def proxy_image(url: str) -> Response:
    """Proxy an image from an allowed SoundCloud CDN host."""
    parsed = urlparse(url)
    if parsed.hostname not in _ALLOWED_SC_HOSTS or parsed.scheme != "https":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL not allowed")
    try:
        r = httpx.get(url, timeout=10, follow_redirects=True)
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Failed to fetch image") from e
    return Response(content=r.content, media_type=r.headers.get("content-type", "image/jpeg"))


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
        readiness = metadata.check_file_readiness(resolved_path, root_folder)
    except Exception as e:
        logger.exception("Failed to check readiness")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to check readiness"
        ) from e

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
        readiness = metadata.check_file_readiness(resolved_path, root_folder)
    except Exception as e:
        logger.exception("Failed to check readiness")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to check readiness"
        ) from e

    if not readiness["is_ready"]:
        missing_fields = readiness["missing_fields"]
        if isinstance(missing_fields, list):
            missing_str = ", ".join(missing_fields)
        else:
            missing_str = str(missing_fields)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File not ready for finalization. Missing: {missing_str}",
        )

    # Finalize track
    try:
        result = metadata.finalize_track(
            file_path=resolved_path,
            root_folder=root_folder,
            target_format=request.target_format,
        )
    except Exception as e:
        logger.exception("Finalization failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Finalization failed",
        ) from e

    collection.invalidate_cache()

    return FinalizeResponse(
        success=result["success"],
        message=result["message"],
        new_file_path=result["output_path"],
    )


# ==================== Artwork Operations ====================


@router.get("/files/{file_path:path}/artwork")
async def get_file_artwork(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FileResponse:
    """
    Get artwork image for an audio file.

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
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to read uploaded file")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read uploaded file",
        ) from e

    # Embed artwork
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
        logger.exception("Failed to delete file")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to delete file") from e

    collection.invalidate_cache()

    return OperationResponse(
        success=True,
        message=f"File deleted: {resolved_path.name}",
    )


# ==================== Audio Streaming ====================


AUDIO_MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}

# Formats that Chrome cannot decode natively — transcode to WAV via ffmpeg.
_TRANSCODE_EXTENSIONS = {".aiff", ".aif"}

# Limit concurrent ffmpeg peak-computation processes so uncached requests
# don't overwhelm the server. Cached requests bypass this semaphore entirely.
_peaks_semaphore = asyncio.Semaphore(4)


@router.get("/files/{file_path:path}/peaks", response_model=PeaksResponse)
async def get_file_peaks(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
    num_peaks: int = Query(200, ge=50, le=500, description="Number of amplitude peaks to return"),
) -> PeaksResponse:
    """
    Get waveform amplitude peak data for a file.

    Cached results (SQLite) are returned immediately without any throttle.
    Uncached files are decoded via ffmpeg; concurrent ffmpeg calls are capped
    at 4 to avoid overwhelming the system during fast scrolling.

    Parameters
    ----------
    file_path : str
        Relative or absolute path to audio file
    root_folder : Path
        Root music folder (injected)
    num_peaks : int
        Number of peak values to return

    Returns
    -------
    PeaksResponse
        Normalized peak amplitudes in range [0, 1]
    """
    resolved_path = validate_file_path(file_path, root_folder)

    if not resolved_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio file not found")

    # Fast path — serve from SQLite cache without touching the semaphore.
    try:
        mtime = resolved_path.stat().st_mtime
        cached = cache_db.get_peaks(resolved_path, mtime)
        if cached is not None:
            return PeaksResponse(peaks=cached)
    except OSError:
        pass

    # Slow path — throttled ffmpeg computation.
    settings = get_backend_settings()
    loop = asyncio.get_event_loop()
    try:
        async with _peaks_semaphore:
            peaks = await loop.run_in_executor(
                None, metadata.get_waveform_peaks, resolved_path, settings.cache_dir, num_peaks
            )
    except Exception as e:
        logger.exception("Failed to compute peaks")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to compute peaks",
        ) from e

    return PeaksResponse(peaks=peaks)


@router.get("/files/{file_path:path}/audio")
def stream_audio(
    file_path: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> StreamingResponse:
    """
    Stream an audio file.

    Formats not natively supported by browsers (e.g. AIFF) are
    transcoded to WAV on the fly via ffmpeg.

    Args:
        file_path: Relative or absolute path to audio file.
        root_folder: Root music folder (injected).

    Returns:
        StreamingResponse with the audio file bytes.

    Raises:
        HTTPException: If the file doesn't exist.
    """
    resolved_path = validate_file_path(file_path, root_folder)

    if not resolved_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio file not found")

    if resolved_path.suffix.lower() in _TRANSCODE_EXTENSIONS:
        return _stream_transcoded(resolved_path)

    mime_type = AUDIO_MIME_TYPES.get(resolved_path.suffix.lower(), "application/octet-stream")

    def iter_file():
        with open(resolved_path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        iter_file(),
        media_type=mime_type,
        headers={
            "Content-Disposition": f'inline; filename="{resolved_path.name}"',
            "Content-Length": str(resolved_path.stat().st_size),
            "Accept-Ranges": "bytes",
        },
    )


def _stream_transcoded(path: Path) -> StreamingResponse:
    """Transcode an audio file to WAV via ffmpeg and stream it."""
    import subprocess

    proc = subprocess.Popen(
        ["ffmpeg", "-i", str(path), "-f", "wav", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    def iterfile():
        assert proc.stdout is not None
        try:
            while chunk := proc.stdout.read(65536):
                yield chunk
        finally:
            proc.stdout.close()
            proc.wait()

    stem = path.stem
    return StreamingResponse(
        iterfile(),
        media_type="audio/wav",
        headers={"Content-Disposition": f'inline; filename="{stem}.wav"'},
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
