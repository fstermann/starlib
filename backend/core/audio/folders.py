from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from mutagen.aiff import AIFF
from mutagen.mp3 import MP3
from mutagen.wave import WAVE
from pydantic import BaseModel, field_validator

FILETYPE_MAP = {
    ".mp3": MP3,
    ".aif": AIFF,
    ".aiff": AIFF,
    ".wav": WAVE,
}


class FolderHandler(BaseModel):
    folder: Path

    @field_validator("folder", mode="before")
    @classmethod
    def check_folder(cls, v) -> Path:
        if isinstance(v, str):
            v = Path(v)
        v = v.expanduser()
        if not v.is_dir():
            raise ValueError(f"Path {v} is not a directory")
        return v

    def move_all_audio_files(self, target: Path, *filters: Callable[[Path], bool]):
        for file in self.collect_audio_files(*filters):
            file.rename(target.joinpath(file.name))

    def collect_audio_files(self, *filters: Callable[[Path], bool], use_default: bool = True) -> list[Path]:
        if use_default:
            filters += (lambda f: f.suffix in FILETYPE_MAP,)
        return [file for file in self.folder.glob("*.*") if all(f(file) for f in filters)]

    @property
    def has_audio_files(self) -> bool:
        return self.folder.is_dir() and any(self.collect_audio_files())

    def get_prepare_folder(self) -> Path:
        """Get the prepare subfolder."""
        return self.folder / "prepare"

    def get_collection_folder(self) -> Path:
        """Get the collection subfolder."""
        return self.folder / "collection"

    def get_cleaned_folder(self) -> Path:
        """Get the cleaned subfolder."""
        return self.folder / "cleaned"

    @staticmethod
    def last_modified(path: Path) -> datetime:
        return datetime.fromtimestamp(path.lstat().st_atime)


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
