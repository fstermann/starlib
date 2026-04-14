"""Round-trip tests for the registry-driven TrackHandler I/O.

These cover the contract that adding/reading any registry-driven tag goes
through ``_write_simple`` / ``_read_simple`` uniformly, plus the StarlibMeta
migration glue (legacy ``COMM::XXX`` -> ``TXXX:starlib`` / ``COMM::eng``).
"""

from datetime import date
from pathlib import Path

import pytest
from mutagen.id3 import COMM, ID3, TIT2

from soundcloud_tools.handler.track import (
    SIMPLE_TAG_FIELDS,
    SIMPLE_TAG_FIELDS_BY_NAME,
    StarlibMeta,
    TrackHandler,
    TrackInfo,
)


def _make_silent_mp3(path: Path) -> None:
    """Generate a minimal valid MP3 via ffmpeg (0.2s silence)."""
    import shutil
    import subprocess

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg not available")
    assert ffmpeg is not None  # narrow for mypy after pytest.skip
    subprocess.run(
        [
            ffmpeg,
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=mono",
            "-t",
            "0.2",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "64k",
            "-y",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


@pytest.fixture
def mp3_file(tmp_path: Path) -> Path:
    p = tmp_path / "track.mp3"
    _make_silent_mp3(p)
    return p


@pytest.fixture
def handler(tmp_path: Path, mp3_file: Path) -> TrackHandler:
    return TrackHandler(root_folder=tmp_path, file=mp3_file)


def test_registry_round_trip_full(handler: TrackHandler) -> None:
    """Every flat field round-trips through ID3 with the right type."""
    info = TrackInfo(
        title="My Song",
        artist=["Alice", "Bob"],
        genre="House",
        bpm=128,
        key="8A",
        original_artist="Carol",
        remixer=["Dave", "Eve"],
        mix_name="VIP Mix",
        release_date=date(2024, 5, 1),
        release_year=2024,
        user_comment="A user-visible note",
        starlib_meta=StarlibMeta(version="1.0", soundcloud_id=123, soundcloud_permalink="https://example/x"),
    )
    handler.add_info(info)

    read = handler.track_info
    assert read.title == "My Song"
    assert read.artist == ["Alice", "Bob"]
    assert read.genre == "House"
    assert read.bpm == 128
    assert read.key == "8A"
    assert read.original_artist == ["Carol"]
    assert read.remixer == ["Dave", "Eve"]
    assert read.mix_name == "VIP Mix"
    assert read.release_date == date(2024, 5, 1)
    assert read.release_year == 2024
    assert read.user_comment == "A user-visible note"
    assert read.starlib_meta is not None
    assert read.starlib_meta.soundcloud_id == 123
    assert read.starlib_meta.version == "1.0"


def test_round_trip_empty_optional_fields(handler: TrackHandler) -> None:
    """All-optional TrackInfo writes cleanly and reads back as None."""
    handler.add_info(TrackInfo())
    read = handler.track_info
    for f in SIMPLE_TAG_FIELDS:
        assert getattr(read, f.name) in (None, []), f"{f.name} should be empty"


def test_clearing_remix_fields_via_none(handler: TrackHandler) -> None:
    """Setting remix-style fields to None deletes the underlying ID3 frames."""
    handler.add_info(TrackInfo(title="X", original_artist="A", remixer="B", mix_name="VIP"))
    cleared = TrackInfo(title="X")
    handler.add_info(cleared)
    read = handler.track_info
    assert read.original_artist is None
    assert read.remixer is None
    assert read.mix_name is None


def test_clear_tags_helper(handler: TrackHandler) -> None:
    handler.add_info(TrackInfo(title="X", remixer="R", original_artist="O"))
    handler.clear_tags(["remixer", "original_artist"])
    read = handler.track_info
    assert read.remixer is None
    assert read.original_artist is None
    assert read.title == "X"


def test_clear_tags_unknown_field(handler: TrackHandler) -> None:
    with pytest.raises(KeyError):
        handler.clear_tags(["not_a_real_field"])


def test_starlib_meta_legacy_comm_xxx_migrates_to_user_comment(handler: TrackHandler, mp3_file: Path) -> None:
    """A plain text in COMM::XXX (no key=value pairs) ends up as user_comment."""
    track = ID3(mp3_file)
    track.add(TIT2(encoding=3, text="X"))
    track.add(COMM(encoding=3, lang="XXX", desc="", text="just a plain comment"))
    track.save()

    read = handler.track_info
    assert read.user_comment == "just a plain comment"
    assert read.starlib_meta is None  # no structured data in the legacy blob

    # Saving evicts COMM::XXX and writes the user comment to COMM::eng.
    handler.add_info(read)
    re_read = ID3(mp3_file)
    assert re_read.get("COMM::XXX") is None
    assert str(re_read.get("COMM::eng")) == "just a plain comment"


def test_starlib_meta_legacy_comm_xxx_migrates_structured(handler: TrackHandler, mp3_file: Path) -> None:
    """Structured key=value blob in COMM::XXX migrates into starlib_meta."""
    track = ID3(mp3_file)
    track.add(TIT2(encoding=3, text="X"))
    payload = "version=0.9; soundcloud_id=42; soundcloud_permalink=https://example/y"
    track.add(COMM(encoding=3, lang="XXX", desc="", text=payload))
    track.save()

    read = handler.track_info
    assert read.starlib_meta is not None
    assert read.starlib_meta.soundcloud_id == 42
    assert read.starlib_meta.soundcloud_permalink == "https://example/y"
    assert read.user_comment is None

    handler.add_info(read)
    re_read = ID3(mp3_file)
    assert re_read.get("COMM::XXX") is None
    assert re_read.get("TXXX:starlib") is not None


def test_user_comment_does_not_clobber_starlib(handler: TrackHandler) -> None:
    """user_comment goes to COMM::eng, starlib stays in TXXX:starlib."""
    handler.add_info(
        TrackInfo(
            title="X",
            user_comment="hello",
            starlib_meta=StarlibMeta(soundcloud_id=7),
        )
    )
    read = handler.track_info
    assert read.user_comment == "hello"
    assert read.starlib_meta and read.starlib_meta.soundcloud_id == 7


def test_release_year_independent_of_release_date(handler: TrackHandler) -> None:
    """release_year and release_date are independent registry fields."""
    handler.add_info(TrackInfo(release_date=date(2020, 5, 1), release_year=1999))
    read = handler.track_info
    assert read.release_date == date(2020, 5, 1)
    assert read.release_year == 1999


def test_registry_field_names_unique() -> None:
    names = [f.name for f in SIMPLE_TAG_FIELDS]
    assert len(names) == len(set(names))
    assert set(SIMPLE_TAG_FIELDS_BY_NAME.keys()) == set(names)


def test_track_info_filename_with_missing_artist() -> None:
    info = TrackInfo(title="Standalone")
    assert info.filename == "Standalone"


def test_track_info_filename_with_artist() -> None:
    info = TrackInfo(title="Song", artist="Alice")
    assert info.filename == "Alice - Song"


def test_schemas_include_every_registry_field() -> None:
    """Adding a TagField must surface in the API schemas automatically."""
    from backend.schemas.metadata import (
        TrackBrowseResponse,
        TrackInfoResponse,
        TrackInfoUpdateRequest,
    )

    expected = {f.name for f in SIMPLE_TAG_FIELDS}
    for schema in (TrackInfoUpdateRequest, TrackInfoResponse, TrackBrowseResponse):
        assert expected <= set(schema.model_fields), (
            f"{schema.__name__} is missing registry fields: {expected - set(schema.model_fields)}"
        )
