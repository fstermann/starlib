"""File and folder operations for the Meta Editor."""

import base64
import logging
from datetime import date
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi_pagination import Page, paginate

from backend.api.deps import get_root_folder, validate_file_path, validate_folder_mode
from backend.api.metadata._helpers import resolve_folder
from backend.core.services import cache_db, collection, metadata
from backend.schemas.metadata import (
    BatchInfoRequest,
    BatchResultItem,
    BatchUpdateRequest,
    BatchUpdateResponse,
    FileInfoResponse,
    FileReadinessResponse,
    FilterValuesResponse,
    FinalizeRequest,
    FinalizeResponse,
    OperationResponse,
    TrackBrowseResponse,
    TrackInfoResponse,
    TrackInfoUpdateRequest,
)
from backend.schemas.tree import TreeNode
from soundcloud_tools.handler.folder import FolderHandler
from soundcloud_tools.handler.track import SIMPLE_TAG_FIELDS, TrackHandler, TrackInfo

logger = logging.getLogger(__name__)

router = APIRouter()


def _row_value(row, key, default=None):
    """sqlite3.Row doesn't support .get(); guard column-missing safely."""
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


def _track_info_to_response_dict(track_info: TrackInfo) -> dict:
    """Project a TrackInfo into the flat dict used by TrackInfoResponse.

    artist/original_artist/remixer are surfaced as their joined-string form so
    the API stays a stable shape regardless of the underlying list-vs-scalar.
    """
    out: dict = {}
    for f in SIMPLE_TAG_FIELDS:
        value = getattr(track_info, f.name)
        if f.name == "artist":
            out["artist"] = track_info.artist_str or None
        elif f.name == "original_artist":
            out["original_artist"] = track_info.original_artist_str or None
        elif f.name == "remixer":
            out["remixer"] = track_info.remixer_str or None
        elif f.name == "starlib_meta":
            out["starlib_meta"] = value.to_str() if value else None
        else:
            out[f.name] = value
    return out


def _row_to_browse_dict(row) -> dict:
    """Project a cache_db row into the flat dict used by TrackBrowseResponse."""
    out = {
        "title": row["title"],
        "artist": row["artist_str"],
        "genre": row["genre"],
        "bpm": row["bpm"],
        "key": row["key"],
        "release_date": date.fromisoformat(row["release_date"]) if row["release_date"] else None,
        "release_year": _row_value(row, "release_year"),
        "original_artist": _row_value(row, "original_artist"),
        "remixer": _row_value(row, "remixer"),
        "mix_name": _row_value(row, "mix_name"),
        "user_comment": _row_value(row, "user_comment"),
        "starlib_meta": None,  # not cached; live read would be required
    }
    return out


@router.post("/folders/initialize", response_model=OperationResponse)
def initialize_folders(
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> OperationResponse:
    """Create the root folder and all required subfolders."""
    root_folder.mkdir(parents=True, exist_ok=True)
    for subfolder in ["prepare", "collection", "cleaned", "archive"]:
        (root_folder / subfolder).mkdir(exist_ok=True)
    return OperationResponse(success=True, message=f"Folders created under {root_folder}")


@router.get("/folders/tree", response_model=TreeNode)
def get_folder_tree(
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> TreeNode:
    """Return the folder tree built from indexed tracks.

    Only folders that contain at least one track (directly or in a
    descendant) are included — empty directories are omitted.
    """
    root_str = str(root_folder.resolve())
    folder_counts = cache_db.get_folder_track_counts()

    # Build nested dict from flat folder paths
    tree: dict = {}
    for fp in folder_counts:
        # Make path relative to root; skip entries outside root
        if not fp.startswith(root_str):
            continue
        rel = fp[len(root_str):]
        if rel.startswith("/"):
            rel = rel[1:]
        parts = rel.split("/") if rel else []
        node = tree
        for part in parts:
            node = node.setdefault(part, {})

    def _build(name: str, abs_path: str, children_dict: dict) -> TreeNode:
        children = [
            _build(k, f"{abs_path}/{k}", v)
            for k, v in sorted(children_dict.items())
        ]
        total = folder_counts.get(abs_path, 0) + sum(c.track_count for c in children)
        return TreeNode(id=abs_path, name=name, children=children, track_count=total)

    root_name = root_folder.name
    children = [
        _build(k, f"{root_str}/{k}", v)
        for k, v in sorted(tree.items())
    ]
    total = folder_counts.get(root_str, 0) + sum(c.track_count for c in children)
    return TreeNode(id=root_str, name=root_name, children=children, track_count=total)


@router.get("/folders/browse-path", response_model=Page[TrackBrowseResponse])
def browse_by_path(
    response: Response,
    root_folder: Annotated[Path, Depends(get_root_folder)],
    path: str = Query(..., description="Absolute folder path to browse"),
    recursive: bool = Query(True, description="Include tracks in subfolders"),
    search: str | None = Query(None),
    genres: list[str] | None = Query(None),
    artists: list[str] | None = Query(None),
    keys: list[str] | None = Query(None),
    bpm_min: int | None = Query(None, ge=0),
    bpm_max: int | None = Query(None, ge=0),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    sort_by: str = Query("file_name", pattern="^(title|artist|genre|bpm|key|release_date|file_name|mtime)$"),
    sort_order: str = Query("asc", pattern="^(asc|desc)$"),
) -> Page[TrackBrowseResponse]:
    """Browse tracks by absolute folder path with optional recursion."""
    folder_path = Path(path).resolve()
    resolved_root = root_folder.resolve()

    # Security: path must be under root
    try:
        folder_path.relative_to(resolved_root)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Path is outside the music library root.",
        )

    collection.ensure_folder_indexed(folder_path, root_folder=resolved_root)

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
            recursive=recursive,
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
            folder=_row_value(row, "folder"),
            soundcloud_id=_row_value(row, "soundcloud_id"),
            has_artwork=bool(row["has_artwork"]),
            file_format=row["file_format"],
            file_size=row["file_size"] or 0,
            duration=row["duration"],
            mtime=row["mtime"],
            **_row_to_browse_dict(row),
        )

    if collection.is_indexing(folder_path):
        response.headers["X-Cache-Loading"] = "true"

    return paginate(pairs, transformer=lambda items: [to_browse_response(p) for p in items])


