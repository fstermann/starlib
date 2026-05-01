"""
Metadata Service - Core business logic for track metadata operations.

This module contains pure functions extracted from the old Meta Editor.
No UI framework dependencies - only business logic.
"""

import logging
import shutil
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from backend.core.services import cache_db, rule_engine
from backend.core.services import folder_config as folder_config_service
from backend.core.services import ruleset as ruleset_service
from soundcloud_tools.handler.track import SIMPLE_TAG_FIELDS, StarlibMeta, TrackHandler, TrackInfo
from soundcloud_tools.utils.string import (
    remove_double_spaces,
    remove_free_dl,
    remove_mix,
    remove_remix,
    replace_underscores,
)

logger = logging.getLogger(__name__)


def _find_ffmpeg() -> str:
    """Return the path to the ffmpeg binary.

    Priority:
    1. Bundled binary inside the PyInstaller extraction dir (``sys._MEIPASS``) —
       present when running as a frozen desktop sidecar.
    2. Common Homebrew prefixes (``/opt/homebrew``, ``/usr/local``) — covers
       developer machines where Homebrew is installed but PATH is stripped by
       the macOS app sandbox.
    3. Whatever ``shutil.which`` finds on the current PATH.
    """
    # When frozen by PyInstaller, _MEIPASS is the temp dir containing bundled files.
    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / "ffmpeg"  # type: ignore[attr-defined]
        if bundled.exists():
            return str(bundled)

    for candidate in (
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "ffmpeg",
    ):
        found = shutil.which(candidate)
        if found:
            return found
    return "ffmpeg"


def prepare_search_query(filename: str) -> str:
    """
    Prepare a clean search query from a filename.

    Removes common noise: underscores, "Free DL" mentions, remix markers, double spaces.

    Parameters
    ----------
    filename : str
        Original filename (stem, without extension)

    Returns
    -------
    str
        Cleaned search query suitable for SoundCloud search

    Examples
    --------
    >>> prepare_search_query("Artist_Name_-_Track_Title_(Free_DL)_Remix")
    'Artist Name - Track Title'
    """
    return remove_double_spaces(remove_mix(remove_remix(replace_underscores(remove_free_dl(filename)))))


_REGISTRY_NAMES = {f.name for f in SIMPLE_TAG_FIELDS}


def _coerce_artist_field(value: Any) -> Any:
    """Split a comma-separated artist string into a list when appropriate."""
    if isinstance(value, str) and "," in value:
        parts = [a.strip() for a in value.split(",") if a.strip()]
        return parts[0] if len(parts) == 1 else parts
    return value


def build_modified_track_info(
    original_info: TrackInfo,
    updates: BaseModel | dict[str, Any] | None = None,
    *,
    artwork_url: str | None = None,
) -> TrackInfo:
    """Apply *updates* (a request model or dict) on top of *original_info*.

    Only registry-driven fields are applied here; ``artwork`` and the ``artwork_data``
    base64 payload are handled separately by the API layer.
    """
    if isinstance(updates, BaseModel):
        patch = updates.model_dump(exclude_unset=True)
    else:
        patch = dict(updates or {})

    data = original_info.model_dump()
    for name in _REGISTRY_NAMES:
        if name not in patch:
            continue
        value = patch[name]
        if name in {"artist", "original_artist", "remixer"}:
            value = _coerce_artist_field(value)
        elif name == "starlib_meta" and isinstance(value, str):
            value = StarlibMeta.from_str(value) if value else None
        data[name] = value

    # Drop binary artwork (handled separately by the API layer) and the URL
    # field (avoids re-triggering the network-fetching validator on every save).
    data.pop("artwork", None)
    if artwork_url is not None:
        data["artwork_url"] = artwork_url
    else:
        data.pop("artwork_url", None)
    return TrackInfo(**data)


