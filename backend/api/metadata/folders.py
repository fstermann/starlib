"""Folder setup routes: creating the library layout and pulling in downloads."""

import logging
import shutil
import time
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from backend.api.deps import get_root_folder
from backend.infra.audio.folders import FILETYPE_MAP
from backend.schemas.metadata import (
    FetchCandidate,
    FetchFromDownloadsPreview,
    FetchFromDownloadsRequest,
    FetchFromDownloadsResponse,
    OperationResponse,
)
from backend.services.collection import indexing

logger = logging.getLogger(__name__)

router = APIRouter()


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
            indexing.reindex_file(resolved_root, target)
        except Exception:
            logger.exception("Failed to reindex %s after move", target)
        moved.append(src.name)

    return FetchFromDownloadsResponse(moved=moved, skipped=skipped, errors=errors)
