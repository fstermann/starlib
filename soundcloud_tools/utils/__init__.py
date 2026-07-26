from pathlib import Path
from typing import Any


def convert_to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def load_tracks(folder: Path, file_types: list[str] | None = None):
    files = list(folder.glob("*"))
    files = [
        f
        for f in files
        if f.is_file() and (f.suffix in file_types if file_types else True) and not f.stem.startswith(".")
    ]
    files.sort(key=lambda f: f.name)
    return files


def load_tracks_recursive(folder: Path, file_types: list[str] | None = None) -> list[Path]:
    """Like ``load_tracks`` but recurses into subdirectories."""
    files = [
        f
        for f in folder.rglob("*")
        if f.is_file() and (f.suffix in file_types if file_types else True) and not f.stem.startswith(".")
    ]
    files.sort(key=lambda f: f.name)
    return files