def save_track_metadata(
    file_path: Path,
    root_folder: Path,
    track_info: TrackInfo,
) -> Path:
    """Write metadata to *file_path* and rename it to match the new title.

    Callers that want to clear remix tags should set ``original_artist``,
    ``remixer`` and ``mix_name`` to ``None`` on ``track_info`` before saving.
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)
    handler.add_info(track_info, artwork=track_info.artwork)
    return handler.rename(track_info.filename)


def apply_rules(
    file_path: Path,
    root_folder: Path,
) -> dict[str, str | bool]:
    """Apply the active ruleset to a track.

    The ruleset defines the ordered sequence of operations (convert, copy,
    move) executed against the file.  Resolution walks the file's parent
    folder ancestors for any folder-bound ruleset and falls back to the
    globally active one.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library

    Returns
    -------
    dict
        Result with keys: ``success``, ``message``, ``converted``, ``output_path``.
    """
    # Resolve ruleset from the file's parent folder, walking ancestors for
    # recursive bindings. Falls back to the globally active ruleset.
    resolved = folder_config_service.resolve_ruleset_for_path(str(file_path.parent))
    active = (
        ruleset_service.get_ruleset_by_id(resolved.ruleset_id)
        if resolved.ruleset_id
        else ruleset_service.get_active_ruleset()
    )
    return rule_engine.execute_ruleset(file_path, root_folder, active)


def delete_track_file(file_path: Path, root_folder: Path) -> None:
    """
    Delete an audio file.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)
    handler.delete()


def rename_track_file(
    file_path: Path,
    root_folder: Path,
    new_filename: str | None = None,
) -> Path:
    """
    Rename a track file based on its metadata.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    new_filename : str | None
        Optional explicit filename. If None, uses track_info.filename

    Returns
    -------
    Path
        New file path after renaming
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)

    if new_filename is None:
        new_filename = handler.track_info.filename

    return handler.rename(new_filename)


def get_track_info(file_path: Path, root_folder: Path) -> TrackInfo:
    """
    Read track information from an audio file.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library

    Returns
    -------
    TrackInfo
        Extracted track information
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)
    return handler.track_info


def check_file_readiness(file_path: Path, root_folder: Path) -> dict[str, bool | list[str] | int]:
    """
    Check if a file is ready for rule application.

    A file is ready when:
    - Metadata is complete (title, artist, genre, release_date, artwork)
    - Exactly 1 cover exists

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library

    Returns
    -------
    dict
        Status with keys:
        - "is_ready": bool
        - "missing_fields": list[str]
        - "issues": list[str]
        - "complete": bool (metadata completeness)
        - "covers_count": int
        - "has_one_cover": bool
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)
    track_info = handler.track_info
    covers_count = len(handler.covers)

    # Determine missing fields
    missing_fields = []
    if not track_info.title:
        missing_fields.append("title")
    if not track_info.artist:
        missing_fields.append("artist")
    if not track_info.genre:
        missing_fields.append("genre")
    if not track_info.release_date:
        missing_fields.append("release_date")
    if not track_info.artwork and covers_count == 0:
        missing_fields.append("artwork")

    # Determine issues
    issues = []
    if covers_count == 0:
        issues.append("No artwork found")
    elif covers_count > 1:
        issues.append(f"Multiple artworks found ({covers_count}), expected exactly 1")

    is_ready = track_info.complete and covers_count == 1

    return {
        "is_ready": is_ready,
        "missing_fields": missing_fields,
        "issues": issues,
        "complete": track_info.complete,
        "covers_count": covers_count,
        "has_one_cover": covers_count == 1,
    }


def get_artwork_covers(file_path: Path, root_folder: Path) -> list[bytes]:
    """
    Get all artwork covers from an audio file.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library

    Returns
    -------
    list[bytes]
        List of cover image data (JPEG bytes)
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)
    return [cover.data for cover in handler.covers]


def add_artwork_to_track(
    file_path: Path,
    root_folder: Path,
    artwork_data: bytes,
) -> None:
    """
    Add artwork to a track file.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    artwork_data : bytes
        JPEG image data
    """
    from mutagen.id3 import APIC

    handler = TrackHandler(root_folder=root_folder, file=file_path)

    track = handler.track

    track.tags.delall("APIC")
    track.tags.add(
        APIC(
            encoding=3,
            mime="image/jpeg",
            type=3,
            desc="Cover",
            data=artwork_data,
        )
    )
    track.save()


