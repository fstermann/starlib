"""Reading the collection back out: listing, filtering, aggregate stats.

Every entry point calls :func:`~backend.services.collection.indexing.ensure_folder_indexed`
first, so a query always reflects what is currently on disk.
"""

import logging
from datetime import date
from pathlib import Path

from backend.infra import cache
from backend.services.collection.indexing import ensure_folder_indexed

logger = logging.getLogger(__name__)


def get_collection_soundcloud_ids(folder: Path) -> list[int]:
    """Return all SoundCloud track IDs linked to collection tracks."""
    ensure_folder_indexed(folder)
    return cache.get_soundcloud_ids(folder)


def get_collection_metadata_stats(folder: Path) -> dict:
    """
    Get statistics and filter values for a collection folder.

    Parameters
    ----------
    folder : Path
        Folder containing tracks

    Returns
    -------
    dict
        Keys: total_tracks, complete_tracks, incomplete_tracks, total_artists,
        total_genres, missing_fields, genres, artists, keys, bpm_min, bpm_max
    """
    ensure_folder_indexed(folder)
    return cache.get_stats(folder.resolve())


def list_and_filter_tracks(
    folder: Path,
    search_query: str | None = None,
    genres: list[str] | None = None,
    artists: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    sort_by: str = "file_name",
    sort_order: str = "asc",
    recursive: bool = False,
    has_soundcloud_id: bool | None = None,
    file_formats: list[str] | None = None,
    size_min: int | None = None,
    size_max: int | None = None,
) -> list:
    """
    List, filter, and sort tracks via SQL. Returns sqlite3.Row items.

    Parameters
    ----------
    folder : Path
        Folder to scan
    search_query : str, optional
        Case-insensitive substring search across title, artist, genre
    genres : list[str], optional
        Exact genre matches (OR logic)
    artists : list[str], optional
        Substring artist matches (OR logic)
    keys : list[str], optional
        Exact key matches (OR logic)
    bpm_min : int, optional
        Minimum BPM (inclusive)
    bpm_max : int, optional
        Maximum BPM (inclusive)
    start_date : date, optional
        Earliest release date (inclusive)
    end_date : date, optional
        Latest release date (inclusive)
    sort_by : str
        Field to sort by: title, artist, genre, bpm, key, release_date, file_name
    sort_order : str
        "asc" or "desc"
    recursive : bool
        Include tracks in subfolders

    Returns
    -------
    list[sqlite3.Row]
        Filtered and sorted track rows from the DB cache.
    """
    ensure_folder_indexed(folder)
    return cache.get_tracks(
        folder.resolve(),
        recursive=recursive,
        search_query=search_query,
        genres=genres,
        artists=artists,
        keys=keys,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
        start_date=start_date,
        end_date=end_date,
        has_soundcloud_id=has_soundcloud_id,
        file_formats=file_formats,
        size_min=size_min,
        size_max=size_max,
        sort_by=sort_by,
        sort_order=sort_order,
    )


def get_folder_filter_values(
    folder: Path,
    *,
    recursive: bool = False,
    search_query: str | None = None,
    genres: list[str] | None = None,
    keys: list[str] | None = None,
    bpm_min: int | None = None,
    bpm_max: int | None = None,
    file_formats: list[str] | None = None,
    size_min: int | None = None,
    size_max: int | None = None,
) -> dict:
    """
    Get available filter values for a folder (for filter dropdowns).

    Parameters
    ----------
    folder : Path
        Folder to scan
    recursive : bool
        Include tracks in subfolders
    search_query : str, optional
        Active search filter (used to compute faceted counts)
    genres : list[str], optional
        Active genre filters (excluded from genre facet counts)
    keys : list[str], optional
        Active key filters (excluded from key facet counts)
    bpm_min : int, optional
        Active BPM minimum filter
    bpm_max : int, optional
        Active BPM maximum filter

    Returns
    -------
    dict
        Keys: genres, genre_counts, artists, keys, key_counts, bpm_min, bpm_max
    """
    ensure_folder_indexed(folder)
    return cache.get_filter_values(
        folder.resolve(),
        recursive=recursive,
        search_query=search_query,
        genres=genres,
        keys=keys,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
        file_formats=file_formats,
        size_min=size_min,
        size_max=size_max,
    )
