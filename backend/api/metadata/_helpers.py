"""Shared helpers for metadata route modules."""

from datetime import date
from pathlib import Path

from fastapi import HTTPException, status

from backend.api.deps import validate_folder_mode
from backend.domain.tags import SIMPLE_TAG_FIELDS, TrackInfo
from backend.services.collection import folders


def resolve_folder(mode: str, root_folder: Path) -> Path:
    """Resolve a folder mode string to an absolute path, validating it exists."""
    validated_mode = validate_folder_mode(mode)
    folder_path = root_folder / validated_mode if validated_mode else root_folder

    is_valid, errors = folders.validate_folder(folder_path)
    if not is_valid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=errors)

    return folder_path


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
