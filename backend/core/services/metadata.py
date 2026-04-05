"""
Metadata Service - Core business logic for track metadata operations.

This module contains pure functions extracted from the old Meta Editor.
No UI framework dependencies - only business logic.
"""

import logging
import struct
import subprocess
from datetime import date
from pathlib import Path
from typing import Literal

from backend.core.services import cache_db
from soundcloud_tools.handler.track import TrackHandler, TrackInfo
from soundcloud_tools.utils.string import (
    remove_double_spaces,
    remove_free_dl,
    remove_mix,
    remove_remix,
    replace_underscores,
)

logger = logging.getLogger(__name__)


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


def build_modified_track_info(
    original_info: TrackInfo,
    title: str | None = None,
    artist: str | None = None,
    bpm: int | None = None,
    key: str | None = None,
    genre: str | None = None,
    comment: str | None = None,
    release_date: date | None = None,
    remixers: list[str] | None = None,
    artwork_url: str | None = None,
) -> TrackInfo:
    """
    Build a modified TrackInfo object from individual field values.

    This is the core transformation that takes user-edited fields and
    produces a complete TrackInfo object ready for writing to file.

    Parameters
    ----------
    original_info : TrackInfo
        Original track information
    title : str | None
        Modified title (or None to keep original)
    artist : str | None
        Modified artist(s) (or None to keep original)
    bpm : int | None
        Modified BPM (or None to keep original)
    key : str | None
        Modified key (or None to keep original)
    genre : str | None
        Modified genre (or None to keep original)
    comment : str | None
        Modified comment (or None to keep original)
    release_date : date | None
        Modified release date (or None to keep original)
    remixers : list[str] | None
        List of remixer names (or None to keep original)
    artwork_url : str | None
        URL to fetch artwork from (or None to keep original)

    Returns
    -------
    TrackInfo
        Complete track info ready for writing
    """
    from soundcloud_tools.handler.track import Comment as CommentModel
    from soundcloud_tools.handler.track import Remix

    # Use original values if not provided
    final_title = title if title is not None else original_info.title
    final_bpm = bpm if bpm is not None else original_info.bpm
    final_key = key if key is not None else original_info.key
    final_genre = genre if genre is not None else original_info.genre
    final_release_date = release_date if release_date is not None else original_info.release_date
    final_artwork_url = artwork_url if artwork_url is not None else original_info.artwork_url

    # Parse artist
    if artist is not None:
        # Parse artists if comma-separated string
        if isinstance(artist, str) and "," in artist:
            artists = [a.strip() for a in artist.split(",")]
            final_artist = artists[0] if len(artists) == 1 else artists
        else:
            final_artist = artist
    else:
        final_artist = original_info.artist

    # Handle remix - convert list of remixers to Remix object
    final_remix = None
    if remixers is not None and len(remixers) > 0:
        # Use first remixer if multiple provided
        final_remix = Remix(
            remixer=remixers[0],
            original_artist=original_info.artist_str if original_info.artist_str else "",
            mix_name=None,
        )
    else:
        final_remix = original_info.remix

    # Handle comment - parse from string to Comment object if provided
    final_comment = None
    if comment is not None:
        final_comment = CommentModel.from_str(comment)
    else:
        final_comment = original_info.comment

    return TrackInfo(
        title=final_title,
        artist=final_artist,
        bpm=final_bpm,
        key=final_key,
        genre=final_genre,
        release_date=final_release_date,
        artwork_url=final_artwork_url,
        remix=final_remix,
        comment=final_comment,
    )


def save_track_metadata(
    file_path: Path,
    root_folder: Path,
    track_info: TrackInfo,
    remove_remix: bool = False,
) -> Path:
    """
    Save metadata to an audio file and rename it.

    This performs the core "save" operation:
    1. Write metadata to file
    2. Remove remix tags if requested
    3. Rename file based on new metadata

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    track_info : TrackInfo
        Track information to write
    remove_remix : bool
        Whether to remove remix tags from the file

    Returns
    -------
    Path
        New file path after renaming
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)

    # Write metadata
    handler.add_info(track_info, artwork=track_info.artwork)

    # Remove remix tags if not a remix
    if remove_remix:
        handler.remove_remix()

    # Rename file based on metadata
    new_path = handler.rename(track_info.filename)

    return new_path


def finalize_track(
    file_path: Path,
    root_folder: Path,
    target_format: Literal["mp3", "aiff"],
) -> dict[str, str | bool]:
    """
    Finalize a track: convert format if needed, move to cleaned folder.

    This is the complete finalization workflow:
    - If format matches target: move to cleaned
    - If format differs: convert, copy metadata, archive original, move to cleaned

    Parameters
    ----------
    file_path : Path
        Path to the audio file
    root_folder : Path
        Root folder for the music library
    target_format : Literal["mp3", "aiff"]
        Target format for finalization

    Returns
    -------
    dict
        Result with keys:
        - "success": bool
        - "message": str
        - "converted": bool
        - "output_path": str (if successful)
    """
    handler = TrackHandler(root_folder=root_folder, file=file_path)

    # Check if format matches target
    if handler.file.suffix == f".{target_format}":
        # No conversion needed, just move
        handler.move_to_cleaned()
        return {
            "success": True,
            "message": "Moved to cleaned folder",
            "converted": False,
            "output_path": str(handler.file),
        }

    # Need to convert
    conversion_success = False

    if target_format == "mp3":
        conversion_success = handler.convert_to_mp3()
        if conversion_success:
            handler.add_mp3_info()
            handler.archive()
        else:
            # Conversion failed, move anyway
            handler.move_to_cleaned()
            return {
                "success": True,
                "message": "Conversion failed, moved original to cleaned",
                "converted": False,
                "output_path": str(handler.file),
            }

    elif target_format == "aiff":
        conversion_success = handler.convert_to_aiff()
        if conversion_success:
            handler.add_aiff_info()
            handler.archive()
        else:
            # Conversion failed, move anyway
            handler.move_to_cleaned()
            return {
                "success": True,
                "message": "Conversion failed, moved original to cleaned",
                "converted": False,
                "output_path": str(handler.file),
            }

    return {
        "success": True,
        "message": "Converted and moved to cleaned",
        "converted": True,
        "output_path": str(handler.mp3_file if target_format == "mp3" else handler.file),
    }


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
    Check if a file is ready for finalization.

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
        "ffmpeg",
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
