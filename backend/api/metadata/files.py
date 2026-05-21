"""File and folder operations for the Meta Editor."""

import asyncio
import base64
import logging
import shutil
import time
from datetime import date
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi_pagination import Page, paginate

from backend.api.deps import get_root_folder, validate_file_path, validate_folder_mode
from backend.api.metadata._helpers import resolve_folder
from backend.core.services import cache_db, collection, metadata
from backend.schemas.metadata import (
    ApplyRulesRequest,
    ApplyRulesResponse,
    BatchInfoRequest,
    BatchResultItem,
    BatchUpdateRequest,
    BatchUpdateResponse,
    FetchCandidate,
    FetchFromDownloadsPreview,
    FetchFromDownloadsRequest,
    FetchFromDownloadsResponse,
    FileInfoResponse,
    FileReadinessResponse,
    FilterValuesResponse,
    OperationResponse,
    TrackBrowseResponse,
    TrackInfoResponse,
    TrackInfoUpdateRequest,
)
from backend.schemas.tree import TreeNode
from soundcloud_tools.handler.folder import FolderHandler
from soundcloud_tools.handler.track import FILETYPE_MAP, SIMPLE_TAG_FIELDS, TrackHandler, TrackInfo

logger = logging.getLogger(__name__)

router = APIRouter()

# Bound concurrent Apply Rules jobs so a stack of clicks can't spawn
# unbounded ffmpeg conversions in parallel.
_apply_rules_semaphore = asyncio.Semaphore(2)

_SORT_BY_PATTERN = "^(title|artist|genre|bpm|key|release_date|file_name|folder|mtime|file_format|file_size|duration)$"


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


# Audio file extensions accepted by the Fetch-from-Downloads action.
# Aligned with FILETYPE_MAP (the formats the indexer/handler can actually
# read) so we never move a file the library would then fail to surface.
_FETCH_AUDIO_EXTENSIONS = frozenset(FILETYPE_MAP.keys())


def _is_recent_audio(src: Path, cutoff: float) -> bool:
    """True if *src* is a non-hidden audio file modified at or after *cutoff*."""
    if not src.is_file() or src.name.startswith("."):
        return False
    if src.suffix.lower() not in _FETCH_AUDIO_EXTENSIONS:
        return False
    try:
        return src.stat().st_mtime >= cutoff
    except OSError:
        return False


def _resolve_fetch_paths(dest_path: str, root_folder: Path) -> tuple[Path, Path, Path]:
    """Validate Downloads + destination and return (downloads, dest, resolved_root)."""
    downloads = (Path.home() / "Downloads").resolve()
    if not downloads.is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Downloads folder not found at {downloads}",
        )

    dest = Path(dest_path).resolve()
    resolved_root = root_folder.resolve()
    try:
        dest.relative_to(resolved_root)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Destination is outside the music library root.",
        ) from e
    if not dest.is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Destination folder does not exist: {dest}",
        )
    return downloads, dest, resolved_root


@router.get("/folders/fetch-from-downloads/preview", response_model=FetchFromDownloadsPreview)
def fetch_from_downloads_preview(
    root_folder: Annotated[Path, Depends(get_root_folder)],
    dest_path: str = Query(..., description="Destination folder under the music root"),
    window_days: int = Query(1, ge=1, le=365),
) -> FetchFromDownloadsPreview:
    """List recent audio files in ~/Downloads that would be moved into *dest_path*.

    Files already present in the destination (collisions) are reported under
    ``skipped`` and are not part of ``candidates``.
    """
    downloads, dest, _ = _resolve_fetch_paths(dest_path, root_folder)

    cutoff = time.time() - window_days * 86400
    candidates: list[FetchCandidate] = []
    skipped: list[str] = []

    for src in downloads.iterdir():
        if not _is_recent_audio(src, cutoff):
            continue
        if (dest / src.name).exists():
            skipped.append(src.name)
            continue
        try:
            stat = src.stat()
        except OSError:
            continue
        candidates.append(FetchCandidate(name=src.name, size=stat.st_size, mtime=stat.st_mtime))

    candidates.sort(key=lambda c: c.mtime, reverse=True)
    return FetchFromDownloadsPreview(candidates=candidates, skipped=sorted(skipped))


