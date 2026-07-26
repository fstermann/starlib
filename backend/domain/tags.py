"""Tag vocabulary and the in-memory track model.

Pure half of the old ``core/audio/tags.py``: the ID3 field registry
(:data:`SIMPLE_TAG_FIELDS`), the ``TXXX:starlib`` payload model
(:class:`StarlibMeta`), the list serialisation helpers, and
:class:`TrackInfo` — the app's in-memory view of one track's metadata.

Reading and writing those tags on disk is the job of
:mod:`backend.infra.audio.track_handler`; nothing here touches the filesystem.
"""

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from typing import Any, ClassVar, Literal, Self

import requests
from mutagen.id3 import COMM, TBPM, TCON, TDRC, TDRL, TIT2, TIT3, TKEY, TOPE, TPE1, TPE4, TXXX
from pydantic import BaseModel, ConfigDict, model_validator

from backend.domain.titles import parse_date, rank_artists

logger = logging.getLogger(__name__)


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

    def to_str(self) -> str:
        return "; \n".join(f"{k}={self.escape_value(str(v))}" for k, v in self.model_dump().items() if v is not None)

    @property
    def is_empty(self) -> bool:
        return not (self.version or self.soundcloud_id or self.soundcloud_permalink)


def convert_to_int(value: Any, default: int = 0) -> int:
    """Coerce *value* to ``int``, falling back to *default* on bad input."""
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


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
        return rank_artists(artists, title=title, role=type)
