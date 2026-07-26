"""Read-only views over an indexed folder: the tree, paged browsing, filter values."""

import logging
import os
from collections.abc import Iterable
from datetime import date
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi_pagination import Page, paginate
from fastapi_pagination.api import create_page, resolve_params

from backend.api.deps import get_root_folder, validate_folder_mode
from backend.api.metadata._helpers import _row_to_browse_dict, _row_value, resolve_folder
from backend.infra import cache
from backend.infra.audio.folders import FolderHandler
from backend.infra.audio.track_handler import TrackHandler
from backend.schemas.metadata import (
    FileInfoResponse,
    FilterValuesResponse,
    TrackBrowseResponse,
)
from backend.schemas.tree import TreeNode
from backend.services.collection import folders, indexing, query

logger = logging.getLogger(__name__)

router = APIRouter()

_SORT_BY_PATTERN = "^(title|artist|genre|bpm|key|release_date|file_name|folder|mtime|file_format|file_size|duration)$"


def _folder_tree_dict(root_str: str, track_folders: Iterable[str]) -> dict:
    """Build a nested folder-name dict from track folders and on-disk dirs.

    Args:
        root_str: Resolved root folder path as a string.
        track_folders: Absolute paths of folders containing indexed tracks.

    Returns:
        Nested dict mapping folder name to its children dict.
    """
    tree: dict = {}

    def _insert(fp: str) -> None:
        # Make path relative to root; skip entries outside root
        if not fp.startswith(root_str):
            return
        rel = fp[len(root_str) :]
        if rel.startswith("/"):
            rel = rel[1:]
        parts = rel.split("/") if rel else []
        node = tree
        for part in parts:
            node = node.setdefault(part, {})

    for fp in track_folders:
        _insert(fp)

    # Also walk the filesystem so directories without indexed tracks (empty
    # folders) appear in the tree.
    for dirpath, dirnames, _ in os.walk(root_str):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for d in dirnames:
            _insert(f"{dirpath}/{d}")

    return tree


@router.get("/folders/tree", response_model=TreeNode)
def get_folder_tree(
    root_folder: Annotated[Path, Depends(get_root_folder)],
    search: str | None = Query(None),
    genres: list[str] | None = Query(None),
    keys: list[str] | None = Query(None),
    bpm_min: int | None = Query(None, ge=0),
    bpm_max: int | None = Query(None, ge=0),
    has_soundcloud_id: bool | None = Query(None),
    file_formats: list[str] | None = Query(None),
    size_min: int | None = Query(None, ge=0),
    size_max: int | None = Query(None, ge=0),
) -> TreeNode:
    """Return the folder tree built from indexed tracks and on-disk directories.

    Every directory under the root is included — empty folders too. Hidden
    (dot-prefixed) directories are skipped, matching the indexer.

    ``track_count`` is always the unfiltered recursive total, so the tree
    structure is stable. When any filter argument is supplied, each node's
    ``filtered_count`` carries the recursive count of tracks matching those
    filters (``None`` otherwise).
    """
    root_str = str(root_folder.resolve())
    folder_counts = cache.get_folder_track_counts()

    has_filters = any(
        v is not None
        for v in (search, genres, keys, bpm_min, bpm_max, has_soundcloud_id, file_formats, size_min, size_max)
    )
    filtered_counts = (
        cache.get_folder_track_counts(
            search_query=search,
            genres=genres,
            keys=keys,
            bpm_min=bpm_min,
            bpm_max=bpm_max,
            has_soundcloud_id=has_soundcloud_id,
            file_formats=file_formats,
            size_min=size_min,
            size_max=size_max,
        )
        if has_filters
        else None
    )

    # Build nested dict from flat folder paths (always the unfiltered set, so
    # folders never disappear when a filter narrows the counts).
    tree = _folder_tree_dict(root_str, folder_counts)

    def _build(name: str, abs_path: str, children_dict: dict) -> TreeNode:
        children = [_build(k, f"{abs_path}/{k}", v) for k, v in sorted(children_dict.items())]
        total = folder_counts.get(abs_path, 0) + sum(c.track_count for c in children)
        filtered = None
        if filtered_counts is not None:
            filtered = filtered_counts.get(abs_path, 0) + sum(c.filtered_count or 0 for c in children)
        return TreeNode(id=abs_path, name=name, children=children, track_count=total, filtered_count=filtered)

    root_name = root_folder.name
    children = [_build(k, f"{root_str}/{k}", v) for k, v in sorted(tree.items())]
    total = folder_counts.get(root_str, 0) + sum(c.track_count for c in children)
    filtered_root = None
    if filtered_counts is not None:
        filtered_root = filtered_counts.get(root_str, 0) + sum(c.filtered_count or 0 for c in children)
    return TreeNode(id=root_str, name=root_name, children=children, track_count=total, filtered_count=filtered_root)


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

    indexing.ensure_folder_indexed(folder_path, root_folder=resolved_root)

    # Page in SQL. Materialising the whole folder and slicing it in Python
    # costs the full row set on every page request.
    params = resolve_params()
    raw = params.to_raw_params().as_limit_offset()

    try:
        total = query.count_filtered_tracks(
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
            recursive=recursive,
        )
        pairs = query.list_and_filter_tracks(
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
            recursive=recursive,
            sort_by=sort_by,
            sort_order=sort_order,
            limit=raw.limit,
            offset=raw.offset,
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

    if indexing.is_indexing(folder_path):
        response.headers["X-Cache-Loading"] = "true"

    return create_page([to_browse_response(row) for row in pairs], total=total, params=params)


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

    indexing.ensure_folder_indexed(folder_path, root_folder=resolved_root)

    result = query.get_folder_filter_values(
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

    is_valid, _ = folders.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder does not exist",
        )

    files = [f for f in folders.list_audio_files(folder_path) if f.suffix != ".asd"]

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

    # Page in SQL. Materialising the whole folder and slicing it in Python
    # costs the full row set on every page request.
    params = resolve_params()
    raw = params.to_raw_params().as_limit_offset()

    try:
        total = query.count_filtered_tracks(
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
        )
        pairs = query.list_and_filter_tracks(
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
            limit=raw.limit,
            offset=raw.offset,
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

    if indexing.is_indexing(folder_path):
        response.headers["X-Cache-Loading"] = "true"

    return create_page([to_browse_response(row) for row in pairs], total=total, params=params)


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
        values = query.get_folder_filter_values(
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