@router.post("/folders/fetch-from-downloads", response_model=FetchFromDownloadsResponse)
def fetch_from_downloads(
    request: FetchFromDownloadsRequest,
    root_folder: Annotated[Path, Depends(get_root_folder)],
) -> FetchFromDownloadsResponse:
    """Move recent audio files from ~/Downloads into a library subfolder.

    Files are filtered by extension (audio formats only) and mtime (within
    ``window_days`` of now). A file is skipped when the destination already
    contains an entry with the same name — making the operation idempotent.
    When ``request.file_names`` is set, only those names are eligible to move.
    """
    downloads, dest, resolved_root = _resolve_fetch_paths(request.dest_path, root_folder)

    cutoff = time.time() - request.window_days * 86400
    selection = set(request.file_names) if request.file_names is not None else None
    moved: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []

    for src in downloads.iterdir():
        if not _is_recent_audio(src, cutoff):
            continue
        if selection is not None and src.name not in selection:
            continue

        target = dest / src.name
        if target.exists():
            skipped.append(src.name)
            continue

        try:
            shutil.move(str(src), str(target))
        except Exception as e:
            logger.exception("Failed to move %s to %s", src, target)
            errors.append(f"{src.name}: {e}")
            continue

        try:
            collection.reindex_file(resolved_root, target)
        except Exception:
            logger.exception("Failed to reindex %s after move", target)
        moved.append(src.name)

    return FetchFromDownloadsResponse(moved=moved, skipped=skipped, errors=errors)


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
        rel = fp[len(root_str) :]
        if rel.startswith("/"):
            rel = rel[1:]
        parts = rel.split("/") if rel else []
        node = tree
        for part in parts:
            node = node.setdefault(part, {})

    def _build(name: str, abs_path: str, children_dict: dict) -> TreeNode:
        children = [_build(k, f"{abs_path}/{k}", v) for k, v in sorted(children_dict.items())]
        total = folder_counts.get(abs_path, 0) + sum(c.track_count for c in children)
        return TreeNode(id=abs_path, name=name, children=children, track_count=total)

    root_name = root_folder.name
    children = [_build(k, f"{root_str}/{k}", v) for k, v in sorted(tree.items())]
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
    has_soundcloud_id: bool | None = Query(None),
    file_formats: list[str] | None = Query(None),
    size_min: int | None = Query(None, ge=0),
    size_max: int | None = Query(None, ge=0),
    sort_by: str = Query("file_name", pattern=_SORT_BY_PATTERN),
    sort_order: str = Query("asc", pattern="^(asc|desc)$"),
) -> Page[TrackBrowseResponse]:
    """Browse tracks by absolute folder path with optional recursion."""
    folder_path = Path(path).resolve()
    resolved_root = root_folder.resolve()

    # Security: path must be under root
    try:
        folder_path.relative_to(resolved_root)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Path is outside the music library root.",
        ) from e

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
            has_soundcloud_id=has_soundcloud_id,
            file_formats=file_formats,
            size_min=size_min,
            size_max=size_max,
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
    file_formats: list[str] | None = Query(None),
    size_min: int | None = Query(None, ge=0),
    size_max: int | None = Query(None, ge=0),
) -> FilterValuesResponse:
    """Get available filter values for a folder path."""
    folder_path = Path(path).resolve()
    resolved_root = root_folder.resolve()

    try:
        folder_path.relative_to(resolved_root)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Path is outside the music library root.",
        ) from e

    collection.ensure_folder_indexed(folder_path, root_folder=resolved_root)

    result = collection.get_folder_filter_values(
        folder_path,
        recursive=recursive,
        search_query=search,
        genres=genres,
        keys=keys,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
        file_formats=file_formats,
        size_min=size_min,
        size_max=size_max,
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
    has_soundcloud_id: bool | None = Query(None, description="Filter by SoundCloud link presence"),
    file_formats: list[str] | None = Query(None, description="Filter by file format (e.g. mp3, flac)"),
    size_min: int | None = Query(None, ge=0, description="Minimum file size in bytes"),
    size_max: int | None = Query(None, ge=0, description="Maximum file size in bytes"),
    sort_by: str = Query("file_name", pattern=_SORT_BY_PATTERN),
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
            has_soundcloud_id=has_soundcloud_id,
            file_formats=file_formats,
            size_min=size_min,
            size_max=size_max,
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
    file_formats: list[str] | None = Query(None, description="Active file-format filters"),
    size_min: int | None = Query(None, ge=0, description="Active file-size minimum (bytes)"),
    size_max: int | None = Query(None, ge=0, description="Active file-size maximum (bytes)"),
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
            file_formats=file_formats,
            size_min=size_min,
            size_max=size_max,
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
    cache_db.delete_track(resolved_path)

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

    cache_db.delete_track(resolved_path)

    return OperationResponse(
        success=True,
        message=f"File deleted: {resolved_path.name}",
    )
