import logging
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, ClassVar, Literal, Self

import mutagen
import requests
from mutagen.aiff import AIFF
from mutagen.easyid3 import EasyID3
from mutagen.id3 import APIC, COMM, ID3, TBPM, TCON, TDRC, TDRL, TIT2, TIT3, TKEY, TOPE, TPE1, TPE4, TXXX
from mutagen.mp3 import MP3
from mutagen.wave import WAVE
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from soundcloud_tools.models import Track
from soundcloud_tools.settings import get_settings
from soundcloud_tools.utils import convert_to_int, load_tracks
from soundcloud_tools.utils.string import get_first_artist, get_mix_arist, get_mix_name, parse_date

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


FILETYPE_MAP = {
    ".mp3": MP3,
    ".aif": AIFF,
    ".aiff": AIFF,
    ".wav": WAVE,
}


class StarlibMeta(BaseModel):
    """App-managed origin/sync metadata stored in ``TXXX:starlib``.

    Was previously called ``Comment`` and stored in ``COMM::XXX`` — that slot
    is the standard user-comment slot, so writing app data there clobbered the
    user's plain-text comment in every other player.
    """

    version: str | None = None
    soundcloud_id: int | None = None
    soundcloud_permalink: str | None = None

    @staticmethod
    def unescape_value(value: str):
        return value.replace(r"\;", ";").replace(r"\=", "=").replace(r"\\", "\\")

    @staticmethod
    def escape_value(value: str):
        return re.sub(r"([=;\\])", r"\\\1", value)

    @classmethod
    def from_str(cls, string: str) -> Self:
        if not string:
            return cls()
        pairs = [pair.split("=", 1) for pair in re.split(r"(?<!\\);\s*", string) if pair.strip()]
        try:
            data = {k.strip(): cls.unescape_value(str(v)) for k, v in pairs if k.strip()}
        except ValueError as e:
            logger.error(f"Error parsing starlib meta: {string}, {e}")
            data = {}
        # Drop unknown keys so legacy/foreign blobs don't blow up validation.
        known = set(cls.model_fields)
        data = {k: v for k, v in data.items() if k in known}
        return cls(**data)

    @classmethod
    def from_sc_track(cls, track: Track) -> Self:
        return cls(
            version=get_settings().version,
            soundcloud_id=track.id,
            soundcloud_permalink=track.permalink_url,
        )

    def to_str(self) -> str:
        return "; \n".join(f"{k}={self.escape_value(str(v))}" for k, v in self.model_dump().items() if v is not None)

    @property
    def is_empty(self) -> bool:
        return not (self.version or self.soundcloud_id or self.soundcloud_permalink)


def unescape_list_value(value: str):
    return value.replace(r"\,", ",").replace(r"\\", "\\")


def escape_list_value(value: str):
    return re.sub(r"([,\\])", r"\\\1", value)


def serialize_list(values: list[str]) -> str:
    return ", ".join(escape_list_value(artist) for artist in values)


def deserialize_list(values: str) -> list[str]:
    return [unescape_list_value(artist) for artist in values.split(", ")]


@dataclass(frozen=True)
class TagField:
    """Single source of truth for one ID3 tag <-> TrackInfo field mapping."""

    name: str
    frame: type
    frame_id: str
    is_list: bool = False
    label: str = ""
    sortable: bool = True
    searchable: bool = False
    to_str: Callable[[Any], str] | None = None
    from_str: Callable[[str], Any] | None = None
    frame_kwargs: dict = field(default_factory=dict)
    tag_key: str | None = None

    @property
    def key(self) -> str:
        return self.tag_key or self.frame_id


def _bpm_from_str(s: str) -> int | None:
    return convert_to_int(s) or None


def _date_to_str(d: date) -> str:
    return d.strftime("%Y-%m-%d")


def _year_to_str(y: int) -> str:
    return str(y)


def _starlib_to_str(m: "StarlibMeta") -> str:
    return m.to_str()


