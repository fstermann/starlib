import logging
import re
import subprocess
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any, ClassVar, Literal, Self

import mutagen
import requests
from mutagen.aiff import AIFF
from mutagen.easyid3 import EasyID3
from mutagen.id3 import APIC, COMM, ID3, TCON, TDRC, TDRL, TIT2, TIT3, TOPE, TPE1, TPE4
from mutagen.mp3 import MP3
from mutagen.wave import WAVE
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from soundcloud_tools.models import Track
from soundcloud_tools.settings import get_settings
from soundcloud_tools.utils import convert_to_int, load_tracks
from soundcloud_tools.utils.string import get_first_artist, get_mix_arist, get_mix_name, is_remix, parse_date

logger = logging.getLogger(__name__)
FILETYPE_MAP = {
    ".mp3": MP3,
    ".aif": AIFF,
    ".aiff": AIFF,
    ".wav": WAVE,
}


class Comment(BaseModel):
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
        pairs = [pair.split("=", 1) for pair in re.split(r"(?<!\\);\s*", string)]
        try:
            data = {k: cls.unescape_value(str(v)) for k, v in pairs}
        except ValueError as e:
            logger.error(f"Error parsing comment: {string}, {e}")
            data = {}
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


class Remix(BaseModel):
    original_artist: str | list[str]
    remixer: str | list[str]
    mix_name: str | None

    @property
    def original_artist_str(self) -> str:
        return TrackInfo._join_artists(self.original_artist)

    @property
    def remixer_str(self) -> str:
        return TrackInfo._join_artists(self.remixer)


def unescape_list_value(value: str):
    return value.replace(r"\,", ",").replace(r"\\", "\\")


def escape_list_value(value: str):
    return re.sub(r"([,\\])", r"\\\1", value)


def serialize_list(values: list[str]) -> str:
    return ", ".join(escape_list_value(artist) for artist in values)


def deserialize_list(values: str) -> list[str]:
    return [unescape_list_value(artist) for artist in values.split(", ")]


class TrackInfo(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    title: str
    artist: str | list[str]
    genre: str
    release_date: date | None = None
    artwork: bytes | None = None
    artwork_url: str | None = None

    remix: Remix | None = None
    comment: Comment | None = None

    bpm: int | None = None
    key: str | None = None

    artist_options: set[str] = Field(default_factory=set)

    _artist_sep: ClassVar[str] = ", "

    @model_validator(mode="after")
    def check_artwork_url(self):
        if self.artwork_url and not self.artwork:
            self.artwork = requests.get(self.artwork_url).content
        return self

    @staticmethod
    def _join_artists(artists: str | list[str]) -> str:
        return serialize_list(artists) if isinstance(artists, list) else artists

    @property
    def filename(self) -> str:
        return self.title if self.artist_str in self.title else f"{self.artist_str} - {self.title}"

    @property
    def complete(self) -> bool:
        return all([self.title, self.artist, self.genre, self.release_date, self.artwork])

    @property
    def artist_str(self) -> str:
        return self._join_artists(self.artist)

    @staticmethod
    def _get_artist_sorter(title: str, type: Literal["artist", "original_artist", "remixer"]) -> Callable[[str], int]:
        def is_in(artist: str, text: str | None):
            return int(re.search(re.escape(artist.strip()), text or "", flags=re.IGNORECASE) is not None)

        first_artist = get_first_artist(title)
        mix_artist = get_mix_arist(title)

        def by_first_sorter(artist: str):
            return 0 if not artist else is_in(artist, title) + is_in(artist, first_artist)

        def by_mix_sorter(artist: str):
            return 0 if not artist else is_in(artist, title) + is_in(artist, mix_artist)

        match type:
            case "artist":
                return by_mix_sorter if is_remix(title) else by_first_sorter
            case "original_artist":
                return by_first_sorter
            case "remixer":
                return by_mix_sorter
            case _:
                raise ValueError(f"Invalid type {type}")

    @classmethod
    def sort_artists(
        cls, artists: set[str], title: str, type: Literal["artist", "original_artist", "remixer"]
    ) -> list[str]:
        return sorted(artists, key=cls._get_artist_sorter(title, type=type), reverse=True)

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

        return cls(
            title=track.title,
            artist=next(iter(most_likely_artists), ""),
            genre=track.genre or "",
            release_date=track.display_date.date(),
            artwork_url=track.hq_artwork_url or track.user.hq_avatar_url,
            artist_options=artist_options,
            remix=Remix(
                original_artist=next(iter(most_likely_original_artists), ""),
                remixer=next(iter(most_likely_remixers), ""),
                mix_name=mix_name,
            ),
            comment=Comment.from_sc_track(track),
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
        return [cls(root_folder=root_folder, file=f) for f in load_tracks(root_folder)]

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

    @property
    def track_info(self):
        track = self.track
        remix_data = {
            "original_artist": self._get_tag_list_value(track, "TOPE"),
            "remixer": self._get_tag_list_value(track, "TPE4"),
            "mix_name": self._get_tag_value(track, "TIT3"),
        }
        if not any(any(item != "" for item in v) if isinstance(v, list) else v for v in remix_data.values()):
            remix = None
        else:
            remix = Remix(**remix_data)
        return TrackInfo(
            title=self._get_tag_value(track, "TIT2"),
            artist=self._get_tag_list_value(track, "TPE1"),
            genre=self._get_tag_value(track, "TCON"),
            release_date=parse_date(self._get_tag_value(track, "TDRL")),
            artwork=self.get_single_cover(raise_error=False),
            remix=remix,
            comment=Comment.from_str(self._get_tag_value(track, "COMM::XXX")),
            bpm=convert_to_int(self._get_tag_value(track, "TBPM")) or None,
            key=self._get_tag_value(track, "TKEY"),
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
            "ffmpeg",
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
            "ffprobe",
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
            "ffmpeg",
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

    def remove_remix(self):
        track = self.track
        track.tags.delall("TOPE")
        track.tags.delall("TPE4")
        track.tags.delall("TIT3")
        track.save()

    def _add_info(self, track, info: TrackInfo, artwork: bytes | None = None):
        track.add(TIT2(encoding=3, text=info.title))
        track.add(TPE1(encoding=3, text=info.artist_str))
        track.add(TCON(encoding=3, text=info.genre))
        track.add(TDRC(encoding=3, text=str(info.release_date.year) if info.release_date else ""))
        track.add(TDRL(encoding=3, text=info.release_date.strftime("%Y-%m-%d") if info.release_date else ""))
        if artwork:
            track.delall("APIC")
            track.add(
                APIC(
                    encoding=3,
                    mime="image/jpeg",
                    type=3,
                    desc="Cover",
                    data=artwork,
                )
            )
        if info.remix:
            if info.remix.original_artist_str:
                track.add(TOPE(encoding=3, text=info.remix.original_artist_str))
            if info.remix.remixer_str:
                track.add(TPE4(encoding=3, text=info.remix.remixer_str))
            if info.remix.mix_name:
                track.add(TIT3(encoding=3, text=info.remix.mix_name))
        if info.comment:
            track.delall("COMM")
            track.add(COMM(encoding=3, text=info.comment.to_str()))

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

    def rename(self, new_name: str):
        safe_name = new_name.replace("/", "-")
        return self.file.rename(Path(self.file.parent, safe_name + self.file.suffix))
