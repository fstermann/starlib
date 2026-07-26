"""The folder scan must not do redundant work.

Two regressions this pins:

* ``TrackHandler.track`` was a plain property, so reading one track's tags
  re-opened and re-parsed the file three times (once directly, twice more via
  ``get_single_cover``).
* the scan issued a ``get_track_mtime`` query and a separate write transaction
  per file, so an unchanged folder still cost one round trip per track.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from mutagen.id3 import ID3, TIT2
from mutagen.mp3 import MP3

from backend.infra import cache
from backend.infra.audio import folders as folders_mod
from backend.infra.audio import track_handler as th
from backend.infra.db import engine as db_engine
from backend.services.collection import indexing


@pytest.fixture(autouse=True)
def _reset_engine():
    yield
    if db_engine._engine is not None:  # type: ignore[attr-defined]
        db_engine._engine.dispose()  # type: ignore[attr-defined]
    db_engine._engine = None  # type: ignore[attr-defined]
    db_engine._engine_path = None  # type: ignore[attr-defined]
    indexing._indexed_this_session.clear()
    indexing._indexing.clear()


def _make_mp3(path: Path, title: str) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "quiet",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=mono",
            "-t",
            "1",
            "-c:a",
            "libmp3lame",
            str(path),
        ],
        check=True,
    )
    tags = ID3()
    tags.add(TIT2(encoding=3, text=title))
    tags.save(path)


@pytest.fixture
def counting_mp3(monkeypatch):
    """Patch the MP3 reader to count how often a file is opened and parsed."""
    calls = {"n": 0}

    class Counting(MP3):
        def __init__(self, *args, **kwargs):
            calls["n"] += 1
            super().__init__(*args, **kwargs)

    monkeypatch.setitem(folders_mod.FILETYPE_MAP, ".mp3", Counting)
    monkeypatch.setitem(th.FILETYPE_MAP, ".mp3", Counting)
    return calls


def test_track_info_parses_the_file_once(tmp_path: Path, counting_mp3) -> None:
    f = tmp_path / "a.mp3"
    _make_mp3(f, "Title A")

    handler = th.TrackHandler(root_folder=tmp_path, file=f)
    info = handler.track_info

    assert info.title == "Title A"
    assert counting_mp3["n"] == 1, "track_info re-opened the file"


def test_reading_cover_reuses_the_parsed_file(tmp_path: Path, counting_mp3) -> None:
    f = tmp_path / "b.mp3"
    _make_mp3(f, "Title B")

    handler = th.TrackHandler(root_folder=tmp_path, file=f)
    assert handler.track_info is not None
    handler.get_single_cover(raise_error=False)
    assert handler.covers == []

    assert counting_mp3["n"] == 1


def test_scan_indexes_every_audio_file(tmp_path: Path) -> None:
    cache.init_db(tmp_path / "cache.db")
    music = tmp_path / "music"
    music.mkdir()
    for i in range(3):
        _make_mp3(music / f"t{i}.mp3", f"Track {i}")

    indexing._load_folder_to_db(music, music)

    rows = cache.get_tracks(music.resolve())
    assert {r["title"] for r in rows} == {"Track 0", "Track 1", "Track 2"}


def test_rescan_of_unchanged_folder_writes_nothing(tmp_path: Path, monkeypatch) -> None:
    """An unchanged folder must not re-read tags or re-write rows."""
    cache.init_db(tmp_path / "cache.db")
    music = tmp_path / "music"
    music.mkdir()
    for i in range(3):
        _make_mp3(music / f"t{i}.mp3", f"Track {i}")

    indexing._load_folder_to_db(music, music)

    built: list[Path] = []
    original = indexing._build_row

    def counting_build_row(root: Path, f: Path, mtime: float, size: int):
        built.append(f)
        return original(root, f, mtime, size)

    writes: list[int] = []
    original_upsert = cache.upsert_tracks

    def counting_upsert(rows) -> None:
        writes.append(len(rows))
        original_upsert(rows)

    monkeypatch.setattr(indexing, "_build_row", counting_build_row)
    monkeypatch.setattr(indexing.cache, "upsert_tracks", counting_upsert)

    indexing._indexed_this_session.clear()
    indexing._load_folder_to_db(music, music)

    assert built == [], "unchanged files were re-parsed"
    assert writes == [], "unchanged folder issued a write"


def test_non_audio_files_are_not_opened(tmp_path: Path) -> None:
    """Stray files must be filtered out before the tag reader sees them."""
    cache.init_db(tmp_path / "cache.db")
    music = tmp_path / "music"
    music.mkdir()
    _make_mp3(music / "real.mp3", "Real")
    (music / "sidecar.asd").write_bytes(b"not audio")
    (music / "cover.jpg").write_bytes(b"not audio")

    indexing._load_folder_to_db(music, music)

    rows = cache.get_tracks(music.resolve())
    assert [r["file_name"] for r in rows] == ["real.mp3"]


def test_changed_file_is_reindexed(tmp_path: Path) -> None:
    cache.init_db(tmp_path / "cache.db")
    music = tmp_path / "music"
    music.mkdir()
    f = music / "t.mp3"
    _make_mp3(f, "Before")

    indexing._load_folder_to_db(music, music)
    assert [r["title"] for r in cache.get_tracks(music.resolve())] == ["Before"]

    tags = ID3(f)
    tags.delall("TIT2")
    tags.add(TIT2(encoding=3, text="After"))
    tags.save(f)

    indexing._indexed_this_session.clear()
    indexing._load_folder_to_db(music, music)
    assert [r["title"] for r in cache.get_tracks(music.resolve())] == ["After"]
