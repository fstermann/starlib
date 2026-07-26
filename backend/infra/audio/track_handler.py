"""Read and write track metadata on disk.

Adapter over ``mutagen`` (ID3 frames) and ``ffmpeg`` (format conversion).
The pure tag vocabulary and the :class:`~backend.domain.tags.TrackInfo` model
it produces live in :mod:`backend.domain.tags`.
"""

import logging
import shutil
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Literal, Self

import mutagen
from mutagen.easyid3 import EasyID3
from mutagen.id3 import APIC, ID3, TCON
from pydantic import BaseModel, field_validator

from backend.domain.tags import (
    SIMPLE_TAG_FIELDS,
    SIMPLE_TAG_FIELDS_BY_NAME,
    StarlibMeta,
    TrackInfo,
    deserialize_list,
)
from backend.infra.audio.folders import FILETYPE_MAP, load_tracks

logger = logging.getLogger(__name__)


def _find_binary(name: str) -> str:
    """Resolve *name* (ffmpeg or ffprobe) to an absolute path.

    Checks (in order):
    1. Bundled binary in the PyInstaller extraction dir (sys._MEIPASS).
    2. Common Homebrew prefixes - PATH is often stripped in the macOS app sandbox.
    3. Whatever shutil.which finds on the current PATH.
    """
    if getattr(sys, "frozen", False):
        bundled = Path(sys._MEIPASS) / name  # type: ignore[attr-defined]
        if bundled.exists():
            return str(bundled)
    for candidate in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}", name):
        found = shutil.which(candidate)
        if found:
            return found
    return name


def _run_ffmpeg(command: list[Any]) -> None:
    """Run an ffmpeg command with its stdio detached from the parent's.

    ffmpeg inherits the parent's stdout/stderr by default. When the backend runs
    without a reader on those pipes, ffmpeg's progress output triggers SIGPIPE and
    the conversion dies mid-encode. Capturing the output keeps it alive and lets us
    surface ffmpeg's own error message instead of a bare signal.

    Raises
    ------
    RuntimeError
        If ffmpeg exits with a non-zero status.
    """
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"ffmpeg failed (exit {result.returncode}): {stderr[-2000:] or '(no stderr)'}")