def remove_all_artwork_from_track(
    file_path: Path,
    root_folder: Path,
) -> None:
    """
    Remove all artwork from a track file.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)
    track = handler.track
    track.tags.delall("APIC")
    track.save()


def extract_artwork(file_path: Path, root_folder: Path, cache_dir: Path | None = None) -> Path | None:
    """
    Extract artwork from an audio file, caching it to disk.

    On first call for a given file the cover bytes are extracted from the audio
    file and written to ``<cache_dir>/artwork/<sha256>.jpg``.  Subsequent calls
    return the cached path immediately without re-reading the audio file.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    cache_dir : Path | None
        Directory used for persistent caching.  When *None* the artwork is
        written to a temporary file (legacy behaviour).

    Returns
    -------
    Path | None
        Path to the artwork file, or None if no artwork found
    """
    import hashlib
    import tempfile

    # Check disk cache first (fast path - no audio file read needed).
    if cache_dir is not None:
        art_cache_dir = cache_dir / "artwork"
        key = hashlib.sha256(str(file_path).encode()).hexdigest()
        cached_path = art_cache_dir / f"{key}.jpg"
        if cached_path.exists():
            return cached_path

    handler = TrackHandler(root_folder=root_folder, file=file_path)
    covers = handler.covers

    if not covers:
        return None

    cover_data = covers[0].data

    if cache_dir is not None:
        art_cache_dir.mkdir(parents=True, exist_ok=True)
        cached_path.write_bytes(cover_data)
        return cached_path

    # Fallback: write to a temp file (legacy / no cache_dir).
    temp_file = Path(tempfile.mkstemp(suffix=".jpg")[1])
    temp_file.write_bytes(cover_data)
    return temp_file


def embed_artwork(file_path: Path, root_folder: Path, artwork_path: Path) -> None:
    """
    Embed artwork from an image file into an audio file.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    artwork_path : Path
        Path to the artwork image file
    """
    artwork_data = artwork_path.read_bytes()
    add_artwork_to_track(file_path, root_folder, artwork_data)


def remove_artwork(file_path: Path, root_folder: Path) -> None:
    """
    Remove all artwork from an audio file.

    Alias for remove_all_artwork_from_track for API compatibility.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    """
    remove_all_artwork_from_track(file_path, root_folder)


def get_waveform_peaks(file_path: Path, cache_dir: Path, num_peaks: int = 200) -> list[float]:
    """
    Compute amplitude peak data for waveform visualization.

    Decodes audio to mono PCM via ffmpeg, computes max absolute amplitude per
    chunk, normalizes to [0, 1], and caches the result in SQLite.

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    cache_dir : Path
        Kept for backwards-compatible signature; no longer used.
    num_peaks : int
        Number of peak values to return (default 200)

    Returns
    -------
    list[float]
        Normalized amplitude peaks in range [0, 1]
    """
    mtime = file_path.stat().st_mtime
    cached = cache_db.get_peaks(file_path, mtime, num_peaks)
    if cached is not None:
        return cached

    # Decode to raw signed f32le PCM (mono, 8 kHz) via ffmpeg
    cmd = [
        _find_ffmpeg(),
        "-i",
        str(file_path),
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "f32le",
        "-v",
        "quiet",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=120)
    if proc.returncode != 0:
        return [0.0] * num_peaks

    raw = proc.stdout
    n = len(raw) // 4
    if n == 0:
        return [0.0] * num_peaks

    samples = struct.unpack(f"{n}f", raw)
    chunk_size = max(1, n // num_peaks)

    peaks = []
    for i in range(num_peaks):
        start = i * chunk_size
        end = min(start + chunk_size, n)
        chunk = samples[start:end]
        peaks.append(max(abs(s) for s in chunk) if chunk else 0.0)

    max_val = max(peaks) or 1.0
    normalized = [p / max_val for p in peaks]

    cache_db.upsert_peaks(file_path, normalized, mtime)
    return normalized