SIMPLE_TAG_FIELDS: tuple[TagField, ...] = (
    TagField("title", TIT2, "TIT2", label="Title", searchable=True),
    TagField("artist", TPE1, "TPE1", is_list=True, label="Artist", searchable=True),
    TagField("genre", TCON, "TCON", label="Genre", searchable=True),
    TagField("bpm", TBPM, "TBPM", label="BPM", to_str=str, from_str=_bpm_from_str),
    TagField("key", TKEY, "TKEY", label="Key"),
    TagField("original_artist", TOPE, "TOPE", is_list=True, label="Original Artist", searchable=True),
    TagField("remixer", TPE4, "TPE4", is_list=True, label="Remixer", searchable=True),
    TagField("mix_name", TIT3, "TIT3", label="Mix"),
    TagField("release_date", TDRL, "TDRL", label="Release Date", to_str=_date_to_str, from_str=parse_date),
    TagField("release_year", TDRC, "TDRC", label="Release Year", to_str=_year_to_str, from_str=_bpm_from_str),
    TagField(
        "user_comment",
        COMM,
        "COMM",
        label="Comment",
        tag_key="COMM::eng",
        frame_kwargs={"desc": "", "lang": "eng"},
    ),
    TagField(
        "starlib_meta",
        TXXX,
        "TXXX",
        label="Starlib Meta",
        tag_key="TXXX:starlib",
        frame_kwargs={"desc": "starlib"},
        to_str=_starlib_to_str,
        from_str=StarlibMeta.from_str,
        sortable=False,
    ),
)
SIMPLE_TAG_FIELDS_BY_NAME: dict[str, TagField] = {f.name: f for f in SIMPLE_TAG_FIELDS}


class TrackInfo(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    # All ID3 tags are optional on disk — none of the flat fields are required.
    title: str | None = None
    artist: str | list[str] | None = None
    genre: str | None = None
    bpm: int | None = None
    key: str | None = None
    original_artist: str | list[str] | None = None
    remixer: str | list[str] | None = None
    mix_name: str | None = None
    release_date: date | None = None
    release_year: int | None = None
    user_comment: str | None = None
    starlib_meta: StarlibMeta | None = None

    artwork: bytes | None = None
    artwork_url: str | None = None
    length: float | None = None

    _artist_sep: ClassVar[str] = ", "

    @model_validator(mode="after")
    def check_artwork_url(self):
        if self.artwork_url and not self.artwork:
            self.artwork = requests.get(self.artwork_url).content
        return self

    @staticmethod
    def _join_artists(artists: str | list[str] | None) -> str:
        if artists is None:
            return ""
        return serialize_list(artists) if isinstance(artists, list) else artists

    @property
    def filename(self) -> str:
        title = self.title or ""
        artist_str = self.artist_str
        if not artist_str:
            return title
        return title if artist_str in title else f"{artist_str} - {title}"

    @property
    def complete(self) -> bool:
        return all([self.title, self.artist, self.genre, self.release_date, self.artwork])

    @property
    def artist_str(self) -> str:
        return self._join_artists(self.artist)

    @property
    def original_artist_str(self) -> str:
        return self._join_artists(self.original_artist)

    @property
    def remixer_str(self) -> str:
        return self._join_artists(self.remixer)

    @classmethod
    def sort_artists(
        cls, artists: set[str], title: str, type: Literal["artist", "original_artist", "remixer"]
    ) -> list[str]:
        from soundcloud_tools.handler.artist_ranking import rank_artists

        return rank_artists(artists, title=title, role=type)

    @classmethod
    def from_sc_track(cls, track: Track) -> Self:
        artist_options: set[str] = {
            a
            for a in (
                track.publisher_metadata and track.publisher_metadata.artist,
                track.user.username,
                get_first_artist(track.title),
                get_mix_arist(track.title),
            )
            if a
        }

        most_likely_artists = cls.sort_artists(artist_options, track.title, "artist")
        most_likely_original_artists = cls.sort_artists(artist_options, track.title, "original_artist")
        most_likely_remixers = cls.sort_artists(artist_options, track.title, "remixer")

        mix_name = get_mix_name(track.title)

        release_date = track.display_date.date()
        return cls(
            title=track.title,
            artist=next(iter(most_likely_artists), ""),
            genre=track.genre or "",
            release_date=release_date,
            release_year=release_date.year,
            artwork_url=track.hq_artwork_url or track.user.hq_avatar_url,
            original_artist=next(iter(most_likely_original_artists), ""),
            remixer=next(iter(most_likely_remixers), ""),
            mix_name=mix_name,
            starlib_meta=StarlibMeta.from_sc_track(track),
        )


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
    def _get_tag_value(track: Track, tag: str, default: Any = "") -> str:
        return str(track.tags.get(tag, default))

    @staticmethod
    def _get_tag_list_value(track: Track, tag: str, default: Any = "") -> list[str]:
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
        subprocess.run(command, check=True)
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
        subprocess.run(command, check=True)
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
            subprocess.run(command, check=True)
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
            subprocess.run(command, check=True)
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