class TrackHandler(BaseModel):
    root_folder: Path
    file: Path
    bitrate: int = 320

    @field_validator("root_folder", "file", mode="before")
    @classmethod
    def check_paths(cls, v) -> Path:
        if isinstance(v, str):
            v = Path(v)
        return v

    @classmethod
    def load_all(cls, root_folder: Path) -> list[Self]:
        return [cls(root_folder=root_folder, file=f) for f in load_tracks(root_folder, list(FILETYPE_MAP))]

    @classmethod
    def load_track_infos(cls, folder: Path):
        return [t.track_info for t in cls.load_all(folder)]

    @property
    def cleaned_folder(self):
        return self.root_folder / "cleaned"

    @property
    def prepare_folder(self):
        return self.root_folder / "prepare"

    @property
    def archive_folder(self):
        return self.root_folder / "archive"

    def delete(self):
        self.file.unlink()
        return

    @property
    def mp3_file(self):
        return self.cleaned_folder / (self.file.stem + ".mp3")

    @property
    def aiff_file(self):
        return self.cleaned_folder / (self.file.stem + ".aiff")

    @property
    def is_lossless(self) -> bool:
        """Check if the file is in a lossless format."""
        lossless_extensions = {".aif", ".aiff", ".wav", ".flac", ".alac"}
        return self.file.suffix.lower() in lossless_extensions

    @property
    def track(self):
        class_ = FILETYPE_MAP.get(Path(self.file).suffix, EasyID3)
        obj = class_(self.file)
        if not hasattr(obj, "tags") or obj.tags is None:
            obj.add_tags()
        return obj

    @staticmethod
    def _get_tag_value(track: mutagen.FileType, tag: str, default: Any = "") -> str:
        return str(track.tags.get(tag, default))

    @staticmethod
    def _get_tag_list_value(track: mutagen.FileType, tag: str, default: Any = "") -> list[str]:
        value = TrackHandler._get_tag_value(track, tag, default=default)
        return value.split("\u0000") if "\u0000" in value else deserialize_list(value)

    def _read_simple(self, track) -> dict[str, Any]:
        """Read every registry-driven tag off *track* into a TrackInfo-ready dict."""
        out: dict[str, Any] = {}
        for f in SIMPLE_TAG_FIELDS:
            if f.is_list:
                values = self._get_tag_list_value(track, f.key)
                cleaned = [v for v in values if v]
                out[f.name] = cleaned or None
            else:
                raw = self._get_tag_value(track, f.key)
                if not raw:
                    out[f.name] = None
                    continue
                out[f.name] = f.from_str(raw) if f.from_str else raw

        # Legacy fallback: starlib data used to live in COMM::XXX.
        # If TXXX:starlib is empty, try the old slot. If it parses to something
        # meaningful, treat it as starlib data; otherwise route it to user_comment.
        if not out.get("starlib_meta"):
            legacy = self._get_tag_value(track, "COMM::XXX")
            if legacy:
                try:
                    parsed = StarlibMeta.from_str(legacy)
                except Exception:
                    parsed = StarlibMeta()
                if not parsed.is_empty:
                    out["starlib_meta"] = parsed
                elif not out.get("user_comment"):
                    out["user_comment"] = legacy
        return out

    @property
    def track_info(self):
        track = self.track
        data = self._read_simple(track)
        return TrackInfo(
            **data,
            artwork=self.get_single_cover(raise_error=False),
            length=track.info.length if hasattr(track, "info") else None,
        )

    @property
    def covers(self):
        return self.track.tags.getall("APIC")

    def get_single_cover(self, raise_error: bool = True):
        if len(self.covers) != 1:
            if raise_error:
                raise ValueError("Track has more than one cover")
            return self.covers[0].data if self.covers else None
        return self.covers[0].data

    def convert_to_mp3(self):
        if not self.cleaned_folder.exists():
            self.cleaned_folder.mkdir(parents=True)
        command = [
            _find_binary("ffmpeg"),
            "-i",
            self.file,
            "-c:a",
            "libmp3lame",
            "-b:a",
            f"{self.bitrate}k",
            "-y",
            self.mp3_file,
        ]
        _run_ffmpeg(command)
        return self.mp3_file

    def convert_to_aiff(self):
        """
        Convert lossless audio file to AIFF format.
        Preserves the original bit depth (16-bit, 24-bit, 32-bit, etc.).

        Returns
        -------
        Path
            Path to the converted AIFF file

        Raises
        ------
        ValueError
            If the source file is not lossless (e.g., MP3)
        """
        if not self.is_lossless:
            logger.warning(
                f"Cannot convert {self.file.suffix} to AIFF: source file is not lossless. "
                f"Lossless formats: .aif, .aiff, .wav, .flac, .alac"
            )
            return None

        if not self.cleaned_folder.exists():
            self.cleaned_folder.mkdir(parents=True)

        # Detect bit depth using ffprobe
        probe_command = [
            _find_binary("ffprobe"),
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=bits_per_raw_sample,sample_fmt",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            self.file,
        ]
        result = subprocess.run(probe_command, capture_output=True, text=True, check=True)
        output_lines = result.stdout.strip().split("\n")

        # Parse bit depth - ffprobe returns bits_per_raw_sample first, then sample_fmt
        bit_depth = None
        sample_fmt = None

        for line in output_lines:
            if line and line.isdigit():
                bit_depth = int(line)
            elif line:
                sample_fmt = line

        # Determine appropriate PCM codec based on bit depth
        # Default to 16-bit if we can't determine
        if bit_depth == 24 or (sample_fmt and "s32" in sample_fmt):
            codec = "pcm_s24be"  # 24-bit PCM big-endian
        elif bit_depth == 32 or (sample_fmt and ("s32" in sample_fmt or "f32" in sample_fmt)):
            codec = "pcm_s32be"  # 32-bit PCM big-endian
        else:
            codec = "pcm_s16be"  # 16-bit PCM big-endian (default/most common)

        logger.info(
            f"Converting {self.file.name} to AIFF with codec {codec} (detected: {bit_depth}-bit, format: {sample_fmt})"
        )

        command = [
            _find_binary("ffmpeg"),
            "-i",
            self.file,
            "-c:a",
            codec,
            "-y",
            self.aiff_file,
        ]
        _run_ffmpeg(command)
        return self.aiff_file

    def move_to_cleaned(self):
        if not self.cleaned_folder.exists():
            self.cleaned_folder.mkdir(parents=True)
        safe_name = self.file.name.replace("/", "-")
        self.file.rename(self.cleaned_folder / safe_name)

    def set_genre(self, genre: str):
        track = self.track
        track.tags.delall("TCON")
        track.tags.add(TCON(encoding=3, text=genre))
        track.save()

    def clear_tags(self, field_names: Iterable[str]) -> None:
        """Delete the given registry fields from the track and save."""
        track = self.track
        for name in field_names:
            field_def = SIMPLE_TAG_FIELDS_BY_NAME.get(name)
            if field_def is None:
                raise KeyError(f"Unknown tag field: {name}")
            track.tags.delall(field_def.key)
        track.save()

    def _write_simple(self, track, info: TrackInfo) -> None:
        """Write every registry-driven tag from *info* onto *track*."""
        for f in SIMPLE_TAG_FIELDS:
            value = getattr(info, f.name)
            if f.is_list:
                text = TrackInfo._join_artists(value) if value else ""
            elif value in (None, ""):
                text = ""
            else:
                text = f.to_str(value) if f.to_str else str(value)

            track.delall(f.key)
            if not text:
                continue
            track.add(f.frame(encoding=3, text=text, **f.frame_kwargs))

        # One-shot migration: evict legacy COMM::XXX so it doesn't shadow our
        # new TXXX:starlib payload or the user's COMM::eng comment.
        track.delall("COMM::XXX")

    def _add_info(self, track, info: TrackInfo, artwork: bytes | None = None):
        self._write_simple(track, info)
        if artwork:
            track.delall("APIC")
            track.add(
                APIC(
                    encoding=3,
                    mime="image/png",
                    type=3,
                    desc="Cover",
                    data=artwork,
                )
            )

    def add_info(self, info: TrackInfo, artwork: bytes | None = None):
        track = self.track
        self._add_info(track.tags, info=info, artwork=artwork)
        track.save()

    def add_mp3_info(self):
        track = ID3(str(self.mp3_file))
        self._add_info(track, info=self.track_info, artwork=self.get_single_cover())
        track.save()

    def add_aiff_info(self):
        try:
            track = EasyID3(str(self.aiff_file))
        except mutagen.id3.ID3NoHeaderError:
            track = mutagen.File(str(self.aiff_file), easy=True)
            track.add_tags()
        self._add_info(track.tags, info=self.track_info, artwork=self.get_single_cover())
        track.save(str(self.aiff_file))

    def archive(self):
        if not self.archive_folder.exists():
            self.archive_folder.mkdir(parents=True)
        self.file.rename(self.archive_folder / self.file.name)

    def archive_to(self, folder: Path) -> None:
        """Archive original file to an arbitrary folder, creating it if needed."""
        folder.mkdir(parents=True, exist_ok=True)
        self.file.rename(folder / self.file.name)

    def copy_to(self, folder: Path) -> Path:
        """Copy file to an arbitrary folder (leaving the original in place).

        Creates the destination folder if needed and returns the path of the
        new copy.
        """
        folder.mkdir(parents=True, exist_ok=True)
        safe_name = self.file.name.replace("/", "-")
        dest = folder / safe_name
        shutil.copy2(self.file, dest)
        return dest

    def move_to(self, folder: Path) -> Path:
        """Move file to an arbitrary folder, creating it if needed. Returns new path."""
        folder.mkdir(parents=True, exist_ok=True)
        safe_name = self.file.name.replace("/", "-")
        new_path = folder / safe_name
        self.file.rename(new_path)
        return new_path

    def _detect_aiff_codec(self) -> str:
        """Detect appropriate PCM codec for AIFF conversion based on source bit depth."""
        probe_command: list[str] = [
            _find_binary("ffprobe"),
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=bits_per_raw_sample,sample_fmt",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(self.file),
        ]
        result = subprocess.run(probe_command, capture_output=True, text=True, check=True)
        output_lines = result.stdout.strip().split("\n")
        bit_depth = None
        sample_fmt = None
        for line in output_lines:
            if line and line.isdigit():
                bit_depth = int(line)
            elif line:
                sample_fmt = line
        if bit_depth == 24 or (sample_fmt and "s32" in sample_fmt):
            return "pcm_s24be"
        if bit_depth == 32 or (sample_fmt and ("s32" in sample_fmt or "f32" in sample_fmt)):
            return "pcm_s32be"
        return "pcm_s16be"

    def convert(self, target_format: Literal["mp3", "aiff"], output_dir: Path, quality: int = 320) -> Path | None:
        """Convert file to target format, placing the output in output_dir.

        Parameters
        ----------
        target_format:
            "mp3" or "aiff".
        output_dir:
            Directory where the converted file will be written.
        quality:
            Bitrate in kbps for MP3 output (ignored for AIFF).

        Returns
        -------
        Path | None
            Path to the converted file, or None if conversion was skipped
            (e.g. source is not lossless and target is aiff).
        """
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{self.file.stem}.{target_format}"

        if target_format == "mp3":
            command = [
                _find_binary("ffmpeg"),
                "-i",
                str(self.file),
                "-c:a",
                "libmp3lame",
                "-b:a",
                f"{quality}k",
                "-y",
                str(output_path),
            ]
            _run_ffmpeg(command)
            return output_path

        if target_format == "aiff":
            if not self.is_lossless:
                logger.warning("Cannot convert %s to AIFF: source file is not lossless", self.file.suffix)
                return None
            codec = self._detect_aiff_codec()
            logger.info("Converting %s to AIFF with codec %s", self.file.name, codec)
            command = [
                _find_binary("ffmpeg"),
                "-i",
                str(self.file),
                "-c:a",
                codec,
                "-y",
                str(output_path),
            ]
            _run_ffmpeg(command)
            return output_path

        return None

    def copy_tags_to(self, target_path: Path) -> None:
        """Copy all metadata tags and artwork from this file to target_path."""
        info = self.track_info
        artwork = self.get_single_cover(raise_error=False)
        suffix = target_path.suffix.lower()
        if suffix == ".mp3":
            track = ID3(str(target_path))
            self._add_info(track, info=info, artwork=artwork)
            track.save()
        else:
            try:
                track = EasyID3(str(target_path))
            except mutagen.id3.ID3NoHeaderError:
                track = mutagen.File(str(target_path), easy=True)
                track.add_tags()
            self._add_info(track.tags, info=info, artwork=artwork)
            track.save(str(target_path))

    def rename(self, new_name: str):
        safe_name = new_name.replace("/", "-")
        return self.file.rename(Path(self.file.parent, safe_name + self.file.suffix))