@router.get("/folders/browse-path/filter-values", response_model=FilterValuesResponse)
def browse_path_filter_values(
    root_folder: Annotated[Path, Depends(get_root_folder)],
    path: str = Query(..., description="Absolute folder path"),
    recursive: bool = Query(True),
    search: str | None = Query(None),
    genres: list[str] | None = Query(None),
    keys: list[str] | None = Query(None),
    bpm_min: int | None = Query(None, ge=0),
    bpm_max: int | None = Query(None, ge=0),
) -> FilterValuesResponse:
    """Get available filter values for a folder path."""
    folder_path = Path(path).resolve()
    resolved_root = root_folder.resolve()

    try:
        folder_path.relative_to(resolved_root)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Path is outside the music library root.",
        )

    collection.ensure_folder_indexed(folder_path, root_folder=resolved_root)

    result = collection.get_folder_filter_values(
        folder_path,
        recursive=recursive,
        search_query=search,
        genres=genres,
        keys=keys,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
    )
    return FilterValuesResponse(**result)


@router.get("/folders/{mode}/files", response_model=Page[FileInfoResponse])
def list_folder_files(
    mode: str,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> Page[FileInfoResponse]:
    """List all audio files in a specific folder (paginated).

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

    if not root_folder.is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder does not exist",
        )

    folder_handler = FolderHandler(folder=root_folder)

    if validated_mode == "prepare":
        folder_path = folder_handler.get_prepare_folder()
    elif validated_mode == "collection":
        folder_path = folder_handler.get_collection_folder()
    elif validated_mode == "cleaned":
        folder_path = folder_handler.get_cleaned_folder()
    else:
        folder_path = root_folder

    is_valid, _ = collection.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder does not exist",
        )

    files = [f for f in collection.list_audio_files(folder_path) if f.suffix != ".asd"]

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
    sort_by: str = Query("file_name", pattern="^(title|artist|genre|bpm|key|release_date|file_name|mtime)$"),
    sort_order: str = Query("asc", pattern="^(asc|desc)$"),
) -> Page[TrackBrowseResponse]:
    """Browse tracks in a folder with filtering, sorting, and pagination.

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
    folder_path = resolve_folder(mode, root_folder)

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
            folder=_row_value(row, "folder"),
            soundcloud_id=_row_value(row, "soundcloud_id"),
            has_artwork=bool(row["has_artwork"]),
            file_format=row["file_format"],
            file_size=row["file_size"] or 0,
            duration=row["duration"],
            mtime=row["mtime"],
            **_row_to_browse_dict(row),
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
    """Get available filter values for a folder (genres, artists, keys, BPM range).

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
    folder_path = resolve_folder(mode, root_folder)

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
        cache_db.delete_track(resolved_path)
    collection.reindex_file(root_folder, new_path)

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
                cache_db.delete_track(resolved_path)
            collection.reindex_file(root_folder, new_path)

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
    """Check if a file is ready for finalization.

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


@router.post("/files/{file_path:path}/finalize", response_model=FinalizeResponse)
def finalize_file(
    file_path: str,
    request: FinalizeRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FinalizeResponse:
    """Finalize a track: convert format and move to collection.

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

    try:
        readiness = metadata.check_file_readiness(resolved_path, root_folder)
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
            detail=f"File not ready for finalization. Missing: {missing_str}",
        )

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
            detail=f"Finalization failed: {e}",
        ) from e

    # Remove the old file from cache (it's been moved/converted)
    cache_db.delete_track(resolved_path)

    return FinalizeResponse(
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

    cache_db.delete_track(resolved_path)

    return OperationResponse(
        success=True,
        message=f"File deleted: {resolved_path.name}",
    )
